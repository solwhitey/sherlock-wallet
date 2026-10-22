import type { FC } from 'react';
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppContext } from './context';
import { ApproveConnection } from './pages/ApproveConnection';
import { Home } from './pages/Home';
import { Inspect } from './pages/Inspect';
import { applyTheme, followThemeChanges } from './theme';

applyTheme();
followThemeChanges();

const Root: FC = () => {
  const queryParams = new URLSearchParams(window.location.search);
  const page = queryParams.get('page');

  const Route = page
    ? {
        approveConnection: ApproveConnection,
        inspect: Inspect,
      }[page]!
    : Home;
  // Request windows fill their window; the toolbar popup is a fixed 400px column.
  const width = page ? 'w-full' : 'mx-auto w-[400px]';

  return (
    <StrictMode>
      <AppContext>
        <div className={`${width} min-h-screen`}>
          <Route />
        </div>
      </AppContext>
    </StrictMode>
  );
};

const rootNode = document.getElementById('root');
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const root = createRoot(rootNode!);
root.render(<Root />);
