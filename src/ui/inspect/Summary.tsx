import clsx from 'clsx';
import React, { FC, ReactNode } from 'react';
import { Analysis, AssetDelta, Check, SOL, usdValue } from '../../sim/analyze';
import type { FreshQuote } from '../../sim/jupApi';
import type { JupiterSwap } from '../../sim/jupiter';
import { WSOL_MINT } from '../../sim/programs';
import { AlertIcon, RefreshIcon } from '../kit/icons';
import { Button, Dot, FigCell, FigStrip, Pill, Section, Stat, TokenIcon, Tone } from '../kit/kit';
import { formatAmount, formatBps, formatPct, formatUsd, iconOf, lamportsToSol, symbolOf, toneOf } from './format';

export type QuoteState = { loading: boolean; quote?: FreshQuote; error?: string };
export type SeriesPoint = { t: number; amount?: bigint; failed: boolean };

const bpsTone = (bps?: number): Tone | undefined =>
  bps === undefined ? undefined : bps > 0.05 ? 'pos' : bps < -0.05 ? 'neg' : 'muted';

// What the fee payer spends on the network, so a SOL change made only of fees reads as a fee line
// rather than as a balance change.
function networkCost(a: Analysis) {
  return a.user === a.feePayer ? (a.fees.total ?? a.fees.base + a.fees.priority) + a.fees.jitoTip : 0n;
}

// ---- Hero -------------------------------------------------------------------------------------

const AssetLine: FC<{ asset: AssetDelta; a: Analysis; note?: string }> = ({ asset, a, note }) => {
  const usd = usdValue(asset, asset.delta, a.tokens);
  const name = asset.mint === SOL ? 'Solana' : asset.mint === WSOL_MINT ? 'Wrapped SOL' : a.tokens[asset.mint]?.name;
  return (
    <div className="flex items-center gap-3 py-2.5">
      <TokenIcon src={iconOf(asset.mint, a.tokens)} size={36} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">{symbolOf(asset.mint, a.tokens)}</div>
        <div className="truncate text-xs text-ink-3">{note ?? name ?? ''}</div>
      </div>
      <div className="text-right">
        <div className={clsx('text-[17px] font-semibold', asset.delta > 0n ? 'text-pos' : 'text-ink')}>
          {formatAmount(asset.delta, asset.decimals, { signed: true, maxFraction: asset.decimals > 6 ? 6 : 4 })}
        </div>
        <div className="text-xs text-ink-3">{formatUsd(usd, { signed: true })}</div>
      </div>
    </div>
  );
};

export const Hero: FC<{ a: Analysis }> = ({ a }) => {
  const cost = networkCost(a);
  // SOL and wSOL moving in opposite directions is wrapping or unwrapping, not two trades: show the
  // net SOL once.
  let changes = a.userChanges;
  const sol = changes.find((c) => c.mint === SOL);
  const wsol = changes.find((c) => c.mint === WSOL_MINT);
  const notes: Record<string, string> = {};
  if (sol && wsol && sol.delta > 0n !== wsol.delta > 0n) {
    const net = { ...sol, delta: sol.delta + wsol.delta };
    notes[SOL] =
      `incl. ${formatAmount(wsol.delta < 0n ? -wsol.delta : wsol.delta, 9, { maxFraction: 4 })} SOL ${wsol.delta < 0n ? 'unwrapped' : 'wrapped'}`;
    changes = [net, ...changes.filter((c) => c !== sol && c !== wsol)];
  }
  // Hide the SOL line when it is nothing but fees and tips; the fee line below says it.
  changes = changes.filter((c) => c.delta !== 0n && !(c.mint === SOL && cost > 0n && c.delta === -cost));
  const sends = changes.filter((c) => c.delta < 0n);
  const receives = changes.filter((c) => c.delta > 0n);
  const swap = a.jupiter[0];
  const title = a.err
    ? 'This transaction fails'
    : swap || a.swap
      ? 'Swap'
      : changes.length
        ? 'Balance changes'
        : 'No balance changes';

  return (
    <div className="rise-in">
      <h1 className="text-[26px] font-bold leading-tight tracking-tight">{title}</h1>
      {a.error ? (
        <div className="mt-3 rounded-card bg-neg-soft px-4 py-3">
          <div className="text-[15px] font-semibold text-neg">{a.error.name ?? 'Simulation failed'}</div>
          <div className="mt-0.5 break-words text-sm text-ink-2">{a.error.msg ?? a.error.text}</div>
          {swap?.unbounded ? (
            <div className="mt-2 text-sm text-ink">
              The route would fill <b>{formatBps(Math.abs(swap.unbounded.vsLimitBps)).replace(/^[+−]/, '')}</b> short of
              your {swap.exactOut ? 'maximum input' : 'minimum output'} ({formatBps(swap.unbounded.vsQuoteBps)} vs
              quote).
            </div>
          ) : null}
        </div>
      ) : null}

      {changes.length ? (
        <div className="mt-3">
          {sends.length ? <div className="caps mt-2">You send</div> : null}
          {sends.map((asset) => (
            <AssetLine key={asset.mint} asset={asset} a={a} note={notes[asset.mint]} />
          ))}
          {receives.length ? <div className="caps mt-3">You receive</div> : null}
          {receives.map((asset) => (
            <AssetLine key={asset.mint} asset={asset} a={a} note={notes[asset.mint]} />
          ))}
        </div>
      ) : !a.err ? (
        <p className="mt-2 text-sm text-ink-2">Nothing moves in or out of this address.</p>
      ) : null}

      {cost > 0n ? (
        <p className="mt-2 text-xs text-ink-3">
          Network fee {lamportsToSol(cost)} SOL{' '}
          {formatUsd(usdValue({ mint: SOL, decimals: 9 }, cost, a.tokens)) &&
            `· ${formatUsd(usdValue({ mint: SOL, decimals: 9 }, cost, a.tokens))}`}
        </p>
      ) : null}
    </div>
  );
};

// ---- Key figures --------------------------------------------------------------------------------

export const KeyFigures: FC<{ a: Analysis }> = ({ a }) => {
  const j = a.jupiter[0];
  if (j) {
    const side = j.exactOut ? 'in' : 'out';
    const decimals = (j.exactOut ? j.inputDecimals : j.outputDecimals) ?? 0;
    const sym = (j.exactOut ? j.inputMint : j.outputMint)
      ? symbolOf((j.exactOut ? j.inputMint : j.outputMint)!, a.tokens)
      : '';
    const quoted = j.exactOut ? j.quotedInAmount : j.quotedOutAmount;
    if (j.failed) {
      return (
        <FigStrip>
          <FigCell
            label="Short of limit"
            value={j.unbounded ? formatBps(Math.abs(j.unbounded.vsLimitBps)).replace(/^[+−]/, '') : '—'}
            tone="neg"
          />
          <FigCell label="Slippage" value={formatPct(j.slippageBps)} />
          <FigCell
            label={`Quoted ${side}`}
            value={quoted !== undefined ? formatAmount(quoted, decimals, { maxFraction: 2 }) : '—'}
            sub={sym}
          />
        </FigStrip>
      );
    }
    return (
      <FigStrip>
        <FigCell
          label="vs quote"
          value={formatBps(j.vsQuoteBps) || '—'}
          tone={bpsTone(j.vsQuoteBps)}
          sub={quoted !== undefined ? `quoted ${formatAmount(quoted, decimals, { maxFraction: 2 })}` : undefined}
        />
        <FigCell
          label={j.exactOut ? 'Room to max in' : 'Room to min out'}
          value={
            j.headroomUsd !== undefined
              ? formatUsd(j.headroomUsd)
              : j.headroom !== undefined
                ? formatAmount(j.headroom, decimals)
                : '—'
          }
          sub={`slippage ${formatPct(j.slippageBps)}`}
        />
        <FigCell
          label="vs market"
          value={formatBps(j.vsMarketBps) || '—'}
          tone={bpsTone(j.vsMarketBps)}
          sub="Jupiter price"
        />
      </FigStrip>
    );
  }

  const { compute } = a;
  const used = compute.consumed !== undefined ? Math.round((compute.consumed / compute.limit) * 100) : undefined;
  return (
    <FigStrip>
      {a.swap ? (
        <FigCell
          label="vs market"
          value={formatBps(a.swap.vsMarketBps) || '—'}
          tone={bpsTone(a.swap.vsMarketBps)}
          sub="Jupiter price"
        />
      ) : null}
      <FigCell
        label="Network fee"
        value={`${lamportsToSol((a.fees.total ?? a.fees.base + a.fees.priority) + a.fees.jitoTip)}`}
        sub="SOL"
      />
      <FigCell
        label="Compute"
        value={used !== undefined ? `${used}%` : '—'}
        sub={compute.consumed !== undefined ? `${compute.consumed.toLocaleString()} CU` : undefined}
      />
      <FigCell label="Size" value={`${a.size} B`} sub={`of ${a.maxSize}`} />
    </FigStrip>
  );
};

// ---- Attention ----------------------------------------------------------------------------------

const CheckRow: FC<{ check: Check }> = ({ check }) => (
  <div className="flex gap-3 py-2">
    <Dot tone={check.level === 'ok' ? 'pos' : check.level === 'error' ? 'neg' : check.level} className="mt-1.5" />
    <div className="min-w-0">
      <div className="text-sm font-medium">{check.title}</div>
      {check.detail ? <div className="break-words text-xs text-ink-2">{check.detail}</div> : null}
    </div>
  </div>
);

// Only what needs a look: warnings and errors other than the failure the hero already shows.
export const Attention: FC<{ a: Analysis }> = ({ a }) => {
  const items = a.checks.filter((c) => (c.level === 'warn' || c.level === 'error') && c.title !== 'Simulation failed');
  if (!items.length) return null;
  return (
    <div className="rounded-card border border-line px-4 py-2">
      <div className="flex items-center gap-2 pt-1 text-sm font-semibold text-warn">
        <AlertIcon size={15} /> Worth a look
      </div>
      {items.map((c, i) => (
        <CheckRow key={i} check={c} />
      ))}
    </div>
  );
};

// ---- Sections -----------------------------------------------------------------------------------

const Sparkline: FC<{ series: SeriesPoint[]; quoted?: bigint; limit?: bigint }> = ({ series, quoted, limit }) => {
  const points = series.filter((p) => p.amount !== undefined) as { t: number; amount: bigint }[];
  if (points.length < 2) return null;
  const values = [
    ...points.map((p) => Number(p.amount)),
    ...(quoted ? [Number(quoted)] : []),
    ...(limit ? [Number(limit)] : []),
  ];
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const w = 480;
  const h = 56;
  const y = (v: number) => h - 6 - ((v - min) / span) * (h - 12);
  const x = (i: number) => (i / (points.length - 1)) * w;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(p.amount)).toFixed(1)}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" preserveAspectRatio="none">
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
        <path d={path} fill="none" stroke="var(--pos)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex gap-4 text-[11px] text-ink-3">
        <span>— simulated, every 5 s</span>
        <span>- - quote</span>
        <span className="text-neg">· · limit</span>
      </div>
    </div>
  );
};

const SubHead: FC<{ children: ReactNode }> = ({ children }) => <div className="caps mb-2 mt-5">{children}</div>;

export const SwapSection: FC<{
  a: Analysis;
  swap: JupiterSwap;
  series: SeriesPoint[];
  quote?: QuoteState;
  onRequote: () => void;
}> = ({ a, swap, series, quote, onRequote }) => {
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

  const fresh = quote?.quote;
  const freshAmount = fresh ? (swap.exactOut ? fresh.inAmount : fresh.outAmount) : undefined;
  const freshVsTx =
    freshAmount !== undefined && simulated
      ? (((swap.exactOut ? -1 : 1) * Number(freshAmount - simulated)) / Number(simulated)) * 10_000
      : undefined;
  const venues = [...new Set(swap.hops.map((h) => h.label))];

  return (
    <Section
      title="Jupiter swap"
      summary={venues.length ? venues.slice(0, 3).join(', ') + (venues.length > 3 ? '…' : '') : swap.instruction}
    >
      <div className="grid grid-cols-3 gap-x-4 gap-y-4">
        <Stat label={`Quoted ${side}`} value={fmt(quoted, side)} />
        <Stat
          label={`Simulated ${side}`}
          value={swap.failed ? <span className="text-neg">Reverts</span> : fmt(simulated, side)}
          sub={
            swap.vsQuoteBps !== undefined ? (
              <span className={toneOf(swap.vsQuoteBps)}>{formatBps(swap.vsQuoteBps)}</span>
            ) : undefined
          }
        />
        <Stat
          label={`${swap.exactOut ? 'Max in' : 'Min out'} · ${formatPct(swap.slippageBps)}`}
          value={fmt(limit, side)}
        />
        <Stat
          label="Value in → out"
          value={`${formatUsd(swap.inUsd) || '—'} → ${formatUsd(swap.outUsd) || '—'}`}
          className="col-span-2"
        />
        <Stat
          label="Fees"
          value={`Platform ${formatPct(swap.platformFeeBps)}`}
          sub={
            swap.positiveSlippageBps !== undefined
              ? `Positive slippage cap ${formatPct(swap.positiveSlippageBps)}`
              : undefined
          }
        />
      </div>

      <div className="mt-5 flex items-center gap-3 rounded-card bg-tint px-4 py-3">
        <div className="min-w-0 flex-1">
          {fresh ? (
            <>
              <div className="text-sm font-semibold">
                Fresh quote {fmt(freshAmount, side)}{' '}
                {freshVsTx !== undefined ? <span className={toneOf(freshVsTx)}>{formatBps(freshVsTx)}</span> : null}
              </div>
              <div className="truncate text-xs text-ink-2">
                {fresh.route.join(' · ')} · impact {(fresh.priceImpactPct * 100).toFixed(3)}%
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-semibold">Is this still the best route?</div>
              <div className="text-xs text-ink-2">
                {quote?.error ? `Quote failed: ${quote.error}` : 'Ask Jupiter for the same trade now.'}
              </div>
            </>
          )}
        </div>
        <Button
          kind="outline"
          size="sm"
          onClick={onRequote}
          disabled={quote?.loading || !swap.inputMint || !swap.outputMint}
        >
          <RefreshIcon size={13} className={quote?.loading ? 'animate-spin' : ''} />
          {fresh ? 'Re-quote' : 'Quote'}
        </Button>
      </div>

      {series.filter((p) => p.amount !== undefined).length > 1 ? (
        <>
          <SubHead>Simulated {side} over time</SubHead>
          <Sparkline series={series} quoted={quoted} limit={limit} />
        </>
      ) : null}

      {swap.route.length ? (
        <>
          <SubHead>Route plan</SubHead>
          <div className="space-y-2">
            {swap.route.map((step, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <span className="w-32 shrink-0 truncate">{step.label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-tint">
                  <div className="h-full rounded-full bg-ink" style={{ width: `${Math.min(100, step.pct)}%` }} />
                </div>
                <span className="w-10 shrink-0 text-right text-ink-2">{step.pct}%</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {swap.hops.length ? (
        <>
          <SubHead>Simulated hops</SubHead>
          <div className="divide-y divide-line">
            {swap.hops.map((hop, i) => {
              const inDec = a.tokens[hop.inputMint]?.decimals ?? (hop.inputMint === WSOL_MINT ? 9 : undefined);
              const outDec = a.tokens[hop.outputMint]?.decimals ?? (hop.outputMint === WSOL_MINT ? 9 : undefined);
              const amt = (v: bigint, d?: number) =>
                d !== undefined ? formatAmount(v, d, { maxFraction: 2 }) : v.toString();
              return (
                <div key={i} className="flex items-center gap-3 py-2 text-sm">
                  <span className="w-28 shrink-0 truncate font-medium" title={hop.program ?? hop.amm}>
                    {hop.label}
                  </span>
                  <span className="truncate text-ink-2">
                    {amt(hop.inputAmount, inDec)} {symbolOf(hop.inputMint, a.tokens)} → {amt(hop.outputAmount, outDec)}{' '}
                    {symbolOf(hop.outputMint, a.tokens)}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </Section>
  );
};

export const FeesSection: FC<{ a: Analysis }> = ({ a }) => {
  const { compute, fees, rent } = a;
  const used = compute.consumed !== undefined ? Math.min(1, compute.consumed / compute.limit) : 0;
  const rentPaid = rent.created.reduce((s, c) => s + c.lamports, 0n);
  const rentBack = rent.closed.reduce((s, c) => s + c.lamports, 0n);
  const total = (fees.total ?? fees.base + fees.priority) + fees.jitoTip;
  return (
    <Section title="Fees & compute" summary={`${lamportsToSol(total)} SOL`}>
      <div className="grid grid-cols-3 gap-x-4 gap-y-4">
        <Stat label="Base fee" value={`${lamportsToSol(fees.base)} SOL`} />
        <Stat
          label="Priority fee"
          value={`${lamportsToSol(fees.priority)} SOL`}
          sub={`${Number(compute.microLamportsPerCu).toLocaleString()} µL/CU`}
        />
        <Stat label="Jito tip" value={fees.jitoTip ? `${lamportsToSol(fees.jitoTip)} SOL` : 'None'} />
      </div>
      {a.priorityFees ? (
        <p className="mt-3 text-xs text-ink-2">
          Recent priority fees on these accounts: p50 {a.priorityFees.p50.toLocaleString()} · p75{' '}
          {a.priorityFees.p75.toLocaleString()} · p90 {a.priorityFees.p90.toLocaleString()} µL/CU
        </p>
      ) : null}
      <div className="mt-5">
        <div className="flex justify-between text-xs text-ink-2">
          <span>Compute{compute.explicitLimit ? '' : ' · default limit'}</span>
          <span>
            {compute.consumed?.toLocaleString() ?? '—'} / {compute.limit.toLocaleString()} CU
          </span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-tint">
          <div
            className={clsx('h-full rounded-full', used > 0.95 ? 'bg-warn' : 'bg-ink')}
            style={{ width: `${used * 100}%` }}
          />
        </div>
      </div>
      {rentPaid || rentBack ? (
        <p className="mt-4 text-sm">
          {rentPaid
            ? `${lamportsToSol(rentPaid)} SOL locked as rent in ${rent.created.length} new account${rent.created.length > 1 ? 's' : ''}`
            : ''}
          {rentPaid && rentBack ? ' · ' : ''}
          {rentBack
            ? `${lamportsToSol(rentBack)} SOL rent back from ${rent.closed.length} closed account${rent.closed.length > 1 ? 's' : ''}`
            : ''}
        </p>
      ) : null}
    </Section>
  );
};

export const ChecksSection: FC<{ a: Analysis }> = ({ a }) => {
  const passed = a.checks.filter((c) => c.level === 'ok').length;
  const flagged = a.checks.length - passed;
  return (
    <Section
      title="Checks"
      summary={
        <span className="inline-flex items-center gap-1.5">
          {passed} passed
          {flagged ? <Pill tone={a.checks.some((c) => c.level === 'error') ? 'neg' : 'warn'}>{flagged}</Pill> : null}
        </span>
      }
    >
      <div className="divide-y divide-line">
        {a.checks.map((c, i) => (
          <CheckRow key={i} check={c} />
        ))}
      </div>
    </Section>
  );
};

export const OthersSection: FC<{ a: Analysis; renderAddress: (address: string) => ReactNode }> = ({
  a,
  renderAddress,
}) => {
  if (!a.others.length) return null;
  return (
    <Section title="Other accounts" summary={`${a.others.length} touched`}>
      <p className="mb-2 text-xs text-ink-2">Pools, vaults and other owners whose balances change.</p>
      <div className="divide-y divide-line">
        {a.others.map((o) => (
          <div key={o.owner} className="py-2.5">
            <div className="text-sm font-medium">{renderAddress(o.owner)}</div>
            {o.assets.map((asset) => (
              <div key={asset.mint} className="flex justify-between text-sm">
                <span className="text-ink-2">{symbolOf(asset.mint, a.tokens)}</span>
                <span className={toneOf(asset.delta)}>
                  {formatAmount(asset.delta, asset.decimals, { signed: true })}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
};
