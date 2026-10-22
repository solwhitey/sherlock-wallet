import clsx from 'clsx';
import React, { FC, useState } from 'react';
import type { Analysis, Instr } from '../../sim/analyze';
import { ChevronDown, DownloadIcon, ExternalIcon } from '../kit/icons';
import { Button, Collapse, CopyButton, Pill } from '../kit/kit';
import { explorerAddress, shortAddress } from './format';

export const AddressLink: FC<{
  address: string;
  labels?: Record<string, string>;
  chars?: number;
  className?: string;
}> = ({ address, labels, chars = 4, className }) => {
  const label = labels?.[address];
  return (
    <a
      href={explorerAddress(address)}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className={clsx('truncate hover:underline', label ? 'text-ink' : 'mono text-ink-2', className)}
    >
      {label ?? shortAddress(address, chars)}
    </a>
  );
};

const argsReplacer = (_key: string, value: unknown) =>
  typeof value === 'bigint'
    ? value.toString()
    : value instanceof Uint8Array
      ? value.length <= 64
        ? `0x${Buffer.from(value).toString('hex')}`
        : `<${value.length} bytes>`
      : value;

const Code: FC<{ value: unknown }> = ({ value }) => (
  <pre className="mono max-h-72 overflow-auto rounded-xl bg-hover p-3 text-[11px] leading-relaxed text-ink-2">
    {JSON.stringify(value, argsReplacer, 2)}
  </pre>
);

const InnerRow: FC<{ ix: Instr; a: Analysis }> = ({ ix, a }) => {
  const [open, setOpen] = useState(false);
  const detail = ix.event?.data ?? ix.parsed?.info ?? ix.decoded?.args;
  return (
    <div style={{ paddingLeft: (ix.stackHeight - 2) * 16 }}>
      <button
        type="button"
        onClick={() => detail && setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-hover"
      >
        <span className="w-9 shrink-0 text-ink-3">{ix.path}</span>
        <span className="truncate font-medium">{a.labels[ix.programId] ?? shortAddress(ix.programId)}</span>
        <span className={clsx('truncate', ix.event ? 'text-info' : 'text-ink-2')}>
          {ix.decoded?.name ?? ix.parsed?.type ?? 'unknown'}
        </span>
      </button>
      {detail ? (
        <Collapse open={open}>
          <div className="px-2 pb-2">
            <Code value={detail} />
          </div>
        </Collapse>
      ) : null}
    </div>
  );
};

const InstructionCard: FC<{ ix: Instr; a: Analysis }> = ({ ix, a }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className={clsx('rounded-card border', ix.failed ? 'border-neg' : 'border-line')}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="text-sm text-ink-3">{ix.path}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{ix.decoded?.name ?? 'Unknown instruction'}</div>
          <div className="truncate text-xs text-ink-2">{a.labels[ix.programId] ?? ix.programId}</div>
        </div>
        {ix.failed ? <Pill tone="neg">Failed</Pill> : null}
        {ix.decoded?.decodeError ? <Pill tone="warn">Partial</Pill> : null}
        {ix.computeUnits !== undefined ? (
          <span className="text-xs text-ink-3">{ix.computeUnits.toLocaleString()} CU</span>
        ) : null}
        <ChevronDown size={16} className={clsx('shrink-0 text-ink-2 transition-transform', open && 'rotate-180')} />
      </button>
      <Collapse open={open}>
        <div className="space-y-4 border-t border-line px-4 py-4">
          {ix.decoded?.args && Object.keys(ix.decoded.args).length ? <Code value={ix.decoded.args} /> : null}
          {ix.decoded?.decodeError ? (
            <p className="text-xs text-warn">Decoding stopped: {ix.decoded.decodeError}</p>
          ) : null}
          {!ix.decoded && ix.data ? (
            <div className="mono break-all text-[11px] text-ink-2">0x{Buffer.from(ix.data).toString('hex')}</div>
          ) : null}
          <div>
            <div className="caps mb-1.5">Accounts</div>
            {ix.accounts.map((acc, i) => (
              <div key={i} className="flex items-center gap-3 py-0.5 text-[13px]">
                <span className="w-5 shrink-0 text-right text-ink-3">{i}</span>
                <span className="w-36 shrink-0 truncate text-ink-3">{acc.name ?? ''}</span>
                <AddressLink address={acc.address} labels={a.labels} />
                <span className="ml-auto shrink-0 text-[11px] text-ink-3">
                  {[acc.writable && 'writable', acc.signer && 'signer'].filter(Boolean).join(' · ')}
                </span>
              </div>
            ))}
          </div>
          {ix.inner.length ? (
            <div>
              <div className="caps mb-1.5">Inner instructions · {ix.inner.length}</div>
              {ix.inner.map((inner) => (
                <InnerRow key={inner.path} ix={inner} a={a} />
              ))}
            </div>
          ) : null}
        </div>
      </Collapse>
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
    <p className="text-sm text-ink-2">This transaction format could not be decoded locally.</p>
  );

const logTone = (line: string) =>
  / failed: /.test(line)
    ? 'text-neg'
    : / invoke \[\d+\]$/.test(line)
      ? 'text-info'
      : / success$| consumed \d+ of /.test(line)
        ? 'text-ink-3'
        : line.startsWith('Program return:')
          ? 'text-pos'
          : 'text-ink';

export const LogsTab: FC<{ a: Analysis }> = ({ a }) => (
  <div>
    <div className="mb-3 flex items-center justify-between">
      <span className="text-sm text-ink-2">
        {a.logs.length} lines{a.logsTruncated ? ' · truncated by the RPC' : ''}
      </span>
      <CopyButton text={a.logs.join('\n')} label="Copy logs" />
    </div>
    <div className="mono rounded-card bg-hover p-3 text-[11px] leading-relaxed">
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
  </div>
);

export const RawTab: FC<{ a: Analysis; base64: string; explorerUrl?: string; onExport: () => void }> = ({
  a,
  base64,
  explorerUrl,
  onExport,
}) => (
  <div className="space-y-6">
    <div className="flex flex-wrap gap-2">
      <Button kind="outline" size="sm" onClick={() => navigator.clipboard.writeText(base64)}>
        Copy base64
      </Button>
      {explorerUrl ? (
        <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
          <Button kind="outline" size="sm">
            Explorer <ExternalIcon size={13} />
          </Button>
        </a>
      ) : null}
      <Button kind="outline" size="sm" onClick={onExport}>
        <DownloadIcon size={13} /> Report
      </Button>
    </div>

    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      <span className="text-ink-2">Version</span>
      <span>{a.version === 'legacy' ? 'Legacy' : `v${String(a.version)}`}</span>
      <span className="text-ink-2">Size</span>
      <span>
        {a.size} / {a.maxSize} bytes
      </span>
      <span className="text-ink-2">Fee payer</span>
      {a.feePayer ? <AddressLink address={a.feePayer} labels={a.labels} /> : <span>—</span>}
      <span className="text-ink-2">Blockhash</span>
      <span className="mono truncate text-ink-2">{a.recentBlockhash ?? '—'}</span>
    </div>

    <textarea readOnly value={base64} className="field mono h-28 resize-none text-[11px] text-ink-2" />

    <div>
      <div className="caps mb-2">Accounts · {a.accountKeys.length}</div>
      {a.accountKeys.map((acc, i) => (
        <div key={i} className="flex items-center gap-3 py-0.5 text-[13px]">
          <span className="w-6 shrink-0 text-right text-ink-3">{i}</span>
          <AddressLink address={acc.address} labels={a.labels} chars={8} />
          <span className="ml-auto shrink-0 text-[11px] text-ink-3">
            {[acc.writable && 'writable', acc.signer && 'signer'].filter(Boolean).join(' · ')}
          </span>
        </div>
      ))}
    </div>
  </div>
);
