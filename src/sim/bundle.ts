import { analyze, Analysis, AssetDelta } from './analyze';
import { rpcCall } from './rpc';

export type BundleSimulation = {
  // 'bundle': one simulateBundle call, in sequence. 'independent': the RPC has no simulateBundle,
  // so each transaction was simulated on its own from the same starting state.
  mode: 'bundle' | 'independent';
  unsupportedReason?: string;
  slot?: number;
  succeeded: boolean;
  // Index of the transaction that failed, when the RPC says which.
  failedIndex?: number;
  failure?: string;
  // One analysis per transaction that ran, in order, each against the state the previous left.
  results: Analysis[];
  // The viewing address's net change over the whole bundle.
  net: AssetDelta[];
};

export class BundleUnsupported extends Error {}

// Jito's simulateBundle (on Jito-enabled RPCs, e.g. Triton): the transactions run in sequence on
// one bank, unlike separate simulateTransaction calls that each start from the same state.
export async function simulateBundle(
  rpcUrl: string,
  transactions: Uint8Array[],
  user: string | undefined,
  addressBook?: Record<string, string>
): Promise<BundleSimulation> {
  const encoded = transactions.map((t) => Buffer.from(t).toString('base64'));
  let result: any;
  try {
    result = await rpcCall<any>(rpcUrl, 'simulateBundle', [
      { encodedTransactions: encoded },
      {
        skipSigVerify: true,
        replaceRecentBlockhash: true,
        transactionEncoding: 'base64',
        preExecutionAccountsConfigs: encoded.map(() => null),
        postExecutionAccountsConfigs: encoded.map(() => null),
      },
    ]);
  } catch (e) {
    const message = (e as Error).message;
    if (/disabled|not found|invalid method|method not found|-32601|410/i.test(message)) {
      throw new BundleUnsupported(message);
    }
    throw e;
  }

  const value = result.value;
  const summary = value.summary;
  const succeeded = summary === 'succeeded';
  const entries: any[] = value.transactionResults ?? [];
  const results: Analysis[] = [];
  for (let i = 0; i < entries.length; i++) {
    results.push(
      await analyze({
        rpcUrl,
        transaction: transactions[i],
        user,
        addressBook,
        execution: { value: entries[i], slot: result.context?.slot, source: 'bundle' },
      })
    );
  }
  const failedIndex = succeeded ? undefined : results.findIndex((r) => r.err);

  const net = new Map<string, AssetDelta>();
  for (const r of results) {
    for (const c of r.userChanges) {
      const prev = net.get(c.mint);
      if (prev) prev.delta += c.delta;
      else net.set(c.mint, { ...c });
    }
  }

  return {
    mode: 'bundle',
    slot: result.context?.slot,
    succeeded,
    failedIndex: failedIndex !== undefined && failedIndex >= 0 ? failedIndex : undefined,
    failure: succeeded
      ? undefined
      : typeof summary === 'object'
        ? JSON.stringify(summary.failed?.error ?? summary)
        : String(summary),
    results,
    net: [...net.values()].filter((c) => c.delta !== 0n),
  };
}

// Bundle simulation when the RPC offers it, otherwise each transaction on its own: requests with
// several transactions always get a result, labelled with how it was obtained.
export async function simulateSequence(
  rpcUrl: string,
  transactions: Uint8Array[],
  user: string | undefined,
  addressBook?: Record<string, string>
): Promise<BundleSimulation> {
  try {
    return await simulateBundle(rpcUrl, transactions, user, addressBook);
  } catch (e) {
    if (!(e instanceof BundleUnsupported)) throw e;
    const results = await Promise.all(
      transactions.map((transaction) => analyze({ rpcUrl, transaction, user, addressBook }))
    );
    const net = new Map<string, AssetDelta>();
    for (const r of results) {
      for (const c of r.userChanges) {
        const prev = net.get(c.mint);
        if (prev) prev.delta += c.delta;
        else net.set(c.mint, { ...c });
      }
    }
    const failedIndex = results.findIndex((r) => r.err);
    return {
      mode: 'independent',
      unsupportedReason: e.message,
      slot: results[0]?.slot,
      succeeded: failedIndex < 0,
      failedIndex: failedIndex >= 0 ? failedIndex : undefined,
      results,
      net: [...net.values()].filter((c) => c.delta !== 0n),
    };
  }
}
