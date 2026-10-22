import { cacheGet, cacheSet } from './cache';

export const JUP_API = 'https://lite-api.jup.ag';

export type TokenInfo = {
  mint: string;
  symbol?: string;
  name?: string;
  icon?: string;
  decimals?: number;
  usdPrice?: number;
  verified?: boolean;
};

async function getJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

// Token metadata and USD prices from Jupiter's token API. Missing tokens are simply absent; network
// failures return what is cached, never throw.
export async function getTokenInfos(mints: string[]): Promise<Map<string, TokenInfo>> {
  const out = new Map<string, TokenInfo>();
  const missing: string[] = [];
  for (const mint of new Set(mints)) {
    const cached = await cacheGet<TokenInfo>(`token:${mint}`);
    if (cached) out.set(mint, cached);
    else missing.push(mint);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const list = await getJson(`${JUP_API}/tokens/v2/search?query=${chunk.join(',')}`);
      for (const t of list) {
        if (!chunk.includes(t.id)) continue;
        const info: TokenInfo = {
          mint: t.id,
          symbol: t.symbol,
          name: t.name,
          icon: t.icon,
          decimals: t.decimals,
          usdPrice: t.usdPrice,
          verified: t.isVerified,
        };
        out.set(t.id, info);
        // Prices go stale quickly; metadata does not, but one TTL keeps it simple.
        await cacheSet(`token:${t.id}`, info, 60_000);
      }
    } catch {
      // Token metadata is decoration; the simulation stands without it.
    }
  }
  return out;
}

export async function getAmmLabels(): Promise<Record<string, string>> {
  const cached = await cacheGet<Record<string, string>>('jup:amm-labels');
  if (cached) return cached;
  try {
    const labels = await getJson(`${JUP_API}/swap/v1/program-id-to-label`);
    await cacheSet('jup:amm-labels', labels, 24 * 3600_000);
    return labels;
  } catch {
    return {};
  }
}

export type FreshQuote = {
  inAmount: bigint;
  outAmount: bigint;
  otherAmountThreshold: bigint;
  priceImpactPct: number;
  route: string[];
  fetchedAt: number;
};

export async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  exactOut?: boolean;
}): Promise<FreshQuote> {
  const url = new URL(`${JUP_API}/swap/v1/quote`);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', params.amount.toString());
  url.searchParams.set('slippageBps', String(params.slippageBps));
  if (params.exactOut) url.searchParams.set('swapMode', 'ExactOut');
  const q = await getJson(url.toString());
  if (q.error) throw new Error(q.error);
  return {
    inAmount: BigInt(q.inAmount),
    outAmount: BigInt(q.outAmount),
    otherAmountThreshold: BigInt(q.otherAmountThreshold),
    priceImpactPct: Number(q.priceImpactPct),
    route: q.routePlan.map((r: any) => `${r.swapInfo.label} ${r.percent ?? Math.round((r.bps ?? 0) / 100)}%`),
    fetchedAt: Date.now(),
  };
}
