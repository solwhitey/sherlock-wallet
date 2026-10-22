import { VersionedTransaction } from '@solana/web3.js';
import base58 from 'bs58';
import type { FC } from 'react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InspectRequest } from '../../background/requests';
import { analyze, Analysis } from '../../sim/analyze';
import { getQuote } from '../../sim/jupApi';
import { useConnection } from '../context/ConnectionContext';
import { useAccounts } from '../hooks/useAccounts';
import { AccountsTab, InstructionsTab, LogsTab, RawTab } from '../inspect/Details';
import { jsonReplacer, shortAddress, timeAgo } from '../inspect/format';
import {
  BalanceChanges,
  ChecksCard,
  ErrorCard,
  FeesCard,
  JupiterCard,
  OthersCard,
  QuoteState,
  SeriesPoint,
} from '../inspect/Overview';
import { Badge, Button, Card, Tabs } from '../inspect/ui';
import { rpc } from '../rpc';

const EXPLORER_INSPECT_BASE_URL = 'https://explorer.solana.com/tx/inspector';
const RESIMULATE_MS = 5_000;
const SERIES_LIMIT = 120;

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function explorerUrl(bytes: Uint8Array) {
  try {
    const tx = VersionedTransaction.deserialize(bytes);
    const url = new URL(EXPLORER_INSPECT_BASE_URL);
    url.searchParams.append('signatures', JSON.stringify(tx.signatures.map((sig) => base58.encode(sig))));
    url.searchParams.append('message', Buffer.from(tx.message.serialize()).toString('base64'));
    return url.toString();
  } catch {
    return undefined;
  }
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

type TabId = 'overview' | 'instructions' | 'logs' | 'accounts' | 'raw';

const TxInspector: FC<{ request: InspectRequest; index: number; active: boolean; auto: boolean }> = ({
  request,
  index,
  active,
  auto,
}) => {
  const { rpcUrl } = useConnection();
  const { accounts } = useAccounts();
  const base64 = request.transactions![index];
  const bytes = useMemo(() => fromBase64(base64), [base64]);
  const addressBook = useMemo(
    () => Object.fromEntries(accounts.map((acc) => [acc.address.toBase58(), acc.label])),
    [accounts]
  );

  const [analysis, setAnalysis] = useState<Analysis>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<TabId>('overview');
  const [series, setSeries] = useState<Record<string, SeriesPoint[]>>({});
  const [quotes, setQuotes] = useState<Record<string, QuoteState>>({});
  const inFlight = useRef(false);
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;

  const requote = useCallback(async (a: Analysis, path: string) => {
    const swap = a.jupiter.find((j) => j.path === path);
    const amount = swap?.exactOut ? swap.outAmount : swap?.inAmount;
    if (!swap?.inputMint || !swap.outputMint || amount === undefined) return;
    setQuotes((q) => ({ ...q, [path]: { ...q[path], loading: true } }));
    try {
      const quote = await getQuote({
        inputMint: swap.inputMint,
        outputMint: swap.outputMint,
        amount,
        slippageBps: swap.slippageBps,
        exactOut: swap.exactOut,
      });
      setQuotes((q) => ({ ...q, [path]: { loading: false, quote } }));
    } catch (e) {
      setQuotes((q) => ({ ...q, [path]: { loading: false, error: (e as Error).message } }));
    }
  }, []);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    try {
      const a = await analyze({ rpcUrl, transaction: bytes, user: request.address, addressBook });
      setAnalysis(a);
      setError(undefined);
      setSeries((prev) => {
        const next = { ...prev };
        for (const swap of a.jupiter) {
          const point = {
            t: a.simulatedAt,
            amount: swap.exactOut ? swap.inAmount : swap.outAmount,
            failed: swap.failed,
          };
          next[swap.path] = [...(prev[swap.path] ?? []), point].slice(-SERIES_LIMIT);
        }
        return next;
      });
      // Once a fresh quote was asked for, keep it in step with the simulation.
      for (const path of Object.keys(quotesRef.current)) requote(a, path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  }, [rpcUrl, bytes, request.address, addressBook, requote]);

  useEffect(() => {
    run();
  }, [run]);

  useEffect(() => {
    if (!auto || !active) return;
    const timer = setInterval(run, RESIMULATE_MS);
    return () => clearInterval(timer);
  }, [auto, active, run]);

  // Re-render the "updated … ago" label.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const exportReport = () => {
    if (!analysis) return;
    let rpcHost = '';
    try {
      rpcHost = new URL(rpcUrl).host; // never the path or query, which may carry an API key
    } catch {
      rpcHost = '';
    }
    const report = {
      generatedBy: 'Sherlock Wallet',
      request: {
        origin: request.origin,
        method: request.method,
        address: request.address,
        createdAt: new Date(request.createdAt).toISOString(),
      },
      rpcHost,
      transaction: base64,
      analysis,
    };
    download(`sherlock-${analysis.slot ?? 'tx'}-${index + 1}.json`, JSON.stringify(report, jsonReplacer, 2));
  };

  if (!active) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-slate-400">
        {analysis ? (
          analysis.err ? (
            <Badge tone="error">Failed</Badge>
          ) : (
            <Badge tone="ok">Success</Badge>
          )
        ) : (
          <Badge>Simulating…</Badge>
        )}
        {analysis?.slot ? <span>slot {analysis.slot.toLocaleString()}</span> : null}
        {analysis ? <span>· {timeAgo(analysis.simulatedAt)}</span> : null}
        <Button className="ml-auto" onClick={run} disabled={running}>
          {running ? 'Simulating…' : 'Re-simulate'}
        </Button>
      </div>

      {error ? (
        <Card>
          <p className="text-sm text-rose-300">Simulation request failed: {error}</p>
          <p className="mt-1 text-xs text-slate-400">
            Check the RPC URL in Sherlock's settings ({rpcUrl.replace(/\?.*$/, '')}).
          </p>
        </Card>
      ) : null}

      {analysis ? (
        <>
          <Tabs<TabId>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'instructions', label: `Instructions · ${analysis.instructions.length}` },
              { id: 'logs', label: 'Logs' },
              { id: 'accounts', label: 'Accounts' },
              { id: 'raw', label: 'Raw' },
            ]}
          />
          {tab === 'overview' ? (
            <div className="space-y-4">
              <ErrorCard a={analysis} />
              <BalanceChanges a={analysis} />
              {analysis.jupiter.map((swap) => (
                <JupiterCard
                  key={swap.path}
                  a={analysis}
                  swap={swap}
                  series={series[swap.path] ?? []}
                  quote={quotes[swap.path]}
                  onRequote={() => requote(analysis, swap.path)}
                />
              ))}
              <FeesCard a={analysis} />
              <ChecksCard a={analysis} />
              <OthersCard a={analysis} />
            </div>
          ) : null}
          {tab === 'instructions' ? <InstructionsTab a={analysis} /> : null}
          {tab === 'logs' ? <LogsTab a={analysis} /> : null}
          {tab === 'accounts' ? <AccountsTab a={analysis} /> : null}
          {tab === 'raw' ? (
            <RawTab a={analysis} base64={base64} explorerUrl={explorerUrl(bytes)} onExport={exportReport} />
          ) : null}
        </>
      ) : null}
    </div>
  );
};

const SIWS_MARKER = 'wants you to sign in with your Solana account';

const MessageView: FC<{ request: InspectRequest }> = ({ request }) => {
  const bytes = fromBase64(request.message ?? '');
  let text: string | undefined;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = undefined;
  }
  return (
    <Card
      title={text?.includes(SIWS_MARKER) ? 'Sign-in with Solana message' : 'Message'}
      right={<Badge>{bytes.length} bytes</Badge>}
    >
      {text !== undefined ? (
        <pre className="whitespace-pre-wrap break-words rounded bg-black/40 p-3 text-xs text-slate-200">{text}</pre>
      ) : null}
      <details className="mt-3" open={text === undefined}>
        <summary className="cursor-pointer text-xs text-slate-400">Hex</summary>
        <div className="mt-1 break-all font-mono text-[11px] text-slate-400">{Buffer.from(bytes).toString('hex')}</div>
      </details>
    </Card>
  );
};

const METHOD_LABEL: Record<InspectRequest['method'], string> = {
  signTransaction: 'signTransaction',
  signAndSendTransaction: 'signAndSendTransaction',
  signMessage: 'signMessage',
  paste: 'pasted',
};

export const Inspect: FC = () => {
  const { accounts } = useAccounts();
  const { rpcUrl } = useConnection();
  const id = new URLSearchParams(window.location.search).get('request');
  const [request, setRequest] = useState<InspectRequest | null>();
  const [txIndex, setTxIndex] = useState(0);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    rpc.callMethod('getRequest', [id]).then((r) => setRequest(r ?? null));
  }, [id]);

  const label = request ? accounts.find((a) => a.address.toBase58() === request.address)?.label : undefined;

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex-1 space-y-4 p-4 pt-20">
        {request === undefined ? <p className="text-sm text-slate-400">Loading request…</p> : null}
        {request === null ? <p className="text-sm text-slate-400">This request is no longer in the history.</p> : null}
        {request ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="info">{METHOD_LABEL[request.method]}</Badge>
              {request.origin ? (
                <span className="truncate text-slate-300">{request.origin.replace(/^https?:\/\//, '')}</span>
              ) : null}
              <span className="text-slate-500">as</span>
              <span className="truncate" title={request.address}>
                {label ? `${label} · ` : ''}
                <span className="font-mono text-slate-400">{shortAddress(request.address)}</span>
              </span>
              {request.kind === 'transactions' ? (
                <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
                  <input
                    type="checkbox"
                    checked={auto}
                    onChange={() => setAuto(!auto)}
                    className="h-3.5 w-3.5 rounded border-white/30 bg-transparent text-slate-400"
                  />
                  re-simulate every 5s
                </label>
              ) : null}
            </div>
            <div className="truncate text-[11px] text-slate-500">
              RPC {rpcUrl.replace(/\?.*$/, '').replace(/\/[^/]{24,}$/, '/…')}
            </div>

            {request.kind === 'message' ? <MessageView request={request} /> : null}

            {request.kind === 'transactions' && request.transactions!.length > 1 ? (
              <Tabs<string>
                value={String(txIndex)}
                onChange={(v) => setTxIndex(Number(v))}
                tabs={request.transactions!.map((_, i) => ({ id: String(i), label: `Transaction ${i + 1}` }))}
              />
            ) : null}
            {request.kind === 'transactions'
              ? request.transactions!.map((_, i) => (
                  <TxInspector key={i} request={request} index={i} active={i === txIndex} auto={auto} />
                ))
              : null}
          </>
        ) : null}
      </div>

      <div className="sticky bottom-0 border-t border-white/10 bg-slate-900/95 p-3 backdrop-blur">
        <Button variant="primary" size="md" className="w-full" onClick={() => window.close()}>
          {request?.method === 'paste' ? 'Close' : 'Close and reject'}
        </Button>
      </div>
    </div>
  );
};
