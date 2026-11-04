/**
 * Publishing Studio — Google Sheet bridge (v2)
 * ------------------------------------------------------------------------------------------------
 * One row per ticket in the "Tickets" tab (every metric), the full generated page in the "Content" tab
 * (split into pieces, because one cell holds at most 50,000 characters), every change in "History".
 *
 * Each teammate gets their OWN token (run addUser from the editor). Remove a token = that person is out.
 * No shared secret is written in this file, so it is safe to keep in the repo.
 *
 * SETUP (once):
 *   1. SPREADSHEET_ID below = the sheet's id (the long text in its URL between /d/ and /edit).
 *   2. Run  addUserHelper  once for yourself (first change NAME inside it to your name),
 *      press Run, then View → Execution log: copy the token.  Do the same for each teammate (their name).
 *   3. Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone → Deploy. Copy the /exec URL.
 *   4. In the extension's Bulk dashboard → ⚙ Settings: paste the /exec URL + your token.
 * UPDATING this file later: Deploy → Manage deployments → ✎ → Version: New version → Deploy (same URL stays).
 */
const SPREADSHEET_ID = '1LmtNCk5sN059s6y1KAnr8exuU_H3VLEEg2T_nN3l0LM';
const VERSION = '2.1';
const TICKETS_TAB = 'Tickets';
const CONTENT_TAB = 'Content';
const HISTORY_TAB = 'History';
const CHUNK = 45000;
const MAX_LIST = 1500;

const HEADERS = [
  'Ticket', 'Status', 'Run By', 'Task Type', 'Subject', 'Account', 'Website', 'WP Admin URL', 'Salesforce URL', 'Group 1',
  'Doc URL', 'Page Title', 'Slug', 'Meta Title', 'Meta Title Chars', 'Meta Description', 'Meta Desc Chars',
  'Template', 'Parent Page', 'Content Words', 'Content Chars', 'H2 Count', 'Internal Links', 'External Links',
  'Checks', 'Warnings', 'Salesforce Secs', 'Doc Secs', 'Total Secs', 'Fetched At', 'Updated At',
  'Draft Status', 'Draft Link', 'Preview Link', 'Draft Saved At', 'Draft Secs', 'Draft Notes', 'Notes', 'Published URL',
];

/* ------------------------------ web app entry points ------------------------------ */

function doGet() {
  return json_({ ok: true, message: 'Publishing Studio sheet bridge v' + VERSION + ' is online. The extension talks to it with POST.' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const user = authorize_(p.token);
    lock.waitLock(25000);
    const book = SpreadsheetApp.openById(SPREADSHEET_ID);
    switch (p.op) {
      case 'ping':  return json_({ ok: true, user: user, version: VERSION, spreadsheet: book.getName() });
      case 'list':  return json_(list_(book));
      case 'get':   return json_(get_(book, p.ticket));
      case 'save':  return json_(save_(book, user, p.row || {}, p.hub));
      case 'patch': return json_(patch_(book, user, p.ticket, p.patch || {}, p.event));
      default: throw new Error('Unknown operation: ' + p.op);
    }
  } catch (err) {
    return json_({ ok: false, error: err && err.message ? err.message : String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* not held */ }
  }
}

/* ------------------------------ operations ------------------------------ */

function list_(book) {
  const sh = ticketsSheet_(book);
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, rows: [] };
  const values = sh.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues();
  const rows = values.filter(function (r) { return r[0]; }).map(function (r) {
    const o = {};
    HEADERS.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  }).reverse().slice(0, MAX_LIST);
  return { ok: true, rows: rows };
}

function get_(book, ticket) {
  const t = clean_(ticket);
  const sh = ticketsSheet_(book);
  const at = findRow_(sh, t);
  if (!at) throw new Error('Ticket ' + t + ' is not in the sheet.');
  const r = sh.getRange(at, 1, 1, HEADERS.length).getDisplayValues()[0];
  const row = {};
  HEADERS.forEach(function (h, i) { row[h] = r[i]; });
  return { ok: true, row: row, hub: readContent_(book, t) };
}

function save_(book, user, row, hub) {
  const t = clean_(row['Ticket']);
  if (!t) throw new Error('The row has no ticket number.');
  const sh = ticketsSheet_(book);
  const now = new Date().toISOString();
  row['Ticket'] = t;
  row['Run By'] = user;
  row['Updated At'] = now;
  const at = findRow_(sh, t);
  let values;
  if (at) {
    // keep what is already there (draft result, notes ...) unless the new row says otherwise
    const old = sh.getRange(at, 1, 1, HEADERS.length).getValues()[0];
    values = HEADERS.map(function (h, i) { return row.hasOwnProperty(h) ? safe_(row[h]) : old[i]; });
    sh.getRange(at, 1, 1, HEADERS.length).setValues([values]);
  } else {
    values = HEADERS.map(function (h) { return safe_(row[h]); });
    sh.appendRow(values);
  }
  if (hub) writeContent_(book, t, JSON.stringify(hub));
  log_(book, t, user, at ? 'Re-fetched' : 'Fetched', String(row['Status'] || ''));
  return { ok: true, updated: !!at };
}

function patch_(book, user, ticket, patch, event) {
  const t = clean_(ticket);
  const sh = ticketsSheet_(book);
  const at = findRow_(sh, t);
  if (!at) throw new Error('Ticket ' + t + ' is not in the sheet.');
  patch['Updated At'] = new Date().toISOString();
  Object.keys(patch).forEach(function (k) {
    const col = HEADERS.indexOf(k);
    if (col >= 0) sh.getRange(at, col + 1).setValue(safe_(patch[k]));
  });
  log_(book, t, user, event || 'Updated', Object.keys(patch).filter(function (k) { return k !== 'Updated At'; }).join(', '));
  return { ok: true };
}

/* ------------------------------ sheets ------------------------------ */

function ticketsSheet_(book) {
  let sh = book.getSheetByName(TICKETS_TAB);
  if (!sh) {
    sh = book.insertSheet(TICKETS_TAB);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#0b5a4a').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setFrozenColumns(1);
  } else if (sh.getLastColumn() < HEADERS.length || sh.getRange(1, 1).getValue() !== HEADERS[0]) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  return sh;
}

function contentSheet_(book) {
  let sh = book.getSheetByName(CONTENT_TAB);
  if (!sh) {
    sh = book.insertSheet(CONTENT_TAB);
    sh.getRange(1, 1, 1, 3).setValues([['Ticket', 'Part', 'Data (the generated page, as JSON — do not edit)']]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('C:C').setNumberFormat('@');
  }
  return sh;
}

function historySheet_(book) {
  let sh = book.getSheetByName(HISTORY_TAB);
  if (!sh) {
    sh = book.insertSheet(HISTORY_TAB);
    sh.getRange(1, 1, 1, 5).setValues([['Time', 'Ticket', 'User', 'Event', 'Detail']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function log_(book, ticket, user, event, detail) {
  try { historySheet_(book).appendRow([new Date(), ticket, user, event, safe_(detail)]); } catch (e) { /* history is a nice-to-have */ }
}

function writeContent_(book, ticket, text) {
  const sh = contentSheet_(book);
  const last = sh.getLastRow();
  if (last > 1) {
    const col = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = col.length - 1; i >= 0; i--) if (String(col[i][0]) === ticket) sh.deleteRow(i + 2);
  }
  const rows = [];
  for (let i = 0, part = 1; i < text.length; i += CHUNK, part++) rows.push([ticket, part, text.substring(i, i + CHUNK)]);
  if (!rows.length) return;
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 3, rows.length, 1).setNumberFormat('@');
  sh.getRange(start, 1, rows.length, 3).setValues(rows);
}

function readContent_(book, ticket) {
  const sh = book.getSheetByName(CONTENT_TAB);
  if (!sh || sh.getLastRow() < 2) return null;
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    .filter(function (r) { return String(r[0]) === ticket; })
    .sort(function (a, b) { return a[1] - b[1]; });
  if (!data.length) return null;
  try { return JSON.parse(data.map(function (r) { return r[2]; }).join('')); } catch (e) { return null; }
}

/* ------------------------------ helpers ------------------------------ */

function findRow_(sh, ticket) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const col = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  for (let i = col.length - 1; i >= 0; i--) if (clean_(col[i][0]) === ticket) return i + 2;
  return 0;
}

function clean_(v) { return String(v || '').trim().toUpperCase(); }

/** A cell that starts with = + - @ would be run as a formula; the leading ' keeps it as plain text. */
function safe_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function authorize_(token) {
  const map = tokens_();
  const name = map[String(token || '').trim()];
  if (!name) throw new Error('Invalid token — ask the owner for a new one.');
  return name;
}

function tokens_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('TOKENS') || '{}'); } catch (e) { return {}; }
}

/* ------------------------------ Helpers you run by hand (Run button, then View → Logs) ------------------------------ */

/** Gives a person a token. Change the name in the quotes, press Run, copy the token from the log. */
function addUserHelper() { addUser('NAME'); }

function addUser(name) {
  if (!name || name === 'NAME') throw new Error('Do not run addUser directly. Run addUserHelper, after replacing NAME inside it with the person\'s name.');
  const map = tokens_();
  Object.keys(map).forEach(function (t) { if (map[t] === name) delete map[t]; });   // one token per person
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').substring(0, 8);
  map[token] = name;
  PropertiesService.getScriptProperties().setProperty('TOKENS', JSON.stringify(map));
  Logger.log('Token for ' + name + ':\n' + token);
}

/** Takes a person's access away. Change the name, press Run. */
function removeUserHelper() { removeUser('NAME'); }

function removeUser(name) {
  const map = tokens_();
  let n = 0;
  Object.keys(map).forEach(function (t) { if (map[t] === name) { delete map[t]; n++; } });
  PropertiesService.getScriptProperties().setProperty('TOKENS', JSON.stringify(map));
  Logger.log(n ? 'Removed ' + name : 'No user called ' + name);
}

/** Shows every person and their token again (View → Execution log) — use it when a token was lost or does not work. */
function showTokens() {
  const map = tokens_();
  const lines = Object.keys(map).map(function (t) { return map[t] + ': ' + t; });
  Logger.log(lines.length ? lines.join('\n') : 'No tokens saved yet. Run addUserHelper (with a name instead of NAME).');
}

function listUsers() {
  Logger.log(Object.keys(tokens_()).map(function (t) { return tokens_()[t]; }).join(', ') || 'No users yet.');
}
