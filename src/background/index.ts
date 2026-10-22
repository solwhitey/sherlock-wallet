import type { RPC } from '../messages';
import { CONTENT_PORT_NAME, createPortTransport, createRPC, POPUP_PORT_NAME } from '../messages';
import { toBase64 } from '../messages/bytes';
import { asyncState } from '../utils/asyncState';
import { openPopup, PopupHandle, trackPopup } from '../utils/popup';
import { clearHistory, getHistory, getRequest, saveRequest } from './requests';
import { addAccount, getAccounts, removeAccount } from './storage';

// Popup pages by tab, so a request is answered by the window opened for it and not by whichever
// Sherlock page connected last (the toolbar popup, the home page in a tab, another request).
const popupRPCs = new Map<number, ReturnType<typeof asyncState<RPC>>>();
const popupRPC = (tabId: number) => {
  let state = popupRPCs.get(tabId);
  if (!state) popupRPCs.set(tabId, (state = asyncState<RPC>()));
  return state;
};
const contentRPCs = new Set<RPC>();

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    addAccount({ label: 'Coinbase 2', address: '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm' });
  }
});

// ---- Surviving service worker restarts --------------------------------------------------------
// Chrome stops an idle worker after ~30 s, which used to drop a dapp's pending request while its
// window was still open. Calling an extension API resets the idle timer, so do that while any
// request is pending; and should the worker restart anyway, the content script replays the
// request and the window recorded below is reused instead of opening a second one.

let pending = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

async function keepAlive<T>(work: () => Promise<T>): Promise<T> {
  pending++;
  keepAliveTimer ??= setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    return await work();
  } finally {
    if (--pending === 0 && keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = undefined;
    }
  }
}

const windowKey = (key: string) => `window:${key}`;

// Opens the window for a dapp request, or finds the one already open for it (same request key,
// replayed after a restart).
async function requestWindow(key: string | undefined, open: () => Promise<PopupHandle>): Promise<PopupHandle> {
  if (key) {
    const stored = (await chrome.storage.session.get(windowKey(key)))[windowKey(key)] as number | undefined;
    if (stored !== undefined) {
      try {
        await chrome.tabs.get(stored);
        return trackPopup(stored);
      } catch {
        // The window is gone: open a new one.
      }
    }
  }
  const handle = await open();
  if (key && handle.tabId !== undefined) await chrome.storage.session.set({ [windowKey(key)]: handle.tabId });
  return handle;
}

const forgetWindow = (key?: string) => (key ? chrome.storage.session.remove(windowKey(key)) : Promise.resolve());

type StoredAccount = { publicKey: number[] };

async function getConnectedAccounts() {
  const { connectedAccounts } = await chrome.storage.session.get('connectedAccounts');
  return (connectedAccounts as StoredAccount[] | undefined)?.map((a) => ({ publicKey: Uint8Array.from(a.publicKey) }));
}

async function setConnectedAccounts(accounts: { publicKey: Uint8Array }[] | null | undefined) {
  if (!accounts) return;
  await chrome.storage.session.set({
    connectedAccounts: accounts.map((a) => ({ publicKey: Array.from(a.publicKey) })),
  });
}

// Sites the user approved: they reconnect without a window, like a trusted site in other wallets,
// until they disconnect.
async function approvedOrigins(): Promise<string[]> {
  const { approvedOrigins } = await chrome.storage.local.get('approvedOrigins');
  return (approvedOrigins as string[] | undefined) ?? [];
}

async function setApproved(origin: string, approved: boolean) {
  const origins = (await approvedOrigins()).filter((o) => o !== origin);
  await chrome.storage.local.set({ approvedOrigins: approved ? [...origins, origin] : origins });
}

// One approval window at a time: a second connect (another tab, a double click) waits for it.
let approvalInFlight: Promise<{ publicKey: Uint8Array }[] | null> | undefined;

async function inspect(key: string | undefined, request: Parameters<typeof saveRequest>[0]) {
  return keepAlive(async () => {
    const { popupClosed } = await requestWindow(key, async () => {
      const saved = await saveRequest(request);
      return openPopup('inspect', { request: saved.id });
    });
    await popupClosed;
    await forgetWindow(key);
    // Sherlock never signs: closing the inspector always rejects.
    return null;
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === POPUP_PORT_NAME) {
    const transport = createPortTransport(port);
    const rpc = createRPC(transport);

    rpc.exposeMethod('getAccounts', getAccounts);
    rpc.exposeMethod('addAccount', async (params) => {
      const account = params[0];
      await addAccount(account);
    });
    rpc.exposeMethod('removeAccount', async (params) => {
      const account = params[0];
      await removeAccount(account);
    });
    rpc.exposeMethod('changeAccounts', async (params) => {
      await setConnectedAccounts(params);
      for (const content of contentRPCs) content.callMethod('changeAccounts', params);
    });
    rpc.exposeMethod('connectedAccounts', getConnectedAccounts);

    rpc.exposeMethod('getRequest', async ([id]) => (await getRequest(id)) ?? null);
    rpc.exposeMethod('getHistory', getHistory);
    rpc.exposeMethod('clearHistory', clearHistory);
    rpc.exposeMethod('inspectPasted', async ([{ address, transactions }]) => {
      const saved = await saveRequest({ kind: 'transactions', method: 'paste', address, transactions });
      await openPopup('inspect', { request: saved.id });
      return saved.id;
    });
    rpc.exposeMethod('inspectSignature', async ([{ address, signature }]) => {
      const saved = await saveRequest({ kind: 'transactions', method: 'replay', address, signature, transactions: [] });
      await openPopup('inspect', { request: saved.id });
      return saved.id;
    });
    rpc.exposeMethod('openRequest', async ([id]) => {
      await openPopup('inspect', { request: id });
    });

    const tabId = port.sender?.tab?.id;
    port.onDisconnect.addListener(() => {
      if (tabId !== undefined) popupRPCs.delete(tabId);
      rpc.end();
    });

    if (tabId !== undefined) popupRPC(tabId).set(rpc);
  }

  if (port.name === CONTENT_PORT_NAME) {
    const transport = createPortTransport(port);
    const rpc = createRPC(transport);

    rpc.exposeMethod(
      'connect',
      async ([{ origin, key, silent } = {} as { origin?: string; key?: string; silent?: boolean }]) => {
        const current = await getConnectedAccounts();
        const trusted = !!origin && (await approvedOrigins()).includes(origin) && !!current?.length;
        if (trusted) return current;
        if (silent) return null;

        approvalInFlight ??= keepAlive(async () => {
          const { closePopup, popupClosed, tabId } = await requestWindow(key, () =>
            openPopup('approveConnection', origin ? { origin } : {})
          );
          if (tabId === undefined) throw new Error('approval window has no tab');

          // A reused window reconnects its port after a restart; wait for it (or for it to close).
          const approval = await Promise.race([popupRPC(tabId).get(), popupClosed]);
          const response = approval ? await Promise.race([approval.callMethod('connect'), popupClosed]) : null;

          await setConnectedAccounts(response);
          await forgetWindow(key);
          closePopup();
          return response;
        }).finally(() => {
          approvalInFlight = undefined;
        });
        const response = await approvalInFlight;
        if (response && origin) await setApproved(origin, true);
        return response;
      }
    );

    rpc.exposeMethod('disconnect', async ([{ origin } = {} as { origin?: string }]) => {
      if (origin) await setApproved(origin, false);
    });

    rpc.exposeMethod('inspectTransactions', async ([{ method, address, transactions, chain, origin, key }]) =>
      inspect(key, {
        kind: 'transactions',
        method,
        address,
        chain,
        origin,
        transactions: (transactions as Uint8Array[]).map(toBase64),
      })
    );

    rpc.exposeMethod('inspectMessage', async ([{ address, message, origin, key }]) =>
      inspect(key, { kind: 'message', method: 'signMessage', address, origin, message: toBase64(message) })
    );

    port.onDisconnect.addListener(() => {
      contentRPCs.delete(rpc);
      rpc.end();
    });

    contentRPCs.add(rpc);
  }
});
