// Browser bench for the WASM SVM: `npx parcel build scripts/wasm-bench/index.html --dist-dir <dir>`
// then serve <dir> and open index.html?rpc=<url>[&tx=<file.b64>]. Shows the same numbers as
// scripts/wasm-svm-check.ts, measured in the browser (instantiate, fetch, load, simulate).
import { simulateInWasm } from '../../src/sim/wasmSvm';

const params = new URLSearchParams(location.search);
// ?rpc=<url>, else an rpc.txt served next to the page (keeps API keys out of the URL bar).
let rpc = params.get('rpc') ?? 'https://api.mainnet-beta.solana.com';
const rpcReady = params.get('rpc')
  ? Promise.resolve()
  : fetch('rpc.txt')
      .then((r) => (r.ok ? r.text() : undefined))
      .then((t) => void (t?.startsWith('http') && (rpc = t.trim())))
      .catch(() => undefined);
const out = document.getElementById('out')!;
const input = document.getElementById('tx') as HTMLTextAreaElement;
const log = (s: string) => (out.textContent += s + '\n');

async function run() {
  await rpcReady;
  const bytes = Uint8Array.from(atob(input.value.trim()), (c) => c.charCodeAt(0));
  // In-memory program cache; the extension would back this with IndexedDB.
  const blobs = new Map<string, Uint8Array>();
  const programCache = {
    get: async (k: string) => blobs.get(k),
    set: async (k: string, v: Uint8Array) => void blobs.set(k, v),
  };
  for (const label of ['cold', 'warm (programs cached)']) {
    const t = performance.now();
    const r = await simulateInWasm(rpc, bytes, { programCache });
    const v = r.value;
    log(
      `${label}: total=${(performance.now() - t).toFixed(0)}ms ${Object.entries(r.timings)
        .map(([k, x]) => `${k}=${x.toFixed(0)}`)
        .join(
          ' '
        )} fetched=${(r.fetchedBytes / 1024).toFixed(0)}KiB err=${JSON.stringify(v.err)} cu=${v.unitsConsumed} fee=${v.fee} logs=${v.logs.length}`
    );
  }
  (window as any).done = true;
}

document.getElementById('run')!.onclick = () => run().catch((e) => log(String(e?.stack ?? e)));
const fixture = params.get('tx');
if (fixture)
  fetch(fixture)
    .then((r) => r.text())
    .then((t) => {
      input.value = t.trim();
      return run();
    })
    .catch((e) => log(String(e?.stack ?? e)));
