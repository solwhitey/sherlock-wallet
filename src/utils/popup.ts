const SIZES: Record<string, { width: number; height: number }> = {
  default: { width: 420, height: 640 },
  inspect: { width: 560, height: 860 },
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

export async function openPopup(page?: string, params?: Record<string, string>) {
  const popup = await createPopup(page, params);

  let isOpen = true;
  // Track the popup's tab rather than its window: some environments (headless Chrome, window
  // managers that merge popups) put it in a window shared with other tabs.
  const tabId = popup.tabs?.[0]?.id;

  const closePopup = async () => {
    if (!isOpen) return;
    if (tabId !== undefined) await chrome.tabs.remove(tabId);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    else await chrome.windows.remove(popup.id!);
  };

  const popupClosed: Promise<null> = new Promise((resolve) => {
    const done = () => {
      isOpen = false;
      chrome.tabs.onRemoved.removeListener(handleTabRemoved);
      chrome.windows.onRemoved.removeListener(handleWindowRemoved);
      resolve(null);
    };
    const handleTabRemoved = (id: number) => id === tabId && done();
    const handleWindowRemoved = (id: number) => id === popup.id && done();
    chrome.tabs.onRemoved.addListener(handleTabRemoved);
    chrome.windows.onRemoved.addListener(handleWindowRemoved);
  });

  return { closePopup, popupClosed, tabId };
}
