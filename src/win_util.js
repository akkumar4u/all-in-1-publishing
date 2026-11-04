/* Helper windows (the Image Library, the Salesforce helper) are opened and closed by the extension.
 * A WordPress tab must NEVER end up inside one of them — closing the helper window would then close the WordPress
 * tab too and Chrome asks "Leave site? Changes you made may not be saved". */
const HELPER_URL = /image-libary-api\.dealerinspire\.com|\.force\.com|\.salesforce\.com|^about:blank$/i;

/* the normal browser window a WordPress tab should open in (null when there is only a helper window) */
export async function pickNormalWindow() {
  const held = await chrome.storage.local.get(['diLandingHeld', 'diBlogHeld']).catch(() => ({}));
  const heldIds = new Set(Object.values(held).map(h => h && h.winId).filter(Boolean));
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }).catch(() => []);
  const usable = wins.filter(w => !heldIds.has(w.id)
    && !((w.tabs || []).length && (w.tabs || []).every(t => HELPER_URL.test(t.url || t.pendingUrl || ''))));
  return usable.find(w => w.focused) || usable[usable.length - 1] || null;
}

/* close a helper window — but if some other tab got into it, close only the helper tab and leave the window alone */
export async function closeHelperWindow(winId, tabId) {
  if (!winId) return;
  try {
    const w = await chrome.windows.get(winId, { populate: true });
    const others = (w.tabs || []).filter(t => t.id !== tabId);
    if (others.length && tabId) { await chrome.tabs.remove(tabId).catch(() => {}); return; }
    if (others.length) return;
  } catch { return; }          // the window is already gone
  await chrome.windows.remove(winId).catch(() => {});
}

/* open a WordPress URL as a tab in a normal window (a new window only if there is none) */
export async function openInNormalWindow(url, { background = false } = {}) {
  const target = await pickNormalWindow();
  if (target) {
    const tab = await chrome.tabs.create({ url, windowId: target.id, active: !background });
    if (!background) chrome.windows.update(target.id, { focused: true }).catch(() => {});
    return tab;
  }
  const win = await chrome.windows.create({ url, focused: !background, type: 'normal' });
  return win.tabs[0];
}
