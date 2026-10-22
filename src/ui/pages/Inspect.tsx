import type { FC } from 'react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InspectRequest } from '../../background/requests';
import { analyze, Analysis, Execution } from '../../sim/analyze';
import { fetchLanded } from '../../sim/replay';
import { supportReport } from '../../sim/report';
import { getQuote } from '../../sim/jupApi';
import { explorerInspectorUrl, parseTransaction } from '../../sim/tx';
import { useConnection } from '../context/ConnectionContext';
import { useAccounts } from '../hooks/useAccounts';
import { AccountsTab, AddressLink, InstructionsTab, LogsTab, RawTab } from '../inspect/Details';
import { jsonReplacer, shortAddress, timeAgo } from '../inspect/format';
import {
  BalanceCard,
  ChecksSection,
  ComputeSection,
  ErrorBanner,
  ExecutionCard,
  FeesSection,
  OthersSection,
  QuoteState,
  RouteSection,
  RoutersSection,
  SeriesPoint,
} from '../inspect/Summary';
import { CheckIcon, CopyIcon, RefreshIcon, XIcon } from '../kit/icons';
import { AddressAvatar, Button, Dot, IconButton, Pill, Segmented, Switch } from '../kit/kit';
import { rpc } from '../rpc';
import { BundleView } from '../inspect/Bundle';

const RESIMULATE_MS = 5_000;
const SERIES_LIMIT = 120;

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

type TabId = 'summary' | 'instructions' | 'accounts' | 'logs' | 'raw';
type DetailId = 'instructions' | 'accounts' | 'compute' | 'logs' | 'raw';

// Wide windows get a two-column, desktop-style layout: summary on the left, explorer-level detail
// on the right.
const WIDE = 1100;
function useWide() {
  const [wide, setWide] = useState(() => window.innerWidth >= WIDE);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= WIDE);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return wide;
}

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
  // For replays: what happened on chain, shown next to a fresh simulation of the same bytes.
  landed?: Execution;
  // Reports the active transaction's latest analysis, for the footer's report button.
  onAnalysis?: (a: Analysis, base64: string) => void;
}> = ({ request, index, active, live, setLive, landed, onAnalysis }) => {
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
  const [detailTab, setDetailTab] = useState<DetailId>('instructions');
  const wide = useWide();
  const [mode, setMode] = useState<'landed' | 'now'>(landed ? 'landed' : 'now');
  // A replay is viewed from its fee payer unless the chosen address signed it.
  const user = useMemo(() => {
    if (!landed) return request.address;
    const tx = parseTransaction(bytes);
    const signers = tx?.staticKeys.slice(0, tx.header.numRequiredSignatures) ?? [];
    return signers.includes(request.address) ? request.address : undefined;
  }, [landed, bytes, request.address]);
  const [series, setSeries] = useState<Record<string, SeriesPoint[]>>({});
  const [quotes, setQuotes] = useState<Record<string, QuoteState>>({});
  const inFlight = useRef(false);
  const onAnalysisRef = useRef(onAnalysis);
  onAnalysisRef.current = active ? onAnalysis : undefined;
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
      const a = await analyze({
        rpcUrl,
        transaction: bytes,
        user,
        addressBook,
        execution: mode === 'landed' ? landed : undefined,
      });
      setAnalysis(a);
      setError(undefined);
      onAnalysisRef.current?.(a, base64);
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
  }, [rpcUrl, bytes, user, addressBook, requote, mode, landed]);

  useEffect(() => {
    run();
  }, [run]);

  useEffect(() => {
    if (!live || !active || mode === 'landed') return;
    const timer = setInterval(run, RESIMULATE_MS);
    return () => clearInterval(timer);
  }, [live, active, run, mode]);

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

  const status = (
    <div className="ml-auto flex min-w-0 items-center gap-2 text-[11px] text-ink-2">
      {landed ? (
        <Segmented<'landed' | 'now'>
          value={mode}
          onChange={setMode}
          items={[
            { id: 'landed', label: 'On chain' },
            { id: 'now', label: 'Simulated now' },
          ]}
        />
      ) : null}
      <Dot tone={!analysis ? 'muted' : analysis.err ? 'neg' : 'pos'} pulse={(live && mode === 'now') || running} />
      <span className="truncate">
        {running && !analysis
          ? 'Loading…'
          : analysis?.source === 'landed'
            ? `landed${analysis.landed?.blockTime ? ` ${timeAgo(analysis.landed.blockTime * 1000)}` : ''}`
            : analysis
              ? timeAgo(analysis.simulatedAt)
              : ''}
        {analysis?.slot ? ` · slot ${analysis.slot.toLocaleString()}` : ''}
      </span>
      {mode === 'now' ? <Switch checked={live} onChange={setLive} label="Live" /> : null}
      <IconButton label="Simulate again" onClick={run} disabled={running} className="h-7 w-7">
        <RefreshIcon size={13} className={running ? 'animate-spin' : ''} />
      </IconButton>
    </div>
  );

  const errorBox = error ? (
    <div className="mb-5 rounded-card bg-neg-soft px-4 py-3 text-sm">
      <div className="font-semibold text-neg">The RPC did not answer</div>
      <div className="mt-0.5 break-words text-ink-2">{error}</div>
      <div className="mt-1 text-xs text-ink-3">Check the RPC URL in Sherlock's settings.</div>
    </div>
  ) : null;

  const summary = analysis ? (
    <div className="space-y-3">
      <ErrorBanner a={analysis} />
      <BalanceCard a={analysis} />
      <ExecutionCard
        a={analysis}
        quote={analysis.jupiter[0] ? quotes[analysis.jupiter[0].path] : undefined}
        onRequote={() => analysis.jupiter[0] && requote(analysis, analysis.jupiter[0].path)}
      />
      <div className="pt-1">
        {analysis.jupiter.map((swap) => (
          <RouteSection key={swap.path} a={analysis} swap={swap} series={series[swap.path] ?? []} />
        ))}
        <RoutersSection a={analysis} />
        <FeesSection a={analysis} defaultOpen={wide} withBreakdown={!wide} />
        <ChecksSection a={analysis} defaultOpen={wide} />
        <OthersSection
          a={analysis}
          renderAddress={(address) => <AddressLink address={address} labels={analysis.labels} />}
        />
      </div>
    </div>
  ) : null;

  const detail = (id: DetailId) =>
    !analysis ? null : id === 'instructions' ? (
      <InstructionsTab a={analysis} />
    ) : id === 'accounts' ? (
      <AccountsTab a={analysis} />
    ) : id === 'compute' ? (
      <ComputeSection a={analysis} defaultOpen />
    ) : id === 'logs' ? (
      <LogsTab a={analysis} />
    ) : (
      <RawTab a={analysis} base64={base64} explorerUrl={explorerInspectorUrl(bytes)} onExport={exportReport} />
    );

  if (wide) {
    return (
      <div>
        <div className="mb-3 flex items-center gap-3">{status}</div>
        {errorBox}
        {!analysis ? (
          error ? null : (
            <Skeleton />
          )
        ) : (
          <div className="grid grid-cols-[minmax(440px,520px)_minmax(0,1fr)] items-start gap-6">
            <div className="min-w-0">{summary}</div>
            <div className="min-w-0 rounded-card border border-line bg-raised p-4">
              <Segmented<DetailId>
                value={detailTab}
                onChange={setDetailTab}
                items={[
                  { id: 'instructions', label: `Instructions · ${analysis.instructions.length}` },
                  { id: 'accounts', label: `Accounts · ${analysis.accounts.length}` },
                  { id: 'compute', label: 'Compute' },
                  { id: 'logs', label: 'Logs' },
                  { id: 'raw', label: 'Raw' },
                ]}
              />
              <div key={detailTab} className="fade-in mt-4">
                {detail(detailTab)}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2.5 flex items-center gap-3">
        <Segmented<TabId>
          value={tab}
          onChange={setTab}
          items={[
            { id: 'summary', label: 'Summary' },
            { id: 'instructions', label: `Instructions${analysis ? ` · ${analysis.instructions.length}` : ''}` },
            { id: 'accounts', label: 'Accounts' },
            { id: 'logs', label: 'Logs' },
            { id: 'raw', label: 'Raw' },
          ]}
        />
        {status}
      </div>
      {errorBox}
      {!analysis ? (
        error ? null : (
          <Skeleton />
        )
      ) : (
        <div key={tab} className="fade-in">
          {tab === 'summary' ? summary : detail(tab)}
        </div>
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
  replay: 'Landed transaction',
};

export const Inspect: FC = () => {
  const { accounts } = useAccounts();
  const id = new URLSearchParams(window.location.search).get('request');
  const [request, setRequest] = useState<InspectRequest | null>();
  // With several transactions the bundle view comes first (-1), then each transaction.
  const [txIndex, setTxIndex] = useState(-1);
  const [live, setLive] = useState(true);

  const { rpcUrl } = useConnection();
  const [landed, setLanded] = useState<Execution>();
  const [latest, setLatest] = useState<{ a: Analysis; base64: string }>();
  const [copied, setCopied] = useState(false);
  const copyReport = async () => {
    if (!latest || !request) return;
    let rpcHost: string | undefined;
    try {
      rpcHost = new URL(rpcUrl).host;
    } catch {
      rpcHost = undefined;
    }
    const text = supportReport(latest.a, {
      origin: request.origin,
      method: request.method,
      transactionBase64: latest.base64,
      rpcHost,
    });
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    rpc.callMethod('getRequest', [id]).then(async (r: InspectRequest | null) => {
      if (r?.method === 'replay' && r.signature && !r.transactions?.length) {
        try {
          const result = await fetchLanded(rpcUrl, r.signature);
          setLanded(result.execution);
          setRequest({ ...r, transactions: [Buffer.from(result.transaction).toString('base64')] });
        } catch (e) {
          setLoadError((e as Error).message);
          setRequest(null);
        }
        return;
      }
      setRequest(r ?? null);
    });
  }, [id, rpcUrl]);

  const label = request ? accounts.find((a) => a.address.toBase58() === request.address)?.label : undefined;
  const count = request?.transactions?.length ?? 0;
  const activeIndex = count > 1 ? txIndex : 0;
  const bundleBytes = useMemo(() => (request?.transactions ?? []).map(fromBase64), [request]);
  const addressBook = useMemo(
    () => Object.fromEntries(accounts.map((acc) => [acc.address.toBase58(), acc.label])),
    [accounts]
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-canvas px-3 py-2">
        <IconButton label={request?.method === 'paste' ? 'Close' : 'Reject and close'} onClick={() => window.close()}>
          <XIcon size={18} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold leading-tight">
            {request?.origin
              ? request.origin.replace(/^https?:\/\//, '')
              : request
                ? METHOD_LABEL[request.method]
                : 'Sherlock'}
          </div>
          {request?.origin ? (
            <div className="truncate text-[11px] text-ink-2">{METHOD_LABEL[request.method]}</div>
          ) : null}
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

      <main className="flex-1 px-5 pb-4 pt-3">
        {request === undefined ? <Skeleton /> : null}
        {request === null ? (
          <p className="text-sm text-ink-2">{loadError ?? 'This request is no longer in the history.'}</p>
        ) : null}
        {request?.kind === 'message' ? <MessageView request={request} /> : null}
        {request?.kind === 'transactions' ? (
          <>
            {count > 1 ? (
              <div className="mb-3 flex items-center gap-2">
                <Pill>{count} transactions</Pill>
                <Segmented<string>
                  value={String(activeIndex)}
                  onChange={(v) => setTxIndex(Number(v))}
                  items={[
                    { id: '-1', label: 'Bundle' },
                    ...request.transactions!.map((_, i) => ({ id: String(i), label: `${i + 1}` })),
                  ]}
                />
              </div>
            ) : null}
            {count > 1 && activeIndex === -1 ? (
              <BundleView
                rpcUrl={rpcUrl}
                transactions={bundleBytes}
                user={request.address}
                addressBook={addressBook}
                onOpen={setTxIndex}
              />
            ) : null}
            {request.transactions!.map((_, i) => (
              <TxInspector
                key={i}
                request={request}
                index={i}
                active={i === activeIndex}
                live={live}
                setLive={setLive}
                landed={landed}
                onAnalysis={(a, base64) => setLatest({ a, base64 })}
              />
            ))}
          </>
        ) : null}
      </main>

      <footer className="sticky bottom-0 flex gap-3 border-t border-line bg-canvas px-5 py-3">
        {request?.kind === 'transactions' ? (
          <Button
            kind="outline"
            size="md"
            onClick={copyReport}
            disabled={!latest}
            title="Copies a Markdown report with a command that reproduces the simulation"
          >
            {copied ? <CheckIcon size={14} className="text-pos" /> : <CopyIcon size={14} />}
            {copied ? 'Copied' : 'Copy report for support'}
          </Button>
        ) : null}
        <Button kind="dark" size="md" className="flex-1" onClick={() => window.close()}>
          {request?.method === 'paste' || request?.method === 'replay' ? 'Done' : 'Reject and close'}
        </Button>
      </footer>
    </div>
  );
};
