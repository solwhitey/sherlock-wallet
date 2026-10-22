import clsx from 'clsx';
import React, { FC, useState } from 'react';
import type { Analysis, Instr } from '../../sim/analyze';
import { Address, Badge, Button, Card, CopyButton } from './ui';

const argsReplacer = (_key: string, value: unknown) =>
  typeof value === 'bigint'
    ? value.toString()
    : value instanceof Uint8Array
      ? value.length <= 64
        ? `0x${Buffer.from(value).toString('hex')}`
        : `<${value.length} bytes>`
      : value;

const Args: FC<{ value: unknown }> = ({ value }) => (
  <pre className="max-h-64 overflow-auto rounded bg-black/40 p-2 text-[11px] leading-snug text-slate-300">
    {JSON.stringify(value, argsReplacer, 2)}
  </pre>
);

const InnerRow: FC<{ ix: Instr; a: Analysis }> = ({ ix, a }) => {
  const [open, setOpen] = useState(false);
  const name = ix.decoded?.name ?? ix.parsed?.type ?? 'unknown';
  const detail = ix.event?.data ?? ix.parsed?.info ?? ix.decoded?.args;
  return (
    <div style={{ paddingLeft: (ix.stackHeight - 2) * 14 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-0.5 text-left text-xs hover:bg-white/5"
      >
        <span className="w-10 shrink-0 font-mono text-slate-500">{ix.path}</span>
        <span className="truncate text-slate-300">{a.labels[ix.programId] ?? ix.programId.slice(0, 8) + '…'}</span>
        <span className={clsx('truncate', ix.event ? 'text-violet-300' : 'text-slate-400')}>{name}</span>
      </button>
      {open && detail ? <Args value={detail} /> : null}
    </div>
  );
};

const InstructionCard: FC<{ ix: Instr; a: Analysis }> = ({ ix, a }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className={clsx('rounded-lg border bg-slate-950/60', ix.failed ? 'border-rose-500/50' : 'border-white/10')}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-xs text-slate-500">#{ix.path}</span>
        <span className="truncate text-sm">{a.labels[ix.programId] ?? ix.programId}</span>
        <span className="truncate text-sm text-slate-400">{ix.decoded?.name ?? 'unknown instruction'}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {ix.failed ? <Badge tone="error">failed</Badge> : null}
          {ix.decoded?.decodeError ? <Badge tone="warn">partial decode</Badge> : null}
          {ix.inner.length ? <Badge>{ix.inner.length} inner</Badge> : null}
          {ix.computeUnits !== undefined ? (
            <span className="font-mono text-xs text-slate-500">{ix.computeUnits.toLocaleString()} CU</span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-white/10 px-3 py-3">
          {ix.decoded?.args && Object.keys(ix.decoded.args).length ? <Args value={ix.decoded.args} /> : null}
          {ix.decoded?.decodeError ? (
            <p className="text-xs text-amber-300">Decode stopped: {ix.decoded.decodeError}</p>
          ) : null}
          {!ix.decoded && ix.data ? (
            <div className="break-all font-mono text-[11px] text-slate-400">
              data 0x{Buffer.from(ix.data).toString('hex')}
            </div>
          ) : null}
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Accounts</div>
            <div className="space-y-0.5">
              {ix.accounts.map((acc, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="w-5 shrink-0 text-right font-mono text-slate-600">{i}</span>
                  <span className="w-40 shrink-0 truncate text-slate-500">{acc.name ?? ''}</span>
                  <Address address={acc.address} labels={a.labels} />
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-500">
                    {acc.writable ? 'W' : ''}
                    {acc.signer ? 'S' : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {ix.inner.length ? (
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Inner instructions</div>
              {ix.inner.map((inner) => (
                <InnerRow key={inner.path} ix={inner} a={a} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const InstructionsTab: FC<{ a: Analysis }> = ({ a }) =>
  a.instructions.length ? (
    <div className="space-y-2">
      {a.instructions.map((ix) => (
        <InstructionCard key={ix.path} ix={ix} a={a} />
      ))}
    </div>
  ) : (
    <p className="text-sm text-slate-400">This transaction format could not be decoded locally.</p>
  );

const logTone = (line: string) =>
  / failed: /.test(line) || line.startsWith('Program failed')
    ? 'text-rose-300'
    : / invoke \[\d+\]$/.test(line)
      ? 'text-sky-300/80'
      : / success$| consumed \d+ of /.test(line)
        ? 'text-slate-500'
        : line.startsWith('Program return:')
          ? 'text-violet-300'
          : 'text-slate-300';

export const LogsTab: FC<{ a: Analysis }> = ({ a }) => (
  <Card
    title={`Logs · ${a.logs.length} lines${a.logsTruncated ? ' (truncated)' : ''}`}
    right={<CopyButton text={a.logs.join('\n')} />}
  >
    <div className="max-h-[560px] overflow-auto rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
      {a.logs.map((line, i) => {
        const depth = Number(/ invoke \[(\d+)\]$/.exec(line)?.[1] ?? 0);
        return (
          <div
            key={i}
            className={clsx('whitespace-pre-wrap break-all', logTone(line))}
            style={{ paddingLeft: depth > 1 ? (depth - 1) * 12 : 0 }}
          >
            {line}
          </div>
        );
      })}
    </div>
  </Card>
);

export const AccountsTab: FC<{ a: Analysis }> = ({ a }) => (
  <Card title={`Accounts · ${a.accountKeys.length}`}>
    <div className="space-y-0.5">
      {a.accountKeys.map((acc, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="w-6 shrink-0 text-right font-mono text-slate-600">{i}</span>
          <Address address={acc.address} labels={a.labels} chars={8} />
          <span className="ml-auto shrink-0 space-x-1">
            {acc.signer ? <Badge tone="info">signer</Badge> : null}
            {acc.writable ? <Badge tone="warn">writable</Badge> : null}
          </span>
        </div>
      ))}
    </div>
  </Card>
);

export const RawTab: FC<{ a: Analysis; base64: string; explorerUrl?: string; onExport: () => void }> = ({
  a,
  base64,
  explorerUrl,
  onExport,
}) => (
  <Card title="Raw transaction">
    <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
      <div>Version: {String(a.version)}</div>
      <div>
        Size: {a.size} / {a.maxSize} bytes
      </div>
      <div className="col-span-2 truncate">Blockhash: {a.recentBlockhash ?? '—'}</div>
      <div className="col-span-2 truncate">Fee payer: {a.feePayer ?? '—'}</div>
    </div>
    <textarea
      readOnly
      value={base64}
      className="h-32 w-full resize-none rounded bg-black/40 p-2 font-mono text-[11px] text-slate-300"
    />
    <div className="mt-3 flex flex-wrap gap-2">
      <CopyButton text={base64} label="Copy base64" />
      {explorerUrl ? (
        <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
          <Button>Open in Explorer inspector</Button>
        </a>
      ) : null}
      <Button onClick={onExport}>Download report (JSON)</Button>
    </div>
  </Card>
);
