/* "Clear all" button at the top of the popup: wipes everything the extension remembers
 * (form values, imported doc, Salesforce result, image + time log, saved URLs, run flags),
 * closes any helper image-library window, then reloads the popup completely blank. */
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
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* ignore */ }
    } catch (e) { /* reload anyway */ }
    location.reload();
  });
})();
