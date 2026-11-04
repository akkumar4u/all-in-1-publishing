/**
 * Popup side of the landing-page banner image. Everything runs in the background (the library opens in its
 * own window and the popup closes), so this only starts the job and shows what is stored.
 * hub_popup.js reads the result through window.__diGetLandingImage().
 */
import { vehicleQuery } from './img_query.js';

const $ = id => document.getElementById(id);
/* The same picker is used twice: the landing-page banner (1400x500, Hub panel) and the BLOG image (1000x400, Blog panel).
 * Each one has its own storage key, so one never overwrites the other. */
function initPicker(cfg) {
const { KEY, WIDTH, HEIGHT, p, ALT_KEY, GLOBAL, FALLBACK_NAME, DONE_NOTE, getTitle, getSlug, titleWatch } = cfg;
const queryEl = $(p + '-query'), altEl = $(p + '-alt'), btn = $(p + '-fetch');
const sourceEl = $(p + '-source');
if (!queryEl || !altEl || !btn) return;
const chooseBox = $(p + '-choose'), choices = $(p + '-choices');
const statusEl = $(p + '-status'), preview = $(p + '-preview');
const saveBtn = $(p + '-save'), chipsEl = $(p + '-chips');
const slugEl = { get value() { return getSlug(); } };
const titleEl = { get value() { return getTitle(); } };
const hasTitle = true;
const slugifyName = v => (v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const curFilename = () => slugifyName((slugEl && slugEl.value.split('/').filter(Boolean).pop()) || (titleEl && titleEl.value) || (state && state.query) || '') || FALLBACK_NAME;
const dealerHost = () => { try { const u = ['admin-url', 'publishing-admin-url', 'blog-admin-url'].map(i => (document.getElementById(i) || {}).value || '').find(v => /^https?:\/\//i.test(v.trim())); return u ? new URL(u.trim()).hostname : ''; } catch (e) { return ''; } };

let state = null;
let queryEdited = false;

function setStatus(text, kind) { statusEl.textContent = text || ''; statusEl.className = 'status' + (kind ? ' ' + kind : ''); }

function render() {
  choices.hidden = true;
  if (saveBtn) saveBtn.hidden = !(state && state.status === 'done' && state.dataUrl);
  if (!state) { setStatus(''); preview.hidden = true; btn.disabled = false; return; }
  btn.disabled = state.status === 'running';
  if (state.status === 'choose' && state.candidates?.length) {
    setStatus((state.error ? state.error + ' — pick another image or search again. ' : '') + 'Click the image you want (best matches first):', state.error ? 'error' : '');
    preview.hidden = true;
    choices.hidden = false;
    choices.replaceChildren(...state.candidates.map(c => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.title = c.title;
      cell.style.cssText = 'padding:2px;border:1px solid #c8d3d0;border-radius:6px;background:#fff;cursor:pointer;text-align:left';
      const im = document.createElement('img');
      im.src = c.imgSrc; im.alt = c.title; im.style.cssText = 'width:100%;height:56px;object-fit:cover;border-radius:4px;display:block';
      const cap = document.createElement('div');
      cap.textContent = c.title + (c.sizes && c.sizes.length ? ` · ${WIDTH} ✓` : ''); cap.style.cssText = 'font-size:10px;line-height:1.2;margin-top:2px;overflow:hidden;max-height:24px';
      cell.append(im, cap);
      cell.addEventListener('click', async () => {
        setStatus(`Downloading "${c.title}"…`);
        cell.style.opacity = '0.5';
        const slugify = v => (v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const filename = slugify((slugEl && slugEl.value.split('/').filter(Boolean).pop()) || (titleEl && titleEl.value) || state.query) || FALLBACK_NAME;
        let host = '';
        // the dealer's site = the WordPress Admin URL typed in the popup (NOT the active tab, which is the Google Doc)
        try { const u = ['admin-url', 'publishing-admin-url', 'blog-admin-url'].map(i => (document.getElementById(i) || {}).value || '').find(v => /^https?:\/\//i.test(v.trim())); host = u ? new URL(u.trim()).hostname : ''; } catch (e) { /* ignore */ }
        chrome.runtime.sendMessage({ type: 'LIB_IMAGE_DOWNLOAD', key: KEY, host, query: state.query, width: WIDTH, height: HEIGHT, title: c.title, imgSrc: c.imgSrc, landingUrl: c.landingUrl || '', filename, source: sourceEl?.value || 'dealer' });
      });
      return cell;
    }));
    // custom search text: look again in the library with different words
    const again = document.createElement('div');
    again.style.cssText = 'grid-column:1/-1;display:flex;gap:6px;margin-top:4px';
    const ai = document.createElement('input');
    ai.type = 'text'; ai.value = queryEl.value || state.query || ''; ai.placeholder = 'Custom search text'; ai.style.cssText = 'flex:1;min-width:0';
    const ab = document.createElement('button');
    ab.type = 'button'; ab.textContent = 'Search again';
    ab.addEventListener('click', () => { if (!ai.value.trim()) return; queryEl.value = ai.value.trim(); queryEdited = true; chooseBox.checked = true; btn.click(); });
    again.append(ai, ab);
    choices.append(again);
    return;
  }
  if (state.status === 'running') { setStatus(state.step || 'Working…'); preview.hidden = true; return; }
  if (state.status === 'error') { setStatus(state.error || 'Could not get the image.', 'error'); preview.hidden = true; return; }
  if (state.status === 'done' && state.dataUrl) {
    setStatus(`Got ${state.width}×${state.height}: "${state.imageTitle || state.query}". ${state.savedAs ? '✔ Saved in Downloads as ' + state.savedAs + '. ' : state.saveError ? '⚠ NOT saved to Downloads (' + state.saveError + ') - use the Save button. ' : ''}${DONE_NOTE}`, state.saveError ? 'error' : 'success');
    preview.src = state.dataUrl; preview.hidden = false;
  }
}

let chipKey = '';
function renderChips() {
  if (!chipsEl) return;
  const full = vehicleQuery(titleEl ? titleEl.value : '');
  const noYear = full.replace(/^20\d{2}\s+/, '');
  // comparison titles ("2026 Toyota Tacoma vs 2026 Ford Ranger"): one chip per vehicle
  const sides = String(titleEl ? titleEl.value : '').split(/\s+(?:vs\.?|versus)\s+/i);
  const yearM = full.match(/^20\d{2}/);
  const sideQs = sides.length === 2 ? sides.map((x, i) => {
    let q = vehicleQuery(x);
    for (let k = 0; k < 3; k++) q = q.replace(/\s+(comparison|compare|review|reviews|specs?|price|which|is|better)\s*$/i, '').trim();
    if (i === 1 && yearM && !/^20\d{2}\b/.test(q)) q = `${yearM[0]} ${q}`;
    return q;
  }) : [];
  const list = [...new Set([full, ...sideQs, noYear].filter(Boolean))];
  const key = list.join('|');
  if (key === chipKey) return;
  chipKey = key;
  chipsEl.replaceChildren(...list.map(v => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = v; b.title = 'Use this search text';
    b.style.cssText = 'padding:2px 8px;border:1px solid #c8d3d0;border-radius:12px;background:#fff;cursor:pointer;font-size:11px';
    b.addEventListener('click', () => { queryEl.value = v; queryEdited = true; });
    return b;
  }));
}
function suggest() {
  renderChips();
  if (queryEdited) return;
  queryEl.value = vehicleQuery(titleEl.value);
}

queryEl.addEventListener('input', () => { queryEdited = true; });
titleWatch(suggest);
// the title is filled by code after a Google Doc import / Salesforce apply, so also check when the popup gets focus
setInterval(suggest, 1500);

btn.addEventListener('click', () => {
  const query = queryEl.value.trim() || vehicleQuery(titleEl?.value);
  if (!query) { setStatus('Type the search text first (year + make + model).', 'error'); return; }
  queryEl.value = query;
  setStatus('Opening the image library…');
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'LIB_IMAGE_FETCH', key: KEY, filename: curFilename(), host: dealerHost(), query, width: WIDTH, height: HEIGHT, mode: chooseBox.checked ? 'choose' : 'auto', source: sourceEl?.value || 'dealer' });
});

chrome.storage.local.get(KEY).then(r => { state = r[KEY] || null; if (state?.query && !queryEl.value) { queryEl.value = state.query; queryEdited = true; } render(); suggest(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[KEY]) { state = changes[KEY].newValue || null; render(); } });

if (saveBtn) saveBtn.addEventListener('click', () => {
  // a normal browser download of the captured file, named after the page slug — also a quick check that the image really exists
  const img = window[GLOBAL] && window[GLOBAL]();
  if (!img) { setStatus('No finished image to save yet.', 'error'); return; }
  const mime = (/^data:([^;,]+)/.exec(img.dataUrl) || [])[1] || 'image/png';
  const ext = /jpe?g/.test(mime) ? 'jpg' : /webp/.test(mime) ? 'webp' : 'png';
  const bin = atob(img.dataUrl.split(',')[1] || ''), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([arr], { type: mime }));
  a.download = `${img.filename}.${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
  setStatus(`Saved ${img.filename}.${ext} to your Downloads folder.`, 'success');
});
altEl.addEventListener('input', () => chrome.storage.local.set({ [ALT_KEY]: altEl.value.trim() }));
window[GLOBAL] = () => {
  if (!state || state.status !== 'done' || !state.dataUrl) return null;
  const alt = altEl.value.trim() || state.query || queryEl.value.trim();
  // File name = the page slug (from the Google Doc); title + alt text = the vehicle name.
  const slugify = v => (v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filename = slugify((slugEl && slugEl.value.split('/').filter(Boolean).pop()) || (titleEl && titleEl.value) || state.query) || FALLBACK_NAME;
  return { dataUrl: state.dataUrl, width: state.width, height: state.height, alt, filename };
};
}

// 1) landing-page banner (Hub panel) - unchanged behaviour
initPicker({
  KEY: 'diLandingImage', WIDTH: 1400, HEIGHT: 500, p: 'landing-image', ALT_KEY: 'diLandingImageAlt', GLOBAL: '__diGetLandingImage', FALLBACK_NAME: 'landing-banner',
  DONE_NOTE: 'It is saved as the page slug and uploaded to the site when the page is built.',
  getTitle: () => (($('comparison-page-title') || {}).value) || '',
  getSlug: () => (($('comparison-page-slug') || {}).value) || '',
  titleWatch: fn => { const t = $('comparison-page-title'); if (t) { t.addEventListener('input', fn); new MutationObserver(fn).observe(t, { attributes: true }); } },
});

// 2) BLOG image (Blog panel): 1000x400. After the draft is queued, "Open & fill WordPress" uploads it to the media library
//    and puts it at the very start of the post content with its alt text.
initPicker({
  KEY: 'diBlogImage', WIDTH: 1000, HEIGHT: 400, p: 'blog-image', ALT_KEY: 'diBlogImageAlt', GLOBAL: '__diGetBlogImage', FALLBACK_NAME: 'blog-image',
  DONE_NOTE: 'It is uploaded to the media library and added at the start of the post (with alt text) when you click "Open & fill WordPress".',
  getTitle: () => ($('title') || {}).textContent || '',
  getSlug: () => ($('slug') || {}).textContent || '',
  titleWatch: () => { /* the interval in initPicker re-reads the draft title */ },
});
