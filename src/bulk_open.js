/* "Bulk dashboard" button: opens the dashboard in a normal tab (or brings the one that is already open to the front). */
document.getElementById('open-bulk')?.addEventListener('click', async () => {
  const url = chrome.runtime.getURL('bulk/bulk.html');
  const [open] = await chrome.tabs.query({ url });
  if (open) { await chrome.tabs.update(open.id, { active: true }); await chrome.windows.update(open.windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
});
