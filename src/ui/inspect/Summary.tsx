import clsx from 'clsx';
import React, { FC, ReactNode, useState } from 'react';
import { Analysis, AssetDelta, Check, SOL, usdValue } from '../../sim/analyze';
import type { FreshQuote } from '../../sim/jupApi';
import type { JupiterSwap } from '../../sim/jupiter';
import { WSOL_MINT } from '../../sim/programs';
import { ChevronDown, RefreshIcon } from '../kit/icons';
import { Button, Collapse, Dot, TokenIcon, Tone, toneText } from '../kit/kit';
import {
  formatAmount,
  formatBps,
  formatPct,
  formatUsd,
  iconOf,
  lamportsToSol,
  shortAddress,
  symbolOf,
  toneOf,
} from './format';

export type QuoteState = { loading: boolean; quote?: FreshQuote; error?: string };
export type SeriesPoint = { t: number; amount?: bigint; failed: boolean };

// Signed values: negative red, positive green, zero in the normal colour. Tiny bps moves count as zero.
const bpsTone = (bps?: number): Tone | undefined =>
  bps === undefined ? undefined : bps > 0.05 ? 'pos' : bps < -0.05 ? 'neg' : undefined;

// What the fee payer spends on the network, so a SOL change made only of fees reads as a fee line
// rather than as a balance change.
function networkCost(a: Analysis) {
  return a.user === a.feePayer ? (a.fees.total ?? a.fees.base + a.fees.priority) + a.fees.jitoTip : 0n;
}

const solUsd = (a: Analysis, lamports: bigint) => formatUsd(usdValue({ mint: SOL, decimals: 9 }, lamports, a.tokens));

// ---- Building blocks ------------------------------------------------------------------------------

const Card: FC<{ title: ReactNode; right?: ReactNode; className?: string; children: ReactNode }> = ({
  title,
  right,
  className,
  children,
}) => (
  <section className={clsx('rounded-card border border-line bg-raised px-5 py-3.5', className)}>
    <div className="mb-2 flex min-h-[28px] items-center gap-3">
      <h2 className="truncate text-[15px] font-semibold">{title}</h2>
      {right ? <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
    {children}
  </section>
);

const Stat: FC<{
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}> = ({ label, value, sub, tone, className, title }) => (
  <div className={clsx('min-w-0', className)} title={title}>
    <div className="truncate text-xs text-ink-2">{label}</div>
    <div className={clsx('mt-0.5 truncate text-[15px] font-semibold', tone && toneText[tone])}>{value}</div>
    {sub ? <div className="truncate text-xs text-ink-3">{sub}</div> : null}
  </div>
);

const Meter: FC<{ label: ReactNode; value: number; max: number; text: ReactNode }> = ({ label, value, max, text }) => {
  const ratio = max ? Math.min(1, value / max) : 0;
  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-2 text-xs">
        <span className="truncate text-ink-2">{label}</span>
        <span className="shrink-0 text-ink-3">{text}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-tint">
        <div
          className={clsx('h-full rounded-full', ratio > 0.9 ? 'bg-warn' : 'bg-accent')}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
};

const Toggle: FC<{ open: boolean; onClick: () => void; children: ReactNode; className?: string }> = ({
  open,
  onClick,
  children,
  className,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={clsx(
      'inline-flex items-center gap-1 text-[13px] font-semibold text-ink-2 underline-offset-2 hover:text-ink hover:underline',
      className
    )}
  >
    {children}
    <ChevronDown size={14} className={clsx('transition-transform duration-[var(--dur-2)]', open && 'rotate-180')} />
  </button>
);

// ---- Balance changes ------------------------------------------------------------------------------

function displayChanges(a: Analysis) {
  const cost = networkCost(a);
  // SOL and wSOL moving in opposite directions is wrapping or unwrapping, not two trades.
  let changes = a.userChanges;
  const sol = changes.find((c) => c.mint === SOL);
  const wsol = changes.find((c) => c.mint === WSOL_MINT);
  const notes: Record<string, string> = {};
  if (sol && wsol && sol.delta > 0n !== wsol.delta > 0n) {
    notes[SOL] =
      `incl. ${formatAmount(wsol.delta < 0n ? -wsol.delta : wsol.delta, 9, { maxFraction: 4 })} ${wsol.delta < 0n ? 'unwrapped' : 'wrapped'}`;
    changes = [{ ...sol, delta: sol.delta + wsol.delta }, ...changes.filter((c) => c !== sol && c !== wsol)];
  }
  // A SOL change that is only fees and tips shows as the fee line instead.
  changes = changes.filter((c) => c.delta !== 0n && !(c.mint === SOL && cost > 0n && c.delta === -cost));
  return { changes, notes, cost };
}

function assetName(asset: AssetDelta, a: Analysis) {
  if (asset.mint === SOL) return 'Solana';
  if (asset.mint === WSOL_MINT) return 'Wrapped SOL';
  const info = a.tokens[asset.mint];
  if (info?.name) return info.name;
  // Unlisted tokens moving by exactly one whole unit with no decimals are positions or NFTs
  // (lending positions, LP NFTs…), not fungible tokens.
  if (asset.decimals === 0 && (asset.delta === 1n || asset.delta === -1n)) return 'Position or NFT · unlisted';
  return 'Unlisted token';
}

const AssetRow: FC<{ asset: AssetDelta; a: Analysis; note?: string }> = ({ asset, a, note }) => {
  const usd = usdValue(asset, asset.delta, a.tokens);
  return (
    <div className="flex items-center gap-3 py-2">
      <TokenIcon src={iconOf(asset.mint, a.tokens)} size={36} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">{symbolOf(asset.mint, a.tokens)}</div>
        <div className="truncate text-xs text-ink-3">{note ?? assetName(asset, a)}</div>
      </div>
      <div className="text-right">
        <div className={clsx('text-[16px] font-semibold', toneOf(asset.delta))}>
          {formatAmount(asset.delta, asset.decimals, { signed: true, maxFraction: asset.decimals > 6 ? 6 : 4 })}
        </div>
        <div className={clsx('text-xs', toneOf(usd))}>{formatUsd(usd, { signed: true }) || ' '}</div>
      </div>
    </div>
  );
};

// "1 SOL = 103.62 USDC" for what was bought, and the same at Jupiter's market prices.
function prices(a: Analysis) {
  const swap = a.swap;
  if (!swap) return undefined;
  const bought = Number(swap.bought.delta) / 10 ** swap.bought.decimals;
  const sold = Number(-swap.sold.delta) / 10 ** swap.sold.decimals;
  if (!bought || !sold) return undefined;
  const priceOf = (mint: string) => a.tokens[mint === SOL ? WSOL_MINT : mint]?.usdPrice;
  const pb = priceOf(swap.bought.mint);
  const ps = priceOf(swap.sold.mint);
  const fmt = (v: number) => v.toLocaleString('en-US', { maximumSignificantDigits: 6 });
  const quote = symbolOf(swap.sold.mint, a.tokens);
  return {
    unit: `1 ${symbolOf(swap.bought.mint, a.tokens)}`,
    effective: `${fmt(sold / bought)} ${quote}`,
    market: pb && ps ? `${fmt(pb / ps)} ${quote}` : undefined,
  };
}

export const BalanceCard: FC<{ a: Analysis }> = ({ a }) => {
  const { changes, notes, cost } = displayChanges(a);
  const ordered = [...changes.filter((c) => c.delta < 0n), ...changes.filter((c) => c.delta > 0n)];
  const p = prices(a);
  return (
    <Card
      title={
        <>
          Balance changes <span className="font-normal text-ink-2">· {a.labels[a.user] ?? shortAddress(a.user)}</span>
        </>
      }
    >
      {ordered.length ? (
        <div className="-my-1 divide-y divide-line">
          {ordered.map((asset) => (
            <AssetRow key={asset.mint} asset={asset} a={a} note={notes[asset.mint]} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-2">
          {a.err ? 'Nothing moves: the transaction reverts.' : 'Nothing moves in or out of this address.'}
        </p>
      )}
      {p ? (
        <div className="mt-2 truncate text-xs text-ink-2">
          {p.unit} = <span className="font-semibold text-ink">{p.effective}</span>
          {p.market ? <span className="text-ink-3"> · market {p.market}</span> : null}
        </div>
      ) : null}
      <NetworkFees a={a} paysFees={cost > 0n} />
    </Card>
  );
};

// ---- Jupiter -----------------------------------------------------------------------------------------

const Sparkline: FC<{ series: SeriesPoint[]; quoted?: bigint; limit?: bigint }> = ({ series, quoted, limit }) => {
  const points = series.filter((p) => p.amount !== undefined) as { t: number; amount: bigint }[];
  if (points.length < 2)
    return <div className="flex h-9 items-center text-xs text-ink-3">Fills in as it re-simulates…</div>;
  const values = [
    ...points.map((p) => Number(p.amount)),
    ...(quoted ? [Number(quoted)] : []),
    ...(limit ? [Number(limit)] : []),
  ];
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const w = 480;
  const h = 36;
  const y = (v: number) => h - 4 - ((v - min) / span) * (h - 8);
  const x = (i: number) => (i / (points.length - 1)) * w;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(p.amount)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-9 w-full" preserveAspectRatio="none">
      {quoted ? (
        <line
          x1={0}
          x2={w}
          y1={y(Number(quoted))}
          y2={y(Number(quoted))}
          stroke="var(--ink-3)"
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {limit ? (
        <line
          x1={0}
          x2={w}
          y1={y(Number(limit))}
          y2={y(Number(limit))}
          stroke="var(--neg)"
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

export const JupiterCard: FC<{
  a: Analysis;
  swap: JupiterSwap;
  series: SeriesPoint[];
  quote?: QuoteState;
  onRequote: () => void;
}> = ({ a, swap, series, quote, onRequote }) => {
  const [showHops, setShowHops] = useState(false);
  const inSym = swap.inputMint ? symbolOf(swap.inputMint, a.tokens) : '?';
  const outSym = swap.outputMint ? symbolOf(swap.outputMint, a.tokens) : '?';
  const fmt = (v: bigint | undefined, side: 'in' | 'out') =>
    v === undefined
      ? '—'
      : `${formatAmount(v, (side === 'in' ? swap.inputDecimals : swap.outputDecimals) ?? 0)} ${side === 'in' ? inSym : outSym}`;
  const side = swap.exactOut ? 'in' : 'out';
  const quoted = swap.exactOut ? swap.quotedInAmount : swap.quotedOutAmount;
  const limit = swap.exactOut ? swap.maxInAmount : swap.minOutAmount;
  const simulated = swap.exactOut ? swap.inAmount : swap.outAmount;
  const decimals = (swap.exactOut ? swap.inputDecimals : swap.outputDecimals) ?? 0;

  const fresh = quote?.quote;
  const freshAmount = fresh ? (swap.exactOut ? fresh.inAmount : fresh.outAmount) : undefined;
  const freshVsTx =
    freshAmount !== undefined && simulated
      ? (((swap.exactOut ? -1 : 1) * Number(freshAmount - simulated)) / Number(simulated)) * 10_000
      : undefined;

  return (
    <Card
      title={
        <>
          Jupiter swap{' '}
          <span className="font-normal text-ink-2">
            · {swap.instruction}
            {swap.exactOut ? ' · exact out' : ''}
          </span>
        </>
      }
      right={
        <>
          {swap.hops.length ? (
            <Toggle open={showHops} onClick={() => setShowHops(!showHops)}>
              {swap.hops.length} hops
            </Toggle>
          ) : null}
          <Button
            kind="outline"
            size="sm"
            onClick={onRequote}
            disabled={quote?.loading || !swap.inputMint || !swap.outputMint}
          >
            <RefreshIcon size={12} className={quote?.loading ? 'animate-spin' : ''} />
            {fresh ? 'Re-quote' : 'Fresh quote'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-x-5 gap-y-3">
        <Stat label={`Quoted ${side}`} value={fmt(quoted, side)} />
        <Stat
          label={`Simulated ${side}`}
          value={swap.failed ? <span className="text-neg">Reverts</span> : fmt(simulated, side)}
          sub={
            swap.failed && swap.unbounded ? (
              <span className="text-neg">fills {formatBps(swap.unbounded.vsQuoteBps)} vs quote</span>
            ) : swap.vsQuoteBps !== undefined ? (
              <span className={toneText[bpsTone(swap.vsQuoteBps) ?? 'muted']}>
                {formatBps(swap.vsQuoteBps)} vs quote
              </span>
            ) : undefined
          }
        />
        <Stat
          label={`${swap.exactOut ? 'Max in' : 'Min out'} · ${formatPct(swap.slippageBps)} slippage`}
          value={fmt(limit, side)}
          sub={
            swap.headroom !== undefined
              ? `room ${formatAmount(swap.headroom, decimals)}${swap.headroomUsd !== undefined ? ` · ${formatUsd(swap.headroomUsd)}` : ''}`
              : undefined
          }
          title="How much worse the fill can get before the swap reverts; also what a sandwich could take."
        />
        <Stat
          label="Value in → out"
          value={`${formatUsd(swap.inUsd) || '—'} → ${formatUsd(swap.outUsd) || '—'}`}
          sub={
            swap.vsMarketBps !== undefined ? (
              <span className={toneText[bpsTone(swap.vsMarketBps) ?? 'muted']}>
                {formatBps(swap.vsMarketBps)} vs market
              </span>
            ) : (
              'no price'
            )
          }
        />
        <Stat
          label="Fees"
          value={`Platform ${formatPct(swap.platformFeeBps)}`}
          sub={
            swap.positiveSlippageBps !== undefined
              ? `positive slippage cap ${formatPct(swap.positiveSlippageBps)}`
              : undefined
          }
        />
        <div className="min-w-0">
          <div className="truncate text-xs text-ink-2">Simulated {side} · live</div>
          <Sparkline series={series} quoted={quoted} limit={limit} />
        </div>
      </div>

      {fresh || quote?.error ? (
        <div className="mt-3 rounded-xl bg-tint px-3.5 py-2 text-[13px]">
          {fresh ? (
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-ink-2">Fresh quote now</span>
              <span className="font-semibold">{fmt(freshAmount, side)}</span>
              {freshVsTx !== undefined ? (
                <span className={toneText[bpsTone(freshVsTx) ?? 'muted']}>
                  {formatBps(freshVsTx)} vs this transaction
                </span>
              ) : null}
              <span className="w-full truncate text-xs text-ink-3">
                {fresh.route.join(' · ')} · impact {(fresh.priceImpactPct * 100).toFixed(3)}%
              </span>
            </div>
          ) : (
            <span className="text-neg">Quote failed: {quote?.error}</span>
          )}
        </div>
      ) : null}

      {swap.route.length ? (
        <div className="mt-3 grid grid-cols-3 gap-x-5 gap-y-1.5">
          {swap.route.map((step, i) => (
            <div key={i} className="flex items-center gap-2.5 text-[13px]">
              <span className="w-20 shrink-0 truncate" title={step.label}>
                {step.label}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-tint">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, step.pct)}%` }} />
              </div>
              <span className="w-9 shrink-0 text-right text-ink-2">{Number(step.pct.toFixed(0))}%</span>
            </div>
          ))}
        </div>
      ) : null}

      {swap.hops.length ? (
        <>
          <Collapse open={showHops}>
            <div className="mt-2.5 grid grid-cols-2 gap-x-6">
              {swap.hops.map((hop, i) => {
                const inDec = a.tokens[hop.inputMint]?.decimals ?? (hop.inputMint === WSOL_MINT ? 9 : undefined);
                const outDec = a.tokens[hop.outputMint]?.decimals ?? (hop.outputMint === WSOL_MINT ? 9 : undefined);
                const amt = (v: bigint, d?: number) =>
                  d !== undefined ? formatAmount(v, d, { maxFraction: 2 }) : v.toString();
                return (
                  <div key={i} className="flex items-center gap-2.5 border-b border-line py-1.5 text-[13px]">
                    <span className="w-24 shrink-0 truncate font-semibold" title={hop.program ?? hop.amm}>
                      {hop.label}
                    </span>
                    <span className="truncate text-ink-2">
                      {amt(hop.inputAmount, inDec)} {symbolOf(hop.inputMint, a.tokens)} →{' '}
                      {amt(hop.outputAmount, outDec)} {symbolOf(hop.outputMint, a.tokens)}
                    </span>
                  </div>
                );
              })}
            </div>
          </Collapse>
        </>
      ) : null}
    </Card>
  );
};

// Swaps that do not go through a Jupiter route (RFQ fills, other routers) and other transactions.
export const ExecutionCard: FC<{ a: Analysis }> = ({ a }) => {
  const otherSigners = a.signers.filter((s) => s !== a.user);
  const via = a.programs.map((id) => a.labels[id] ?? shortAddress(id));
  const p = prices(a);
  if (!a.swap && !otherSigners.length && !via.length) return null;
  return (
    <Card title={a.swap ? 'Execution' : 'Programs'}>
      <div className="grid grid-cols-3 gap-x-5 gap-y-3.5">
        {a.swap ? (
          <>
            <Stat
              label="vs market"
              value={formatBps(a.swap.vsMarketBps) || '—'}
              tone={bpsTone(a.swap.vsMarketBps)}
              sub={
                a.swap.soldUsd !== undefined
                  ? `${formatUsd(a.swap.soldUsd)} → ${formatUsd(a.swap.boughtUsd) || '—'}`
                  : 'no price'
              }
            />
            <Stat label={`Price · ${p?.unit ?? ''}`} value={p?.effective ?? '—'} />
            <Stat label="Market price" value={p?.market ?? '—'} sub="Jupiter price" />
          </>
        ) : null}
        <Stat
          className="col-span-2"
          label="Route via"
          value={via.length ? via.join(' · ') : 'Built-in programs only'}
        />
        <Stat
          label={a.swap ? 'Filled by' : 'Also signed by'}
          value={otherSigners.length ? otherSigners.map((s) => a.labels[s] ?? shortAddress(s)).join(', ') : '—'}
          sub={a.swap && otherSigners.length ? 'market maker co-signs (RFQ)' : undefined}
        />
      </div>
    </Card>
  );
};

// ---- Fees & compute ---------------------------------------------------------------------------------

function priorityRank(a: Analysis) {
  const pf = a.priorityFees;
  if (!pf || !pf.samples) return undefined;
  const p = Number(a.compute.microLamportsPerCu);
  return p >= pf.p90 ? '≥ p90' : p >= pf.p75 ? 'p75–p90' : p >= pf.p50 ? 'p50–p75' : p >= pf.p25 ? 'p25–p50' : '< p25';
}

// Network costs, shown under the balance changes they are part of.
const NetworkFees: FC<{ a: Analysis; paysFees: boolean }> = ({ a, paysFees }) => {
  const { fees, rent, compute } = a;
  const total = (fees.total ?? fees.base + fees.priority) + fees.jitoTip;
  const rentPaid = rent.created.reduce((s, c) => s + c.lamports, 0n);
  const rentBack = rent.closed.reduce((s, c) => s + c.lamports, 0n);
  const rentNet = rentBack - rentPaid;
  const rank = priorityRank(a);
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-2 flex items-baseline justify-between text-xs">
        <span className="font-semibold text-ink">Network fees{paysFees ? '' : ' · paid by another fee payer'}</span>
        <span className="text-ink-3">{solUsd(a, total)}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-2.5">
        <Stat
          label="Total"
          value={
            paysFees ? <span className="text-neg">−{lamportsToSol(total)} SOL</span> : `${lamportsToSol(total)} SOL`
          }
          sub={`priority ${lamportsToSol(fees.priority)}`}
        />
        <Stat
          label="Priority price"
          value={`${Number(compute.microLamportsPerCu).toLocaleString()} µL/CU`}
          sub={rank ? `${rank} of recent · p50 ${a.priorityFees!.p50.toLocaleString()}` : undefined}
        />
        <Stat
          label="Jito tip"
          value={fees.jitoTip ? <span className="text-neg">−{lamportsToSol(fees.jitoTip)} SOL</span> : 'None'}
        />
        <Stat
          label="Rent"
          value={rentNet ? `${formatAmount(rentNet, 9, { signed: true, maxFraction: 6 })} SOL` : 'None'}
          tone={rentNet > 0n ? 'pos' : rentNet < 0n ? 'neg' : undefined}
          sub={rentPaid || rentBack ? `${rent.created.length} opened · ${rent.closed.length} closed` : undefined}
        />
      </div>
    </div>
  );
};

export const ResourcesCard: FC<{ a: Analysis }> = ({ a }) => {
  const { compute } = a;
  const mib = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MiB`;
  return (
    <Card
      title="Compute & size"
      right={
        <span className="text-[13px] text-ink-2">
          {a.instructions.length} ix · {a.accountKeys.length} accounts
        </span>
      }
    >
      <div className="space-y-2.5">
        <Meter
          label={compute.explicitLimit ? 'Compute' : 'Compute · default limit'}
          value={compute.consumed ?? 0}
          max={compute.limit}
          text={`${compute.consumed?.toLocaleString() ?? '—'} / ${compute.limit.toLocaleString()} CU`}
        />
        <Meter
          label={`Size · ${a.version === 'legacy' ? 'legacy' : `v${String(a.version)}`}`}
          value={a.size}
          max={a.maxSize}
          text={`${a.size} / ${a.maxSize} B`}
        />
        {a.loadedAccountsDataSize !== undefined ? (
          <Meter
            label="Loaded account data"
            value={a.loadedAccountsDataSize}
            max={a.loadedAccountsDataLimit}
            text={`${mib(a.loadedAccountsDataSize)} / ${mib(a.loadedAccountsDataLimit)}`}
          />
        ) : null}
      </div>
    </Card>
  );
};

// ---- Checks, other accounts, errors ---------------------------------------------------------------------

const CheckRow: FC<{ check: Check }> = ({ check }) => (
  <div className="flex gap-2.5 py-1.5">
    <Dot tone={check.level === 'ok' ? 'pos' : check.level === 'error' ? 'neg' : check.level} className="mt-[7px]" />
    <div className="min-w-0">
      <div className="text-[13px] font-semibold">{check.title}</div>
      {check.detail ? <div className="break-words text-xs text-ink-2">{check.detail}</div> : null}
    </div>
  </div>
);

export const ChecksCard: FC<{ a: Analysis; renderAddress: (address: string) => ReactNode }> = ({
  a,
  renderAddress,
}) => {
  const [showPassed, setShowPassed] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const passed = a.checks.filter((c) => c.level === 'ok');
  const flagged = a.checks.filter((c) => c.level !== 'ok' && c.title !== 'Simulation failed');
  return (
    <Card
      title="Checks"
      right={
        <span className="text-[13px] text-ink-2">
          {passed.length} passed{flagged.length ? ` · ${flagged.length} to look at` : ''}
        </span>
      }
    >
      {flagged.map((c, i) => (
        <CheckRow key={i} check={c} />
      ))}
      <div className="mt-1 flex flex-wrap gap-x-4">
        <Toggle open={showPassed} onClick={() => setShowPassed(!showPassed)}>
          {passed.length} passed
        </Toggle>
        {a.others.length ? (
          <Toggle open={showOthers} onClick={() => setShowOthers(!showOthers)}>
            {a.others.length} account{a.others.length > 1 ? 's' : ''} touched
          </Toggle>
        ) : null}
      </div>
      <Collapse open={showPassed}>
        <div className="mt-1 grid grid-cols-2 gap-x-6">
          {passed.map((c, i) => (
            <CheckRow key={i} check={c} />
          ))}
        </div>
      </Collapse>
      {a.others.length ? (
        <Collapse open={showOthers}>
          <div className="mt-2 grid grid-cols-2 gap-x-6">
            {a.others.map((o) => (
              <div key={o.owner} className="border-b border-line py-2">
                <div className="text-[13px] font-semibold">{renderAddress(o.owner)}</div>
                {o.assets.map((asset) => (
                  <div key={asset.mint} className="flex justify-between text-[13px]">
                    <span className="text-ink-2">{symbolOf(asset.mint, a.tokens)}</span>
                    <span className={toneOf(asset.delta)}>
                      {formatAmount(asset.delta, asset.decimals, { signed: true })}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Collapse>
      ) : null}
    </Card>
  );
};

export const ErrorBanner: FC<{ a: Analysis }> = ({ a }) => {
  if (!a.error) return null;
  const swap = a.jupiter[0];
  return (
    <div className="rounded-card bg-neg-soft px-5 py-3.5">
      <div className="text-[15px] font-semibold text-neg">{a.error.name ?? 'Simulation failed'}</div>
      <div className="mt-0.5 break-words text-[13px] text-ink-2">{a.error.text}</div>
      {swap?.unbounded ? (
        <div className="mt-1.5 text-[13px]">
          Without the limit the route fills {formatBps(swap.unbounded.vsQuoteBps)} vs quote, which is{' '}
          <b className="text-neg">{formatBps(Math.abs(swap.unbounded.vsLimitBps)).replace(/^[+−]/, '')}</b> past your{' '}
          {swap.exactOut ? 'maximum input' : 'minimum output'}.
        </div>
      ) : null}
    </div>
  );
};
