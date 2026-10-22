import clsx from 'clsx';
import React, { FC } from 'react';
import { Analysis, AssetDelta, SOL, usdValue } from '../../sim/analyze';
import type { FreshQuote } from '../../sim/jupApi';
import type { JupiterSwap } from '../../sim/jupiter';
import { WSOL_MINT } from '../../sim/programs';
import { formatAmount, formatBps, formatPct, formatUsd, iconOf, lamportsToSol, symbolOf, toneOf } from './format';
import { Address, Badge, Button, Card, LevelDot, Stat, TokenIcon } from './ui';

export type QuoteState = { loading: boolean; quote?: FreshQuote; error?: string };
export type SeriesPoint = { t: number; amount?: bigint; failed: boolean };

const AssetRow: FC<{ asset: AssetDelta; a: Analysis; note?: string }> = ({ asset, a, note }) => {
  const usd = usdValue(asset, asset.delta, a.tokens);
  return (
    <div className="flex items-center gap-3 py-1.5">
      <TokenIcon src={iconOf(asset.mint, a.tokens)} />
      <div className="min-w-0 flex-1">
        <div className="text-sm">{symbolOf(asset.mint, a.tokens)}</div>
        {note ? <div className="text-xs text-slate-500">{note}</div> : null}
      </div>
      <div className="text-right">
        <div className={clsx('font-mono text-sm tabular-nums', toneOf(asset.delta))}>
          {formatAmount(asset.delta, asset.decimals, { signed: true, maxFraction: asset.decimals > 6 ? 6 : 4 })}
        </div>
        <div className="text-xs text-slate-500">{formatUsd(usd, { signed: true })}</div>
      </div>
    </div>
  );
};

export const BalanceChanges: FC<{ a: Analysis }> = ({ a }) => {
  const paysFees = a.user === a.feePayer;
  return (
    <Card title={`Balance changes · ${a.labels[a.user] ?? 'you'}`}>
      {a.userChanges.length ? (
        <div className="divide-y divide-white/5">
          {a.userChanges.map((asset) => (
            <AssetRow
              key={asset.mint}
              asset={asset}
              a={a}
              note={
                asset.mint === SOL && paysFees && a.fees.total
                  ? `incl. ${lamportsToSol(a.fees.total + a.fees.jitoTip)} SOL fees & tips`
                  : undefined
              }
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-400">
          {a.err ? 'Nothing changes: the transaction fails.' : 'No balance changes for this address.'}
        </p>
      )}
      {a.swap && !a.jupiter.length ? (
        <div className="mt-3 flex items-center justify-between rounded-md bg-white/5 px-3 py-2 text-xs">
          <span className="text-slate-400">Execution vs Jupiter market price</span>
          <span className={clsx('font-mono', toneOf(a.swap.vsMarketBps))}>
            {formatBps(a.swap.vsMarketBps) || 'no price'}
          </span>
        </div>
      ) : null}
    </Card>
  );
};

const Sparkline: FC<{ series: SeriesPoint[]; quoted?: bigint; limit?: bigint }> = ({ series, quoted, limit }) => {
  const points = series.filter((p) => p.amount !== undefined) as { t: number; amount: bigint }[];
  if (points.length < 2) return null;
  const values = [
    ...points.map((p) => Number(p.amount)),
    ...(quoted ? [Number(quoted)] : []),
    ...(limit ? [Number(limit)] : []),
  ];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 480;
  const h = 44;
  const y = (v: number) => h - 4 - ((v - min) / span) * (h - 8);
  const x = (i: number) => (i / (points.length - 1)) * w;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(p.amount)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 h-11 w-full" preserveAspectRatio="none">
      {quoted ? (
        <line
          x1={0}
          x2={w}
          y1={y(Number(quoted))}
          y2={y(Number(quoted))}
          stroke="rgb(148 163 184 / .5)"
          strokeDasharray="4 4"
        />
      ) : null}
      {limit ? (
        <line
          x1={0}
          x2={w}
          y1={y(Number(limit))}
          y2={y(Number(limit))}
          stroke="rgb(244 63 94 / .6)"
          strokeDasharray="2 4"
        />
      ) : null}
      <path d={path} fill="none" stroke="rgb(52 211 153)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
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
  const inSym = swap.inputMint ? symbolOf(swap.inputMint, a.tokens) : '?';
  const outSym = swap.outputMint ? symbolOf(swap.outputMint, a.tokens) : '?';
  const fmtIn = (v?: bigint) => (v === undefined ? '—' : `${formatAmount(v, swap.inputDecimals ?? 0)} ${inSym}`);
  const fmtOut = (v?: bigint) => (v === undefined ? '—' : `${formatAmount(v, swap.outputDecimals ?? 0)} ${outSym}`);
  const quoted = swap.exactOut ? swap.quotedInAmount : swap.quotedOutAmount;
  const limit = swap.exactOut ? swap.maxInAmount : swap.minOutAmount;
  const fmtSide = swap.exactOut ? fmtIn : fmtOut;
  const simulated = swap.exactOut ? swap.inAmount : swap.outAmount;

  // A fresh quote for the same trade, compared with what this transaction fills at.
  const fresh = quote?.quote;
  const freshAmount = fresh ? (swap.exactOut ? fresh.inAmount : fresh.outAmount) : undefined;
  const freshVsTx =
    freshAmount !== undefined && simulated
      ? (((swap.exactOut ? -1 : 1) * Number(freshAmount - simulated)) / Number(simulated)) * 10_000
      : undefined;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Jupiter <Badge>{swap.instruction}</Badge>
          {swap.exactOut ? <Badge tone="info">exact out</Badge> : null}
        </span>
      }
      right={
        <Button onClick={onRequote} disabled={quote?.loading || !swap.inputMint || !swap.outputMint}>
          {quote?.loading ? 'Quoting…' : fresh ? 'Re-quote' : 'Fresh quote'}
        </Button>
      }
    >
      <div className="mb-4 flex items-center gap-2 text-base">
        <TokenIcon src={swap.inputMint && iconOf(swap.inputMint, a.tokens)} />
        <span className="font-mono tabular-nums">{fmtIn(swap.inAmount)}</span>
        <span className="text-slate-500">→</span>
        <TokenIcon src={swap.outputMint && iconOf(swap.outputMint, a.tokens)} />
        <span className="font-mono tabular-nums">{fmtOut(swap.outAmount)}</span>
      </div>

      <div className="grid grid-cols-3 gap-x-4 gap-y-3">
        <Stat label={swap.exactOut ? 'Quoted in' : 'Quoted out'} value={fmtSide(quoted)} />
        <Stat
          label={swap.exactOut ? 'Simulated in' : 'Simulated out'}
          value={swap.failed ? <span className="text-rose-400">reverted</span> : fmtSide(simulated)}
          sub={<span className={toneOf(swap.vsQuoteBps)}>{formatBps(swap.vsQuoteBps)} vs quote</span>}
        />
        <Stat
          label={`${swap.exactOut ? 'Max in' : 'Min out'} · ${formatPct(swap.slippageBps)}`}
          value={fmtSide(limit)}
          sub={
            swap.headroom !== undefined ? (
              <span title="How much worse the fill can get before the swap reverts; also the most a sandwich can take.">
                room {formatAmount(swap.headroom, (swap.exactOut ? swap.inputDecimals : swap.outputDecimals) ?? 0)}{' '}
                {swap.headroomUsd !== undefined ? `· ${formatUsd(swap.headroomUsd)}` : ''}
              </span>
            ) : undefined
          }
        />
        <Stat
          label="Value in → out"
          value={`${formatUsd(swap.inUsd) || '—'} → ${formatUsd(swap.outUsd) || '—'}`}
          sub={
            swap.vsMarketBps !== undefined ? (
              <span className={toneOf(swap.vsMarketBps)}>{formatBps(swap.vsMarketBps)} vs market</span>
            ) : (
              'no price'
            )
          }
          className="col-span-2"
        />
        <Stat
          label="Fees"
          value={`platform ${formatPct(swap.platformFeeBps)}`}
          sub={
            swap.positiveSlippageBps !== undefined
              ? `positive slippage cap ${formatPct(swap.positiveSlippageBps)}`
              : undefined
          }
        />
      </div>

      {swap.unbounded ? (
        <div className="mt-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          Without the slippage limit this route fills {fmtSide(swap.unbounded.amount)} (
          {formatBps(swap.unbounded.vsQuoteBps)} vs quote), which is{' '}
          <b>{formatBps(Math.abs(swap.unbounded.vsLimitBps)).replace(/^[+−]/, '')}</b> past the{' '}
          {swap.exactOut ? 'maximum input' : 'minimum output'}.
        </div>
      ) : null}

      {quote?.error ? <p className="mt-3 text-xs text-rose-300">Quote failed: {quote.error}</p> : null}
      {fresh ? (
        <div className="mt-3 rounded-md bg-white/5 px-3 py-2 text-xs">
          <div className="flex justify-between gap-2">
            <span className="text-slate-400">Fresh quote now</span>
            <span className="font-mono">
              {fmtSide(freshAmount)}{' '}
              {freshVsTx !== undefined ? (
                <span className={toneOf(freshVsTx)}>({formatBps(freshVsTx)} vs this tx)</span>
              ) : null}
            </span>
          </div>
          <div className="mt-1 truncate text-slate-500">
            {fresh.route.join(' · ')} · impact {(fresh.priceImpactPct * 100).toFixed(3)}%
          </div>
        </div>
      ) : null}

      <Sparkline series={series} quoted={quoted} limit={limit} />

      {swap.route.length ? (
        <div className="mt-4">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Route plan</div>
          <div className="space-y-1">
            {swap.route.map((step, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-10 shrink-0 text-right font-mono text-slate-400">{step.pct}%</span>
                <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded bg-white/10">
                  <div className="h-full bg-sky-400/70" style={{ width: `${Math.min(100, step.pct)}%` }} />
                </div>
                <span className="truncate">{step.label}</span>
                <span className="ml-auto shrink-0 font-mono text-slate-500">
                  {step.inputIndex}→{step.outputIndex}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {swap.hops.length ? (
        <div className="mt-4">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Simulated hops</div>
          <div className="space-y-1">
            {swap.hops.map((hop, i) => {
              const inDec = a.tokens[hop.inputMint]?.decimals ?? (hop.inputMint === WSOL_MINT ? 9 : undefined);
              const outDec = a.tokens[hop.outputMint]?.decimals ?? (hop.outputMint === WSOL_MINT ? 9 : undefined);
              return (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 truncate text-slate-300" title={hop.program ?? hop.amm}>
                    {hop.label}
                  </span>
                  <span className="truncate font-mono text-slate-400">
                    {inDec !== undefined ? formatAmount(hop.inputAmount, inDec) : hop.inputAmount.toString()}{' '}
                    {symbolOf(hop.inputMint, a.tokens)} →{' '}
                    {outDec !== undefined ? formatAmount(hop.outputAmount, outDec) : hop.outputAmount.toString()}{' '}
                    {symbolOf(hop.outputMint, a.tokens)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </Card>
  );
};

export const FeesCard: FC<{ a: Analysis }> = ({ a }) => {
  const { compute, fees, rent } = a;
  const used = compute.consumed !== undefined ? Math.min(1, compute.consumed / compute.limit) : 0;
  const rentPaid = rent.created.reduce((s, c) => s + c.lamports, 0n);
  const rentBack = rent.closed.reduce((s, c) => s + c.lamports, 0n);
  return (
    <Card title="Fees & compute">
      <div className="grid grid-cols-3 gap-x-4 gap-y-3">
        <Stat
          label="Network fee"
          value={`${lamportsToSol(fees.total ?? fees.base + fees.priority)} SOL`}
          sub={`priority ${lamportsToSol(fees.priority)}`}
        />
        <Stat
          label="Priority price"
          value={`${Number(compute.microLamportsPerCu).toLocaleString()} µL/CU`}
          sub={
            a.priorityFees
              ? `p50 ${a.priorityFees.p50.toLocaleString()} · p75 ${a.priorityFees.p75.toLocaleString()}`
              : undefined
          }
        />
        <Stat label="Jito tip" value={fees.jitoTip ? `${lamportsToSol(fees.jitoTip)} SOL` : '—'} />
        <div className="col-span-3">
          <div className="flex justify-between text-[11px] uppercase tracking-wide text-slate-500">
            <span>Compute {compute.explicitLimit ? '' : '(default limit)'}</span>
            <span className="font-mono normal-case tracking-normal text-slate-300">
              {compute.consumed?.toLocaleString() ?? '—'} / {compute.limit.toLocaleString()} CU
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-white/10">
            <div
              className={clsx('h-full', used > 0.95 ? 'bg-amber-400' : 'bg-emerald-400/80')}
              style={{ width: `${used * 100}%` }}
            />
          </div>
        </div>
        {rentPaid || rentBack ? (
          <Stat
            className="col-span-3"
            label="Rent"
            value={`${rentPaid ? `−${lamportsToSol(rentPaid)} SOL locked in ${rent.created.length} new account${rent.created.length > 1 ? 's' : ''}` : ''}${rentPaid && rentBack ? ' · ' : ''}${rentBack ? `+${lamportsToSol(rentBack)} SOL from ${rent.closed.length} closed` : ''}`}
          />
        ) : null}
      </div>
    </Card>
  );
};

export const ChecksCard: FC<{ a: Analysis }> = ({ a }) => (
  <Card title="Checks">
    <ul className="space-y-2">
      {a.checks.map((c, i) => (
        <li key={i} className="flex gap-2 text-sm">
          <LevelDot level={c.level} />
          <div className="min-w-0">
            <div>{c.title}</div>
            {c.detail ? <div className="break-words text-xs text-slate-400">{c.detail}</div> : null}
          </div>
        </li>
      ))}
    </ul>
  </Card>
);

export const OthersCard: FC<{ a: Analysis }> = ({ a }) => {
  if (!a.others.length) return null;
  return (
    <Card title={`Other accounts · ${a.others.length}`}>
      <details>
        <summary className="cursor-pointer text-xs text-slate-400">
          Pools, vaults and other owners whose balances change
        </summary>
        <div className="mt-2 space-y-2">
          {a.others.map((o) => (
            <div key={o.owner} className="rounded-md bg-white/5 px-3 py-2">
              <Address address={o.owner} labels={a.labels} className="text-xs" />
              {o.assets.map((asset) => (
                <div key={asset.mint} className="flex justify-between text-xs">
                  <span className="text-slate-400">{symbolOf(asset.mint, a.tokens)}</span>
                  <span className={clsx('font-mono', toneOf(asset.delta))}>
                    {formatAmount(asset.delta, asset.decimals, { signed: true })}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </details>
    </Card>
  );
};

export const ErrorCard: FC<{ a: Analysis }> = ({ a }) => {
  if (!a.error) return null;
  return (
    <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4">
      <div className="text-sm font-semibold text-rose-200">{a.error.name ?? 'Simulation failed'}</div>
      <div className="mt-1 break-words text-xs text-rose-200/80">{a.error.text}</div>
    </div>
  );
};
