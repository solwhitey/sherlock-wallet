import { VersionedTransaction } from '@solana/web3.js';
import base58 from 'bs58';
import type { FC } from 'react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InspectRequest } from '../../background/requests';
import { analyze, Analysis } from '../../sim/analyze';
import { getQuote } from '../../sim/jupApi';
import { useConnection } from '../context/ConnectionContext';
import { useAccounts } from '../hooks/useAccounts';
import { AddressLink, InstructionsTab, LogsTab, RawTab } from '../inspect/Details';
import { jsonReplacer, shortAddress, timeAgo } from '../inspect/format';
import {
  Attention,
  ChecksSection,
  FeesSection,
  Hero,
  KeyFigures,
  OthersSection,
  QuoteState,
  SeriesPoint,
  SwapSection,
} from '../inspect/Summary';
import { RefreshIcon, XIcon } from '../kit/icons';
import { AddressAvatar, Button, Dot, IconButton, Pill, Segmented, Switch } from '../kit/kit';
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

type TabId = 'summary' | 'instructions' | 'logs' | 'raw';

const Skeleton: FC = () => (
  <div className="animate-pulse space-y-4 pt-2">
    <div className="h-7 w-40 rounded-lg bg-tint" />
    <div className="h-14 rounded-card bg-tint" />
    <div className="h-14 rounded-card bg-tint" />
    <div className="h-20 rounded-card bg-tint" />
  </div>
);

const TxInspector: FC<{
  request: InspectRequest;
  index: number;
  active: boolean;
  live: boolean;
  setLive: (v: boolean) => void;
}> = ({ request, index, active, live, setLive }) => {
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
  const [tab, setTab] = useState<TabId>('summary');
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
    if (!live || !active) return;
    const timer = setInterval(run, RESIMULATE_MS);
    return () => clearInterval(timer);
  }, [live, active, run]);

  // Keeps the "… ago" label current.
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
    <div>
      <div className="mb-5 flex items-center gap-2 text-xs text-ink-2">
        <Dot tone={!analysis ? 'muted' : analysis.err ? 'neg' : 'pos'} pulse={live || running} />
        <span>
          {running && !analysis ? 'Simulating…' : analysis ? `Simulated ${timeAgo(analysis.simulatedAt)}` : ''}
          {analysis?.slot ? ` · slot ${analysis.slot.toLocaleString()}` : ''}
        </span>
        <span className="ml-auto" />
        <Switch checked={live} onChange={setLive} label="Live" />
        <IconButton label="Simulate again" onClick={run} disabled={running}>
          <RefreshIcon size={14} className={running ? 'animate-spin' : ''} />
        </IconButton>
      </div>

      {error ? (
        <div className="mb-5 rounded-card bg-neg-soft px-4 py-3 text-sm">
          <div className="font-semibold text-neg">The RPC did not answer</div>
          <div className="mt-0.5 break-words text-ink-2">{error}</div>
          <div className="mt-1 text-xs text-ink-3">Check the RPC URL in Sherlock's settings.</div>
        </div>
      ) : null}

      {!analysis ? (
        error ? null : (
          <Skeleton />
        )
      ) : (
        <>
          <Segmented<TabId>
            className="mb-6"
            value={tab}
            onChange={setTab}
            items={[
              { id: 'summary', label: 'Summary' },
              { id: 'instructions', label: 'Instructions' },
              { id: 'logs', label: 'Logs' },
              { id: 'raw', label: 'Raw' },
            ]}
          />
          <div key={tab} className="fade-in">
            {tab === 'summary' ? (
              <div className="space-y-6">
                <Hero a={analysis} />
                <KeyFigures a={analysis} />
                <Attention a={analysis} />
                <div>
                  {analysis.jupiter.map((swap) => (
                    <SwapSection
                      key={swap.path}
                      a={analysis}
                      swap={swap}
                      series={series[swap.path] ?? []}
                      quote={quotes[swap.path]}
                      onRequote={() => requote(analysis, swap.path)}
                    />
                  ))}
                  <FeesSection a={analysis} />
                  <ChecksSection a={analysis} />
                  <OthersSection
                    a={analysis}
                    renderAddress={(address) => <AddressLink address={address} labels={analysis.labels} />}
                  />
                </div>
              </div>
            ) : null}
            {tab === 'instructions' ? <InstructionsTab a={analysis} /> : null}
            {tab === 'logs' ? <LogsTab a={analysis} /> : null}
            {tab === 'raw' ? (
              <RawTab a={analysis} base64={base64} explorerUrl={explorerUrl(bytes)} onExport={exportReport} />
            ) : null}
          </div>
        </>
      )}
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
  const siws = text?.includes(SIWS_MARKER);
  return (
    <div className="rise-in">
      <h1 className="text-[26px] font-bold leading-tight tracking-tight">
        {siws ? 'Sign in with Solana' : 'Sign a message'}
      </h1>
      <p className="mt-1 text-sm text-ink-2">
        {bytes.length} bytes · signing a message moves no funds, but proves you own the address.
      </p>
      {text !== undefined ? (
        <pre className="mt-5 whitespace-pre-wrap break-words rounded-card border border-line p-4 text-sm leading-relaxed">
          {text}
        </pre>
      ) : null}
      <details className="mt-4" open={text === undefined}>
        <summary className="cursor-pointer text-sm font-medium text-ink-2">Raw bytes</summary>
        <div className="mono mt-2 break-all text-[11px] text-ink-2">{Buffer.from(bytes).toString('hex')}</div>
      </details>
    </div>
  );
};

const METHOD_LABEL: Record<InspectRequest['method'], string> = {
  signTransaction: 'Sign transaction',
  signAndSendTransaction: 'Sign and send',
  signMessage: 'Sign message',
  paste: 'Pasted transaction',
};

export const Inspect: FC = () => {
  const { accounts } = useAccounts();
  const id = new URLSearchParams(window.location.search).get('request');
  const [request, setRequest] = useState<InspectRequest | null>();
  const [txIndex, setTxIndex] = useState(0);
  const [live, setLive] = useState(true);

  useEffect(() => {
    rpc.callMethod('getRequest', [id]).then((r) => setRequest(r ?? null));
  }, [id]);

  const label = request ? accounts.find((a) => a.address.toBase58() === request.address)?.label : undefined;
  const count = request?.transactions?.length ?? 0;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-canvas px-4 py-3 ">
        <IconButton label={request?.method === 'paste' ? 'Close' : 'Reject and close'} onClick={() => window.close()}>
          <XIcon size={18} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">
            {request?.origin
              ? request.origin.replace(/^https?:\/\//, '')
              : request
                ? METHOD_LABEL[request.method]
                : 'Sherlock'}
          </div>
          {request?.origin ? <div className="truncate text-xs text-ink-2">{METHOD_LABEL[request.method]}</div> : null}
        </div>
        {request ? (
          <div
            className="flex min-w-0 items-center gap-2 rounded-full border border-line py-1 pl-1 pr-3"
            title={request.address}
          >
            <AddressAvatar address={request.address} size={24} />
            <span className="truncate text-[13px] font-medium">{label ?? shortAddress(request.address)}</span>
          </div>
        ) : null}
      </header>

      <main className="flex-1 px-6 pb-8 pt-5">
        {request === undefined ? <Skeleton /> : null}
        {request === null ? <p className="text-sm text-ink-2">This request is no longer in the history.</p> : null}
        {request?.kind === 'message' ? <MessageView request={request} /> : null}
        {request?.kind === 'transactions' ? (
          <>
            {count > 1 ? (
              <div className="mb-5 flex items-center gap-2">
                <Pill>{count} transactions</Pill>
                <Segmented<string>
                  value={String(txIndex)}
                  onChange={(v) => setTxIndex(Number(v))}
                  items={request.transactions!.map((_, i) => ({ id: String(i), label: `${i + 1}` }))}
                />
              </div>
            ) : null}
            {request.transactions!.map((_, i) => (
              <TxInspector key={i} request={request} index={i} active={i === txIndex} live={live} setLive={setLive} />
            ))}
          </>
        ) : null}
      </main>

      <footer className="sticky bottom-0 border-t border-line bg-canvas px-6 py-4 ">
        <Button kind="dark" size="lg" className="w-full" onClick={() => window.close()}>
          {request?.method === 'paste' ? 'Done' : 'Reject and close'}
        </Button>
      </footer>
    </div>
  );
};
