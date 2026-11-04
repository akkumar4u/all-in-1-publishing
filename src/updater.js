/**
 * Auto-update for the BUILT extension (the one loaded from the shared folder).
 *
 * The build (build.mjs) writes build.json LAST. It holds the version label and a SHA-256 of every file. This file:
 *   1. every 5 minutes (and at start) reads build.json from disk;
 *   2. if its versionName differs from the one this extension was loaded with, checks that EVERY listed file on disk
 *      matches its hash — a folder that is still syncing is never loaded half-way;
 *   3. reloads when it is safe (no fill running, side panel closed). Otherwise it only sets `updateAvailable`, and the
 *      side panel shows an "Update now" bar (update_banner.js).
 * Loaded straight from the source folder there is no build.json, so nothing happens.
 */
const ALARM = 'di-update-check';
const EVERY_MIN = 5;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const bust = p => `${chrome.runtime.getURL(p)}?t=${Date.now()}`;

async function readBuildInfo() {
  try {
    const r = await fetch(bust('build.json'), { cache: 'no-store' });
    if (!r.ok) return null;
    const info = await r.json();
    return info && info.versionName && info.files ? info : null;
  } catch { return null; }
}

async function filesMatch(files) {
  try {
    for (const [path, want] of Object.entries(files)) {
      const r = await fetch(bust(path), { cache: 'no-store' });
      if (!r.ok) return false;
      const got = hex(await crypto.subtle.digest('SHA-256', await r.arrayBuffer()));
      if (got !== want) return false;
    }
    return true;
  } catch { return false; }
}

async function isBusy() {
  try {
    const auto = (await chrome.storage.session.get('autoRun')).autoRun;
    if (auto && auto.active) return true;                                   // the one-click run is going
    const opened = (await chrome.storage.session.get('hubOpenedAt')).hubOpenedAt;
    if (opened && Date.now() - opened < 10 * 60 * 1000) {                   // a WordPress fill started < 10 min ago ...
      const tl = (await chrome.storage.local.get('timeLog')).timeLog;
      if (!(tl && tl.at > opened)) return true;                              // ... and has not written its time log yet
    }
    const targets = await chrome.debugger.getTargets();
    if (targets.some(t => t.attached)) return true;                         // a debugger is attached (a fill, or DevTools)
  } catch { /* if in doubt, fall through */ }
  return false;
}

async function panelIsOpen() {
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    return ctx.length > 0;
  } catch { return false; }
}

export async function checkForUpdate() {
  const info = await readBuildInfo();
  const loaded = chrome.runtime.getManifest().version_name || '';
  if (!info || info.versionName === loaded) {
    await chrome.storage.local.remove('updateAvailable');
    return;
  }
  if (!(await filesMatch(info.files))) return;                              // still syncing — look again in 5 minutes
  await chrome.storage.local.set({ updateAvailable: { versionName: info.versionName, at: Date.now() } });
  if ((await isBusy()) || (await panelIsOpen())) return;                    // the side panel shows the "Update now" bar
  chrome.runtime.reload();
}

chrome.alarms.get(ALARM).then(a => { if (!a) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: EVERY_MIN }); }).catch(() => {});
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) checkForUpdate().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { checkForUpdate().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { checkForUpdate().catch(() => {}); });
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'APPLY_UPDATE') { sendResponse({ ok: true }); setTimeout(() => chrome.runtime.reload(), 100); return true; }
  if (message?.type === 'CHECK_UPDATE_NOW') { checkForUpdate().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false })); return true; }
  return false;
});
