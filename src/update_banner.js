/* "A new version is ready" bar at the top of the side panel. Shown only when updater.js found a verified newer build
   while the panel was open (it never reloads under an open panel). */
(function () {
  const bar = document.getElementById('update-banner');
  const btn = document.getElementById('update-apply');
  if (!bar || !btn) return;
  const show = v => { bar.hidden = !v; };
  chrome.storage.local.get('updateAvailable').then(r => show(!!r.updateAvailable));
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.updateAvailable) show(!!changes.updateAvailable.newValue); });
  btn.addEventListener('click', () => { btn.disabled = true; btn.textContent = 'Updating…'; chrome.runtime.sendMessage({ type: 'APPLY_UPDATE' }); });
})();
