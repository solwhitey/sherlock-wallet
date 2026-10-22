import type { RPC } from '../messages';
import { CONTENT_PORT_NAME, createPortTransport, createRPC, POPUP_PORT_NAME } from '../messages';
import { asyncState } from '../utils/asyncState';
import { openPopup } from '../utils/popup';
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

let connectedAccounts: { publicKey: Uint8Array }[] | undefined;

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    addAccount({ label: 'Coinbase 2', address: '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm' });
  }
  // Keep the service worker alive while dapps hold pending requests.
  chrome.alarms.get('keep-alive', (a) => {
    if (!a) chrome.alarms.create('keep-alive', { periodInMinutes: 0.5 });
  });
});

// Add a noop listener to the alarm. Without this, the service worker seems
// to be deemed as idle by Chrome and will be killed after 30s.
chrome.alarms.onAlarm.addListener(() => {
  // Noop
  Function.prototype();
});

async function inspect(request: Parameters<typeof saveRequest>[0]) {
  const saved = await saveRequest(request);
  const { popupClosed } = await openPopup('inspect', { request: saved.id });
  await popupClosed;
  // Sherlock never signs: closing the inspector always rejects.
  return null;
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
      for (const content of contentRPCs) content.callMethod('changeAccounts', params);
    });
    rpc.exposeMethod('connectedAccounts', async () => {
      return connectedAccounts;
    });

    rpc.exposeMethod('getRequest', async ([id]) => (await getRequest(id)) ?? null);
    rpc.exposeMethod('getHistory', getHistory);
    rpc.exposeMethod('clearHistory', clearHistory);
    rpc.exposeMethod('inspectPasted', async ([{ address, transactions }]) => {
      const saved = await saveRequest({ kind: 'transactions', method: 'paste', address, transactions });
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

    rpc.exposeMethod('connect', async ([{ origin } = {} as { origin?: string }]) => {
      const { closePopup, popupClosed, tabId } = await openPopup('approveConnection', origin ? { origin } : {});
      if (tabId === undefined) throw new Error('approval window has no tab');

      const approval = await popupRPC(tabId).get();
      const connectResult = approval.callMethod('connect');

      const response = await Promise.race([connectResult, popupClosed]);

      connectedAccounts = response;
      closePopup();

      return response;
    });

    rpc.exposeMethod('inspectTransactions', async ([{ method, address, transactions, chain, origin }]) =>
      inspect({
        kind: 'transactions',
        method,
        address,
        chain,
        origin,
        transactions: (transactions as Uint8Array[]).map(toBase64),
      })
    );

    rpc.exposeMethod('inspectMessage', async ([{ address, message, origin }]) =>
      inspect({ kind: 'message', method: 'signMessage', address, origin, message: toBase64(message) })
    );

    port.onDisconnect.addListener(() => {
      contentRPCs.delete(rpc);
      rpc.end();
    });

    contentRPCs.add(rpc);
  }
});
