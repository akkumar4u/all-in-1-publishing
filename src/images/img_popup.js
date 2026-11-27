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
const cropBox = $(p + '-crop-box'), cropYEl = $(p + '-crop-y'), cropZoomEl = $(p + '-zoom');
const cropYValue = $(p + '-crop-value'), cropZoomValue = $(p + '-zoom-value');
const slugEl = { get value() { return getSlug(); } };
const titleEl = { get value() { return getTitle(); } };
const hasTitle = true;
const slugifyName = v => (v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const curFilename = () => slugifyName((slugEl && slugEl.value.split('/').filter(Boolean).pop()) || (titleEl && titleEl.value) || (state && state.query) || '') || FALLBACK_NAME;
const dealerHost = () => { try { const u = ['admin-url', 'publishing-admin-url', 'blog-admin-url'].map(i => (document.getElementById(i) || {}).value || '').find(v => /^https?:\/\//i.test(v.trim())); return u ? new URL(u.trim()).hostname : ''; } catch (e) { return ''; } };

let state = null;
let queryEdited = false;
let cropTimer = 0, cropRun = 0;
let dragCrop = null;
let altEdited = false;
let lastAutoAlt = '';

function syncDefaultAlt() {
  const title = String(getTitle() || '').trim();
  if (!title) return;
  if (lastAutoAlt && title !== lastAutoAlt && altEdited) altEdited = false;
  if (!altEdited) {
    altEl.value = title;
    lastAutoAlt = title;
    chrome.storage.local.set({ [ALT_KEY]: title });
  }
}

async function cropDataUrl(source, yPercent, zoomPercent) {
  const zoom = Math.max(1, Number(zoomPercent || 100) / 100);
  const y = Math.max(0, Math.min(100, Number(yPercent ?? 50))) / 100;
  if (zoom <= 1 && y === 0.5) return source;
  const bitmap = await createImageBitmap(await (await fetch(source)).blob());
  const ratio = WIDTH / HEIGHT;
  let cropWidth = bitmap.width, cropHeight = bitmap.height;
  if (cropWidth / cropHeight > ratio) cropWidth = cropHeight * ratio;
  else cropHeight = cropWidth / ratio;
  cropWidth /= zoom; cropHeight /= zoom;
  const sx = Math.max(0, (bitmap.width - cropWidth) / 2);
  const sy = Math.max(0, (bitmap.height - cropHeight) * y);
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not create the image crop preview.');
  ctx.drawImage(bitmap, sx, sy, cropWidth, cropHeight, 0, 0, WIDTH, HEIGHT);
  bitmap.close?.();
  let blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: .9 });
  if (blob.size > 990 * 1024) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: .78 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

function queueCrop() {
  if (!state || state.status !== 'done' || !state.dataUrl || !cropYEl || !cropZoomEl) return;
  if (cropYEl.value !== '50' && cropZoomEl.value === '100') cropZoomEl.value = '120';
  const y = Number(cropYEl.value), zoom = Number(cropZoomEl.value), run = ++cropRun;
  if (cropYValue) cropYValue.value = `${y}%`;
  if (cropZoomValue) cropZoomValue.value = `${zoom}%`;
  clearTimeout(cropTimer);
  cropTimer = setTimeout(async () => {
    try {
      const croppedDataUrl = await cropDataUrl(state.dataUrl, y, zoom);
      if (run !== cropRun || !state) return;
      const next = { ...state, cropY: y, cropZoom: zoom, croppedDataUrl };
      state = next;
      preview.src = croppedDataUrl;
      chrome.storage.local.set({ [KEY]: next });
      setStatus(`Crop preview updated · vertical position ${y}% · zoom ${zoom}%.`, 'success');
    } catch (error) { setStatus(`Could not adjust this crop: ${error.message}`, 'error'); }
  }, 120);
}
cropYEl?.addEventListener('input', queueCrop);
cropZoomEl?.addEventListener('input', queueCrop);

// Let the user reposition the crop directly on the finished preview. Dragging
// the photo down reveals more of its upper edge; the slider remains in sync.
preview?.addEventListener('pointerdown', event => {
  if (!state || state.status !== 'done' || !cropYEl || !cropZoomEl) return;
  event.preventDefault();
  preview.setPointerCapture(event.pointerId);
  dragCrop = { pointerId: event.pointerId, startY: event.clientY, cropY: Number(cropYEl.value || 50), height: Math.max(1, preview.getBoundingClientRect().height) };
  preview.classList.add('is-crop-dragging');
});
preview?.addEventListener('pointermove', event => {
  if (!dragCrop || dragCrop.pointerId !== event.pointerId) return;
  const delta = (event.clientY - dragCrop.startY) / dragCrop.height * 100;
  cropYEl.value = String(Math.max(0, Math.min(100, Math.round(dragCrop.cropY - delta))));
  cropYEl.dispatchEvent(new Event('input', { bubbles: true }));
});
const finishCropDrag = event => {
  if (!dragCrop || (event && dragCrop.pointerId !== event.pointerId)) return;
  dragCrop = null;
  preview.classList.remove('is-crop-dragging');
};
preview?.addEventListener('pointerup', finishCropDrag);
preview?.addEventListener('pointercancel', finishCropDrag);

function setStatus(text, kind) { statusEl.textContent = text || ''; statusEl.className = 'status' + (kind ? ' ' + kind : ''); }

function render() {
  choices.hidden = true;
  if (saveBtn) saveBtn.hidden = !(state && state.status === 'done' && state.dataUrl);
  if (cropBox) cropBox.hidden = !(state && state.status === 'done' && state.dataUrl);
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
      if (p === 'blog-image') cell.className = 'blog-image-choice';
      else cell.style.cssText = 'padding:2px;border:1px solid #c8d3d0;border-radius:6px;background:#fff;cursor:pointer;text-align:left';
      const im = document.createElement('img');
      im.src = c.imgSrc; im.alt = c.title;
      if (p !== 'blog-image') im.style.cssText = 'width:100%;height:56px;object-fit:cover;border-radius:4px;display:block';
      const cap = document.createElement('div');
      const readableTitle = String(c.title || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
      cap.textContent = readableTitle + (c.sizes && c.sizes.length ? ` · ${WIDTH} ✓` : '');
      if (p === 'blog-image') cap.className = 'blog-image-choice-title';
      else cap.style.cssText = 'font-size:10px;line-height:1.25;margin-top:4px;overflow:hidden;max-height:26px;overflow-wrap:anywhere';
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
    again.className = p === 'blog-image' ? 'blog-image-search-again' : '';
    if (p !== 'blog-image') again.style.cssText = 'grid-column:1/-1;display:flex;gap:6px;margin-top:4px';
    const ai = document.createElement('input');
    ai.type = 'text'; ai.value = queryEl.value || state.query || ''; ai.placeholder = 'Custom search text';
    if (p !== 'blog-image') ai.style.cssText = 'flex:1;min-width:0';
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
    setStatus(`Got ${state.width}×${state.height}: "${state.imageTitle || state.query}". Drag the preview up or down to adjust framing, or use the slider. ${state.savedAs ? '✔ Saved in Downloads as ' + state.savedAs + '. ' : state.saveError ? '⚠ NOT saved to Downloads (' + state.saveError + ') - use the Save button. ' : ''}${DONE_NOTE}`, state.saveError ? 'error' : 'success');
    if (cropBox) cropBox.hidden = false;
    if (cropYEl) cropYEl.value = String(state.cropY ?? 50);
    if (cropZoomEl) cropZoomEl.value = String(state.cropZoom ?? 100);
    if (cropYValue) cropYValue.value = `${state.cropY ?? 50}%`;
    if (cropZoomValue) cropZoomValue.value = `${state.cropZoom ?? 100}%`;
    preview.src = state.croppedDataUrl || state.dataUrl; preview.hidden = false;
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
    if (p === 'blog-image') b.className = 'image-query-chip';
    else b.style.cssText = 'padding:2px 8px;border:1px solid #c8d3d0;border-radius:12px;background:#fff;cursor:pointer;font-size:11px';
    b.addEventListener('click', () => { queryEl.value = v; queryEdited = true; });
    return b;
  }));
}
function suggest() {
  syncDefaultAlt();
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[KEY]) return;
  const previous = state, next = changes[KEY].newValue || null;
  state = next;
  if (previous?.status === 'running' && next?.status === 'done') {
    state = { ...next, cropY: 50, cropZoom: 100, croppedDataUrl: '' };
    chrome.storage.local.set({ [KEY]: state });
  }
  render();
});

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
altEl.addEventListener('input', () => {
  const value = altEl.value.trim();
  altEdited = !!value && value !== lastAutoAlt;
  chrome.storage.local.set({ [ALT_KEY]: value || String(getTitle() || '').trim() });
});
window[GLOBAL] = () => {
  if (!state || state.status !== 'done' || !state.dataUrl) return null;
  const alt = altEl.value.trim() || String(getTitle() || '').trim() || state.query || queryEl.value.trim();
  // File name = the page slug (from the Google Doc); title + alt text = the vehicle name.
  const slugify = v => (v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filename = slugify((slugEl && slugEl.value.split('/').filter(Boolean).pop()) || (titleEl && titleEl.value) || state.query) || FALLBACK_NAME;
  return { dataUrl: state.croppedDataUrl || state.dataUrl, width: state.width, height: state.height, alt, filename, cropY: state.cropY ?? 50 };
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
