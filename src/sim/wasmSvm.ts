// Runs a transaction in LiteSVM compiled to WebAssembly (svm-wasm/, memory64), against mainnet
// state fetched lazily over RPC, with optional overrides (fake balances, replaced accounts).
// No backend, no local process: the VM lives in the page/worker that calls this.
//
// The result has the shape of simulateTransaction's `value`, so analyze() can take it as a
// precomputed execution.
//
// Extension pages need `'wasm-unsafe-eval'` in their CSP to instantiate the module. The module
// uses memory64 (Chrome 133+, Node 24+): Solana's runtime assumes 64-bit host pointers.
import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/kit';
import { getMultipleAccounts, rpcCall, type RawAccount } from './rpc';
import { parseTransaction } from './tx';

export type AccountOverride = {
  lamports?: bigint | number;
  data?: Uint8Array;
  owner?: string;
  executable?: boolean;
};

// Sets `owner`'s associated token account for `mint` to `amount` (creating it if needed).
export type TokenBalanceOverride = { owner: string; mint: string; amount: bigint | number };

export type WasmSimOptions = {
  overrides?: Record<string, AccountOverride>;
  tokenBalances?: TokenBalanceOverride[];
  // Optional cache hook for immutable-ish blobs (program data), e.g. IndexedDB in the extension.
  programCache?: ProgramCache;
};

export type ProgramCache = {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
};

export type WasmSimTimings = { loadWasmMs: number; fetchMs: number; setAccountsMs: number; simulateMs: number };

export type WasmSimResult = {
  value: any; // simulateTransaction's value
  slot: number;
  timings: WasmSimTimings;
  fetchedBytes: number;
  accountCount: number;
};

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const NATIVE_LOADER = 'NativeLoader1111111111111111111111111111111';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const SYSVARS = [
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'SysvarEpochSchedu1e111111111111111111111111',
  'SysvarEpochRewards1111111111111111111111111',
  'SysvarLastRestartS1ot1111111111111111111111',
  'SysvarS1otHashes111111111111111111111111111',
];
const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111';
const TOKEN_ACCOUNT_RENT = 2_039_280n;

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();
const encodeAddress = (a: string) => addressEncoder.encode(a as Address) as Uint8Array;
const decodeAddress = (b: Uint8Array) => addressDecoder.decode(b) as string;
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const readU64 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true);

type Acc = { lamports: bigint; owner: string; data: Uint8Array; executable: boolean; rentEpoch: bigint };

// ---------------------------------------------------------------- module loading

type Exports = {
  memory: WebAssembly.Memory;
  svm_alloc(len: bigint): bigint;
  svm_free(ptr: bigint, len: bigint): void;
  svm_out_ptr(): bigint;
  svm_out_len(): bigint;
  svm_reset(): void;
  svm_set_account(ptr: bigint, len: bigint): number;
  svm_simulate(ptr: bigint, len: bigint): number;
};

let wasmSource: string | URL | Uint8Array | undefined;
let instance: Promise<Exports> | undefined;

// Override where the module comes from (bytes, or a URL). Defaults to the bundled svm.wasm.
export function setWasmSource(source: string | URL | Uint8Array) {
  wasmSource = source;
  instance = undefined;
}

async function loadBytes(): Promise<Uint8Array | Response> {
  // Parcel turns `new URL('./svm.wasm', import.meta.url)` into a bundled asset URL. Node scripts
  // pass the bytes with setWasmSource (fetch cannot read file: URLs).
  const source = wasmSource ?? new URL('./svm.wasm', import.meta.url);
  if (source instanceof Uint8Array) return source;
  return fetch(source);
}

function loadModule(): Promise<Exports> {
  instance ??= (async () => {
    const bytes = await loadBytes();
    const result: WebAssembly.WebAssemblyInstantiatedSource =
      bytes instanceof Uint8Array
        ? await WebAssembly.instantiate(bytes as unknown as ArrayBuffer, {})
        : await WebAssembly.instantiateStreaming(bytes, {});
    return result.instance.exports as unknown as Exports;
  })();
  return instance;
}

function call(wasm: Exports, fn: 'svm_set_account' | 'svm_simulate', bytes: Uint8Array) {
  const len = BigInt(bytes.length);
  const ptr = wasm.svm_alloc(len);
  new Uint8Array(wasm.memory.buffer, Number(ptr), bytes.length).set(bytes);
  const code = wasm[fn](ptr, len);
  wasm.svm_free(ptr, len);
  return code;
}

function readOut(wasm: Exports) {
  const ptr = Number(wasm.svm_out_ptr());
  const len = Number(wasm.svm_out_len());
  return JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, ptr, len)));
}

function setAccount(wasm: Exports, address: string, acc: Acc) {
  const buf = new Uint8Array(81 + acc.data.length);
  const view = new DataView(buf.buffer);
  buf.set(encodeAddress(address), 0);
  buf.set(encodeAddress(acc.owner), 32);
  view.setBigUint64(64, acc.lamports, true);
  view.setBigUint64(72, acc.rentEpoch, true);
  buf[80] = acc.executable ? 1 : 0;
  buf.set(acc.data, 81);
  if (call(wasm, 'svm_set_account', buf) !== 0) throw new Error(readOut(wasm).error);
}

// ---------------------------------------------------------------- account loading

function toAcc(raw: RawAccount): Acc | undefined {
  if (!raw) return undefined;
  const epoch = (raw as { rentEpoch?: number }).rentEpoch; // u64::MAX does not survive JSON numbers
  const rentEpoch = epoch !== undefined && Number.isSafeInteger(epoch) ? BigInt(epoch) : 2n ** 64n - 1n;
  return {
    lamports: BigInt(raw.lamports),
    owner: raw.owner,
    data: fromBase64(raw.data[0]),
    executable: raw.executable,
    rentEpoch,
  };
}

class Loader {
  accounts = new Map<string, Acc | undefined>();
  fetchedBytes = 0;
  constructor(
    private rpcUrl: string,
    private programCache?: ProgramCache
  ) {}

  async load(addresses: string[]) {
    const missing = [...new Set(addresses)].filter((a) => !this.accounts.has(a));
    if (!missing.length) return;
    const raws = await getMultipleAccounts(this.rpcUrl, missing);
    raws.forEach((raw, i) => {
      if (raw) this.fetchedBytes += Math.floor((raw.data[0].length * 3) / 4);
      this.accounts.set(missing[i], toAcc(raw));
    });
  }

  // Program data accounts are big (often allocated at the 10 MiB maximum, mostly zero padding)
  // and change only on upgrade. Fetch the 45-byte loader header plus the ELF header first, then
  // only the ELF's own bytes; with a cache, reuse the bytes stored for that deploy slot.
  async loadProgramData(addresses: string[]) {
    const missing = [...new Set(addresses)].filter((a) => !this.accounts.has(a));
    if (!missing.length) return;
    const headers = await rpcCall<{ value: (RawAccount & { rentEpoch?: number })[] }>(
      this.rpcUrl,
      'getMultipleAccounts',
      [missing, { encoding: 'base64', dataSlice: { offset: 0, length: PROGRAMDATA_HEADER + ELF_HEAD } }]
    );
    await Promise.all(
      headers.value.map(async (raw, i) => {
        const address = missing[i];
        if (!raw) return this.accounts.set(address, undefined);
        const head = fromBase64(raw.data[0]);
        const key = `programdata:${address}:${readU64(head, 4)}`;
        const cached = await this.programCache?.get(key);
        if (cached) return this.accounts.set(address, { ...toAcc(raw)!, data: cached });
        const elfLength = elfSize(head.subarray(PROGRAMDATA_HEADER));
        const result = await rpcCall<{ value: (RawAccount & { rentEpoch?: number })[] }>(
          this.rpcUrl,
          'getMultipleAccounts',
          [
            [address],
            elfLength
              ? { encoding: 'base64', dataSlice: { offset: 0, length: PROGRAMDATA_HEADER + elfLength } }
              : { encoding: 'base64' },
          ]
        );
        const acc = toAcc(result.value[0]);
        if (acc) this.fetchedBytes += acc.data.length;
        this.accounts.set(address, acc);
        if (acc) await this.programCache?.set(key, acc.data);
      })
    );
  }
}

const PROGRAMDATA_HEADER = 45; // UpgradeableLoaderState::ProgramData: tag, slot, Option<authority>

const ELF_HEAD = 512; // ELF64 header + up to 8 program headers

// Size of an ELF64 image from its first bytes: the end of the section header table (classic
// SBPF ELFs put it last) or of the furthest segment (SBPFv3 ELFs have no section headers).
// Undefined when it cannot be told, and the whole account is fetched.
function elfSize(h: Uint8Array): number | undefined {
  if (h.length < 64 || h[0] !== 0x7f || h[1] !== 0x45 || h[2] !== 0x4c || h[3] !== 0x46 || h[4] !== 2) return undefined;
  const v = new DataView(h.buffer, h.byteOffset, h.length);
  const phoff = Number(v.getBigUint64(0x20, true));
  const phentsize = v.getUint16(0x36, true);
  const phnum = v.getUint16(0x38, true);
  let end = Math.max(64, Number(v.getBigUint64(0x28, true)) + v.getUint16(0x3a, true) * v.getUint16(0x3c, true));
  if (phoff + phentsize * phnum > h.length || phentsize < 56) return undefined;
  end = Math.max(end, phoff + phentsize * phnum);
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    end = Math.max(end, Number(v.getBigUint64(o + 8, true)) + Number(v.getBigUint64(o + 32, true)));
  }
  return end;
}

function programDataAddress(acc: Acc | undefined): string | undefined {
  // UpgradeableLoaderState::Program { programdata_address }: u32 tag 2, then 32 bytes.
  if (!acc || acc.owner !== UPGRADEABLE_LOADER || acc.data.length < 36) return undefined;
  if (new DataView(acc.data.buffer, acc.data.byteOffset).getUint32(0, true) !== 2) return undefined;
  return decodeAddress(acc.data.subarray(4, 36));
}

function lookupTableAddresses(acc: Acc | undefined, address: string): string[] {
  if (!acc) throw new Error(`lookup table ${address} not found`);
  const out: string[] = [];
  for (let o = 56; o + 32 <= acc.data.length; o += 32) out.push(decodeAddress(acc.data.subarray(o, o + 32)));
  return out;
}

async function ataAddress(owner: string, mint: string, tokenProgram: string) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM as Address,
    seeds: [encodeAddress(owner), encodeAddress(tokenProgram), encodeAddress(mint)],
  });
  return pda as string;
}

function tokenAccountData(mint: string, owner: string, amount: bigint) {
  // spl-token Account: mint, owner, amount, delegate (COption), state, is_native (COption),
  // delegated_amount, close_authority (COption). 165 bytes.
  const data = new Uint8Array(165);
  data.set(encodeAddress(mint), 0);
  data.set(encodeAddress(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1; // Initialized
  return data;
}

// ---------------------------------------------------------------- token balances

function tokenBalance(index: number, acc: Acc | undefined, mints: Map<string, Acc | undefined>) {
  if (!acc || (acc.owner !== TOKEN_PROGRAM && acc.owner !== TOKEN_2022_PROGRAM) || acc.data.length < 165) return;
  if (acc.data.length > 165 && acc.data[165] !== 2) return; // Token-2022: AccountType::Account
  if (acc.data[108] === 0) return; // uninitialized
  const mint = decodeAddress(acc.data.subarray(0, 32));
  const decimals = mints.get(mint)?.data[44] ?? 0;
  const amount = readU64(acc.data, 64);
  const ui = Number(amount) / 10 ** decimals;
  return {
    accountIndex: index,
    mint,
    owner: decodeAddress(acc.data.subarray(32, 64)),
    programId: acc.owner,
    uiTokenAmount: {
      amount: amount.toString(),
      decimals,
      uiAmount: ui,
      uiAmountString: decimals
        ? (Number(amount) / 10 ** decimals).toFixed(decimals).replace(/\.?0+$/, '')
        : amount.toString(),
    },
  };
}

// ---------------------------------------------------------------- simulate

// Tracks what the long-lived VM holds, so programs are only recompiled after an upgrade.
const vmPrograms = new Map<string, string>(); // program address -> programdata slot (or 'inline')

export async function simulateInWasm(
  rpcUrl: string,
  txBytes: Uint8Array,
  options: WasmSimOptions = {}
): Promise<WasmSimResult> {
  const t0 = performance.now();
  const wasm = await loadModule();
  const t1 = performance.now();

  const tx = parseTransaction(txBytes);
  if (!tx) throw new Error('could not decode transaction');
  const loader = new Loader(rpcUrl, options.programCache);

  // Round 1: lookup tables.
  await loader.load(tx.lookups.map((l) => l.accountKey));
  const loaded = { writable: [] as string[], readonly: [] as string[] };
  for (const l of tx.lookups) {
    const table = lookupTableAddresses(loader.accounts.get(l.accountKey), l.accountKey);
    loaded.writable.push(...l.writableIndexes.map((i) => table[i]));
    loaded.readonly.push(...l.readonlyIndexes.map((i) => table[i]));
  }
  const keys = [...tx.staticKeys, ...loaded.writable, ...loaded.readonly];

  // Token balance overrides: resolve the mint's program and the ATA, so the ATA is fetched too.
  const tokenOverrides: { address: string; mint: string; owner: string; amount: bigint; program: string }[] = [];
  if (options.tokenBalances?.length) {
    await loader.load(options.tokenBalances.map((t) => t.mint));
    for (const t of options.tokenBalances) {
      const program = loader.accounts.get(t.mint)?.owner ?? TOKEN_PROGRAM;
      const address = await ataAddress(t.owner, t.mint, program);
      tokenOverrides.push({ address, mint: t.mint, owner: t.owner, amount: BigInt(t.amount), program });
    }
  }

  // Round 2, one batch so the state and the clock come from about the same slot (prop AMMs
  // reject quotes whose oracle update looks newer than the clock): every transaction account,
  // the sysvars, and override targets.
  await loader.load([...keys, ...SYSVARS, ...tokenOverrides.map((t) => t.address)]);
  // Round 3: program data of upgradeable programs, and mints of token accounts (for decimals).
  const programData = keys.map((k) => programDataAddress(loader.accounts.get(k))).filter((a): a is string => !!a);
  const mintKeys = keys
    .map((k) => loader.accounts.get(k))
    .filter((a) => a && (a.owner === TOKEN_PROGRAM || a.owner === TOKEN_2022_PROGRAM) && a.data.length >= 165)
    .map((a) => decodeAddress(a!.data.subarray(0, 32)));
  await Promise.all([loader.loadProgramData(programData), loader.load(mintKeys)]);
  const t2 = performance.now();

  // Apply overrides.
  const state = new Map(loader.accounts);
  for (const t of tokenOverrides) {
    const existing = state.get(t.address);
    const data = existing ? Uint8Array.from(existing.data) : tokenAccountData(t.mint, t.owner, t.amount);
    new DataView(data.buffer).setBigUint64(64, t.amount, true);
    state.set(t.address, {
      lamports: existing?.lamports ?? TOKEN_ACCOUNT_RENT,
      owner: t.program,
      data,
      executable: false,
      rentEpoch: existing?.rentEpoch ?? 2n ** 64n - 1n,
    });
  }
  for (const [address, o] of Object.entries(options.overrides ?? {})) {
    const base = state.get(address) ?? {
      lamports: 0n,
      owner: SYSTEM_PROGRAM,
      data: new Uint8Array(),
      executable: false,
      rentEpoch: 2n ** 64n - 1n,
    };
    state.set(address, {
      lamports: o.lamports !== undefined ? BigInt(o.lamports) : base.lamports,
      owner: o.owner ?? base.owner,
      data: o.data ?? base.data,
      executable: o.executable ?? base.executable,
      rentEpoch: base.rentEpoch,
    });
  }

  // Push into the VM: sysvars, then plain accounts and program data, then programs (they need
  // their program data present to compile). Absent accounts are pushed as empty, which removes
  // whatever an earlier simulation left.
  const empty: Acc = { lamports: 0n, owner: SYSTEM_PROGRAM, data: new Uint8Array(), executable: false, rentEpoch: 0n };
  const programs: string[] = [];
  const tables = tx.lookups.map((l) => l.accountKey); // the VM resolves lookups itself
  for (const address of [...SYSVARS, ...tables, ...programData, ...keys, ...tokenOverrides.map((t) => t.address)]) {
    const acc = state.get(address);
    if (address === INSTRUCTIONS_SYSVAR || acc?.owner === NATIVE_LOADER) continue;
    if (acc?.executable) {
      programs.push(address);
      continue;
    }
    setAccount(wasm, address, acc ?? empty);
  }
  for (const address of new Set(programs)) {
    const acc = state.get(address)!;
    const pd = programDataAddress(acc);
    const version = pd ? `${pd}:${readU64(state.get(pd)?.data ?? new Uint8Array(12), 4)}` : `inline:${acc.data.length}`;
    if (vmPrograms.get(address) === version && !options.overrides?.[address]) continue;
    setAccount(wasm, address, acc);
    vmPrograms.set(address, version);
  }
  const t3 = performance.now();

  // The VM takes the raw wire bytes (bincode VersionedTransaction, legacy/v0/v1).
  if (call(wasm, 'svm_simulate', txBytes) !== 0) throw new Error(readOut(wasm).error);
  const out = readOut(wasm);
  const t4 = performance.now();

  // Map onto simulateTransaction's shape.
  const post = new Map<string, Acc>();
  for (const p of out.postAccounts as any[]) {
    post.set(p.pubkey, {
      lamports: BigInt(p.lamports),
      owner: p.owner,
      data: fromBase64(p.data),
      executable: p.executable,
      rentEpoch: 0n,
    });
  }
  const preAcc = keys.map((k) => state.get(k));
  const postAcc = keys.map((k, i) => post.get(k) ?? preAcc[i]);
  const postBalances = postAcc.map((a) => Number(a?.lamports ?? 0n));
  if (out.err && post.size === 0 && postBalances.length) postBalances[0] = Math.max(0, postBalances[0] - out.fee);
  const mints = new Map([...state].filter(([k]) => mintKeys.includes(k)));
  const value = {
    err: out.err,
    logs: out.logs,
    fee: out.fee,
    unitsConsumed: out.unitsConsumed,
    returnData: out.returnData,
    preBalances: preAcc.map((a) => Number(a?.lamports ?? 0n)),
    postBalances,
    preTokenBalances: preAcc.map((a, i) => tokenBalance(i, a, mints)).filter(Boolean),
    postTokenBalances: postAcc.map((a, i) => tokenBalance(i, a, mints)).filter(Boolean),
    innerInstructions: out.innerInstructions,
    loadedAddresses: loaded,
    loadedAccountsDataSize: [...keys, ...programData].reduce((n, k) => n + (state.get(k)?.data.length ?? 0), 0),
    accounts: null,
  };
  const clock = state.get(SYSVARS[0]);
  return {
    value,
    slot: clock ? Number(readU64(clock.data, 0)) : 0,
    timings: { loadWasmMs: t1 - t0, fetchMs: t2 - t1, setAccountsMs: t3 - t2, simulateMs: t4 - t3 },
    fetchedBytes: loader.fetchedBytes,
    accountCount: keys.length,
  };
}
