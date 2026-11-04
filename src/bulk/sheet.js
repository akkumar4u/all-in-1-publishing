/* Client for the Google Apps Script sheet bridge (apps-script/Code.gs). The URL and the person's own token live in
   chrome.storage.local (Settings), never in the source. A save that cannot reach the sheet is kept and retried. */
const SETTINGS_KEY = 'bulkSettings';
const PENDING_KEY = 'bulkPending';

export const COLUMNS = [
  'Ticket', 'Status', 'Run By', 'Task Type', 'Subject', 'Account', 'Website', 'WP Admin URL', 'Salesforce URL', 'Group 1',
  'Doc URL', 'Page Title', 'Slug', 'Meta Title', 'Meta Title Chars', 'Meta Description', 'Meta Desc Chars',
  'Template', 'Parent Page', 'Content Words', 'Content Chars', 'H2 Count', 'Internal Links', 'External Links',
  'Checks', 'Warnings', 'Salesforce Secs', 'Doc Secs', 'Total Secs', 'Fetched At', 'Updated At',
  'Draft Status', 'Draft Link', 'Preview Link', 'Draft Saved At', 'Draft Secs', 'Draft Notes', 'Notes', 'Published URL',
];

export async function getSettings() {
  const s = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  return { url: (s.url || '').trim(), token: (s.token || '').trim() };
}
export async function saveSettings(s) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { url: (s.url || '').trim(), token: (s.token || '').trim() } });
}

async function call(op, body = {}) {
  const s = await getSettings();
  if (!s.url || !s.token) throw new Error('Open ⚙ Settings and paste the Apps Script URL and your token first.');
  if (!/^https:\/\/script\.google\.com\/.+\/exec/.test(s.url)) throw new Error('The Apps Script URL must end in /exec (Deploy → Web app).');
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(s.url, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },     // a plain type: no CORS pre-flight
        body: JSON.stringify({ token: s.token, op, ...body }),
      });
      break;
    } catch (e) {
      if (attempt) throw new Error('Could not reach the sheet (' + (e.message || 'network') + ').');
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('The Apps Script URL did not answer with data. Check that it ends in /exec and that "Who has access" is Anyone.'); }
  if (!data.ok) throw new Error(data.error || 'The sheet refused the request.');
  return data;
}

export const sheetApi = {
  async ping() {
    const d = await call('ping');
    if (!d.version || !d.user) throw new Error('This URL answers, but it is not the new Code.gs (it sent no version / user). In Apps Script: paste the new Code.gs, then Deploy → Manage deployments → ✎ → Version: New version → Deploy, and use that /exec URL.');
    return d;
  },
  list: async () => (await call('list')).rows || [],
  get: async ticket => { const d = await call('get', { ticket }); return { row: d.row, pkg: d.hub || null }; },
  patch: (ticket, patch, event) => call('patch', { ticket, patch, event }),
  async save(row, pkg) {
    try { await call('save', { row, hub: pkg }); return { saved: true }; }
    catch (e) {
      if (/token|Settings|\/exec/i.test(e.message)) throw e;             // a setup problem — do not queue
      const all = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {};
      all[row.Ticket] = { row, pkg };
      await chrome.storage.local.set({ [PENDING_KEY]: all });
      return { saved: false, error: e.message };
    }
  },
};

export async function pendingCount() {
  return Object.keys((await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {}).length;
}

export async function flushPending() {
  const all = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {};
  let sent = 0;
  for (const [ticket, item] of Object.entries(all)) {
    try { await call('save', { row: item.row, hub: item.pkg }); delete all[ticket]; sent++; }
    catch { break; }                                                     // the sheet is still unreachable — try later
  }
  await chrome.storage.local.set({ [PENDING_KEY]: all });
  return { sent, left: Object.keys(all).length };
}
