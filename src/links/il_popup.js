/**
 * Internal links panel (an ES module). Shows each candidate link with a tick box and a VERIFIED /
 * CHECK / NOT FOUND badge; only ticked links are written into the content HTML.
 * One panel per publishing type: initInternalLinks({...}) is called once for Landing/Comparison (below)
 * and once for Blog (blog_popup.js). It never touches the page templates.
 */
import { suggestPages, textLinkable, findCandidates, siteOpportunities, resolveFixedPaths, getSiteIndex, clearSiteCache, resolveCandidate, checkPage, applyLinks, normText, slugify } from './il_core.js';
import { LIMITS, MAX_SUGGESTIONS } from './il_config.js';

const $ = id => document.getElementById(id);

export function initInternalLinks(o) {
const panel = $(o.panelId), listEl = $(o.listId), statusEl = $(o.statusId), rescanBtn = $(o.rescanId);
if (!panel || !listEl || !statusEl || !rescanBtn) return;

let rows = [];          // { c, res, tick, urlInput, ... }
let lastHtml = '';
let scanId = 0;

const ownSlug = () => slugify(($(o.slugId || '_')?.value || '').split('/').filter(Boolean).pop() || '');
let lastAdmin = '';
// "www.site.com" (no https://) and "https://site.com/wp-admin/" both work
const normOrigin = v => { let t = String(v || '').trim(); if (!t) return ''; if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = 'https://' + t; try { return new URL(t).origin; } catch { return ''; } };
const originOf = () => normOrigin($(o.adminUrlId)?.value) || normOrigin(lastAdmin);
const setStatus = (t, kind) => { statusEl.textContent = t || ''; statusEl.className = kind || ''; };
const resync = () => { if (typeof window[o.resyncFn] === 'function') window[o.resyncFn](); };

function accepted() {
  const map = new Map();
  for (const r of rows) {
    const url = r.urlInput.value.trim();
    if (r.tick.checked && url) { const a = r.getAnchor(); map.set(a.key, { url, source: a.changed ? 'fixed' : r.c.source, text: a.text }); }
  }
  return map;
}

// hub_popup.js calls this every time it builds Content HTML.
const transformFn = html => applyLinks(html, accepted(), '');
window[o.transformHook] = transformFn;

const BADGE = { verified: ['✓ verified', 'il-ok'], check: ['? check', 'il-check'], missing: ['✗ not found', 'il-miss'], pending: ['… checking', 'il-pend'], manual: ['✎ your link', 'il-check'] };

function paintBadge(r) {
  const [label, cls] = BADGE[r.status] || BADGE.pending;
  r.badge.textContent = label;
  r.badge.className = 'il-badge ' + cls;
  r.note.textContent = r.reason || '';
}

function buildRow(c) {
  const el = document.createElement('div');
  el.className = 'il-row';
  const tick = Object.assign(document.createElement('input'), { type: 'checkbox', disabled: true });
  const body = document.createElement('div'); body.className = 'il-body';
  const top = document.createElement('div'); top.className = 'il-top';
  const anchor = document.createElement('strong'); anchor.textContent = c.text;
  const src = document.createElement('small'); src.textContent = c.source === 'red' ? 'red in your doc' : c.source === 'fixed' ? 'from your fixed list' : (c.why || 'matches a page on your site');
  const badge = document.createElement('span');
  top.append(anchor, src, badge);
  // The words around the phrase are clickable: click a word OUTSIDE the link text to extend it up to that word,
  // click a word INSIDE it to cut the link text back to there. Double-click = back to the suggested text.
  const ctx = document.createElement('div'); ctx.className = 'il-context';
  const hint = document.createElement('small'); hint.className = 'il-hint';
  const mw = c.context ? c.context.match.split(' ').filter(Boolean) : [];
  const words = c.context ? [...(c.context.beforeAll || []), ...mw, ...(c.context.afterAll || [])] : [];
  const baseS = c.context ? (c.context.beforeAll || []).length : 0, baseE = baseS + mw.length;
  let selS = baseS, selE = baseE;
  const stripEdge = t => t.replace(/^[\s.,;:!?"“”'‘’()\[\]\-–—]+|[\s.,;:!?"“”'‘’()\[\]\-–—]+$/g, '');
  const changed = () => selS !== baseS || selE !== baseE;
  const curText = () => (words.length && changed()) ? stripEdge(words.slice(selS, selE).join(' ')) : c.text;
  const renderCtx = () => {
    ctx.replaceChildren();
    if (!words.length) return;
    ctx.append('… ');
    words.forEach((w, i) => {
      const sp = document.createElement('span');
      sp.className = 'il-w' + (i >= selS && i < selE ? ' il-w-on' : '');
      sp.textContent = w; sp.dataset.i = i;
      ctx.append(sp, ' ');
    });
    ctx.append('…');
  };
  const paintAnchor = () => { anchor.textContent = curText(); };
  ctx.addEventListener('click', ev => {
    const sp = ev.target.closest('.il-w'); if (!sp) return;
    const i = +sp.dataset.i;
    let s = selS, e = selE;
    if (i < s) s = i;                                         // extend to the left
    else if (i >= e) e = i + 1;                               // extend to the right
    else if (e - s > 1) {                                     // inside the link text: the first / last word drops out, any other word becomes the new edge
      if (i === e - 1) e--; else if (i === s) s++; else if (i - s <= e - 1 - i) s = i; else e = i + 1;
    }
    if (s === selS && e === selE) return;
    const prev = [selS, selE];
    selS = s; selE = e;
    const t = curText();
    if (changed() && !textLinkable(lastHtml, t)) {            // e.g. the words are split by bold text or a line break
      [selS, selE] = prev;
      hint.textContent = '“' + t + '” cannot be one link here (the words are split by formatting or a line break).';
      return;
    }
    hint.textContent = changed() ? 'Link text: “' + t + '”  (double-click a word to go back to “' + c.text + '”)' : '';
    renderCtx(); paintAnchor(); resync(); reresolve();
  });
  ctx.addEventListener('dblclick', () => { selS = baseS; selE = baseE; hint.textContent = ''; renderCtx(); paintAnchor(); resync(); reresolve(); window.getSelection()?.removeAllRanges(); });
  renderCtx();
  const urlInput = Object.assign(document.createElement('input'), { type: 'text', placeholder: '/page-url/ (type one to use your own)', spellcheck: false });
  const note = document.createElement('small'); note.className = 'il-note';
  // typing in the URL box suggests the site's pages (from the sitemap) that match
  const urlWrap = document.createElement('div'); urlWrap.className = 'il-urlwrap';
  const sug = document.createElement('div'); sug.className = 'il-suggest'; sug.hidden = true;
  urlWrap.append(urlInput, sug);
  let sugItems = [], sugActive = -1;
  const hideSug = () => { sug.hidden = true; sugActive = -1; };
  const paintSug = () => [...sug.children].forEach((d, i) => d.classList.toggle('on', i === sugActive));
  const pick = item => {
    urlInput.value = item.path; hideSug();
    urlInput.dispatchEvent(new Event('change'));            // same as typing it: the page is checked and the link is ticked
  };
  const showSug = () => {
    const q = urlInput.value.trim();
    sugItems = (currentIndex && q) ? suggestPages(currentIndex.entries, q, 8, ownSlug()) : [];
    sug.replaceChildren(...sugItems.map(it => {
      const d = document.createElement('div');
      const t = document.createElement('b'); t.textContent = it.title || it.path;
      const p = document.createElement('span'); p.textContent = it.path;
      d.append(t, p);
      d.addEventListener('mousedown', ev => { ev.preventDefault(); pick(it); });
      return d;
    }));
    sugActive = -1; sug.hidden = !sugItems.length;
  };
  urlInput.addEventListener('input', showSug);
  urlInput.addEventListener('focus', () => { if (urlInput.value.trim() && urlInput.value.trim() !== r.origUrl) showSug(); });
  urlInput.addEventListener('blur', () => setTimeout(hideSug, 120));
  urlInput.addEventListener('keydown', ev => {
    if (sug.hidden) return;
    if (ev.key === 'ArrowDown') { sugActive = (sugActive + 1) % sugItems.length; paintSug(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { sugActive = (sugActive - 1 + sugItems.length) % sugItems.length; paintSug(); ev.preventDefault(); }
    else if (ev.key === 'Enter' && sugActive >= 0) { pick(sugItems[sugActive]); ev.preventDefault(); }
    else if (ev.key === 'Escape') hideSug();
  });
  body.append(top, ctx, hint, urlWrap, note);
  el.append(tick, body);
  let urlTyped = false, reTick = 0;
  // "finance" -> the person extends it to "apply for finance": the link must go to the page for THAT text, not stay on /finance/.
  const reresolve = async () => {
    if (urlTyped) return;                                      // their own URL is never replaced
    const mine = ++reTick;
    if (!changed()) {
      if (r.origUrl !== undefined && urlInput.value !== r.origUrl) { urlInput.value = r.origUrl; r.status = r.origStatus; r.reason = r.origReason; paintBadge(r); resync(); }
      return;
    }
    const origin = originOf(); if (!origin) return;
    const t = curText();
    const res = await resolveCandidate({ text: t, key: normText(t), source: 'red' }, { origin, ownSlug: ownSlug(), index: currentIndex || undefined });
    if (mine !== reTick || res.status === 'missing' || !res.url) return;
    if (res.url.replace(/\/+$/, '') !== urlInput.value.replace(/\/+$/, '')) {
      urlInput.value = res.url; r.status = res.status; r.reason = res.reason; tick.disabled = false; paintBadge(r);
      hint.textContent += ` → this text has its own page: ${res.url}`;
      resync();
    }
  };
  const getAnchor = () => { const t = curText(); return { text: t, key: changed() ? normText(t) : c.key, changed: changed() }; };
  const r = { c, el, tick, urlInput, badge, note, status: 'pending', reason: '', getAnchor };
  tick.addEventListener('change', resync);
  urlInput.addEventListener('change', async () => {            // the person typed their own URL: verify that one
    urlTyped = true;
    const v = urlInput.value.trim();
    if (!v) { r.status = 'missing'; r.reason = 'no link'; tick.checked = false; tick.disabled = true; paintBadge(r); resync(); return; }
    r.status = 'pending'; r.reason = ''; paintBadge(r);
    const origin = originOf();
    const page = origin ? await checkPage(/^https?:/i.test(v) ? v : origin + (v.startsWith('/') ? v : '/' + v), c.text) : null;
    r.status = page?.exists ? (page.matches ? 'verified' : 'manual') : 'manual';
    r.reason = page ? (page.exists ? `page exists ("${page.title}")` : page.reason + ' — using it anyway') : 'could not verify (no WordPress Admin URL yet)';
    tick.disabled = false; tick.checked = true; paintBadge(r); resync();
  });
  paintBadge(r);
  return r;
}

// ---- "Load sitemap": an optional sitemap address + a list of the pages that were read ----
const smRow = document.createElement('div'); smRow.className = 'il-sitemap';
const smInput = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'Sitemap address (optional) — e.g. https://www.site.com/sitemap/', spellcheck: false });
const smBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: 'Load sitemap' });
smRow.append(smInput, smBtn);
const pagesBox = document.createElement('details'); pagesBox.className = 'il-pages';
const pagesSum = document.createElement('summary'); pagesSum.textContent = 'Pages read from the sitemap (0)';
const pagesFilter = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'Filter pages…', spellcheck: false });
const pagesList = document.createElement('div'); pagesList.className = 'il-pages-list';
pagesBox.append(pagesSum, pagesFilter, pagesList);
listEl.before(smRow); listEl.after(pagesBox);
pagesFilter.addEventListener('input', () => { const q = normText(pagesFilter.value); for (const li of pagesList.children) li.hidden = !!q && !normText(li.textContent).includes(q); });
function paintPages(entries) {
  pagesSum.textContent = `Pages read from the sitemap (${entries.length})`;
  pagesList.replaceChildren(...entries.slice(0, 600).map(e => {
    const d = document.createElement('div');
    const path = new URL(e.url).pathname;
    d.textContent = (e.titles[0] ? e.titles[0] + ' — ' : '') + path;
    return d;
  }));
}
smBtn.addEventListener('click', () => { if (!lastHtml) { setStatus('Import the content first — then load the sitemap.', 'error'); return; } clearSiteCache(); scan(); });
smInput.addEventListener('keydown', e => { if (e.key === 'Enter') smBtn.click(); });

let currentIndex = null;  // what was read from the site for this scan
let pool = [];            // candidates not shown yet, best first
let siteInfo = '';
let scannedOrigin = '';
const moreBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary il-more', hidden: true });
listEl.after(moreBtn);

async function verifyRows(batch, id, origin) {
  const queue = [...batch];
  const worker = async () => {
    while (queue.length && id === scanId) {
      const r = queue.shift();
      try {
        const res = await resolveCandidate(r.c, { origin, ownSlug: ownSlug(), index: currentIndex || undefined });
        if (id !== scanId) return;
        r.status = res.status; r.reason = res.reason; r.urlInput.value = res.url || '';
        r.origUrl = res.url || ''; r.origStatus = res.status; r.origReason = res.reason;     // what the SUGGESTED text points to (a reset goes back to it)
        r.tick.disabled = res.status === 'missing' && !res.url ? true : res.status === 'missing';
        r.tick.checked = false;                                // nothing is linked until the person ticks (approves) it
      } catch (e) {
        r.status = 'missing'; r.reason = 'check failed: ' + e.message;
      }
      paintBadge(r);
    }
  };
  await Promise.all(Array.from({ length: LIMITS.concurrentChecks }, worker));
}

// Shows `n` more suggestions: takes them from the pool, checks each on the live site, drops site matches whose page
// does not exist and tops up from the pool until `n` good ones are shown (or the pool is empty).
async function loadBatch(n, id, origin) {
  let good = 0;
  while (good < n && pool.length) {
    const batch = pool.splice(0, n - good).map(buildRow);
    listEl.append(...batch.map(r => r.el));
    await verifyRows(batch, id, origin);
    if (id !== scanId) return;
    for (const r of batch) {
      if (r.c.source !== 'red' && r.status === 'missing') { r.el.remove(); continue; }          // a fixed/site page that does not exist is simply not offered
      rows.push(r); good++;
    }
  }
  paintMore();
}

function paintMore() {
  moreBtn.hidden = !pool.length;
  moreBtn.disabled = false;
  moreBtn.textContent = `Show ${Math.min(MAX_SUGGESTIONS, pool.length)} more suggestions (${pool.length} left)`;
}

function paintStatus() {
  const ok = rows.filter(r => !r.tick.disabled).length;
  setStatus(`${ok} link${ok === 1 ? '' : 's'} can be added. Tick the ones you approve — unticked phrases stay as plain text. ${siteInfo}`, siteInfo.startsWith('Could not') ? 'error' : 'success');
}

moreBtn.addEventListener('click', async () => {
  const id = scanId, origin = originOf();
  moreBtn.disabled = true;
  setStatus('Checking more suggestions on ' + origin + '…');
  await loadBatch(MAX_SUGGESTIONS, id, origin);
  if (id !== scanId) return;
  paintStatus(); resync();
});

async function scan() {
  const id = ++scanId;
  const origin = originOf();
  scannedOrigin = origin;
  siteInfo = '';
  currentIndex = null;
  rows = []; pool = [];
  let cands = findCandidates(lastHtml);              // red text from the doc + your fixed phrases
  if (origin) {                                      // + opportunities found by matching the site's own pages
    setStatus('Looking through the pages of ' + origin + ' for link opportunities…');
    try {
      const index = await getSiteIndex(origin, smInput.value.trim());
      if (id !== scanId) return;
      currentIndex = index;
      paintPages(index.entries);
      siteInfo = index.entries.length
        ? `Read ${index.entries.length} pages of the site (XML sitemap: ${index.info.xml}, HTML sitemap: ${index.info.html}${index.info.typed ? ', your address: ' + index.info.typed : ''}).`
        : `Could not read any sitemap on ${origin} (tried: ${index.info.tried.join(', ') || 'none'}). Red text and fixed phrases still work.`;
      resolveFixedPaths(cands, index.entries);                           // fixed pages use the site's real URL when the sitemap names the page
      const site = siteOpportunities(lastHtml, index.entries, { origin, ownSlug: ownSlug(), skip: cands.map(c => c.text) });
      // a longer page name found on the site replaces a shorter fixed word inside it ("service" -> "service specials", "finance" -> "apply for financing")
      cands = cands.filter(c => c.source !== 'fixed' || !site.some(s => s.text.toLowerCase() !== c.text.toLowerCase() && s.text.toLowerCase().includes(c.text.toLowerCase())));
      cands = cands.concat(site);
    } catch (e) { siteInfo = 'Could not read the sitemap: ' + e.message; }
  }
  cands.sort((a, b) => (a.source === 'red' ? 0 : 1) - (b.source === 'red' ? 0 : 1) || (b.score || 0) - (a.score || 0));   // the doc's red text first, then everything else by score
  const seenPath = new Set();                        // one page can only be linked once: keep the first phrase that points to it
  cands = cands.filter(c => { if (c.source === 'red' || !c.path) return true; const k = c.path.replace(/\/+$/, ''); if (seenPath.has(k)) return false; seenPath.add(k); return true; });
  listEl.replaceChildren();
  if (!cands.length) {
    panel.hidden = !origin;                           // nothing to review: say so (and what was read), so a silent panel is never a mystery
    moreBtn.hidden = true;
    setStatus(origin ? `No link opportunities found in this content. ${siteInfo}`.trim() : '', siteInfo.startsWith('Could not') ? 'error' : '');
    resync(); return;
  }
  panel.hidden = false;
  if (!origin) {
    rows = cands.slice(0, MAX_SUGGESTIONS).map(buildRow);
    listEl.append(...rows.map(r => r.el));
    moreBtn.hidden = true;
    setStatus('Waiting for the WordPress Admin URL — the links are checked on the live site as soon as it is filled in.', 'error');
    rows.forEach(r => { r.status = 'missing'; r.reason = 'not checked yet'; paintBadge(r); });
    resync();
    return;
  }
  const red = cands.filter(c => c.source === 'red');
  const others = cands.filter(c => c.source !== 'red');
  const redLead = Math.min(red.length, Math.ceil(MAX_SUGGESTIONS / 2));
  cands = [...red.slice(0, redLead), ...others.slice(0, MAX_SUGGESTIONS - redLead), ...red.slice(redLead), ...others.slice(MAX_SUGGESTIONS - redLead)];
  pool = cands;
  setStatus(`Checking links on ${origin}…`);
  await loadBatch(MAX_SUGGESTIONS, id, origin);
  if (id !== scanId) return;
  panel.hidden = !rows.length && !pool.length;
  paintStatus();
  resync();
}

// The Admin URL is often filled AFTER the doc is imported (ticket flow): scan again as soon as it appears or changes.
const adminEl = $(o.adminUrlId);
let adminTimer;
const maybeRescan = () => { if (lastHtml && originOf() && originOf() !== scannedOrigin) scan(); };
const onAdminInput = () => { clearTimeout(adminTimer); adminTimer = setTimeout(maybeRescan, 900); };
const onImported = e => { lastHtml = e.detail?.bodyHtml || ''; lastAdmin = e.detail?.adminUrl || ''; scan(); };
const onRescan = () => { if (lastHtml) { clearSiteCache(); scan(); } };
adminEl?.addEventListener('input', onAdminInput);
adminEl?.addEventListener('change', maybeRescan);
const rescanTimer = setInterval(maybeRescan, 2000);  // value set by a script fires no event

document.addEventListener(o.event, onImported);
rescanBtn.addEventListener('click', onRescan);
return () => {
  scanId++;
  clearInterval(rescanTimer); clearTimeout(adminTimer);
  adminEl?.removeEventListener('input', onAdminInput);
  adminEl?.removeEventListener('change', maybeRescan);
  document.removeEventListener(o.event, onImported);
  rescanBtn.removeEventListener('click', onRescan);
  if (window[o.transformHook] === transformFn) delete window[o.transformHook];
};
}

// Landing / Comparison panel
initInternalLinks({
  panelId: 'il-panel', listId: 'il-list', statusId: 'il-status', rescanId: 'il-rescan',
  slugId: 'comparison-page-slug', adminUrlId: 'publishing-admin-url',
  event: 'di:imported', transformHook: '__diTransformContent', resyncFn: 'syncSelectedContent',
});

// Blog panel
initInternalLinks({
  panelId: 'blog-il-panel', listId: 'blog-il-list', statusId: 'blog-il-status', rescanId: 'blog-il-rescan',
  slugId: '', adminUrlId: 'blog-admin-url',
  event: 'di:blog-imported', transformHook: '__diBlogTransform', resyncFn: '__diBlogSave',
});
