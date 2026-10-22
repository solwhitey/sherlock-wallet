# Solana VM in WebAssembly, inside the extension

**Verdict: feasible with caveats.** LiteSVM 0.16 (Agave 4.2 runtime, sBPF interpreter) compiles to
**wasm64** (memory64) and runs in Chrome and Node with no backend and no local process. It gives the
same results as mainnet `simulateTransaction` on legacy, v0 (lookup tables) and v1 transactions,
Jupiter swaps included: same error, compute units, fee, logs, inner instructions and balance
changes. Overrides work: an empty wallet given SOL and USDC runs a swap that fails without them.

The main caveat: it needs **memory64** (Chrome 133+, Firefox 134+, Node 24+; not Safari), because
`wasm32` is blocked by the runtime's 64-bit pointer assumptions (below), and memory64 needs a
nightly Rust toolchain to build.

## What compiled, what did not

| Target | Result |
| --- | --- |
| `wasm32-unknown-unknown` | **Blocked.** `solana-program-runtime` 4.2.2 `src/memory.rs:49`: `error[E0512]: cannot transmute between types of different sizes … source type: u64 (64 bits), target type: &mut T (32 bits)`. Patching that line would compile but be wrong: CPI and syscalls read guest structs with host layouts (`translate_type::<&[u8]>`, `StableInstruction`, `AccountInfo` in `cpi.rs`), which only match SBF's 64-bit layout on a 64-bit host. Every Jupiter route is CPI. |
| `wasm64-unknown-unknown` (tier 3, `-Zbuild-std`) | **Compiles and runs.** Pointer and `usize` widths match SBF, so the runtime is used unmodified. |

Other pressure points, all solved without touching the runtime:

- **getrandom** (0.2 and 0.3): `compile_error!` on wasm-unknown. Both get a deterministic custom
  backend (`svm-wasm/src/lib.rs`); a simulation needs no entropy. No wasm-bindgen, no JS imports:
  the module has **zero imports**.
- **`std::time::Instant::now()`** panics at run time (`RuntimeError: unreachable` in
  `solana_svm_measure::Measure::start`). Only `solana-svm-measure` uses it; a patched copy
  (`svm-wasm/vendor/solana-svm-measure`, via `[patch.crates-io]`) reads timings as zero on wasm.
- **blst** (C, BLS12-381 syscalls / vote program): Apple clang compiles it for wasm64, but Apple
  `ar` writes an archive with no wasm symbol index, so linking fails with `undefined symbol:
  blst_fp_cneg …`. `build.sh` uses `llvm-ar` from the `llvm-tools` component.
- **JIT**: x86-64 only, and LiteSVM only enables it there; on wasm the interpreter runs.
- **Threads/rayon, zstd**: not in LiteSVM's dependency graph.
- **Precompiles** (ed25519 / secp256k1 / secp256r1, LiteSVM feature `precompiles`): **not
  included**. The feature pulls `openssl-sys` (secp256r1) and fails the build. Transactions with a
  precompile instruction will not simulate yet.
- **Transaction decoding**: bincode/serde cannot read v1 (signatures come after the message);
  `wincode` (the SDK's own wire codec) reads legacy, v0 and v1.
- LiteSVM is pinned to **0.16.0**: 0.18 needs rustc 1.97.1 and the installed nightly is 1.97.0.

Existing work: none found. The `litesvm` npm package is napi native binaries only (darwin/linux
x64/arm64), no wasm build; nothing on crates.io/npm/GitHub search for an SVM in wasm.

## Results against mainnet `simulateTransaction`

Same slot, `sigVerify: false`, `replaceRecentBlockhash: true` (`scripts/wasm-svm-check.ts`):

| Fixture | Format | CU (wasm = rpc) | Logs | Inner ixs | Balances |
| --- | --- | --- | --- | --- | --- |
| tx_transfer | v0 | 300 | 4 = 4 | 0 | identical |
| tx_v1 | v1 (SIMD-0385) | 150, fee 17 345 | 2 = 2 | 0 | identical |
| tx_swap | v0 + ALTs, Jupiter v6, 51 accounts, 7 programs | ~697k | 88 = 88 | 24 = 24 | identical (SOL and SPL) |
| tx_exactout | v0, Jupiter | ~153k–178k | 40 = 40 | 8 = 8 | identical |
| tx_ultra | v0, Jupiter Ultra | ~213k–222k | 50 = 50 | 11 = 11 | identical |
| tx_user_rfq | v0, failing RFQ | 9 095, `Custom 2506` | 11 = 11 | 0 | identical |
| tx_hostile | legacy | 273 | 5 = 5 | 0 | identical |
| tx_zeroslip | v0, Jupiter | differs | — | 24 = 24 | the RPC simulated one slot later; prop AMM state moved |

CU varies run to run because the pools move; within one run both sides agree to the unit.

Override proof (`scripts/wasm-svm-override.ts`): a fresh random wallet asks Jupiter for a
100 USDC → SOL swap. RPC and wasm both fail with `AccountNotFound`. With
`{ overrides: { [wallet]: { lamports: 0.05 SOL } }, tokenBalances: [{ owner: wallet, mint: USDC, amount: 100e6 }] }`
the wasm VM runs it: `err: null`, ~85–93k CU, wallet 0.05 → 1.015 SOL, USDC 100 → 0.

One fix that mattered: the clock sysvar must be fetched in the same `getMultipleAccounts` batch as
the transaction's accounts. With the clock one round earlier, a prop AMM (Tessera) saw an oracle
update newer than the clock and failed with `0xffff`.

## Numbers

| | |
| --- | --- |
| WASM size | 6.75 MB, 2.78 MB gzip (no `wasm-opt`; binaryen not installed) |
| JS loader | 26 KB in the Parcel bench bundle (incl. its share of @solana/kit) |
| Instantiate (cold) | 24–35 ms Chrome 152 (`instantiateStreaming`), 15–30 ms Node 24 |
| Swap fixture, account data | 7.35 MB (ELF-trimmed; 17.7 MB as stored: one program data account is the 10 MiB max, mostly padding) |
| Swap fixture, fetch | 0.5–1.8 s Node, 1.3 s Chrome (4 RPC round trips) |
| Swap fixture, load accounts + compile 7 programs | 76–100 ms cold in Chrome, 23–51 ms Node; 2–22 ms warm |
| Swap fixture, simulate (~700k CU, interpreter) | 30–74 ms cold Chrome, ~27–32 ms warm; 9–40 ms Node |
| Swap fixture, warm with program cache | **~400 ms total** in Chrome, 848 KB fetched (one 719 KB GoonFi account) |
| Plain transfer | ~150 ms total, almost all RPC |

Fetch dominates. With program data cached (keyed by the deploy slot from its 45-byte header), a
swap re-simulation costs one small round trip for the header slices plus the mutable accounts.

## How it works

- `svm-wasm/` — Rust crate, LiteSVM with a C-style ABI (no wasm-bindgen): `svm_alloc/svm_free`,
  `svm_reset`, `svm_set_account(packed)`, `svm_simulate(tx wire bytes)`, `svm_out_ptr/len` (JSON).
  The VM is built with mainnet features, builtins and sysvars, without LiteSVM's bundled SPL ELFs
  (the real programs come from the RPC), sigverify and blockhash checks off, Agave's 10 KB log cap.
- `src/sim/wasmSvm.ts` — `simulateInWasm(rpcUrl, txBytes, { overrides, tokenBalances, programCache })`
  returns `{ value, slot, timings, fetchedBytes, accountCount }`; `value` has the
  `simulateTransaction` shape (`err, logs, fee, unitsConsumed, returnData, preBalances,
  postBalances, preTokenBalances, postTokenBalances, innerInstructions (programIdIndex/accounts/
  base58 data/stackHeight), loadedAddresses, loadedAccountsDataSize`), ready for `analyze()`'s
  `execution` (add a `'wasm'` source to `Execution['source']`).
- Account loading, 4 round trips: (1) lookup tables; (2) every transaction account + sysvars
  (clock, rent, epoch schedule, epoch rewards, last restart slot, slot hashes) + override targets,
  in one batch; (3) program data of upgradeable programs and mints of token accounts (decimals).
  Program data is fetched as a 557-byte slice first (loader header + ELF header + program headers),
  then only the ELF's own length (section table end, or furthest segment for SBPFv3 ELFs without
  sections). Optional `programCache` (`get/set` of bytes) skips the second fetch; back it with
  IndexedDB in the extension.
- The VM instance is long-lived: programs are only recompiled when their program data slot changes;
  every other account is re-pushed each run, and accounts that do not exist are pushed empty so
  nothing leaks from a previous simulation.
- Overrides: `overrides[address] = { lamports?, data?, owner?, executable? }` patches or creates any
  account (programs too); `tokenBalances: [{ owner, mint, amount }]` sets the owner's ATA (created
  if missing, Token or Token-2022 from the mint's owner). Pre balances reflect the overrides.
- Token balances are computed in TS from pre/post account data (Token and Token-2022 accounts).

## Build and run

```sh
rustup toolchain install nightly --component rust-src llvm-tools   # once
svm-wasm/build.sh                     # → src/sim/svm.wasm (not committed; about a minute from cold, seconds after)
RPC_URL_FILE=path/to/rpc.txt npx tsx scripts/wasm-svm-check.ts tx_transfer.b64 tx_v1.b64 tx_swap.b64
RPC_URL_FILE=path/to/rpc.txt npx tsx scripts/wasm-svm-override.ts
# browser bench (Parcel bundles the .wasm as an asset):
npx parcel build scripts/wasm-bench/index.html --dist-dir /tmp/bench --public-url ./
# serve /tmp/bench with an rpc.txt and a fixture next to it, open index.html?tx=tx_swap.b64
```

Extension integration needs, in `src/manifest.json`:

```json
"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }
```

plus host permission for the RPC. `new URL('./svm.wasm', import.meta.url)` in `wasmSvm.ts` is what
Parcel turns into the bundled asset URL (checked with the bench build).

## Caveats

1. **memory64 only.** Chrome 133+ / Firefox 134+ / Node 24+. No Safari. Building needs nightly +
   `-Zbuild-std` (tier-3 target); pin a nightly date for reproducible builds.
2. **No precompiles** (ed25519/secp256k1/secp256r1 verify instructions). Next step: vendor
   `agave-precompiles` without secp256r1 (openssl), or register pure-Rust versions.
3. **Feature set** is LiteSVM 0.16's hard-coded mainnet snapshot. A feature activated since then
   can change CU or behaviour. Fix: fetch the feature accounts and build the `FeatureSet` from them
   (one `getMultipleAccounts` over ~250 ids, cacheable per epoch).
4. **State consistency.** Accounts beyond 100 per batch come from several calls (different slots);
   a live pool can move between the RPC's slot and ours (tx_zeroslip). Same class of issue as any
   client-side fork; surfpool has it too.
5. **Not modelled:** epoch stakes (`sol_get_epoch_stake` returns 0), stake history / recent
   blockhashes / fees sysvars (LiteSVM defaults), `loadedAccountsDataSize` is approximate (program
   data counted at ELF length, not account length, so a transaction near its loaded-data limit
   could pass here and fail on chain).
6. **MV3 service worker** can be stopped after ~30 s idle; the VM (and its compiled programs) is
   then rebuilt on the next call (~100 ms plus fetch). Keep program bytes in IndexedDB, or run the VM
   in the popup / an offscreen document.
7. Memory: the VM keeps every loaded program's bytes and compiled executable until `svm_reset`
   (not measured; linear memory only grows, so reset it when the program set churns).

## Recommended next step

Integrate behind a setting as an alternative to RPC simulation: `simulateInWasm` → `analyze({
execution: { value, slot, source: 'wasm' } })`, IndexedDB `programCache`, CSP line above. Then, in
order: build the feature set from chain, add precompiles without openssl, run `wasm-opt -O3`
(expect ~20–30 % smaller), and pin the nightly. The override UI (fake balances) is the feature RPC
simulation cannot offer, so that is where this pays off first.
