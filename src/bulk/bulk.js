import { sheetApi, getSettings, saveSettings, flushPending, pendingCount } from './sheet.js';
import { runTicket, analyse, prepareImportedDoc, verifyButtonUrls, normalizeButtonMarkup, composeBlogContent, fetchBlogCategories, fetchWebsitePages, chooseParentPage, suggestedBlogCategory, resolveWebsiteRedirect, esc } from './pipeline.js';
import { initInternalLinks } from '../links/il_popup.js';
import { TASK_TYPES } from '../salesforce/sf_classify.js';

const $ = id => document.getElementById(id);
const send = msg => new Promise(resolve => chrome.runtime.sendMessage(msg, r => resolve(r || { ok: false, error: chrome.runtime.lastError?.message || 'No answer from the extension.' })));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const state = { lastError: {}, rows: [], byTicket: new Map(), cache: new Map(), selected: '', checked: new Set(), busy: false, stop: false, view: 'preview', checkingPublished: false, publishedCheckAt: new Map() };
const PUBLISHED_VISIBLE_KEY = 'bulkPublishedVisibleUntil';
state.publishedVisibleUntil = {};

/* ---------------- small helpers ---------------- */
function toast(text, ms = 3200) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
const pillClass = s => String(s || '').replace(/\s+/g, '-').replace(/^Ready-for-review$/, 'Ready').replace(/^Needs-attention$/, 'Needs');
const statusPill = s => `<span class="pill ${pillClass(s)}">${esc(s || '—')}</span>`;
const dotFor = checks => /\b[1-9]\d* errors?\b/.test(checks || '') ? 'bad' : /\b[1-9]\d* warnings?\b/.test(checks || '') ? 'warn' : checks ? 'ok' : '';
const when = iso => { try { return new Date(iso).toLocaleString(); } catch { return iso || ''; } };
const normTicket = t => String(t || '').trim().toUpperCase();
const PARENT_CHOICES = ['Used Vehicles','Pre-Owned Vehicles','Used Inventory','Pre-Owned Inventory','New Vehicles','New Inventory'];
function parentChoices(row) {
  const current = String(row['Parent Page'] || '').trim();
  const pkg = state.cache.get(normTicket(row.Ticket))?.pkg;
  const site = (pkg?.sitePages || []).map(page => page.title).filter(Boolean);
  return [...new Set([...(current ? [current] : []), ...(site.length ? site : PARENT_CHOICES)])];
}
const displayWebsite = value => String(value || '').replace(/^https?:\/\//, '');
function normalizeWebsiteEdit(value, currentAdmin = '') {
  let input = String(value || '').trim();
  if (!input) throw new Error('Enter a website URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = 'https://' + input;
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Use an http:// or https:// website URL.');
  let adminSuffix = '/wp/wp-admin';
  try {
    const oldPath = new URL(currentAdmin).pathname;
    const suffix = oldPath.match(/\/(?:wp\/)?wp-admin(?:\/.*)?$/i);
    if (suffix) adminSuffix = suffix[0];
  } catch { /* use Dealer Inspire's standard admin path */ }
  const adminPath = url.pathname.match(/\/(?:wp\/)?wp-admin(?:\/.*)?$/i);
  const sitePath = (adminPath ? url.pathname.slice(0, adminPath.index) : url.pathname).replace(/\/+$/, '');
  const website = url.origin + sitePath;
  return { website, adminUrl: website + adminSuffix };
}
function parentCell(row, ticket) {
  if (!(/vrp|landing|comparison|hub/i.test(row['Task Type'] || '') || ['Lightning','DI Page Composer'].includes(row.Template))) return '—';
  const current = String(row['Parent Page'] || '');
  const options = ['<option value=""' + (!current ? ' selected' : '') + '>No parent</option>' + parentChoices(row).map(name => '<option value="' + esc(name) + '"' + (name === current ? ' selected' : '') + '>' + esc(name) + '</option>').join('')].join('');
  return '<select class="parent-select" data-parent-for="' + esc(ticket) + '" aria-label="Parent page for ' + esc(ticket) + '">' + options + '</select>';
}
function blogCategoryCell(row, ticket) {
  const pkg = state.cache.get(normTicket(ticket))?.pkg;
  const blog = pkg?.blog;
  if (!blog && !/\bblog\b/i.test(row['Task Type'] || '')) return '—';
  const categories = blog?.categoryOptions || [];
  if (!categories.length) return '<span class="muted" title="WordPress categories could not be fetched">Unavailable</span>';
  const selected = String(blog.categoryIds?.[0] || '');
  const options = ['<option value="">No category</option>', ...categories.map(c => `<option value="${esc(c.id)}"${String(c.id) === selected ? ' selected' : ''}>${esc(c.name)}</option>`)].join('');
  return `<select class="category-select" data-category-for="${esc(ticket)}" aria-label="Blog category for ${esc(ticket)}">${options}</select>`;
}
const BULK_TYPE_OPTIONS = ['publishing:landing','publishing:comparison','publishing:blog','enhancement:vrp','hub:service','hub:research','hub:finance'];
function taskTypeCell(row, ticket, attribute = 'data-type-for') {
  const current = BULK_TYPE_OPTIONS.find(key => TASK_TYPES[key]?.label === row['Task Type']) || '';
  const options = BULK_TYPE_OPTIONS.map(key => `<option value="${esc(key)}"${key === current ? ' selected' : ''}>${esc(TASK_TYPES[key].label.replace(/^(Publishing|Enhancement|Hub) — /, ''))}</option>`).join('');
  return `<select class="task-type-select" ${attribute}="${esc(ticket)}" aria-label="Page type for ${esc(ticket)}" title="Change page type">${options}</select>`;
}
function detailParentSelect(row, ticket) {
  const current = String(row['Parent Page'] || '').trim();
  const options = [`<option value=""${!current ? ' selected' : ''}>No parent</option>`, ...parentChoices(row).map(name => `<option value="${esc(name)}"${name === current ? ' selected' : ''}>${esc(name)}</option>`)].join('');
  return `<select class="detail-parent-select" data-detail-parent-for="${esc(ticket)}" aria-label="Parent page for ${esc(ticket)}">${options}</select>`;
}
function summaryField(label, value, extra = '') {
  return `<div class="ticket-summary-field ${extra}"><span>${esc(label)}</span><div>${value}</div></div>`;
}
function websiteCellHtml(row, ticket) {
  const pkg = state.cache.get(normTicket(ticket))?.pkg;
  const redirect = String(row['Website Redirect'] || pkg?.websiteRedirect || '').trim();
  return `<td class="website-cell" data-edit-website="${esc(ticket)}" title="Double-click or click Edit to change the website · ${esc(row.Website || '')}"><span>${esc(displayWebsite(row.Website) || '—')}</span><button class="website-edit-trigger" type="button" data-website-edit-trigger aria-label="Edit website for ${esc(ticket)}" title="Edit website">Edit</button><small class="edit-hint">Double-click or click Edit</small>${redirect ? `<small class="website-redirect-note">↪ Redirects to<br><a class="website-redirect-link" href="${esc(redirect)}" target="_blank" rel="noopener">${esc(redirect)}</a><button class="website-use-redirect" type="button" data-use-website-redirect="${esc(ticket)}">Use this URL</button></small>` : ''}</td>`;
}
function publishedCellHtml(row, ticket) {
  const pkg = state.cache.get(normTicket(ticket))?.pkg;
  const url = String(row['Published URL'] || pkg?.publishedUrl || '').trim();
  return `<td class="published-cell">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Published ↗</a>` : `<span class="muted" title="The published link is fetched automatically after the WordPress page is published.">${row['Draft Link'] ? 'Waiting for publish' : 'Auto-fetched after publish'}</span>`}</td>`;
}
function hubAnchorCode(row) {
  if (/\bblog\b/i.test(row['Task Type'] || '')) return '';
  const pkg = state.cache.get(normTicket(row.Ticket))?.pkg, hub = pkg?.hub || {};
  const title = String(row['Page Title'] || hub.title || hub.pageTitle || '').trim();
  const pages = pkg?.sitePages || [];
  const parentName = String(row['Parent Page'] || hub.parentSlug || '').trim().toLowerCase();
  const parent = parentName && pages.find(page => String(page.title || '').trim().toLowerCase() === parentName);
  let targetPath = '';
  const publishedUrl = String(row['Published URL'] || pkg?.publishedUrl || '').trim();
  if (publishedUrl) { try { targetPath = new URL(publishedUrl).pathname; } catch { /* use the draft slug */ } }
  if (!targetPath) {
    let rawSlug = String(row.Slug || hub.slug || hub.pageSlug || '').trim();
    if (/^https?:\/\//i.test(rawSlug)) { try { rawSlug = new URL(rawSlug).pathname; } catch { rawSlug = ''; } }
    const segments = value => String(value || '').split('/').filter(Boolean).map(part => {
      try { return encodeURIComponent(decodeURIComponent(part)); } catch { return encodeURIComponent(part); }
    });
    let parentPath = '';
    if (parent?.link) { try { parentPath = new URL(parent.link).pathname; } catch { /* use parent hierarchy */ } }
    if (!parentPath && parent) {
      const chain = [], seen = new Set(); let current = parent;
      while (current && !seen.has(Number(current.id))) {
        seen.add(Number(current.id));
        if (current.slug) chain.unshift(current.slug);
        current = pages.find(page => Number(page.id) === Number(current.parent));
      }
      parentPath = '/' + chain.join('/') + '/';
    }
    const parentParts = segments(parentPath), slugParts = segments(rawSlug);
    let overlap = 0;
    while (overlap < parentParts.length && overlap < slugParts.length && parentParts[overlap].toLowerCase() === slugParts[overlap].toLowerCase()) overlap++;
    targetPath = '/' + [...parentParts, ...slugParts.slice(overlap)].join('/') + '/';
  }
  if (!title || !targetPath || targetPath === '/' || targetPath === '//') return '';
  if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;
  if (!targetPath.endsWith('/')) targetPath += '/';
  const text = esc(title).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const href = esc(targetPath).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return '<a class="button primary-button" href="' + href + '">' + text + '</a>';
}

function setRow(row) {
  const t = normTicket(row.Ticket);
  const old = state.byTicket.get(t);
  const merged = { ...(old || {}), ...row, Ticket: t };
  state.byTicket.set(t, merged);
  const i = state.rows.findIndex(r => normTicket(r.Ticket) === t);
  if (i >= 0) state.rows[i] = merged; else state.rows.unshift(merged);
  return merged;
}

/* ---------------- grid ---------------- */
function isCompletedTicket(row) { return /^(published|complete|completed|done|closed)$/i.test(String(row?.Status || '').trim()); }
function isPublishedTicket(row) { return /^published$/i.test(String(row?.Status || '').trim()); }
function isRecentlyPublished(row) { return Number(state.publishedVisibleUntil[normTicket(row?.Ticket)] || 0) > Date.now(); }
function matchesTicketSearch(row, query) {
  return !query || [row?.Ticket, row?.Website, row?.Account, row?.['Page Title'], row?.Subject].some(value => String(value || '').toLowerCase().includes(query));
}
function visibleRows() {
  const q = $('search').value.trim().toLowerCase();
  const st = $('status-filter').value;
  const showCompleted = $('show-completed')?.checked || /^(published|complete|completed|done|closed)$/i.test(st);
  return state.rows.filter(r => {
    const searchMatch = !!q && matchesTicketSearch(r, q);
    const visibleByCompletion = isPublishedTicket(r) ? (searchMatch || isRecentlyPublished(r)) : (!isCompletedTicket(r) || showCompleted || searchMatch);
    return visibleByCompletion && (!st || r.Status === st) && matchesTicketSearch(r, q);
  });
}

function renderGrid() {
  const rows = visibleRows();
  const statusFilter = $('status-filter').value;
  const activeRow = state.byTicket.get(normTicket(state.selected));
  const currentSearch = $('search').value.trim().toLowerCase();
  const activeSearchMatch = !!currentSearch && matchesTicketSearch(activeRow, currentSearch);
  const shouldHideSelected = activeRow && (isPublishedTicket(activeRow)
    ? (!isRecentlyPublished(activeRow) && !activeSearchMatch)
    : (isCompletedTicket(activeRow) && !$('show-completed').checked && !/^(published|complete|completed|done|closed)$/i.test(statusFilter) && !activeSearchMatch));
  if (shouldHideSelected) {
    state.selected = '';
    $('detail').innerHTML = '<p class="muted">Completed ticket hidden. Turn on “Show completed” to view it.</p>';
  }
  $('count').textContent = `(${rows.length}${rows.length !== state.rows.length ? ' of ' + state.rows.length : ''})`;
  $('empty').hidden = rows.length > 0;
  $('empty').textContent = state.rows.length && !rows.length ? 'All tickets are complete. Turn on “Show completed” to view them.' : 'No tickets yet. Add ticket numbers above and click Fetch tickets.';
  const body = $('grid').querySelector('tbody');
  body.innerHTML = rows.map(r => {
    const t = normTicket(r.Ticket), hubCode = hubAnchorCode(r);
    return `<tr data-t="${esc(t)}" class="${t === state.selected ? 'sel' : ''}">
      <td><input type="checkbox" data-check="${esc(t)}" ${state.checked.has(t) ? 'checked' : ''}></td>
      <td><b>${esc(t)}</b></td><td>${taskTypeCell(r,t)}</td>
      <td title="${esc(r.Account || '')}">${esc(r.Account || '—')}</td>
      <td class="subject-cell" title="${esc(r.Subject || '')}">${esc(r.Subject || '—')}</td>
      ${websiteCellHtml(r,t)}
      <td>${parentCell(r,t)}</td>
      <td>${blogCategoryCell(r,t)}</td>
      <td title="${esc(r['Page Title'])}">${esc(r['Page Title'] || r.Subject || '')}</td>
      <td>${statusPill(r.Status)}</td>
      <td class="draft-links">${r['Draft Link'] ? `<a href="${esc(r['Draft Link'])}" target="_blank" rel="noopener" title="${esc(r['Draft Link'])}">Draft ↗</a>${r['Preview Link'] ? ` <a href="${esc(r['Preview Link'])}" target="_blank" rel="noopener" title="${esc(r['Preview Link'])}">Preview ↗</a>` : ''}` : (r.Status === 'Drafting' ? 'Saving…' : '—')}</td>
      <td>${hubCode ? `<button class="btn hub-code-copy" type="button" data-copy-hub-ticket="${esc(t)}" title="Copy page-title CTA anchor">Copy Hub Code</button>` : '—'}</td>
      <td><span class="dot ${dotFor(r.Checks)}"></span>${esc(r.Checks || '')}</td>${publishedCellHtml(r,t)}</tr>`;
  }).join('');
  updateBulkButtons();
}

function updateBulkButtons() {
  const n = state.checked.size;
  $('draft-selected').textContent = `Draft selected (${n})`;
  $('draft-selected').disabled = !n || state.busy;
  $('approve-selected').disabled = !n || state.busy;
}

/* ---------------- detail ---------------- */
async function loadDetail(ticket) {
  const t = normTicket(ticket);
  if (state.cache.has(t)) return state.cache.get(t);
  const d = await sheetApi.get(t);
  state.cache.set(t, d);
  return d;
}

function fieldHtml(label, value, opts = {}) {
  const v = String(value ?? '');
  const count = opts.max ? ` <span class="count ${v.length > opts.max ? 'over' : ''}">${v.length}/${opts.max}</span>` : '';
  return `<div class="field"><div class="lbl"><span>${esc(label)}${count}</span>${v ? `<button class="copy" data-copy="${esc(v)}" type="button">Copy</button>` : ''}</div>
    <div class="val ${v ? '' : 'empty'}">${v ? esc(v) : (opts.missing || 'Missing')}</div></div>`;
}

async function renderDetail(ticket) {
  const box = $('detail');
  window.__bulkLinkDispose?.(); window.__bulkLinkDispose = null;
  if (!ticket) { box.innerHTML = '<p class="muted">Click a ticket to review it.</p>'; return; }
  const t = normTicket(ticket), r = state.byTicket.get(t) || {};
  box.innerHTML = '<p class="muted">Loading ' + esc(t) + '…</p>';
  let pkg = null;
  try { pkg = (await loadDetail(t)).pkg; } catch (e) { toast(e.message, 5000); }
  if (state.selected !== t) return;
  if (pkg?.blog || pkg?.sitePages?.length || pkg?.websiteRedirect) renderGrid(); // populate website redirect, category, and page selectors from the saved package
  const ticketType = String(r['Task Type'] || '').toLowerCase();
  const isVrpTicket = /vrp/.test(ticketType), isLandingTicket = /landing/.test(ticketType), isComparisonTicket = /comparison/.test(ticketType);
  if (pkg?.imported && !pkg.hub && !isVrpTicket && (isLandingTicket || isComparisonTicket)) {
    const imp0 = pkg.imported, pageKind = isComparisonTicket ? 'comparison' : 'landing';
    pkg.hub = generateHub(pageKind, {
      pageTitle:imp0.title || r['Page Title'] || '', pageSlug:imp0.slug || r.Slug || '',
      comparisonMetaTitle:imp0.metaTitle || r['Meta Title'] || '', comparisonMetaDescription:imp0.metaDescription || r['Meta Description'] || '',
      ctaLearnMoreUrl:'', ctaInventoryUrl:'', vehicleName:'', ctaBodyContent:imp0.contentHtml || '',
      compareRows:imp0.compareRows || [], ctaButtonsHtml:imp0.buttonsHtml || '', suppressCtaButtons:!imp0.buttonsHtml, landingParent:'', templateName:'DI Page Composer',
      vrpSeoContent:false, landingBottom:r['Group 1']==='Yes'?'form':'blog', landingImage:null,
    });
    pkg.hub.adminUrl = r['WP Admin URL'] || r.Website || ''; pkg.hub.bulkNoImage = true; pkg.canDraft = true;
    r.Template = 'DI Page Composer';
    state.cache.set(t, { row:r, pkg }); setRow(r);
    try { await sheetApi.save(r, pkg); } catch (e) { state.lastError[t] = 'Could not sync the updated draft package: ' + e.message; }
  }
  const imp = pkg?.imported, hub = pkg?.hub, blog = pkg?.blog, isBlog = !!blog || /\bblog\b/i.test(ticketType), isVrp = !!hub?.vrpSeoContent;
  const checks = pkg?.checks || [], errs = checks.filter(c => c.level === 'error');
  let draftWhy = '';
  if (!pkg) draftWhy = 'The full page for this ticket is not in the sheet (Content tab), so it cannot be reviewed or drafted. Click Re-fetch.';
  else if (!pkg?.canDraft && !pkg?.hub && !pkg?.blog) draftWhy = 'This ticket type does not have a bulk draft package.';
  else if (errs.length) draftWhy = 'Fix the listed errors, then Save review before drafting.';
  else if (r.Status === 'Drafting') draftWhy = 'A draft is already running for this ticket.';
  const contentSectionId = /comparison/i.test(ticketType) ? 'ctacontent' : 'landingcontent';
  const content = blog?.content || (hub?.vrpSeoContent ? (hub.vrpContentHtml || imp?.contentHtml || '') : (hub?.sections?.find(section => section.id === contentSectionId)?.html || imp?.contentHtml || ''));
  const docUrl = r['Doc URL'] || '';
  const docId = (docUrl.match(/document\/d\/([a-zA-Z0-9_-]+)/) || [])[1];
  const docPreview = docId ? 'https://docs.google.com/document/d/' + encodeURIComponent(docId) + '/preview' : '';
  const draftPreview = r['Preview Link'] || '';
  const summaryHubCode = hubAnchorCode(r);
  const pageTask = /vrp|landing|comparison|hub/i.test(r['Task Type'] || '') || ['Lightning','DI Page Composer'].includes(r.Template);
  const detailSummary = `<section class="ticket-summary"><div class="ticket-summary-title"><div><span class="eyebrow">TICKET OVERVIEW</span><h3>Review details</h3></div><span class="ticket-summary-count">${esc(t)}</span></div><div class="ticket-summary-grid">
    ${summaryField('Ticket Number', esc(t))}
    ${summaryField('Type', taskTypeCell(r, t, 'data-detail-type-for'))}
    ${summaryField('Account Name', esc(r.Account || '—'))}
    ${summaryField('Website', esc(r.Website || '—'))}
    ${summaryField('Subject', esc(r.Subject || '—'), 'wide')}
    ${summaryField('Parent Page', pageTask ? detailParentSelect(r, t) : esc(r['Parent Page'] || '—'))}
    ${summaryField('Status', statusPill(r.Status))}
    ${summaryField('Draft URL', r['Draft Link'] ? `<a href="${esc(r['Draft Link'])}" target="_blank" rel="noopener">Open saved draft ↗</a>` : '<span class="muted">No draft saved</span>')}
    ${summaryField('Hub Code', summaryHubCode ? `<button class="btn hub-code-copy" type="button" data-copy-hub-detail="${esc(t)}">Copy Hub Code</button>` : '<span class="muted">No Hub Code available</span>')}
  </div></section>`;
  box.innerHTML = `
    <div class="d-head"><div><h2>${esc(t)} · ${esc(r['Page Title'] || r.Subject || '')}</h2><div class="d-sub">${esc(r['Task Type'] || '')} · ${esc(r.Website || r.Account || '')} · fetched ${esc(when(r['Fetched At']))}</div></div>${statusPill(r.Status)}</div>
    ${detailSummary}
    <div class="actions">
      <button class="btn primary" data-act="approve-draft" ${draftWhy ? 'disabled' : ''}>${r['Draft Link'] ? 'Approve & save draft again' : '✓ Approve & save as draft'}</button>
      ${(r['Draft Link'] || /draft failed|failed/i.test(`${r.Status || ''} ${r['Draft Status'] || ''}`) || state.lastError[t]) ? `<button class="btn" data-act="draft-again" ${draftWhy ? 'disabled' : ''} title="Retry this ticket's WordPress draft without putting it back through approval">↻ Draft again</button>` : ''}
      <button class="btn" data-act="save-review">Save review</button>
      <button class="btn" data-act="import-doc">Fetch Doc only</button>
      <button class="btn" data-act="refetch">↻ Re-fetch ticket</button>
    </div>
    <label class="review-doc-url">Google Doc link <input id="review-doc-url" type="url" value="${esc(docUrl)}" placeholder="Paste a Google Docs link"></label>
    ${draftWhy ? `<div class="box"><b>Draft availability:</b> ${esc(draftWhy)}</div>` : ''}
    ${r.Notes ? `<div class="box bad"><b>Fetch / fallback details:</b> ${esc(r.Notes)}</div>` : ''}
    ${state.lastError[t] ? `<div class="box bad"><b>Last problem:</b> ${esc(state.lastError[t])}</div>` : ''}
    <h3>Compare and edit content</h3>
    <p class="muted">Google Doc is on the left. Click into imported content on the right to remove or edit text, then Save review.</p>
    <div class="review-split">
      <section><div class="review-pane-head"><b>Google Doc</b>${docUrl ? `<a class="doc-open" href="${esc(docUrl)}" target="_blank" rel="noopener">Open full Doc ↗</a>` : ''}</div>${docPreview ? `<iframe class="review-frame doc-source" scrolling="auto" title="Google Doc" src="${esc(docPreview)}"></iframe>` : '<p class="muted">Paste a Google Doc URL and choose Fetch Doc only.</p>'}<div id="bulk-il-panel" class="il-panel" hidden><strong>Internal link suggestions</strong><small>Best 7 suggestions first. Click “Show more” for additional options. Verify the page, adjust link text, and tick only the links you want to apply.</small><div id="bulk-il-list" class="il-list"></div><p id="bulk-il-status" role="status"></p><button id="bulk-il-rescan" class="btn" type="button">Re-check links</button><button class="btn primary" data-link-apply type="button">Apply selected links to content</button></div><input id="bulk-il-admin-url" type="hidden" value="${esc(r['WP Admin URL'] || r.Website || '')}"></section>
      <section><b>${isBlog ? 'Blog fields and imported content' : 'Page fields and imported content'}</b><div class="review-fields">
      <label>${isBlog ? 'Post title' : 'Page title'}<input id="review-title" value="${esc(r['Page Title'] || '')}"></label>
      <label>Slug<input id="review-slug" value="${esc(r.Slug || '')}"></label>
      <label>Meta title<input id="review-meta-title" value="${esc(r['Meta Title'] || '')}"></label>
      <label>Meta description<textarea id="review-meta-description" rows="2">${esc(r['Meta Description'] || '')}</textarea></label>
      <label class="review-button-code">Button Code / CTA<textarea id="review-button-code" rows="3" placeholder="Button HTML from the Google Doc">${esc(imp?.buttonsHtml || '')}</textarea><ol id="review-button-checks" class="button-checks">${checks.filter(c => c.name.startsWith('Button URL — ')).map((c,i) => `<li class="${c.level}"><b>${i+1}.</b> ${c.ok ? '✔' : c.level === 'error' ? '✖' : '!'} ${esc(c.name.replace('Button URL — ',''))} — ${esc(c.detail || (c.ok ? 'working' : 'needs attention'))}</li>`).join('') || '<li class="muted">No CTA URLs to check.</li>'}</ol></label>
    </div><div class="review-editor-label">Content (edit or remove text)</div><iframe id="review-content-editor" class="review-frame editable" scrolling="auto" title="Editable imported content" sandbox="allow-same-origin"></iframe>
    </section>
    </div>
    <h3>WordPress draft preview</h3>
    ${draftPreview ? `<iframe class="review-wp" title="Saved WordPress draft preview" src="${esc(draftPreview)}" referrerpolicy="no-referrer"></iframe><p><a href="${esc(draftPreview)}" target="_blank" rel="noopener">Open draft preview in a new tab</a>${r['Draft Link'] ? ` · <a href="${esc(r['Draft Link'])}" target="_blank" rel="noopener">Edit draft in WordPress</a>` : ''}</p>` : '<p class="muted">Draft preview appears here after you save a draft in WordPress.</p>'}
    <h3>Checks</h3><ul class="checks">${checks.length ? checks.map(c => `<li class="${c.level}"><span class="k">${c.ok ? '✔' : c.level === 'error' ? '✖' : '!'}</span><div>${esc(c.name)}${c.detail ? ` <small>— ${esc(c.detail)}</small>` : ''}</div></li>`).join('') : '<li class="muted">No checks stored.</li>'}</ul>
    ${(pkg?.warnings || []).length ? `<div class="box"><b>Notes</b><br>${pkg.warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="muted">Content: ${esc(r['Content Words'] || 0)} words · ${esc(r['H2 Count'] || 0)} H2 · ${esc(r['Internal Links'] || 0)} internal links · ${esc(r['External Links'] || 0)} external</div>
    <details><summary>Content HTML</summary><pre class="html">${esc(content)}</pre></details>
    ${hub ? '<details><summary>Hub page package (JSON)</summary><pre class="html">' + esc(JSON.stringify(hub, null, 2)) + '</pre></details>' : ''}
    <h3>Timing</h3><div class="muted">Salesforce ${esc(r['Salesforce Secs'] || '—')}s · Doc ${esc(r['Doc Secs'] || '—')}s · Total ${esc(r['Total Secs'] || '—')}s</div>`;
  const frame = $('review-content-editor');
  const buttonCodeInput = $('review-button-code');
  if (buttonCodeInput) {
    let checkTimer;
    let checkRun = 0;
    const updateChecks = async () => {
      const run = ++checkRun;
      const list = $('review-button-checks');
      if (!list) return;
      list.innerHTML = '<li class="muted">Checking button URLs…</li>';
      const results = await verifyButtonUrls(buttonCodeInput.value, r['WP Admin URL'] || r.Website || '');
      if (run !== checkRun || $('review-button-code') !== buttonCodeInput) return;
      list.innerHTML = results.length
        ? results.map((c, i) => `<li class="${esc(c.level)}"><b>${i + 1}.</b> ${c.ok ? '✔' : c.level === 'error' ? '✖' : '!'} ${esc(c.name.replace('Button URL — ',''))} — ${esc(c.detail || (c.ok ? 'working' : 'needs attention'))}</li>`).join('')
        : (buttonCodeInput.value.trim() ? '<li class="error">No <a href="…"> button link found in this code.</li>' : '<li class="muted">No CTA buttons in the Google Doc.</li>');
    };
    buttonCodeInput.addEventListener('input', () => { clearTimeout(checkTimer); checkTimer = setTimeout(updateChecks, 350); });
  }
  if ($('review-doc-url')) $('review-doc-url').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('detail').querySelector('[data-act=import-doc]')?.click(); } });
  if (frame) { frame.srcdoc = '<!doctype html><meta charset="utf-8"><style>body{font:15px/1.55 system-ui,sans-serif;color:#222;padding:14px;outline:none}body *{color:#222!important}span[style*=background],mark{background:transparent!important}a{color:#0b5a4a!important}</style>' + content; frame.addEventListener('load', () => { try { frame.contentDocument.body.contentEditable = 'true'; frame.contentDocument.designMode = 'on'; } catch {} if (state.selected !== t) return; window.__bulkLinkDispose?.(); window.__bulkLinkDispose = initInternalLinks({ panelId:'bulk-il-panel', listId:'bulk-il-list', statusId:'bulk-il-status', rescanId:'bulk-il-rescan', slugId:'review-slug', adminUrlId:'bulk-il-admin-url', event:'bulk:doc-imported', transformHook:'__bulkILTransform', resyncFn:'__bulkILResync' }); document.dispatchEvent(new CustomEvent('bulk:doc-imported', { detail:{ bodyHtml:content, adminUrl:$('bulk-il-admin-url')?.value || '' } })); }, { once: true }); }
  box.dataset.content = content;
  box.dataset.hubCode = hub ? JSON.stringify(hub, null, 2) : '';
}
/* ---------------- fetching ---------------- */
function parseTickets(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/).map(normTicket).filter(Boolean))];
}

async function persist(row, pkg) {
  const res = await sheetApi.save(row, pkg);
  if (!res.saved) toast('Sheet not reachable — kept on this computer and will be sent again.', 5000);
  await refreshPending();
  return res;
}

async function runBatch(tickets, options = {}) {
  if (state.busy) return toast('A batch is already running.');
  if (!tickets.length) return toast('Add at least one ticket number.');
  if (tickets.length > 30) tickets = tickets.slice(0, 30), toast('Only the first 30 tickets are taken per batch.');
  const s = await getSettings();
  if (!s.url || !s.token) { toast('Set up ⚙ Settings first (Apps Script URL + token).', 5000); $('settings').showModal(); return; }

  state.busy = true; state.stop = false;
  $('fetch').disabled = true; $('stop').hidden = false; updateBulkButtons();
  const list = $('progress');
  list.innerHTML = tickets.map(t => `<li data-p="${esc(t)}"><b>${esc(t)}</b><span>Waiting…</span></li>`).join('');
  let done = 0, issues = 0;

  for (const ticket of tickets) {
    if (state.stop) { list.querySelector(`[data-p="${CSS.escape(ticket)}"] span`).textContent = 'Skipped (stopped)'; continue; }
    const li = list.querySelector(`[data-p="${CSS.escape(ticket)}"]`);
    li.classList.add('run');
    const step = text => { li.querySelector('span').textContent = text; };
    step('Starting…');
    try {
      const { row, pkg, error } = await runTicket(ticket, { onStep: step, shouldStop: () => state.stop, docUrlOverride: options.docUrlOverride || '' });
      step('Saving to the sheet…');
      state.cache.set(ticket, { row, pkg });
      const merged = setRow(row);
      renderGrid();
      await persist(row, pkg);
      step(error ? `✖ ${error}` : `${merged.Status} — ${merged.Checks || ''}`);
      if (error || merged.Status === 'Needs attention' || merged.Status === 'Failed') issues++;
      done++;
    } catch (e) {
      step('✖ ' + e.message); issues++;
    }
    li.classList.remove('run');
    if (state.selected === ticket) renderDetail(ticket);
  }

  await send({ type: 'SF_BATCH_DONE' });
  state.busy = false;
  $('fetch').disabled = false; $('stop').hidden = true; updateBulkButtons();
  $('batch-note').textContent = `${done} of ${tickets.length} fetched${issues ? `, ${issues} need a look` : ''}.`;
  toast(`Finished: ${done} of ${tickets.length} tickets.`);
  runDraftQueue();
}

async function saveReview(ticket) {
  const t = normTicket(ticket), item = await loadDetail(t), pkg = item.pkg;
  if (!pkg) throw new Error('Re-fetch this ticket before editing its content.');
  const row = { ...(state.byTicket.get(t) || item.row || {}) };
  const frame = $('review-content-editor');
  let content = frame?.contentDocument?.body?.innerHTML || '';
  const parsedContent = new DOMParser().parseFromString(`<div id="review-root">${content}</div>`, 'text/html');
  const contentRoot = parsedContent.querySelector('#review-root');
  contentRoot.querySelectorAll('a.button, a.primary-button, a[class*=button]').forEach(anchor => anchor.remove());
  contentRoot.querySelectorAll('div.text-center').forEach(wrapper => { if (!wrapper.textContent.trim() && !wrapper.querySelector('img')) wrapper.remove(); });
  content = contentRoot.innerHTML;
  const title = $('review-title').value.trim(), slug = $('review-slug').value.trim();
  const metaTitle = $('review-meta-title').value.trim(), metaDescription = $('review-meta-description').value.trim();
  const buttonsHtml = normalizeButtonMarkup($('review-button-code')?.value || '');
  if (pkg.blog) {
    content = composeBlogContent(content, buttonsHtml, pkg.blog.imageShortcode || '');
    Object.assign(pkg.blog, { title, slug, metaTitle, metaDescription, buttons: buttonsHtml, content });
  }
  const stats = analyse(content, row['WP Admin URL'] || row.Website || '');
  row['Page Title'] = title; row.Slug = slug; row['Meta Title'] = metaTitle; row['Meta Title Chars'] = metaTitle.length;
  row['Meta Description'] = metaDescription; row['Meta Desc Chars'] = metaDescription.length;
  row['Content Words'] = stats.words; row['Content Chars'] = stats.chars; row['H2 Count'] = stats.h2; row['Internal Links'] = stats.internal; row['External Links'] = stats.external;
  row['Doc URL'] = $('review-doc-url').value.trim();
  pkg.imported = { ...(pkg.imported || {}), title, slug, metaTitle, metaDescription, buttonsHtml, contentHtml: content };
  if (pkg.blog) Object.assign(pkg.blog, { title, slug, metaTitle, metaDescription, buttons: buttonsHtml, content });
  if (pkg.hub?.vrpSeoContent) Object.assign(pkg.hub, { pageTitle: title, pageSlug: slug, comparisonMetaTitle: metaTitle, comparisonMetaDescription: metaDescription, vrpContentHtml: content, ctaButtonsHtml: buttonsHtml });
  else if (pkg.hub && /landing|comparison/i.test(row['Task Type'] || '')) {
    const isComparison = /comparison/i.test(row['Task Type'] || '');
    const sectionId = isComparison ? 'ctacontent' : 'landingcontent';
    const oldSection = pkg.hub.sections?.find(s => s.id === sectionId);
    const retainedButtons = buttonsHtml;
    const fresh = generateHub(isComparison ? 'comparison' : 'landing', {
      pageTitle: title, pageSlug: slug, comparisonMetaTitle: metaTitle, comparisonMetaDescription: metaDescription,
      ctaLearnMoreUrl: '', ctaInventoryUrl: '', vehicleName: '', ctaBodyContent: content,
      ctaButtonsHtml: retainedButtons, suppressCtaButtons: !retainedButtons, landingParent: row['Parent Page'] || pkg.hub.parentSlug || '',
      templateName: pkg.hub.templateName || 'DI Page Composer', landingBottom: row['Group 1'] === 'Yes' ? 'form' : 'blog', landingImage: null,
    });
    const freshSection = fresh.sections?.find(s => s.id === sectionId);
    if (oldSection && freshSection) oldSection.html = freshSection.html;
    Object.assign(pkg.hub, { title: fresh.title, slug: fresh.slug, parentSlug: fresh.parentSlug, metaTitle: fresh.metaTitle, metaDescription: fresh.metaDescription });
  }
  const check = (name, ok, detail = '') => ({ name, ok, level: ok ? 'ok' : 'error', detail });
  const checks = (pkg.checks || []).filter(c => !['Page title (H1 in the doc)','Page slug in the doc','Meta title present','Meta title length (≤ 60)','Meta description present','Meta description length (≤ 160)','Content found','Content starts with an H2','No H1 left in the content','External links have nofollow'].includes(c.name) && !c.name.startsWith('Button URL — '));
  checks.push(check('Page title (H1 in the doc)', !!title, title));
  checks.push({ name:'Page slug in the doc', ok:!!slug, level:slug?'ok':'warn', detail:slug || 'Will be made from the title if left blank.' });
  checks.push(check('Meta title present', !!metaTitle));
  checks.push({ name:'Meta title length (≤ 60)', ok:metaTitle.length<=60, level:metaTitle.length>60?'warn':'ok', detail:metaTitle.length + ' characters' });
  checks.push(check('Meta description present', !!metaDescription));
  checks.push({ name:'Meta description length (≤ 160)', ok:metaDescription.length<=160, level:metaDescription.length>160?'warn':'ok', detail:metaDescription.length + ' characters' });
  checks.push(check('Content found', stats.words > 0, stats.words + ' words'));
  if (pkg.hub?.vrpSeoContent) {
    checks.push({ name:'Content starts with an H2', ok:stats.startsWithH2, level:stats.startsWithH2?'ok':'warn', detail:'' });
    checks.push(check('No H1 left in the content', stats.h1 === 0, stats.h1 ? stats.h1 + ' H1 found' : ''));
  }
  checks.push({ name:'External links have nofollow', ok:stats.noFollowMissing === 0, level:stats.noFollowMissing?'warn':'ok', detail:stats.noFollowMissing ? stats.noFollowMissing + ' without nofollow' : stats.external + ' external' });
  checks.push(...await verifyButtonUrls(buttonsHtml, row['WP Admin URL'] || row.Website || ''));
  pkg.checks = checks;
  row.Checks = checks.filter(c => !c.ok && c.level === 'error').length + ' errors · ' + checks.filter(c => !c.ok && c.level === 'warn').length + ' warnings';
  row.Status = checks.some(c => c.level === 'error' && !c.ok) ? 'Needs attention' : 'Ready for review';
  const saved = await sheetApi.save(row, pkg);
  state.cache.set(t, { row, pkg }); setRow(row); renderGrid(); await refreshPending();
  toast(saved.saved ? 'Review saved to the sheet.' : 'Review saved locally; it will sync when the sheet is reachable.', 4500);
  renderDetail(t);
}

async function importReviewDoc(ticket, urlOverride = '') {
  const t = normTicket(ticket), url = String(urlOverride || $('review-doc-url').value || '').trim();
  if (!url) throw new Error('Paste a Google Doc link first.');
  const current = await loadDetail(t), pkg = current.pkg;
  if (!pkg) throw new Error('Fetch the Salesforce ticket once before importing a replacement Doc.');
  toast('Fetching the selected Google Doc…', 5000);
  const doc = await send({ type: 'IMPORT_COMPARISON_DOC', documentUrl: url });
  if (!doc.ok) throw new Error(doc.error || 'Could not import the Google Doc.');
  const row = { ...(state.byTicket.get(t) || current.row || {}) };
  const isBlog = /\bblog\b/i.test(row['Task Type'] || ''), isVrp = /vrp/i.test(row['Task Type'] || ''), isLanding = /landing/i.test(row['Task Type'] || ''), isComparison = /comparison/i.test(row['Task Type'] || ''), admin = row['WP Admin URL'] || row.Website || '';
  if (isBlog) {
    const imported = await send({ type: 'IMPORT_GOOGLE_DOC', documentUrl: url, adminUrl: admin, landingBottom: 'blog', returnOnly: true });
    if (!imported.ok) throw new Error(imported.error || 'Could not import the Blog Google Doc.');
    const blog = imported.draft || {};
    const content = composeBlogContent(blog.bodyHtml || '', blog.buttons || '', blog.imageShortcode || '');
    const stats = analyse(content, admin);
    Object.assign(row, { 'Doc URL': url, 'Page Title': blog.title || '', Slug: blog.slug || '', 'Meta Title': blog.metaTitle || '', 'Meta Title Chars': (blog.metaTitle || '').length, 'Meta Description': blog.metaDescription || '', 'Meta Desc Chars': (blog.metaDescription || '').length, 'Content Words': stats.words, 'Content Chars': stats.chars, 'H2 Count': stats.h2, 'Internal Links': stats.internal, 'External Links': stats.external, Template: 'Blog' });
    pkg.imported = { ...(pkg.imported || {}), title: blog.title || '', slug: blog.slug || '', metaTitle: blog.metaTitle || '', metaDescription: blog.metaDescription || '', buttonsHtml: blog.buttons || '', contentHtml: content, skipped: blog.skipped || [] };
    pkg.blog = { ...blog, categoryOptions: pkg.blog?.categoryOptions || [], categoryIds: pkg.blog?.categoryIds || [], categoryName: pkg.blog?.categoryName || '', categoryChoiceSet: !!pkg.blog?.categoryChoiceSet, title: blog.title || '', slug: blog.slug || '', metaTitle: blog.metaTitle || '', metaDescription: blog.metaDescription || '', buttons: blog.buttons || '', content, adminUrl: admin, bulkTicket: t };
    const checks = (pkg.checks || []).filter(c => !['Page title (H1 in the doc)','Page slug in the doc','Meta title present','Meta title length (≤ 60)','Meta description present','Meta description length (≤ 160)','Content found','External links have nofollow','Nothing skipped from the doc'].includes(c.name) && !c.name.startsWith('Button URL — '));
    const add = (name, ok, level = 'error', detail = '') => checks.push({ name, ok: !!ok, level: ok ? 'ok' : level, detail });
    add('Post title in the doc', !!blog.title, 'error', blog.title || 'Missing');
    add('Post slug in the doc', !!blog.slug, 'warn', blog.slug || 'Will be made from the title if blank.');
    add('Meta title present', !!blog.metaTitle, 'error'); add('Meta title length (≤ 60)', (blog.metaTitle || '').length <= 60, 'warn', (blog.metaTitle || '').length + ' characters');
    add('Meta description present', !!blog.metaDescription, 'error'); add('Meta description length (≤ 160)', (blog.metaDescription || '').length <= 160, 'warn', (blog.metaDescription || '').length + ' characters');
    add('Content found', stats.words > 0, 'error', stats.words + ' words');
    add('External links have nofollow', stats.noFollowMissing === 0, 'warn', stats.noFollowMissing ? stats.noFollowMissing + ' without nofollow' : stats.external + ' external');
    checks.push(...await verifyButtonUrls(blog.buttons || '', admin));
    if (blog.skipped?.length) add('Nothing skipped from the doc', false, 'warn', blog.skipped.map(x => '“' + x.text + '” (' + x.why + ')').join(' · '));
    pkg.checks = checks; pkg.canDraft = true; row.Status = checks.some(c => !c.ok && c.level === 'error') ? 'Needs attention' : 'Ready for review';
    row.Checks = checks.filter(c => !c.ok && c.level === 'error').length + ' errors · ' + checks.filter(c => !c.ok && c.level === 'warn').length + ' warnings';
    await sheetApi.save(row, pkg); state.cache.set(t, { row, pkg }); setRow(row); renderGrid(); await refreshPending(); renderDetail(t);
    toast('Blog Doc imported. Review it and save a WordPress draft from here.', 4000);
    return;
  }
  const prepared = prepareImportedDoc(doc, { isVrp, adminUrl: admin });
  row['Doc URL'] = url; row['Page Title'] = prepared.title; row.Slug = prepared.slug;
  row['Meta Title'] = prepared.metaTitle; row['Meta Title Chars'] = prepared.metaTitle.length;
  row['Meta Description'] = prepared.metaDescription; row['Meta Desc Chars'] = prepared.metaDescription.length;
  row['Content Words'] = prepared.stats.words; row['Content Chars'] = prepared.stats.chars; row['H2 Count'] = prepared.stats.h2;
  row['Internal Links'] = prepared.stats.internal; row['External Links'] = prepared.stats.external;
  pkg.imported = { ...(pkg.imported || {}), title:prepared.title, slug:prepared.slug, metaTitle:prepared.metaTitle, metaDescription:prepared.metaDescription, buttonsHtml:doc.buttons||'', contentHtml:prepared.content, disclaimerFound:!!doc.disclaimerFound, skipped:doc.skipped||[] };
  if (isVrp || isLanding || isComparison) {
    const pageKind = isComparison ? 'comparison' : 'landing';
    pkg.hub = generateHub(pageKind, { pageTitle:prepared.title, pageSlug:prepared.slug, comparisonMetaTitle:prepared.metaTitle, comparisonMetaDescription:prepared.metaDescription, ctaLearnMoreUrl:'', ctaInventoryUrl:'', vehicleName:'', ctaBodyContent:prepared.content, compareRows:doc.compareRows||[], ctaButtonsHtml:doc.buttons||'', landingParent:row['Parent Page']||'', templateName:isVrp?'Lightning':'DI Page Composer', vrpSeoContent:isVrp, landingBottom:isVrp?'':(row['Group 1']==='Yes'?'form':'blog'), landingImage:null });
    pkg.hub.adminUrl = admin; pkg.hub.bulkNoImage = !isVrp; pkg.canDraft = true; row.Template=isVrp?'Lightning':'DI Page Composer';
  }
  const checks = (pkg.checks||[]).filter(c=>!['Page title (H1 in the doc)','Page slug in the doc','Meta title present','Meta title length (≤ 60)','Meta description present','Meta description length (≤ 160)','Content found','Content starts with an H2','No H1 left in the content','External links have nofollow','Nothing skipped from the doc'].includes(c.name) && !c.name.startsWith('Button URL — '));
  const add=(name,ok,level='error',detail='')=>checks.push({name,ok:!!ok,level:ok?'ok':level,detail});
  add('Page title (H1 in the doc)',!!prepared.title,'error',prepared.title);
  add('Page slug in the doc',!!prepared.slug,'warn',prepared.slug||'Will be made from the title if left blank.');
  add('Meta title present',!!prepared.metaTitle,'error'); add('Meta title length (≤ 60)',prepared.metaTitle.length<=60,'warn',prepared.metaTitle.length+' characters');
  add('Meta description present',!!prepared.metaDescription,'error'); add('Meta description length (≤ 160)',prepared.metaDescription.length<=160,'warn',prepared.metaDescription.length+' characters');
  add('Content found',prepared.stats.words>0,'error',prepared.stats.words+' words');
  if(isVrp){add('Content starts with an H2',prepared.stats.startsWithH2,'warn');add('No H1 left in the content',prepared.stats.h1===0,'error');}
  add('External links have nofollow',prepared.stats.noFollowMissing===0,'warn',prepared.stats.noFollowMissing?prepared.stats.noFollowMissing+' without':prepared.stats.external+' external');
  checks.push(...await verifyButtonUrls(doc.buttons||'', admin));
  if(doc.skipped?.length)add('Nothing skipped from the doc',false,'warn',doc.skipped.map(x=>'“'+x.text+'” ('+x.why+')').join(' · '));
  pkg.checks=checks; pkg.warnings=doc.skipped?.length?['Some document content was skipped; check the import notes.']:[];
  row.Checks=checks.filter(c=>!c.ok&&c.level==='error').length+' errors · '+checks.filter(c=>!c.ok&&c.level==='warn').length+' warnings';
  row.Status=checks.some(c=>!c.ok&&c.level==='error')?'Needs attention':'Ready for review';
  const saved=await sheetApi.save(row,pkg); state.cache.set(t,{row,pkg});setRow(row);renderGrid();await refreshPending();
  toast(saved.saved?'Google Doc imported; Salesforce was not re-run.':'Doc imported and saved locally; it will sync when the sheet is reachable.',4500);
  renderDetail(t);
}

/* ---------------- approve / draft ---------------- */
async function setStatus(ticket, patch, event) {
  const t = normTicket(ticket);
  await sheetApi.patch(t, patch, event);
  setRow({ Ticket: t, ...patch });
  const c = state.cache.get(t); if (c) c.row = { ...c.row, ...patch };
  renderGrid();
  if (state.selected === t) renderDetail(t);
}

const pendingDraftQueue = [];
const pendingDraftTickets = new Set();
let draftQueueRunning = false;
async function runDraftQueue() {
  if (draftQueueRunning || state.busy || !pendingDraftQueue.length) return;
  draftQueueRunning = true;
  try {
    while (pendingDraftQueue.length) {
      const ticket = pendingDraftQueue.shift(), t = normTicket(ticket);
      try { await draftOne(t, { ask:false }); toast(t + ' draft saved. Moving to the next queued ticket.', 3500); }
      catch (e) { state.lastError[t] = e.message; toast(t + ': ' + e.message, 7000); if (state.selected === t) renderDetail(t); }
      finally { pendingDraftTickets.delete(t); }
    }
  } finally { draftQueueRunning = false; updateBulkButtons(); }
}

async function approveAndDraft(ticket) {
  const t = normTicket(ticket), { pkg } = await loadDetail(t);
  if ((pkg?.checks || []).some(c => c.level === 'error')) throw new Error(t + ': fix the errors first, then Save review.');
  if (pendingDraftTickets.has(t) || draftQueueRunning && normTicket(pendingDraftQueue[0]) === t) return toast(t + ' is already queued for a draft.', 3000);
  await setStatus(t, { Status: 'Approved' }, 'Approved');
  pendingDraftTickets.add(t); pendingDraftQueue.push(t);
  toast(t + ' approved and queued. Keep reviewing; the WordPress draft runs in a background tab.', 5000);
  runDraftQueue();
}

async function approve(ticket) {
  const { pkg } = await loadDetail(ticket);
  if ((pkg?.checks || []).some(c => c.level === 'error')) throw new Error(`${ticket}: fix the errors first (re-fetch after correcting the doc).`);
  await setStatus(ticket, { Status: 'Approved' }, 'Approved');
  drainApproved();
}

async function waitDraftResult(ticket, since, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = (await chrome.storage.local.get('bulkDraftResult')).bulkDraftResult;
    if (r && r.ticket === ticket && r.at >= since) return r;
    await sleep(1500);
  }
  return null;
}

async function applyDraftResult(ticket, res) {
  const patch = res.ok
    ? { Status: 'Draft saved', 'Draft Status': 'Saved as draft', 'Draft Link': res.editUrl || '', 'Preview Link': res.previewUrl || '', 'Draft Saved At': new Date(res.at).toISOString(), 'Draft Secs': res.seconds || '', 'Draft Notes': res.notice || '' }
    : { Status: 'Draft failed', 'Draft Status': 'Failed', 'Draft Notes': res.error || 'Unknown error' };
  await setStatus(ticket, patch, res.ok ? 'Draft saved' : 'Draft failed');
  if (res.ok && res.postId) {
    const t = normTicket(ticket), item = await loadDetail(t), pkg = item.pkg || {};
    pkg.wpPostId = Number(res.postId);
    pkg.wpObjectType = /^blog$/i.test((state.byTicket.get(t) || {}).Template || '') ? 'post' : 'page';
    const row = state.byTicket.get(t) || item.row || {};
    await sheetApi.save(row, pkg);
    state.cache.set(t, { row, pkg });
  }
  if (res.parentPage) {
    const t = normTicket(ticket), item = await loadDetail(t), pkg = item.pkg || state.cache.get(t)?.pkg || null;
    const row = { ...(state.byTicket.get(t) || item.row || {}), 'Parent Page': res.parentPage };
    if (pkg?.hub) pkg.hub.parentSlug = res.parentPage;
    if (pkg) await sheetApi.save(row, pkg); else await sheetApi.patch(t, { 'Parent Page': res.parentPage }, 'Parent selected in WordPress');
    state.cache.set(t, { row, pkg }); setRow(row); renderGrid();
    if (state.selected === t) renderDetail(t);
  }
  await chrome.storage.local.set({ bulkDraftSyncedAt: res.at });
}

async function draftOne(ticket, { ask = true } = {}) {
  const t = normTicket(ticket);
  const { row, pkg } = await loadDetail(t);
  if ((!pkg?.hub && !pkg?.blog) || !pkg?.canDraft) throw new Error(`${t}: this ticket does not have a bulk draft package. Fetch the ticket and Google Doc first.`);
  const errors = (pkg.checks || []).filter(c => c.level === 'error');
  if (errors.length) throw new Error(`${t}: fix first — ${errors.map(c => c.name).join('; ')}`);
  if (ask) {
    const again = row['Draft Link'] ? '\n\nA draft already exists for this ticket — this will create ANOTHER page.' : '';
    if (!confirm(`Fill WordPress for ${t} and save it as a DRAFT?\n\nTitle: ${row['Page Title']}\nSite: ${row['WP Admin URL']}\n\nNothing is published.${again}`)) return;
  }
  const admin = row['WP Admin URL'] || pkg.hub?.adminUrl || pkg.blog?.adminUrl;
  const since = Date.now();
  await setStatus(t, { Status: 'Drafting', 'Draft Status': 'Running', 'Draft Notes': '' }, 'Draft started');
  let op;
  if (pkg.blog) {
    const queued = await send({ type: 'QUEUE_WORDPRESS_DRAFT', draft: { ...pkg.blog, adminUrl: admin, bulkTicket: t } });
    if (!queued.ok) { await applyDraftResult(t, { ok: false, at: Date.now(), error: queued.error }); throw new Error(queued.error); }
    op = await send({ type: 'OPEN_PENDING_DRAFT', autoSaveDraft: true });
  } else {
    const hub = { ...pkg.hub, autoDraft: true, bulkTicket: t, adminUrl: admin };
    const st = await send({ type: 'STORE_HUB_PAGE', hub });
    if (!st.ok) { await applyDraftResult(t, { ok: false, at: Date.now(), error: st.error }); throw new Error(st.error); }
    op = await send({ type: 'OPEN_HUB_PAGE', adminUrl: admin });
  }
  if (!op.ok) { await applyDraftResult(t, { ok: false, at: Date.now(), error: op.error }); throw new Error(op.error); }
  const res = await waitDraftResult(t, since, 6 * 60 * 1000);
  if (!res) {
    const timeout = { ok: false, at: Date.now(), error: 'WordPress did not finish within 6 minutes (not logged in to the site, or the editor did not open?).' };
    await applyDraftResult(t, timeout);
    throw new Error(timeout.error);
  }
  await applyDraftResult(t, res);
  if (!res.ok) throw new Error(`${t}: ${res.error}`);
  return res;
}

/* ---- Auto-draft: Approve a ticket and it is drafted by itself (one after another); you only review the draft and publish ---- */
let draining = false;
async function drainApproved() {
  if (draining || state.busy || !$('auto-draft').checked) return;
  draining = true; state.busy = true; updateBulkButtons();
  const tried = new Set();
  let ok = 0, failed = 0;
  try {
    for (;;) {
      if (!$('auto-draft').checked) break;
      const next = [...state.rows].reverse().find(r => r.Status === 'Approved' && ['Lightning','DI Page Composer','Blog'].includes(r.Template) && !r['Draft Link'] && !tried.has(normTicket(r.Ticket)));
      if (!next) break;
      const t = normTicket(next.Ticket);
      tried.add(t);
      toast(`Auto-draft: ${t} …`, 60000);
      try { await draftOne(t, { ask: false }); ok++; } catch (e) { failed++; state.lastError[t] = e.message; }
    }
  } finally { draining = false; state.busy = false; updateBulkButtons(); renderGrid(); if (state.selected) renderDetail(state.selected); }
  if (ok || failed) toast(`Auto-draft finished: ${ok} draft${ok === 1 ? '' : 's'} saved${failed ? `, ${failed} failed` : ''}. Review them with “Open drafts”.`, 8000);
}

const draftRows = () => visibleRows().filter(r => r.Status === 'Draft saved' && r['Draft Link']);

async function draftChecked() {
  const tickets = [...state.checked];
  if (!tickets.length || state.busy) return;
  if (!confirm(`Draft ${tickets.length} ticket${tickets.length > 1 ? 's' : ''} in WordPress, one after another?\nEach is saved as a DRAFT only; nothing is published. Keep this tab open until it finishes.`)) return;
  state.busy = true; updateBulkButtons();
  let ok = 0; const failed = [];
  for (const t of tickets) {
    toast(`Drafting ${t} (${ok + failed.length + 1} of ${tickets.length})…`, 60000);
    try { await draftOne(t, { ask: false }); ok++; } catch (e) { failed.push(e.message); }
  }
  state.busy = false; updateBulkButtons();
  toast(`${ok} draft${ok === 1 ? '' : 's'} saved${failed.length ? `, ${failed.length} failed` : ''}.`, 6000);
  if (failed.length) alert('Not drafted:\n\n' + failed.join('\n'));
}

/* ---------------- sheet / settings ---------------- */
async function refreshPending() {
  const n = await pendingCount();
  $('pending').textContent = n ? `${n} waiting to reach the sheet` : '';
}

async function loadFromSheet() {
  const rows = await sheetApi.list();
  state.rows = rows; state.byTicket = new Map(rows.map(r => [normTicket(r.Ticket), r]));
  renderGrid();
}

async function connect() {
  const chip = $('conn');
  const s = await getSettings();
  if (!s.url || !s.token) { chip.textContent = 'Not connected — open ⚙ Settings'; chip.className = 'chip warn'; return false; }
  try {
    const p = await sheetApi.ping();
    chip.textContent = `Connected · ${p.user} · ${p.spreadsheet}`; chip.className = 'chip ok';
    await flushPending(); await refreshPending();
    await loadFromSheet();
    await syncLeftoverDraft();
    await autoFetchPublishedUrls();
    return true;
  } catch (e) {
    chip.textContent = 'Sheet error — ' + e.message; chip.className = 'chip bad';
    return false;
  }
}

// a draft that finished while this tab was closed
async function syncLeftoverDraft() {
  const { bulkDraftResult: r, bulkDraftSyncedAt } = await chrome.storage.local.get(['bulkDraftResult', 'bulkDraftSyncedAt']);
  if (r?.ticket && r.at > (bulkDraftSyncedAt || 0) && state.byTicket.has(normTicket(r.ticket))) {
    try { await applyDraftResult(r.ticket, r); toast(`Draft result for ${r.ticket} added to the sheet.`); } catch { /* next time */ }
  }
}

/* ---------------- events ---------------- */
async function changeTicketType(ticket, key) {
  const t = normTicket(ticket), type = TASK_TYPES[key];
  if (!type || !BULK_TYPE_OPTIONS.includes(key)) throw new Error('Choose one of the supported bulk page types.');
  const item = await loadDetail(t), row = { ...(state.byTicket.get(t) || item.row || {}) }, pkg = item.pkg || {};
  if (row['Draft Link'] && !confirm(`${t} already has a WordPress draft. Changing the page type will update the queued content; draft it again to create a new draft.`)) { renderGrid(); return; }
  row['Task Type'] = type.label;
  pkg.taskKey = key;
  pkg.checks = [];
  delete pkg.blog; delete pkg.hub;
  pkg.canDraft = false;

  if (type.category === 'hub') {
    const hubType = type.hubType;
    const cleanSubject = String(row.Subject || '').replace(/\b(hub|page|publishing|enhancement|service and parts information|service and parts|make research|research|finance and insurance information|finance and insurance)\b/gi, ' ').replace(/[-–—:|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const brandName = hubType === 'research' ? (cleanSubject || String(row.Account || '').replace(/\b(dealer(ship)?|motors?|automotive|auto)\b/gi, '').trim()) : '';
    const hub = generateHub(hubType, { brandName });
    const parent = chooseParentPage(pkg.sitePages || [], key, row.Subject, hub.title) || hub.parentSlug || '';
    hub.adminUrl = row['WP Admin URL'] || row.Website || ''; hub.parentSlug = parent || null; hub.bulkHubTemplate = true;
    const contentHtml = (hub.sections || []).map(section => section.html || '').join('\n');
    pkg.hub = hub; pkg.canDraft = !!hub.title;
    pkg.imported = { title:hub.title, slug:hub.slug, metaTitle:hub.metaTitle, metaDescription:hub.metaDescription, buttonsHtml:'', contentHtml };
    const stats = analyse(contentHtml, row['WP Admin URL'] || row.Website || '');
    Object.assign(row, { 'Page Title':hub.title, Slug:hub.slug, 'Meta Title':hub.metaTitle, 'Meta Title Chars':hub.metaTitle.length, 'Meta Description':hub.metaDescription, 'Meta Desc Chars':hub.metaDescription.length, Template:hub.templateName || 'DI Page Composer', 'Parent Page':parent, 'Content Words':stats.words, 'Content Chars':stats.chars, 'H2 Count':stats.h2, 'Internal Links':stats.internal, 'External Links':stats.external });
    pkg.checks = [{ name:'Hub page template built', ok:!!hub.title && !!hub.sections?.length, level:'ok', detail:type.label }, ...await verifyButtonUrls(contentHtml, row['WP Admin URL'] || row.Website || '')];
    row.Checks = `${pkg.checks.filter(c => c.ok).length} OK · 0 warnings · 0 errors`;
    row.Status = pkg.canDraft ? 'Ready for review' : 'Needs attention';
    const result = await sheetApi.save(row, pkg);
    state.cache.set(t, { row, pkg }); setRow(row); renderGrid(); await refreshPending();
    if (state.selected === t) renderDetail(t);
    toast(result.saved ? `${type.label} template added to the review and draft queue.` : 'Hub template saved locally; it will sync when the sheet is reachable.', 4500);
    return;
  }

  if (key === 'publishing:blog') pkg.blog = { categoryOptions: await fetchBlogCategories(row['WP Admin URL'] || row.Website || ''), categoryIds:[], categoryName:'' };
  row.Status = row['Doc URL'] ? 'Fetching' : 'Needs attention';
  row.Checks = row['Doc URL'] ? 'Re-importing Google Doc for the selected page type' : '0 errors · 0 warnings';
  row.Notes = row['Doc URL'] ? '' : 'A Google Doc link is required for this page type.';
  const saved = await sheetApi.save(row, pkg);
  state.cache.set(t, { row, pkg }); setRow(row); renderGrid(); await refreshPending();
  if (!row['Doc URL']) { if (state.selected === t) renderDetail(t); throw new Error(`${type.label}: add a Google Doc link before rebuilding this type.`); }
  if (!saved.saved) toast('Page type saved locally; importing the Google Doc…', 3500);
  await importReviewDoc(t, row['Doc URL']);
  toast(`${type.label} selected. The saved Google Doc was re-imported; Salesforce was not run again.`, 4500);
}

$('fetch').addEventListener('click', () => runBatch(parseTickets($('ticket-input').value)));
$('stop').addEventListener('click', () => { state.stop = true; $('stop').textContent = 'Stopping…'; });
$('refresh').addEventListener('click', async () => { state.cache.clear(); if (await connect()) { toast('Refreshed from the sheet.'); if (state.selected) renderDetail(state.selected); } });
$('search').addEventListener('input', renderGrid);
$('status-filter').addEventListener('change', renderGrid);
$('show-completed').addEventListener('change', renderGrid);
$('select-all').addEventListener('change', e => {
  visibleRows().forEach(r => e.target.checked ? state.checked.add(normTicket(r.Ticket)) : state.checked.delete(normTicket(r.Ticket)));
  renderGrid();
});
$('draft-selected').addEventListener('click', draftChecked);
$('approve-selected').addEventListener('click', async () => {
  const errs = [];
  for (const t of [...state.checked]) { try { await approve(t); } catch (e) { errs.push(e.message); } }
  toast(errs.length ? errs.join(' · ') : ($('auto-draft').checked ? 'Approved — drafting starts now.' : 'Approved.'), errs.length ? 7000 : 2500);
});

$('auto-draft').addEventListener('change', async e => {
  if (e.target.checked && !confirm('Auto-draft ON:\n\nEvery ticket you Approve will be filled in WordPress and saved as a DRAFT, one after another (VRP pages). Nothing is published.\nKeep this tab open while it runs.\n\nTurn it on?')) { e.target.checked = false; return; }
  await chrome.storage.local.set({ bulkAutoDraft: e.target.checked });
  if (e.target.checked) drainApproved();
});
$('open-drafts').addEventListener('click', () => {
  const rows = draftRows();
  if (!rows.length) return toast('No saved drafts in the list (check the status filter).', 4000);
  if (rows.length > 8 && !confirm(`Open ${rows.length} drafts in new tabs?`)) return;
  rows.forEach(r => chrome.tabs.create({ url: r['Draft Link'], active: false }));
});
$('copy-drafts').addEventListener('click', async () => {
  const rows = draftRows();
  if (!rows.length) return toast('No saved drafts in the list (check the status filter).', 4000);
  await navigator.clipboard.writeText(rows.map(r => `${r.Ticket}\t${r['Page Title']}\t${r['Draft Link']}`).join('\n'));
  toast(`${rows.length} draft link${rows.length === 1 ? '' : 's'} copied.`, 3000);
});

$('grid').addEventListener('change', async e => {
  const typeSelect = e.target.closest('[data-type-for]');
  if (typeSelect) {
    const ticket = normTicket(typeSelect.dataset.typeFor), key = typeSelect.value;
    typeSelect.disabled = true;
    try { await changeTicketType(ticket, key); }
    catch (err) { console.error('[Publishing Studio] Page type change failed', { ticket, key, error:err }); toast('Could not change page type: ' + err.message, 6000); renderGrid(); }
    finally { typeSelect.disabled = false; }
    return;
  }
  const categorySelect = e.target.closest('[data-category-for]');
  if (categorySelect) {
    const ticket = normTicket(categorySelect.dataset.categoryFor), id = Number(categorySelect.value || 0);
    try {
      const item = await loadDetail(ticket), pkg = item.pkg || {};
      if (!pkg.blog) throw new Error('Re-fetch this Blog ticket to load its WordPress categories.');
      const selected = (pkg.blog.categoryOptions || []).find(c => Number(c.id) === id);
      pkg.blog.categoryIds = selected ? [Number(selected.id)] : [];
      pkg.blog.categoryName = selected?.name || '';
      pkg.blog.categoryChoiceSet = true;
      const row = { ...(state.byTicket.get(ticket) || item.row || {}), Category: selected?.name || '' };
      const result = await sheetApi.save(row, pkg);
      state.cache.set(ticket, { row, pkg }); setRow(row); renderGrid(); await refreshPending();
      toast(result.saved ? `Blog category saved${selected ? ': ' + selected.name : ''}.` : 'Blog category saved locally; it will sync when the sheet is reachable.', 4000);
    } catch (err) { toast('Could not save Blog category: ' + err.message, 5000); renderGrid(); }
    return;
  }
  const select = e.target.closest('[data-parent-for]');
  if (!select) return;
  const ticket = normTicket(select.dataset.parentFor), parent = select.value;
  try {
    const item = await loadDetail(ticket), pkg = item.pkg || null;
    const row = { ...(state.byTicket.get(ticket) || item.row || {}), 'Parent Page': parent };
    if (pkg?.hub) pkg.hub.parentSlug = parent || null;
    const result = await sheetApi.save(row, pkg);
    state.cache.set(ticket, { row, pkg }); setRow(row); renderGrid(); await refreshPending();
    toast(result.saved ? (row['Draft Link'] ? 'Parent saved. Draft again to apply it to the existing page.' : 'Parent page saved.') : 'Parent saved locally; it will sync when the sheet is reachable.', 4500);
  } catch (err) { toast('Could not save parent page: ' + err.message, 5000); renderGrid(); }
});

$('detail').addEventListener('change', async e => {
  const typeSelect = e.target.closest('[data-detail-type-for]');
  if (typeSelect) {
    const ticket = normTicket(typeSelect.dataset.detailTypeFor), key = typeSelect.value;
    try { await changeTicketType(ticket, key); }
    catch (error) { console.error('[Publishing Studio] Page type change failed', { ticket, key, error }); state.lastError[ticket] = error.message; toast('Could not change page type: ' + error.message, 6000); renderDetail(ticket); }
    return;
  }
  const parentSelect = e.target.closest('[data-detail-parent-for]');
  if (!parentSelect) return;
  const ticket = normTicket(parentSelect.dataset.detailParentFor), parent = parentSelect.value;
  try {
    const item = await loadDetail(ticket), pkg = item.pkg || null;
    const row = { ...(state.byTicket.get(ticket) || item.row || {}), 'Parent Page': parent };
    if (pkg?.hub) pkg.hub.parentSlug = parent || null;
    const result = await sheetApi.save(row, pkg);
    state.cache.set(ticket, { row, pkg }); setRow(row); renderGrid(); await refreshPending(); renderDetail(ticket);
    toast(result.saved ? 'Parent page saved.' : 'Parent saved locally; it will sync when the sheet is reachable.', 3500);
  } catch (error) { console.error('[Publishing Studio] Parent page change failed', { ticket, parent, error }); toast('Could not save parent page: ' + error.message, 5000); }
});

async function saveWebsiteEdit(ticket, value) {
  const t = normTicket(ticket), item = await loadDetail(t), pkg = item.pkg || {};
  const row = { ...(state.byTicket.get(t) || item.row || {}) };
  const oldParent = String(row['Parent Page'] || '').trim();
  const { website, adminUrl } = normalizeWebsiteEdit(value, row['WP Admin URL']);
  row.Website = website; row['WP Admin URL'] = adminUrl;
  pkg.websiteRedirect = await resolveWebsiteRedirect(website);

  // The old dealer's page/category IDs must never be sent to the newly entered website.
  pkg.sitePages = await fetchWebsitePages(adminUrl);
  const type = String(row['Task Type'] || '');
  const taskKey = /vrp/i.test(type) ? 'enhancement:vrp' : /research/i.test(type) ? 'hub:research' : /service/i.test(type) ? 'hub:service' : /finance/i.test(type) ? 'hub:finance' : '';
  const oldParentOnNewSite = pkg.sitePages.find(page => page.title.toLowerCase() === oldParent.toLowerCase());
  const nextParent = oldParentOnNewSite?.title || chooseParentPage(pkg.sitePages, taskKey, row.Subject, row['Page Title']);
  row['Parent Page'] = nextParent;
  if (pkg.hub) { pkg.hub.adminUrl = adminUrl; pkg.hub.parentSlug = nextParent || null; }

  if (pkg.blog) {
    pkg.blog.adminUrl = adminUrl;
    pkg.blog.categoryOptions = await fetchBlogCategories(adminUrl);
    const sameName = pkg.blog.categoryOptions.find(c => c.name.toLowerCase() === String(pkg.blog.categoryName || '').toLowerCase());
    const category = sameName || suggestedBlogCategory(pkg.blog.categoryOptions, pkg.blog);
    pkg.blog.categoryIds = category ? [Number(category.id)] : [];
    pkg.blog.categoryName = category?.name || '';
    pkg.blog.categoryChoiceSet = false;
    row.Category = category?.name || '';
  }
  if (pkg.imported?.buttonsHtml || pkg.blog?.buttons || pkg.hub?.ctaButtonsHtml) {
    const buttonCode = pkg.blog?.buttons || pkg.imported?.buttonsHtml || pkg.hub?.ctaButtonsHtml || '';
    pkg.checks = (pkg.checks || []).filter(c => !c.name.startsWith('Button URL — '));
    pkg.checks.push(...await verifyButtonUrls(buttonCode, website));
    const errors = pkg.checks.filter(c => !c.ok && c.level === 'error').length;
    const warnings = pkg.checks.filter(c => !c.ok && c.level === 'warn').length;
    row.Checks = `${pkg.checks.filter(c => c.ok).length} OK · ${warnings} warning${warnings === 1 ? '' : 's'} · ${errors} error${errors === 1 ? '' : 's'}`;
    if (errors) row.Status = 'Needs attention';
    else if (row.Status === 'Needs attention') row.Status = 'Ready for review';
  }
  const result = await sheetApi.save(row, pkg);
  state.cache.set(t, { row, pkg }); setRow(row); renderGrid(); await refreshPending();
  toast(`${result.saved ? 'Website saved' : 'Website saved locally'}. Parent pages, categories, and redirect details refreshed.`, 5000);
  if (state.selected === t) renderDetail(t);
}

function normalizePublishedUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Use an http:// or https:// published URL.');
  return url.href;
}

async function savePublishedUrl(ticket, value, { quiet = false, publishedAt = '' } = {}) {
  const t = normTicket(ticket), item = await loadDetail(t), pkg = item.pkg || {};
  const row = { ...(state.byTicket.get(t) || item.row || {}) };
  const url = normalizePublishedUrl(value);
  row['Published URL'] = url; pkg.publishedUrl = url;
  row.Status = url ? 'Published' : (row['Draft Link'] ? 'Draft saved' : row.Status);
  if (url) {
    const publishedDate = String(publishedAt || '').trim();
    const detectedAt = Date.parse(publishedDate && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(publishedDate) ? publishedDate + 'Z' : publishedDate);
    state.publishedVisibleUntil[t] = (Number.isFinite(detectedAt) && detectedAt > 0 ? detectedAt : Date.now()) + 5 * 60 * 1000;
    await chrome.storage.local.set({ [PUBLISHED_VISIBLE_KEY]: state.publishedVisibleUntil });
  }
  const result = await sheetApi.save(row, pkg);
  state.cache.set(t, { row, pkg }); setRow(row); renderGrid(); await refreshPending();
  if (!quiet) toast(url ? (result.saved ? 'Published URL fetched and saved to the ticket and sheet.' : 'Published URL fetched locally; it will sync when the sheet is reachable.') : 'Published URL cleared.', 4500);
}

async function autoFetchPublishedUrls() {
  if (state.checkingPublished) return;
  state.checkingPublished = true;
  try {
    const candidates = state.rows.filter(row => !row['Published URL'] && row['Draft Link'] && /draft saved|published/i.test(row.Status || ''));
    for (let i = 0; i < candidates.length; i += 4) {
      await Promise.all(candidates.slice(i, i + 4).map(async row => {
        const ticket = normTicket(row.Ticket), last = state.publishedCheckAt.get(ticket) || 0;
        if (Date.now() - last < 60000) return;
        state.publishedCheckAt.set(ticket, Date.now());
        try {
          const item = await loadDetail(ticket), pkg = item.pkg || {};
          const editUrl = String(row['Draft Link'] || ''), postId = Number(pkg.wpPostId || (editUrl.match(/[?&]post=(\d+)/) || [])[1] || 0);
          if (!postId) return;
          const objectType = pkg.wpObjectType || (/^blog$/i.test(row.Template || '') ? 'post' : 'page');
          const result = await send({ type:'CHECK_PUBLISHED_WORDPRESS_URL', adminUrl:row['WP Admin URL'] || row.Website, postId, objectType });
          if (result.ok && result.published && result.url) await savePublishedUrl(ticket, result.url, { quiet:true, publishedAt:result.publishedAt || '' });
        } catch { /* retry on the next refresh or poll */ }
      }));
    }
  } finally { state.checkingPublished = false; }
}

function beginPublishedUrlEdit(button) {
  const cell = button.closest('[data-published-for]');
  if (!cell || cell.querySelector('input')) return;
  const ticket = cell.dataset.publishedFor, row = state.byTicket.get(normTicket(ticket)) || {};
  const pkg = state.cache.get(normTicket(ticket))?.pkg;
  const input = document.createElement('input');
  input.type = 'url'; input.className = 'published-url-input'; input.placeholder = 'https://dealer.com/page/';
  input.value = row['Published URL'] || pkg?.publishedUrl || '';
  cell.replaceChildren(input); input.focus(); input.select();
  let done = false, cancelled = false;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelled = true; input.blur(); }
  });
  input.addEventListener('blur', async () => {
    if (done) return; done = true;
    if (cancelled) { renderGrid(); return; }
    try { await savePublishedUrl(ticket, input.value); }
    catch (error) { toast('Could not save Published URL: ' + error.message, 5000); renderGrid(); }
  });
}

function beginWebsiteEdit(cell) {
  if (!cell || cell.querySelector('input')) return;
  const ticket = cell.dataset.editWebsite;
  const input = document.createElement('input');
  input.type = 'url'; input.className = 'website-edit-input'; input.value = state.byTicket.get(normTicket(ticket))?.Website || '';
  input.placeholder = 'https://dealer-website.com';
  cell.replaceChildren(input); input.focus(); input.select();
  let finished = false, cancelled = false;
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); cancelled = true; input.blur(); }
  });
  input.addEventListener('blur', async () => {
    if (finished) return; finished = true;
    if (cancelled) { renderGrid(); return; }
    try { await saveWebsiteEdit(ticket, input.value); }
    catch (error) { toast('Could not update website: ' + error.message, 5000); renderGrid(); }
  });
}

let websiteClickTimer = null;
$('grid').addEventListener('dblclick', e => {
  const cell = e.target.closest('[data-edit-website]');
  if (!cell) return;
  e.preventDefault(); e.stopPropagation(); beginWebsiteEdit(cell);
  clearTimeout(websiteClickTimer);
});

$('grid').addEventListener('click', async e => {
  const typeSelect = e.target.closest('[data-type-for]');
  if (typeSelect) {
    const ticket = normTicket(typeSelect.dataset.typeFor);
    state.selected = ticket;
    $('grid').querySelectorAll('tr.sel').forEach(tr => tr.classList.remove('sel'));
    typeSelect.closest('tr')?.classList.add('sel');
    e.stopPropagation();
    return;
  }
  if (e.target.closest('.website-edit-input')) return;
  if (e.target.closest('.published-url-input')) return;
  const publishedEdit = e.target.closest('[data-published-edit]');
  if (publishedEdit) { e.preventDefault(); e.stopPropagation(); beginPublishedUrlEdit(publishedEdit); return; }
  const websiteCell = e.target.closest('[data-edit-website]');
  if (websiteCell) {
    const ticket = normTicket(websiteCell.dataset.editWebsite);
    clearTimeout(websiteClickTimer);
    const useRedirect = e.target.closest('[data-use-website-redirect]');
    if (useRedirect) {
      e.preventDefault(); e.stopPropagation();
      const pkg = state.cache.get(ticket)?.pkg, row = state.byTicket.get(ticket) || {};
      const target = row['Website Redirect'] || pkg?.websiteRedirect || '';
      if (target) saveWebsiteEdit(ticket, target).catch(error => toast('Could not use redirect destination: ' + error.message, 5000));
      return;
    }
    if (e.target.closest('.website-redirect-link')) return;
    if (e.target.closest('[data-website-edit-trigger]')) { e.preventDefault(); e.stopPropagation(); beginWebsiteEdit(websiteCell); return; }
    if (state.selected !== ticket) {
      state.selected = ticket;
      $('grid').querySelectorAll('tr.sel').forEach(tr => tr.classList.remove('sel'));
      websiteCell.closest('tr')?.classList.add('sel');
    }
    websiteClickTimer = setTimeout(() => { if (state.selected === ticket) renderDetail(ticket); }, 280);
    return; // do not redraw this cell between the two clicks of a double-click
  }
  if (e.target.closest('[data-parent-for]')) { e.stopPropagation(); return; }
  const copyHub = e.target.closest('[data-copy-hub-ticket]');
  if (copyHub) {
    e.stopPropagation();
    const row = state.byTicket.get(normTicket(copyHub.dataset.copyHubTicket));
    const code = row ? hubAnchorCode(row) : '';
    if (!code) return toast('Page title or slug is missing; cannot build the CTA anchor.', 3000);
    await navigator.clipboard.writeText(code);
    toast('Hub CTA anchor copied.', 1800);
    return;
  }
  const check = e.target.closest('[data-check]');
  if (check) { const t = check.dataset.check; check.checked ? state.checked.add(t) : state.checked.delete(t); updateBulkButtons(); return; }
  if (e.target.closest('a')) return;
  const tr = e.target.closest('tr[data-t]');
  if (!tr) return;
  state.selected = tr.dataset.t; renderGrid(); renderDetail(state.selected);
});

$('detail').addEventListener('click', async e => {
  const copyHub = e.target.closest('[data-copy-hub-detail]');
  if (copyHub) {
    e.stopPropagation();
    const row = state.byTicket.get(normTicket(copyHub.dataset.copyHubDetail));
    const code = row ? hubAnchorCode(row) : '';
    if (!code) return toast('Page title or slug is missing; cannot build the CTA anchor.', 3000);
    await navigator.clipboard.writeText(code);
    return toast('Hub CTA anchor copied.', 1800);
  }
  if (e.target.closest('[data-link-apply]')) {
    const frame = $('review-content-editor'), html = frame?.contentDocument?.body?.innerHTML || '';
    const linked = typeof window.__bulkILTransform === 'function' ? window.__bulkILTransform(html) : html;
    if (linked === html) return toast('Tick one or more verified link suggestions first.', 2500);
    frame.contentDocument.body.innerHTML = linked;
    document.dispatchEvent(new CustomEvent('bulk:doc-imported', { detail:{ bodyHtml:linked, adminUrl:$('bulk-il-admin-url')?.value || '' } }));
    toast('Selected internal links added. Click Save review to keep them.', 3500);
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) { await navigator.clipboard.writeText(copy.dataset.copy); return toast('Copied.', 1200); }
  if (e.target.closest('[data-copy-content]')) { await navigator.clipboard.writeText($('detail').dataset.content || ''); return toast('HTML copied.', 1200); }
  const view = e.target.closest('[data-view]');
  if (view) { state.view = view.dataset.view; return renderDetail(state.selected); }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !state.selected) return;
  const t = state.selected;
  if ((act === 'draft' || act === 'draft-again') && state.busy) return toast('Another draft or batch is running — wait until it finishes.', 4000);
  delete state.lastError[t];
  try {
    if (act === 'save-review') await saveReview(t);
    else if (act === 'import-doc') await importReviewDoc(t);
    else if (act === 'approve-draft') await approveAndDraft(t);
    else if (act === 'approve') { await approve(t); toast('Approved.', 1500); }
    else if (act === 'refetch') await runBatch([t]);
    else if (act === 'draft' || act === 'draft-again') {
      state.busy = true; updateBulkButtons();
      try { await draftOne(t); toast(act === 'draft-again' ? 'Draft retry saved in WordPress.' : 'Saved as a draft in WordPress.', 4000); } finally { state.busy = false; updateBulkButtons(); }
    }
  } catch (err) { state.lastError[t] = err.message; toast(err.message, 7000); renderDetail(t); }
});

$('settings-open').addEventListener('click', async () => {
  const s = await getSettings();
  $('set-url').value = s.url; $('set-token').value = s.token; $('set-msg').textContent = '';
  $('settings').showModal();
});
$('set-test').addEventListener('click', async () => {
  await saveSettings({ url: $('set-url').value, token: $('set-token').value });
  $('set-msg').textContent = 'Testing…';
  try { const p = await sheetApi.ping(); $('set-msg').textContent = `✔ Connected as ${p.user} — sheet “${p.spreadsheet}”.`; }
  catch (e) { $('set-msg').textContent = '✖ ' + e.message; }
});
$('set-save').addEventListener('click', async () => {
  await saveSettings({ url: $('set-url').value, token: $('set-token').value });
  setTimeout(connect, 100);
});

(async () => {
  const saved = await chrome.storage.local.get(['bulkAutoDraft', PUBLISHED_VISIBLE_KEY]);
  $('auto-draft').checked = !!saved.bulkAutoDraft;
  state.publishedVisibleUntil = saved[PUBLISHED_VISIBLE_KEY] || {};
  if (await connect()) drainApproved();
})();
setInterval(autoFetchPublishedUrls, 90000);
setInterval(renderGrid, 30000);
window.addEventListener('focus', autoFetchPublishedUrls);
