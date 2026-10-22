import clsx from 'clsx';
import React, { FC, ReactNode, useState } from 'react';
import { Analysis, AssetDelta, Check, SOL, usdValue } from '../../sim/analyze';
import type { FreshQuote } from '../../sim/jupApi';
import type { JupiterSwap } from '../../sim/jupiter';
import { WSOL_MINT } from '../../sim/programs';
import { ChevronDown, RefreshIcon } from '../kit/icons';
import { Button, Collapse, TokenIcon, Tone, toneText } from '../kit/kit';
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

const Panel: FC<{ title?: ReactNode; right?: ReactNode; className?: string; children: ReactNode }> = ({
  title,
  right,
  className,
  children,
}) => (
  <section className={clsx('rounded-xl border border-line bg-raised px-3.5 py-3', className)}>
    {title || right ? (
      <div className="mb-2 flex h-7 items-center gap-2">
        <h2 className="caps truncate">{title}</h2>
        <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>
      </div>
    ) : null}
    {children}
  </section>
);

const KV: FC<{
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}> = ({ label, value, sub, tone, className, title }) => (
  <div className={clsx('min-w-0', className)} title={title}>
    <div className="truncate text-[11px] text-ink-3">{label}</div>
    <div className={clsx('truncate text-[14px] font-semibold leading-snug', tone && toneText[tone])}>{value}</div>
    {sub ? <div className="truncate text-[11px] text-ink-2">{sub}</div> : null}
  </div>
);

const Bar: FC<{ label: ReactNode; value: number; max: number; text: ReactNode }> = ({ label, value, max, text }) => {
  const ratio = max ? Math.min(1, value / max) : 0;
  return (
    <div>
      <div className="flex justify-between gap-2 text-[11px]">
        <span className="text-ink-3">{label}</span>
        <span className="truncate text-ink-2">{text}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-tint">
        <div
          className={clsx('h-full rounded-full', ratio > 0.9 ? 'bg-warn' : 'bg-accent')}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
};

// ---- Trade --------------------------------------------------------------------------------------------

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

const AssetLine: FC<{ asset: AssetDelta; a: Analysis; note?: string }> = ({ asset, a, note }) => {
  const usd = usdValue(asset, asset.delta, a.tokens);
  const name = asset.mint === SOL ? 'Solana' : asset.mint === WSOL_MINT ? 'Wrapped SOL' : a.tokens[asset.mint]?.name;
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <TokenIcon src={iconOf(asset.mint, a.tokens)} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold leading-tight">{symbolOf(asset.mint, a.tokens)}</div>
        <div className="truncate text-[11px] text-ink-3">{note ?? name ?? ''}</div>
      </div>
      <div className="text-right">
        <div className={clsx('text-[15px] font-semibold leading-tight', toneOf(asset.delta))}>
          {formatAmount(asset.delta, asset.decimals, { signed: true, maxFraction: asset.decimals > 6 ? 6 : 4 })}
        </div>
        <div className={clsx('text-[11px]', toneOf(usd))}>{formatUsd(usd, { signed: true })}</div>
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

export const TradePanel: FC<{ a: Analysis }> = ({ a }) => {
  const { changes, notes, cost } = displayChanges(a);
  const sends = changes.filter((c) => c.delta < 0n);
  const receives = changes.filter((c) => c.delta > 0n);
  const title = a.err
    ? 'Fails'
    : a.jupiter.length || a.swap
      ? 'Swap'
      : changes.length
        ? 'Balance changes'
        : 'No balance changes';
  const p = prices(a);
  return (
    <Panel title={title} className="flex flex-col">
      {changes.length ? (
        <div className="divide-y divide-line">
          {[...sends, ...receives].map((asset) => (
            <AssetLine key={asset.mint} asset={asset} a={a} note={notes[asset.mint]} />
          ))}
        </div>
      ) : (
        <p className="py-2 text-sm text-ink-2">
          {a.err ? 'Nothing moves: the transaction reverts.' : 'Nothing moves in or out of this address.'}
        </p>
      )}
      <div className="mt-auto space-y-0.5 pt-2 text-[11px] text-ink-2">
        {p ? (
          <div className="truncate">
            {p.unit} = {p.effective}
            {p.market ? <span className="text-ink-3"> · market {p.market}</span> : null}
          </div>
        ) : null}
        {cost > 0n ? (
          <div className="truncate">
            Network fee <span className="text-neg">−{lamportsToSol(cost)} SOL</span>{' '}
            {solUsd(a, cost) && `· ${solUsd(a, cost)}`}
          </div>
        ) : null}
      </div>
    </Panel>
  );
};

// ---- Execution ------------------------------------------------------------------------------------

export const ExecutionPanel: FC<{ a: Analysis; quote?: QuoteState; onRequote: () => void }> = ({
  a,
  quote,
  onRequote,
}) => {
  const j = a.jupiter[0];
  const otherSigners = a.signers.filter((s) => s !== a.user);
  const via = a.programs.map((id) => a.labels[id] ?? shortAddress(id));

  if (j) {
    const decimals = (j.exactOut ? j.inputDecimals : j.outputDecimals) ?? 0;
    const sym = symbolOf((j.exactOut ? j.inputMint : j.outputMint) ?? '', a.tokens);
    const simulated = j.exactOut ? j.inAmount : j.outAmount;
    const fresh = quote?.quote;
    const freshAmount = fresh ? (j.exactOut ? fresh.inAmount : fresh.outAmount) : undefined;
    const freshVsTx =
      freshAmount !== undefined && simulated
        ? (((j.exactOut ? -1 : 1) * Number(freshAmount - simulated)) / Number(simulated)) * 10_000
        : undefined;
    return (
      <Panel
        title="Execution"
        right={
          <Button
            kind="outline"
            size="sm"
            className="h-7 px-2.5"
            onClick={onRequote}
            disabled={quote?.loading || !j.inputMint || !j.outputMint}
          >
            <RefreshIcon size={12} className={quote?.loading ? 'animate-spin' : ''} />
            {fresh ? 'Re-quote' : 'Fresh quote'}
          </Button>
        }
      >
        <div className="grid grid-cols-3 gap-x-4 gap-y-2">
          {j.failed ? (
            <KV
              label="Short of limit"
              value={j.unbounded ? `−${formatBps(Math.abs(j.unbounded.vsLimitBps)).replace(/^[+−]/, '')}` : '—'}
              tone="neg"
              sub={j.unbounded ? `fills ${formatBps(j.unbounded.vsQuoteBps)} vs quote` : 'route reverts'}
            />
          ) : (
            <KV label="vs quote" value={formatBps(j.vsQuoteBps) || '—'} tone={bpsTone(j.vsQuoteBps)} sub="simulated" />
          )}
          <KV
            label="vs market"
            value={formatBps(j.vsMarketBps) || '—'}
            tone={bpsTone(j.vsMarketBps)}
            sub={j.outUsd !== undefined ? `${formatUsd(j.outUsd)} out` : 'no price'}
          />
          <KV
            label={j.exactOut ? 'Room to max in' : 'Room to min out'}
            value={
              j.headroomUsd !== undefined
                ? formatUsd(j.headroomUsd)
                : j.headroom !== undefined
                  ? formatAmount(j.headroom, decimals)
                  : '—'
            }
            sub={j.headroom !== undefined ? `${formatAmount(j.headroom, decimals)} ${sym}` : undefined}
            title="How much worse the fill can get before the swap reverts; also what a sandwich could take."
          />
          <KV
            className="col-span-3"
            label="Fresh quote now"
            value={
              fresh ? (
                <>
                  {formatAmount(freshAmount!, decimals)} {sym}{' '}
                  {freshVsTx !== undefined ? (
                    <span className={toneOf(Math.abs(freshVsTx) < 0.05 ? 0 : freshVsTx)}>
                      {formatBps(freshVsTx)} vs this tx
                    </span>
                  ) : null}
                </>
              ) : quote?.error ? (
                <span className="text-neg">failed</span>
              ) : (
                <span className="font-normal text-ink-3">not asked yet</span>
              )
            }
            sub={
              fresh ? `${fresh.route.join(' · ')} · impact ${(fresh.priceImpactPct * 100).toFixed(3)}%` : quote?.error
            }
          />
        </div>
      </Panel>
    );
  }

  const { compute } = a;
  const p = prices(a);
  const fee = (a.fees.total ?? a.fees.base + a.fees.priority) + a.fees.jitoTip;
  return (
    <Panel title={a.swap ? 'Execution' : 'Transaction'}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {a.swap ? (
          <>
            <KV
              label="vs market"
              value={formatBps(a.swap.vsMarketBps) || '—'}
              tone={bpsTone(a.swap.vsMarketBps)}
              sub={
                a.swap.soldUsd !== undefined
                  ? `${formatUsd(a.swap.soldUsd)} → ${formatUsd(a.swap.boughtUsd) || '—'}`
                  : 'no price'
              }
            />
            <KV
              label={`Price · ${p?.unit ?? ''}`}
              value={p?.effective ?? '—'}
              sub={p?.market ? `market ${p.market}` : undefined}
            />
          </>
        ) : (
          <>
            <KV label="Network fee" value={`${lamportsToSol(fee)} SOL`} sub={solUsd(a, fee)} />
            <KV
              label="Compute"
              value={compute.consumed !== undefined ? `${compute.consumed.toLocaleString()} CU` : '—'}
              sub={`limit ${compute.limit.toLocaleString()}`}
            />
          </>
        )}
        <KV className="col-span-2" label="Route via" value={via.length ? via.join(' · ') : 'Built-in programs only'} />
        {otherSigners.length ? (
          <KV
            className="col-span-2"
            label={a.swap ? 'Filled by (co-signer)' : 'Also signed by'}
            value={otherSigners.map((s) => a.labels[s] ?? shortAddress(s, 6)).join(', ')}
            sub={a.swap ? 'An RFQ fill: the market maker signs too' : undefined}
          />
        ) : null}
      </div>
    </Panel>
  );
};

// ---- Jupiter route -------------------------------------------------------------------------------

const Sparkline: FC<{ series: SeriesPoint[]; quoted?: bigint; limit?: bigint }> = ({ series, quoted, limit }) => {
  const points = series.filter((p) => p.amount !== undefined) as { t: number; amount: bigint }[];
  if (points.length < 2) {
    return <div className="flex h-10 items-center text-[11px] text-ink-3">Fills in as it re-simulates…</div>;
  }
  const values = [
    ...points.map((p) => Number(p.amount)),
    ...(quoted ? [Number(quoted)] : []),
    ...(limit ? [Number(limit)] : []),
  ];
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const w = 480;
  const h = 40;
  const y = (v: number) => h - 4 - ((v - min) / span) * (h - 8);
  const x = (i: number) => (i / (points.length - 1)) * w;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(p.amount)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full" preserveAspectRatio="none">
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

export const RoutePanel: FC<{ a: Analysis; swap: JupiterSwap; series: SeriesPoint[] }> = ({ a, swap, series }) => {
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

  return (
    <Panel
      title={`Jupiter route · ${swap.instruction}${swap.exactOut ? ' · exact out' : ''}`}
      right={
        <span className="text-[11px] text-ink-3">
          {swap.route.length} steps · {swap.hops.length} hops
        </span>
      }
    >
      <div className="grid grid-cols-[1fr_1fr_1fr_190px] gap-x-4">
        <KV label={`Quoted ${side}`} value={fmt(quoted, side)} />
        <KV
          label={`Simulated ${side}`}
          value={swap.failed ? <span className="text-neg">reverts</span> : fmt(simulated, side)}
          sub={
            swap.vsQuoteBps !== undefined ? (
              <span className={toneText[bpsTone(swap.vsQuoteBps) ?? 'muted']}>
                {formatBps(swap.vsQuoteBps)} vs quote
              </span>
            ) : undefined
          }
        />
        <KV
          label={`${swap.exactOut ? 'Max in' : 'Min out'} (${formatPct(swap.slippageBps)} slippage)`}
          value={fmt(limit, side)}
          sub={`platform fee ${formatPct(swap.platformFeeBps)}${
            swap.positiveSlippageBps !== undefined ? ` · pos. cap ${formatPct(swap.positiveSlippageBps)}` : ''
          }`}
        />
        <div className="min-w-0">
          <div className="text-[11px] text-ink-3">Simulated {side} · live</div>
          <Sparkline series={series} quoted={quoted} limit={limit} />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] text-ink-3">Route</span>
        {swap.route.map((step, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 rounded-full bg-tint px-2 py-0.5 text-[12px]">
            <span className="font-medium">{step.label}</span>
            <span className="text-ink-3">{Number(step.pct.toFixed(1))}%</span>
          </span>
        ))}
        {swap.hops.length ? (
          <button
            type="button"
            onClick={() => setShowHops(!showHops)}
            className="ml-auto inline-flex items-center gap-1 text-[12px] font-medium text-ink-2 hover:text-ink"
          >
            {swap.hops.length} hops
            <ChevronDown size={13} className={clsx('transition-transform', showHops && 'rotate-180')} />
          </button>
        ) : null}
      </div>

      {swap.hops.length ? (
        <>
          <Collapse open={showHops}>
            <div className="mt-1.5 grid grid-cols-2 gap-x-6">
              {swap.hops.map((hop, i) => {
                const inDec = a.tokens[hop.inputMint]?.decimals ?? (hop.inputMint === WSOL_MINT ? 9 : undefined);
                const outDec = a.tokens[hop.outputMint]?.decimals ?? (hop.outputMint === WSOL_MINT ? 9 : undefined);
                const amt = (v: bigint, d?: number) =>
                  d !== undefined ? formatAmount(v, d, { maxFraction: 2 }) : v.toString();
                return (
                  <div key={i} className="flex items-center gap-2 border-b border-line py-1 text-[12px]">
                    <span className="w-24 shrink-0 truncate font-medium" title={hop.program ?? hop.amm}>
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
    </Panel>
  );
};

// ---- Fees & resources -------------------------------------------------------------------------------

function priorityRank(a: Analysis) {
  const pf = a.priorityFees;
  if (!pf || !pf.samples) return undefined;
  const p = Number(a.compute.microLamportsPerCu);
  return p >= pf.p90 ? '≥ p90' : p >= pf.p75 ? 'p75–p90' : p >= pf.p50 ? 'p50–p75' : p >= pf.p25 ? 'p25–p50' : '< p25';
}

export const FeesPanel: FC<{ a: Analysis }> = ({ a }) => {
  const { fees, rent, compute } = a;
  const total = (fees.total ?? fees.base + fees.priority) + fees.jitoTip;
  const rentPaid = rent.created.reduce((s, c) => s + c.lamports, 0n);
  const rentBack = rent.closed.reduce((s, c) => s + c.lamports, 0n);
  const rentNet = rentBack - rentPaid;
  return (
    <Panel title="Fees" right={<span className="text-[11px] text-ink-2">{solUsd(a, total)}</span>}>
      <div className="grid grid-cols-3 gap-x-4 gap-y-2">
        <KV label="Total (SOL)" value={lamportsToSol(total)} />
        <KV
          label="Base"
          value={lamportsToSol(fees.base)}
          sub={`${a.signers.length} signature${a.signers.length > 1 ? 's' : ''}`}
        />
        <KV
          label="Priority"
          value={lamportsToSol(fees.priority)}
          sub={`${Number(compute.microLamportsPerCu).toLocaleString()} µL/CU`}
        />
        <KV label="Jito tip" value={fees.jitoTip ? lamportsToSol(fees.jitoTip) : '—'} />
        <KV
          label="Priority rank"
          value={priorityRank(a) ?? '—'}
          sub={a.priorityFees ? `p50 ${a.priorityFees.p50.toLocaleString()} µL` : undefined}
        />
        <KV
          label="Rent (SOL)"
          value={rentNet ? formatAmount(rentNet, 9, { signed: true, maxFraction: 6 }) : '—'}
          tone={rentNet > 0n ? 'pos' : rentNet < 0n ? 'neg' : undefined}
          sub={rentPaid || rentBack ? `${rent.created.length} opened · ${rent.closed.length} closed` : undefined}
        />
      </div>
    </Panel>
  );
};

export const ResourcesPanel: FC<{ a: Analysis }> = ({ a }) => {
  const { compute } = a;
  const mib = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MiB`;
  return (
    <Panel title="Resources">
      <div className="space-y-2.5">
        <Bar
          label={`Compute${compute.explicitLimit ? '' : ' (default limit)'}`}
          value={compute.consumed ?? 0}
          max={compute.limit}
          text={`${compute.consumed?.toLocaleString() ?? '—'} / ${compute.limit.toLocaleString()} CU`}
        />
        <Bar
          label={`Size · ${a.version === 'legacy' ? 'legacy' : `v${String(a.version)}`}`}
          value={a.size}
          max={a.maxSize}
          text={`${a.size} / ${a.maxSize} B`}
        />
        {a.loadedAccountsDataSize !== undefined ? (
          <Bar
            label="Loaded account data"
            value={a.loadedAccountsDataSize}
            max={a.loadedAccountsDataLimit}
            text={`${mib(a.loadedAccountsDataSize)} / ${mib(a.loadedAccountsDataLimit)}`}
          />
        ) : null}
        <div className="flex justify-between text-[11px]">
          <span className="text-ink-3">Accounts</span>
          <span className="text-ink-2">
            {a.accountKeys.length} total · {a.accountKeys.filter((k) => k.writable).length} writable ·{' '}
            {a.instructions.length} instructions
          </span>
        </div>
      </div>
    </Panel>
  );
};

// ---- Checks & errors -------------------------------------------------------------------------------

const checkTone: Record<Check['level'], string> = {
  ok: 'bg-tint text-ink-2',
  info: 'bg-info-soft text-info',
  warn: 'bg-warn-soft text-warn',
  error: 'bg-neg-soft text-neg',
};

const CheckPill: FC<{ check: Check }> = ({ check }) => (
  <span
    title={check.detail}
    className={clsx(
      'inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-2.5 py-1 text-[12px] font-medium',
      checkTone[check.level]
    )}
  >
    <span
      className={clsx(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        { ok: 'bg-pos', info: 'bg-info', warn: 'bg-warn', error: 'bg-neg' }[check.level]
      )}
    />
    <span className="truncate">{check.title}</span>
  </span>
);

// Passed checks fold into one pill (their figures are in the panels above); anything that needs a
// look gets its own. Other touched accounts open below the strip.
export const ChecksStrip: FC<{ a: Analysis; renderAddress: (address: string) => ReactNode }> = ({
  a,
  renderAddress,
}) => {
  const [showOthers, setShowOthers] = useState(false);
  const passed = a.checks.filter((c) => c.level === 'ok');
  const flagged = a.checks.filter((c) => c.level !== 'ok');
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {passed.length ? (
          <CheckPill
            check={{
              level: 'ok',
              title: `${passed.length} checks passed`,
              detail: passed.map((c) => c.title).join('\n'),
            }}
          />
        ) : null}
        {flagged.map((c, i) => (
          <CheckPill key={i} check={c} />
        ))}
        {a.others.length ? (
          <button
            type="button"
            onClick={() => setShowOthers(!showOthers)}
            className="ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink"
          >
            {a.others.length} other accounts touched
            <ChevronDown size={13} className={clsx('transition-transform', showOthers && 'rotate-180')} />
          </button>
        ) : null}
      </div>
      {a.others.length ? (
        <Collapse open={showOthers}>
          <div className="mt-2 grid grid-cols-2 gap-x-6 rounded-xl border border-line bg-raised px-3.5 py-1">
            {a.others.map((o) => (
              <div key={o.owner} className="border-b border-line py-2 last:border-0">
                <div className="text-[13px] font-medium">{renderAddress(o.owner)}</div>
                {o.assets.map((asset) => (
                  <div key={asset.mint} className="flex justify-between text-[12px]">
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
    </div>
  );
};

export const ErrorBanner: FC<{ a: Analysis }> = ({ a }) => {
  if (!a.error) return null;
  const swap = a.jupiter[0];
  return (
    <div className="rounded-xl bg-neg-soft px-3.5 py-2.5">
      <div className="text-[14px] font-semibold text-neg">{a.error.name ?? 'Simulation failed'}</div>
      <div className="break-words text-[12px] text-ink-2">{a.error.text}</div>
      {swap?.unbounded ? (
        <div className="mt-1 text-[12px]">
          Without the limit the route fills {formatBps(swap.unbounded.vsQuoteBps)} vs quote —{' '}
          <b className="text-neg">{formatBps(Math.abs(swap.unbounded.vsLimitBps)).replace(/^[+−]/, '')}</b> past your{' '}
          {swap.exactOut ? 'maximum input' : 'minimum output'}.
        </div>
      ) : null}
    </div>
  );
};
