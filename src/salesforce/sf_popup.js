/**
 * Salesforce card in the popup (an ES module, so it adds no globals).
 * It only reads/writes the form fields by id and clicks the existing buttons — it contains none
 * of the hub, blog or template logic. What kind of task a ticket is comes from sf_classify.js.
 */
import { classifyTask, TASK_TYPES } from './sf_classify.js';
import { SF_CONFIG } from './sf_config.js';
import { resolveWebsiteRedirect } from '../bulk/pipeline.js';

const $ = id => document.getElementById(id);
const STATE_KEY = 'sfLookupState';

const ticketInput = $('sf-ticket');
const runBtn = $('sf-run');
const statusEl = $('sf-status');
const resultEl = $('sf-result');
const summaryEl = $('sf-summary');
const autoImport = $('sf-auto-import');
const docSelect = $('sf-doc-select');
const docCustom = $('sf-doc-custom');
const websiteInput = $('sf-website');
const adminInput = $('sf-admin');
const redirectBox = $('sf-website-redirect');
const redirectUrl = $('sf-website-redirect-url');
const useRedirectBtn = $('sf-use-website-redirect');
const taskSelect = $('sf-task-type');
const group1Box = $('sf-group1');
const taskNote = $('sf-task-note');
const applyBtn = $('sf-apply');
const logEl = $('sf-log');
const logText = $('sf-log-text');

let current = null;            // latest lookup state
let appliedThisPopup = false;
let fieldsFor = null;          // which lookup the editable fields were filled from
let redirectCheckId = 0;
let detectedRedirect = '';

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = kind || '';
}

function setField(id, value) {
  const el = $(id);
  if (!el || !value) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));   // also saves in-progress form state
}
function setSelect(id, value) {
  const el = $(id);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));  // makes the form show the right fields
}

/* ---------- what happens for each kind of task ---------- */

function applyTask(state, key, docUrl) {
  const type = TASK_TYPES[key];
  if (!type) { setStatus('Pick a task type first.', 'error'); return; }
  document.body.classList.add('sf-applied');   // show only the form for this task
  chrome.runtime.sendMessage({ type: 'SF_MARK_APPLIED' });
  const admin = state.adminUrl;

  // VRP Enhancement uses the existing landing-page publisher, with its own
  // template and a parent inferred from the ticket subject.
  if (key === 'enhancement:vrp') {
    const subject = state.subject || '';
    const parent = /\bused\b|pre[ -]?owned/i.test(subject) ? 'Used Vehicles'
      : /\bnew\b/i.test(subject) ? 'New Vehicles' : '';
    const mode = { active: true, templateName: 'Lightning', parent, pageAction: 'new', existingPageUrl: '' };
    window.__vrpPageMode = mode;
    chrome.storage.session.set({ vrpPageMode: mode });
    $('vrp-page-action').value = 'new';
    $('vrp-selected-page').textContent = '';
    $('tab-publishing').click();
    setSelect('publishing-type', 'vrp');
    if (parent) {
      setSelect('landing-parent', parent);
      setField('landing-parent-custom', '');
    } else {
      setSelect('landing-parent', '__other');
      setField('landing-parent-custom', '');
    }
    setField('publishing-admin-url', admin);
    setField('comparison-doc-url', docUrl);
    if (autoImport.checked && docUrl) {
      const btn = $('import-doc');
      if (btn && !btn.disabled) btn.click();
    }
    setStatus(`${type.label}: Landing Page flow selected with Lightning template${parent ? ` and ${parent} parent` : '; select New Vehicles or Used Vehicles parent'}.`, 'success');
    return;
  }

  window.__vrpPageMode = { active: false };
  chrome.storage.session.set({ vrpPageMode: window.__vrpPageMode });

  if (type.category === 'hub') {
    $('tab-hubs').click();
    setSelect('hub-type', type.hubType);
    setField('admin-url', admin);
    setStatus(`${type.label}: admin URL filled in. Enter the brand name, then Generate Preview.`, 'success');
    $('brand-name')?.focus();
    return;
  }

  // Publishing forms: keep the doc + admin URLs in every field that uses them.
  setField('comparison-doc-url', docUrl);
  setField('document-url', docUrl);
  setField('publishing-admin-url', admin);
  setField('blog-admin-url', admin);

  if (type.publishingType) {
    $('tab-publishing').click();
    setSelect('publishing-type', type.publishingType);
    if (autoImport.checked && docUrl) {
      const btn = $(type.publishingType === 'blog' ? 'import' : 'import-doc');
      if (btn && !btn.disabled) btn.click();
    }
    // Landing AND comparison pages: Group 1 gets the contact form where the blog feed would be.
    const hasBottomRow = ['landing', 'comparison', 'blog'].includes(type.publishingType);
    if (hasBottomRow) setSelect('landing-bottom', state.group1?.is ? 'form' : 'blog');
    setStatus(`${type.label}: filled in from Salesforce.${state.group1?.is && hasBottomRow ? ' Group 1: contact form will replace the blog feed.' : ''}`, 'success');
    return;
  }

  // Identified, but there is no automatic flow for it yet (other Enhancements, Inventory Page Creation).
  $('tab-publishing').click();
  setStatus(`${type.label} — identified from the ticket. There is no automatic flow for this type yet; the Google Doc and admin URL are filled in.`, 'error');
}

window.__sfApplyTask = applyTask;   // used by autorun_popup.js (same code path as the Apply button)

/* ---------- rendering ---------- */

function renderSummary(state) {
  const rows = [];
  if (state.subject) rows.push(['Subject', state.subject]);
  if (state.accountName) rows.push(['Account', state.accountName]);
  summaryEl.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value;
    summaryEl.append(dt, dd);
  }
}

function renderTask(state) {
  taskSelect.value = state.task?.key || '';
  group1Box.checked = !!state.group1?.is;
  const parts = [];
  if (state.task?.reason) parts.push(state.task.reason);
  if (state.group1?.is && state.group1.evidence) parts.push(`Group 1 matched: "${state.group1.evidence}".`);
  taskNote.textContent = parts.join(' ');
}

const docTab = d => ((d.url || '').match(/[?&]tab=(t\.[A-Za-z0-9]+)/) || [])[1];
const docLabel = (d, i, all) => (all.length > 1 ? `${i + 1}. ` : '') + (d.label || 'Google Doc') + (docTab(d) ? ` [tab ${docTab(d)}]` : '');

function renderFields(state) {
  const docs = state.docs?.length ? state.docs : (state.docUrls || []).map(url => ({ url, label: '' }));
  docSelect.replaceChildren(...(docs.length ? docs.map((d, i) => {
    const o = document.createElement('option'); o.value = d.url; o.textContent = docLabel(d, i, docs); return o;
  }) : [Object.assign(document.createElement('option'), { value: '', textContent: 'No Google Doc found on the ticket' })]));
  docCustom.value = docSelect.value || '';     // the full link, shown so it can be cross-checked
  websiteInput.value = state.website || '';
  adminInput.value = state.adminUrl || '';
  checkWebsiteRedirect(websiteInput.value);
}

const chosenDoc = () => docCustom.value.trim() || null;
docSelect.addEventListener('change', () => { docCustom.value = docSelect.value || ''; });

// Editing the website re-derives the admin URL (the admin box can still be edited after that).
websiteInput.addEventListener('input', () => {
  detectedRedirect = '';
  redirectBox.hidden = true;
  let v = websiteInput.value.trim();
  if (!v) { adminInput.value = ''; return; }
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { adminInput.value = new URL(v).origin + SF_CONFIG.wpAdminPath; } catch { /* still typing */ }
  clearTimeout(websiteInput._redirectTimer);
  websiteInput._redirectTimer = setTimeout(() => checkWebsiteRedirect(websiteInput.value), 650);
});

async function checkWebsiteRedirect(value) {
  const checkId = ++redirectCheckId;
  detectedRedirect = '';
  redirectBox.hidden = true;
  const website = String(value || '').trim();
  if (!website) return;
  const finalUrl = await resolveWebsiteRedirect(website);
  if (checkId !== redirectCheckId || website !== websiteInput.value.trim() || !finalUrl) return;
  let original = '';
  try { original = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : 'https://' + website).href; } catch { return; }
  if (finalUrl.replace(/\/$/, '').toLowerCase() === original.replace(/\/$/, '').toLowerCase()) return;
  detectedRedirect = finalUrl;
  redirectUrl.href = finalUrl;
  redirectUrl.textContent = finalUrl;
  redirectBox.hidden = false;
}

useRedirectBtn.addEventListener('click', () => {
  if (!detectedRedirect) return;
  websiteInput.value = detectedRedirect;
  websiteInput.dispatchEvent(new Event('input', { bubbles: true }));
  current = { ...current, website: detectedRedirect, adminUrl: adminInput.value.trim() || null };
  detectedRedirect = '';
  redirectBox.hidden = true;
});

function render(state, { allowApply }) {
  current = state;
  if (state?.applied) document.body.classList.add('sf-applied');
  if (!state) { setStatus(''); resultEl.hidden = true; logEl.hidden = true; return; }
  if (state.ticket && !ticketInput.value) ticketInput.value = state.ticket;
  runBtn.disabled = state.status === 'running';
  logEl.hidden = !(state.log?.length && state.status !== 'running');
  logText.textContent = (state.log || []).join('\n');

  if (state.status === 'running') { setStatus(state.step || 'Working…'); return; }
  if (state.status === 'error') {
    setStatus(state.error || 'Lookup failed.', 'error');
    resultEl.hidden = true;
    return;
  }
  if (state.status !== 'done') return;

  resultEl.hidden = false;
  renderSummary(state);
  renderTask(state);
  const key = state.ticket + '|' + (state.docUrls || []).join(',') + '|' + (state.website || '');
  if (fieldsFor !== key) { renderFields(state); fieldsFor = key; }

  const warn = (state.warnings || []).join(' ');
  const hint = state.applied || appliedThisPopup ? 'Filled in from Salesforce. ' : 'Check the details below, change anything that is wrong, then click Apply to form. ';
  setStatus(hint + warn, warn ? 'error' : 'success');
}

/* ---------- events ---------- */

runBtn.addEventListener('click', () => {
  const ticket = ticketInput.value.trim();
  if (!ticket) { setStatus('Enter a ticket number first.', 'error'); return; }
  appliedThisPopup = false;
  fieldsFor = null;
  setStatus('Starting…');
  chrome.runtime.sendMessage({ type: 'SF_START', ticket }, res => {
    if (!res?.ok) setStatus(res?.error || 'Could not start the lookup.', 'error');
  });
});
ticketInput.addEventListener('keydown', e => { if (e.key === 'Enter') runBtn.click(); });

// Correcting Group 1 re-works out the task type (Group 1 + no "blog" = Landing Page).
group1Box.addEventListener('change', () => {
  if (!current) return;
  const task = classifyTask({ subject: current.subject, group1: group1Box.checked });
  taskSelect.value = task.key || '';
  taskNote.textContent = task.reason;
});

applyBtn.addEventListener('click', () => {
  if (!current) return;
  // Use what the person sees in the boxes (their corrections), not just what was detected.
  const state = { ...current, adminUrl: adminInput.value.trim() || null, website: websiteInput.value.trim() || null,
    group1: { ...(current.group1 || {}), is: group1Box.checked } };
  appliedThisPopup = true;
  applyTask(state, taskSelect.value, chosenDoc());
});

$('sf-manual').addEventListener('click', () => {
  document.body.classList.add('sf-applied');
  $('tab-publishing').parentElement.style.display = 'grid';   // manual mode: tabs come back
});

// Live updates while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[STATE_KEY]) render(changes[STATE_KEY].newValue, { allowApply: true });
});

// On open: show the last result. Wait briefly so the form's own "restore saved values" step
// finishes first and can't overwrite what we fill in.
chrome.runtime.sendMessage({ type: 'SF_GET_STATE' }, res => {
  setTimeout(() => render(res?.state, { allowApply: true }), 500);
});
