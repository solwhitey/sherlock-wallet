import type { FC } from 'react';
import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AppContext } from './context';
import { ApproveConnection } from './pages/ApproveConnection';
import { Home } from './pages/Home';
import { Inspect } from './pages/Inspect';
import { Wallet } from './pages/Wallet';
import { applyTheme, followThemeChanges } from './theme';
import { startPanel, subscribe, View, viewStack } from './view';

applyTheme();
followThemeChanges();

const PAGES: Record<string, FC> = {
  approveConnection: ApproveConnection,
  inspect: Inspect,
  wallet: Wallet,
};

// A page opened as its own window (or the home page in a tab).
const Root: FC = () => {
  const page = new URLSearchParams(window.location.search).get('page');
  const Route = page ? PAGES[page] : Home;
  // Windows fill their window; the home page in a tab is a 400px column.
  const width = page ? 'w-full' : 'mx-auto w-[400px]';
  return (
    <div className={`${width} min-h-screen`}>
      <Route />
    </div>
  );
};

// The side panel: home underneath (kept mounted, so going back keeps its state), the top view over it.
const PanelRoot: FC = () => {
  const [stack, setStack] = useState<View[]>(viewStack);
  useEffect(() => subscribe(setStack), []);
  const top = stack[stack.length - 1];
  const Route = top ? PAGES[top.page] : undefined;
  return (
    <>
      <div className="min-h-screen w-full" hidden={!!top}>
        <Home />
      </div>
      {top && Route ? (
        <div key={top.viewId} className="min-h-screen w-full">
          <Route />
        </div>
      ) : null}
    </>
  );
};

// The side panel page has no tab of its own; `?panel` forces panel mode (handy in a tab for tests).
async function inPanel() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('panel')) return true;
  if (params.get('page')) return false;
  return (await chrome.tabs.getCurrent()) === undefined;
}

const rootNode = document.getElementById('root');
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const root = createRoot(rootNode!);
inPanel().then(async (panel) => {
  if (panel) await startPanel();
  root.render(
    <StrictMode>
      <AppContext>{panel ? <PanelRoot /> : <Root />}</AppContext>
    </StrictMode>
  );
});
