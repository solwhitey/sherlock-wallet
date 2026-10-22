// Usage: RPC_URL(_FILE)=... npx tsx scripts/wasm-svm-override.ts
// Override demo: asks Jupiter for a 100 USDC -> SOL swap for a brand-new (empty) wallet, then
// simulates it (1) with the RPC: fails, (2) in the WASM VM as is: fails the same way, (3) in the
// WASM VM with the wallet given 0.05 SOL and 100 USDC: succeeds.
import { getAddressDecoder } from '@solana/kit';
import { compare, rpcSimulate } from './wasm-svm-check';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

(async () => {
  const wallet = getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32))) as string;
  const quote = await (
    await fetch(
      `https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${SOL}&amount=100000000&slippageBps=100`
    )
  ).json();
  const swap = await (
    await fetch('https://lite-api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet, dynamicComputeUnitLimit: false }),
    })
  ).json();
  if (!swap.swapTransaction) throw new Error(JSON.stringify(swap));
  const bytes = Uint8Array.from(Buffer.from(swap.swapTransaction, 'base64'));
  console.log(
    `empty wallet ${wallet}, quote 100 USDC -> ${Number(quote.outAmount) / 1e9} SOL via ${quote.routePlan.map((r: any) => r.swapInfo.label).join(' > ')}`
  );

  const node = await rpcSimulate(bytes);
  console.log(`\nrpc (no override): err=${JSON.stringify(node.value.err)}`);
  await compare('wasm, no override', bytes, {});
  const res = await compare('wasm, wallet given 0.05 SOL + 100 USDC', bytes, {
    overrides: { [wallet]: { lamports: 50_000_000 } },
    tokenBalances: [{ owner: wallet, mint: USDC, amount: 100_000_000n }],
  });
  const idx = [...res.value.preBalances.keys()].find((i) => i === 0)!;
  console.log(`\nwallet SOL: ${res.value.preBalances[idx] / 1e9} -> ${res.value.postBalances[idx] / 1e9}`);
  for (const b of res.value.postTokenBalances)
    if (b.owner === wallet) console.log(`wallet ${b.mint.slice(0, 6)} post: ${b.uiTokenAmount.uiAmountString}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
