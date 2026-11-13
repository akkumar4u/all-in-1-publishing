/* "Clear all" removes temporary publishing/session data while preserving Bulk dashboard
 * connection settings (including the private Vercel URL/key and sheet credentials).
 * It also closes any helper image-library window, then reloads the popup blank. */
(function () {
  const btn = document.getElementById('clear-all');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Clearing…';
    try {
      const held = await chrome.storage.local.get(['diLandingHeld', 'diBlogHeld']);
      for (const k of Object.keys(held)) {
        if (!(held[k] && held[k].winId)) continue;
        // only the helper window; if another tab (e.g. WordPress) is in it, close just the library tab
        const w = await chrome.windows.get(held[k].winId, { populate: true }).catch(() => null);
        if (!w) continue;
        const others = (w.tabs || []).filter(t => t.id !== held[k].tabId);
        if (others.length) { if (held[k].tabId) await chrome.tabs.remove(held[k].tabId).catch(() => {}); }
        else await chrome.windows.remove(w.id).catch(() => {});
      }
      const savedSettings = (await chrome.storage.local.get('bulkSettings')).bulkSettings;
      await chrome.storage.local.clear();
      if (savedSettings) await chrome.storage.local.set({ bulkSettings: savedSettings });
      await chrome.storage.session.clear();
      try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* ignore */ }
    } catch (e) { /* reload anyway */ }
    location.reload();
  });
})();
