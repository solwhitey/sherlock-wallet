import base58 from 'bs58';
import React, { FC, useEffect, useState } from 'react';
import type { InspectRequest } from '../../background/requests';
import { useAccounts } from '../hooks/useAccounts';
import { shortAddress, timeAgo } from '../inspect/format';
import { rpc } from '../rpc';

const inputClass =
  'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const buttonClass =
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2';

// Accepts a serialized transaction as base64 or base58 (what explorers, logs and APIs hand out).
function decodeTransaction(text: string): string {
  const trimmed = text.trim().replace(/^"|"$/g, '');
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed) && !/[+/=]/.test(trimmed)) {
    try {
      return Buffer.from(base58.decode(trimmed)).toString('base64');
    } catch {
      // Fall through to base64.
    }
  }
  const bytes = Buffer.from(trimmed, 'base64');
  if (!bytes.length) throw new Error('Not a base64 or base58 transaction');
  return bytes.toString('base64');
}

export const PasteTransaction: FC = () => {
  const { accounts, connectedAddress } = useAccounts();
  const [text, setText] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string>();
  const user = address || connectedAddress || accounts[0]?.address.toBase58() || '';

  return (
    <div className="space-y-2">
      <p className="text-base font-semibold">Inspect a transaction</p>
      <textarea
        className={`${inputClass} h-20 resize-none font-mono text-xs`}
        placeholder="Serialized transaction (base64 or base58)"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <select className={inputClass} value={user} onChange={(e) => setAddress(e.target.value)}>
        {accounts.map((acc) => (
          <option key={acc.address.toBase58()} value={acc.address.toBase58()}>
            View as {acc.label} ({shortAddress(acc.address.toBase58())})
          </option>
        ))}
      </select>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      <button
        type="button"
        className={`${buttonClass} w-full`}
        disabled={!text.trim()}
        onClick={async () => {
          try {
            const transaction = decodeTransaction(text);
            setError(undefined);
            await rpc.callMethod('inspectPasted', [{ address: user, transactions: [transaction] }]);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Simulate
      </button>
    </div>
  );
};

export const RequestHistory: FC = () => {
  const [history, setHistory] = useState<InspectRequest[]>([]);
  useEffect(() => {
    rpc.callMethod('getHistory').then((h) => setHistory(h ?? []));
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-base font-semibold">Recent requests</p>
        {history.length ? (
          <button
            type="button"
            className="text-xs text-white/50 hover:text-white"
            onClick={async () => {
              await rpc.callMethod('clearHistory');
              setHistory([]);
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
      {history.length ? (
        <div className="space-y-1">
          {history.slice(0, 15).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => rpc.callMethod('openRequest', [r.id])}
              className="flex w-full items-center gap-2 rounded-md border border-white/10 px-2 py-1.5 text-left text-xs hover:bg-white/10"
            >
              <span className="w-28 shrink-0 truncate text-white/80">
                {r.origin?.replace(/^https?:\/\//, '') ?? 'pasted'}
              </span>
              <span className="truncate text-white/50">
                {r.method}
                {r.transactions && r.transactions.length > 1 ? ` ×${r.transactions.length}` : ''}
              </span>
              <span className="ml-auto shrink-0 text-white/40">{timeAgo(r.createdAt)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-white/40">Sign requests from dapps show up here and can be re-simulated later.</p>
      )}
    </div>
  );
};
