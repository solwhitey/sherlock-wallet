const SIZES: Record<string, { width: number; height: number }> = {
  default: { width: 420, height: 640 },
  inspect: { width: 720, height: 900 },
};

async function getPopupPosition(width: number) {
  let left = 0;
  let top = 0;

  try {
    const lastFocused = await chrome.windows.getLastFocused();

    // Position window in top right corner of lastFocused window.
    top = lastFocused.top ?? 0;
    left = (lastFocused.left ?? 0) + Math.max((lastFocused.width ?? 0) - width, 0);
  } catch (err) {
    // Ignore error.
  }

  return { left, top };
}

async function createPopup(page?: string, params: Record<string, string> = {}): Promise<chrome.windows.Window> {
  const { width, height } = SIZES[page ?? ''] ?? SIZES.default;
  const { left, top } = await getPopupPosition(width);
  const popupURL = new URL('../ui/popup.html', import.meta.url);
  if (page) {
    popupURL.searchParams.append('page', page);
  }
  for (const [key, value] of Object.entries(params)) popupURL.searchParams.append(key, value);
  const popup = await chrome.windows.create({
    url: popupURL.href,
    type: 'popup',
    width,
    height,
    left,
    top,
  });
  if (!popup) throw new Error('could not open popup');
  return popup;
}

export type PopupHandle = { closePopup: () => Promise<void>; popupClosed: Promise<null>; tabId?: number };

// Follows a request window by its tab rather than its window: some environments (headless Chrome,
// window managers that merge popups) put it in a window shared with other tabs.
export function trackPopup(tabId: number | undefined, windowId?: number): PopupHandle {
  let isOpen = true;

  const closePopup = async () => {
    if (!isOpen) return;
    try {
      if (tabId !== undefined) await chrome.tabs.remove(tabId);
      else if (windowId !== undefined) await chrome.windows.remove(windowId);
    } catch {
      // Already gone.
    }
  };

  const popupClosed: Promise<null> = new Promise((resolve) => {
    const done = () => {
      isOpen = false;
      chrome.tabs.onRemoved.removeListener(handleTabRemoved);
      chrome.windows.onRemoved.removeListener(handleWindowRemoved);
      resolve(null);
    };
    const handleTabRemoved = (id: number) => id === tabId && done();
    const handleWindowRemoved = (id: number) => id === windowId && done();
    chrome.tabs.onRemoved.addListener(handleTabRemoved);
    chrome.windows.onRemoved.addListener(handleWindowRemoved);
  });

  return { closePopup, popupClosed, tabId };
}

export async function openPopup(page?: string, params?: Record<string, string>): Promise<PopupHandle> {
  const popup = await createPopup(page, params);
  return trackPopup(popup.tabs?.[0]?.id, popup.id);
}
