import React, { FC, useState } from 'react';
import type { Analysis } from '../../sim/analyze';
import { WSOL_MINT } from '../../sim/programs';
import { PlusIcon, XIcon } from '../kit/icons';
import { Button, IconButton, Pill } from '../kit/kit';
import { shortAddress, symbolOf } from './format';

// One change to the forked state: set the viewing address's SOL or token balance.
export type ForkChange = { mint: 'SOL' | string; amount: number };

export type ForkStats = { fetchedBytes: number; vmMs: number; memoryBytes: number; features: number };

const kb = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

export const ForkPanel: FC<{
  a?: Analysis;
  target: string;
  changes: ForkChange[];
  setChanges: (c: ForkChange[]) => void;
  stats?: ForkStats;
  error?: string;
}> = ({ a, target, changes, setChanges, stats, error }) => {
  const [mint, setMint] = useState<string>('SOL');
  const [amount, setAmount] = useState('');
  // Tokens worth offering: SOL and every mint this transaction touches.
  const mints = [
    ...new Set(
      [
        ...(a?.accounts.map((x) => x.token?.mint) ?? []),
        ...(a?.userChanges.map((c) => c.mint) ?? []),
        ...(a?.jupiter.flatMap((j) => [j.inputMint, j.outputMint]) ?? []),
      ].filter((m): m is string => !!m && m !== 'SOL' && m !== WSOL_MINT)
    ),
  ];
  const label = a?.labels[target] ?? shortAddress(target);
  const add = () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) return;
    setChanges([...changes.filter((c) => c.mint !== mint), { mint, amount: value }]);
    setAmount('');
  };

  return (
    <section
      className="rounded-card border border-accent/40 bg-raised px-5 py-4"
      style={{ borderColor: 'var(--accent)' }}
    >
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-[15px] font-semibold">Fork</h2>
        <span className="text-[13px] text-ink-2">· in-browser Solana VM, live mainnet state</span>
        {stats ? (
          <span className="ml-auto text-[11px] text-ink-3">
            fetched {kb(stats.fetchedBytes)} · VM {Math.round(stats.vmMs)} ms · {stats.features} features
          </span>
        ) : null}
      </div>
      <p className="mb-3 text-xs text-ink-2">
        Set balances for {label} and the transaction is simulated against them. Nothing is sent anywhere: accounts are
        read from your RPC and run locally.
      </p>

      {changes.length ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {changes.map((c) => (
            <Pill key={c.mint} tone="pos" className="pr-1">
              {symbolOf(c.mint, a?.tokens ?? {})} = {c.amount.toLocaleString('en-US')}
              <IconButton
                label={`Remove ${symbolOf(c.mint, a?.tokens ?? {})}`}
                className="h-5 w-5"
                onClick={() => setChanges(changes.filter((x) => x.mint !== c.mint))}
              >
                <XIcon size={11} />
              </IconButton>
            </Pill>
          ))}
        </div>
      ) : null}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <select className="field w-40 py-2 text-sm" value={mint} onChange={(e) => setMint(e.target.value)}>
          <option value="SOL">SOL</option>
          {mints.map((m) => (
            <option key={m} value={m}>
              {symbolOf(m, a?.tokens ?? {})}
            </option>
          ))}
        </select>
        <input
          className="field py-2 text-sm"
          inputMode="decimal"
          placeholder="Balance to set, e.g. 1000"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Button type="submit" kind="dark" disabled={!amount.trim()}>
          <PlusIcon size={14} /> Set
        </Button>
      </form>
      {error ? <p className="mt-2 text-xs text-neg">The VM could not run this: {error}</p> : null}
    </section>
  );
};
