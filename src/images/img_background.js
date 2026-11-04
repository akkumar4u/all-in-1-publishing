/**
 * Landing-page banner from the Dealer Inspire Image Library.
 *
 * The library page lists many images (<figure class="image-figure">). Each one has a "sizes" list of
 * download buttons: original, large, medium, small, "landing", "landing banner", "banner", "blog-banner"…
 * The one we need is the 1400-wide landing / banner size (it comes out 1400x500).
 *
 *   1) SCAN     open  <library>/?text=<query>, read every image: title, thumbnail, its size buttons.
 *   2) PICK     rank by how well the title matches the query (exact model, exterior shots first, no
 *               "Interior / Technology" shots) and pick RANDOMLY among the best ones — never just
 *               "the first image". Or (mode "choose") show the best ones in the popup and let the person pick.
 *   3) DOWNLOAD click that image's landing-size button, capture the file, check its real pixel size (1400x~500).
 *
 * Progress lives in chrome.storage.local ("diLandingImage") because the popup closes when the library window opens.
 */
import { pickDownloadName } from './img_name.js';
import { closeHelperWindow } from '../win_util.js';

let KEY = 'diLandingImage';          // blog images use their own key ('diBlogImage') so they never overwrite the landing banner
let BLOG = false;                    // true = blog image (1000x400, any size label, "blog" labels first)
const LIBRARY = 'https://prod.image-libary-api.dealerinspire.com';   // spelling as given
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setState(patch) {
  const cur = (await chrome.storage.local.get(KEY))[KEY] || {};
  await chrome.storage.local.set({ [KEY]: { ...cur, ...patch, updatedAt: Date.now() } });
}
async function addLog(line) {
  const cur = (await chrome.storage.local.get(KEY))[KEY] || {};
  await setState({ log: [...(cur.log || []), line].slice(-40) });
}
async function waitTabComplete(tabId, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error('Image library tab was closed.');
    if (t.status === 'complete') return;
    await sleep(100);
  }
}
async function bytesToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

/* ================= ranking (plain JS, runs in the background) ================= */
const tokens = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const BAD = ['interior', 'technology', 'tech', 'dashboard', 'cockpit', 'seat', 'seats', 'steering', 'wheel', 'trunk', 'cargo', 'engine', 'console', 'screen', 'detail', 'details'];

export function rankFigures(figures, query) {
  const q = tokens(query);
  const ranked = figures
    .filter(f => f.sizeLabels.length || f.hasMore)   // visible landing size, or a cut-off list that the sizes panel will check
    .map(f => {
      const t = tokens(f.title);
      const hit = q.filter(x => t.includes(x)).length;
      const extra = t.filter(x => !q.includes(x));
      const bad = extra.filter(x => BAD.includes(x)).length;
      const score = (q.length ? (hit / q.length) * 100 : 50) - extra.length * 4 - bad * 30 + (f.sizeLabels.length ? 15 : 0);
      return { ...f, score, full: q.length > 0 && hit === q.length };
    })
    .filter(f => f.score > 20)
    // images that contain the whole search (year + make + model) always beat partial matches (e.g. a GLC for a GLE search)
    .sort((a, b) => (b.full - a.full) || (b.score - a.score));
  return ranked;
}
export function pickAmongBest(ranked) {
  if (!ranked.length) return null;
  const best = ranked[0].score;
  const pool = ranked.filter(f => f.full === ranked[0].full && f.score >= best - 10);          // a "tier" of equally good images
  return pool[Math.floor(Math.random() * pool.length)];
}
// size buttons we may click, best first: "landing banner" > "banner" > "landing" / "landing-page"
export const labelRank = label => /landing[\s-]*banner/i.test(label) ? 0 : /landing/i.test(label) ? 2 : /banner/i.test(label) && !/blog/i.test(label) ? 1 : /blog/i.test(label) ? 9 : 6;

/* ================= runs INSIDE the library page ================= */
async function libraryScan(W, blog) {
  const sleepP = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 120 && !document.querySelector('figure.image-figure'); i++) await sleepP(100);
  if (!document.querySelector('figure.image-figure')) return { ok: false, error: 'No images found on the library page (is it logged in, did the search return results?).', pageText: document.body.innerText.slice(0, 300) };
  // load the whole infinite list (stop when scrolling brings no new images; at most 15 rounds)
  for (let k = 0, stale = 0; k < 4 && stale < 1; k++) {
    const n = document.querySelectorAll('figure.image-figure').length;
    window.scrollTo(0, document.body.scrollHeight);
    await sleepP(500);
    stale = document.querySelectorAll('figure.image-figure').length === n ? stale + 1 : 0;
  }
  window.scrollTo(0, 0);
  await sleepP(100);

  const parse = b => { const m = (b.textContent || '').replace(/\s+/g, ' ').match(/(\d{3,5})\s*\(w\)\s*(.*)$/); return m ? { w: +m[1], label: m[2].trim() } : null; };
  const readSizes = fig => {
    let btns = [...fig.querySelectorAll('.sizes li button')];
    if (!btns.length) btns = [...fig.querySelectorAll('button')];
    return btns.map(parse).filter(Boolean);
  };
  const landing = sizes => sizes.filter(s => Math.abs(s.w - W) <= 2 && (blog || (/landing|banner/i.test(s.label) && !/blog/i.test(s.label)))).map(s => s.label);
  const findMore = fig => {
    const c = [...fig.querySelectorAll('*')].filter(e => /\+\s*\d+\s*more/i.test(e.textContent || '') && (e.textContent || '').trim().length < 30);
    return c.length ? c[c.length - 1] : null;
  };

  const figs = [...document.querySelectorAll('figure.image-figure')];
  // The size list is cut off with "+ N more". The 1400 landing size is usually in the hidden part, so open
  // every list FIRST — otherwise images without a landing size look usable and the download fails later.
  const before = new Map();
  const poke = el => {
    for (const type of ['pointerover', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (e) { /* ignore */ }
    }
    try { el.click(); } catch (e) { /* ignore */ }
  };
  for (const fig of figs) {
    const more = findMore(fig);
    before.set(fig, readSizes(fig).length);
    if (more) poke(more);
  }
  await sleepP(400);
  // second try for lists that did not open: click the <li> around "+ N more"
  for (const fig of figs) {
    const more = findMore(fig);
    if (more && readSizes(fig).length <= (before.get(fig) || 0)) poke(more.closest('li') || more.parentElement || more);
  }
  await sleepP(250);

  const figures = figs.map((fig, i) => {
    const title = ((fig.querySelector('.title p') || {}).textContent || '').replace(/\s+/g, ' ').trim();
    const img = fig.querySelector('img');
    const sizes = readSizes(fig);
    const landingLabels = landing(sizes);
    // no size is labelled "landing" / "banner", but the image has a 1400-wide size (e.g. "large", "original") — that is usable too
    const wideLabels = sizes.filter(z => Math.abs(z.w - W) <= 2 && !/blog/i.test(z.label)).map(z => z.label || String(z.w));
    const sizeLabels = landingLabels.length || blog ? landingLabels : wideLabels;
    const moreEl = findMore(fig);
    // "unverified" = a "+ N more" is still there and opening it changed nothing, so we cannot tell
    const needsExpand = !!moreEl && sizes.length <= (before.get(fig) || 0);
    const stats = ((fig.querySelector('.image-stats p') || {}).textContent || '').replace(/\s+/g, ' ').trim();
    return { i, title, imgSrc: img ? img.src : '', sizeLabels, needsExpand, hasMore: !!moreEl, allSizes: sizes.map(s => `${s.w}${s.label ? ' ' + s.label : ''}`), stats };
  });
  const seen1400 = new Set();
  for (const fig of figs) for (const sz of readSizes(fig)) if (Math.abs(sz.w - W) <= 2) seen1400.add(sz.label || '(no label)');
  const diag = {
    total: figs.length,
    withMore: figs.filter(f => findMore(f)).length,
    notOpened: figs.filter(f => findMore(f) && readSizes(f).length <= (before.get(f) || 0)).length,
    labels1400: [...seen1400].slice(0, 8),
  };
  return { ok: true, figures, diag };
}

/* ---- shared by libraryVerify / libraryDownload (each is serialised into the page, so the helpers are repeated) ----
 * The LIST button of an image (second icon at the bottom right of the picture) opens a panel with one row per size:
 * heading ("landing page"), shortcode / url copy buttons, "dimensions: 1400x499" and a download arrow
 * <a download href="https://...amazonaws.com/images/xxx.jpg">. (The size buttons on top only COPY code - never click those.) */

async function libraryVerify(imgSrcs, budgetMs, W, H, blog, stopAfter) {
  const sleepP = ms => new Promise(r => setTimeout(r, ms));
  const end = Date.now() + (budgetMs || 60000);
  const findFig = src => [...document.querySelectorAll('figure.image-figure')].find(f => { const im = f.querySelector('img'); return im && im.src === src; });
  const listBtn = fig => {
    const bs = [...fig.querySelectorAll('.action-btn button')];
    return bs.find(b => { const p = b.querySelector('path'); return p && /^M7 3a1 1 0 000 2h6/.test(p.getAttribute('d') || ''); }) || bs[bs.length - 1] || null;
  };
  const rowsNow = before => [...document.querySelectorAll('a[download][href]')]
    .filter(a => !a.closest('figure.image-figure') && /^https?:/i.test(a.href) && !before.has(a.href))
    .map(a => {
      const row = a.closest('.bg-gray-100') || (a.parentElement && a.parentElement.parentElement) || a;
      const t = (row.innerText || row.textContent || '').replace(/\s+/g, ' ');
      const d = t.match(/dimensions:\s*(\d{3,5})\s*x\s*(\d{3,5})/i);
      const head = (((row.querySelector('p') || {}).textContent) || '').replace(/\s+/g, ' ').trim();
      return { url: a.href, w: d ? +d[1] : null, h: d ? +d[2] : null, head };
    });
  const rank = l => blog ? (/blog/i.test(l) ? 0 : /banner|feature|header|hero/i.test(l) ? 1 : 5) : (/landing[\s-]*banner/i.test(l) ? 0 : /landing/i.test(l) ? 2 : /banner/i.test(l) && !/blog/i.test(l) ? 1 : /blog/i.test(l) ? 9 : 6);
  const sizeOk = r => r.w && Math.abs(r.w - W) <= 2 && (!blog || (r.h && Math.abs(r.h - H) <= 2));
  const best = rows => rows.filter(r => sizeOk(r) && rank(r.head) < 9).sort((x, y) => (rank(x.head) - rank(y.head)) || (Math.abs((x.h || 0) - H) - Math.abs((y.h || 0) - H)))[0] || null;
  const tryClose = async () => {
    const c = [...document.querySelectorAll('button, [role="button"]')].find(e => !e.closest('figure.image-figure') &&
      (/close|dismiss/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.title || '')) || /^\s*[×✕]\s*$/.test(e.textContent || '') || /close/i.test(((e.querySelector('title') || {}).textContent) || '')));
    if (c) { try { c.click(); } catch (e) { /* ignore */ } }
    for (const t of [document, document.body, window]) { try { t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch (e) { /* ignore */ } }
    await sleepP(80);
  };
  const results = [];
  let navigated = false;
  for (const src of imgSrcs) {
    if (Date.now() > end) break;
    const fig = findFig(src);
    const res = { imgSrc: src, rows: 0, url: '', label: '', sizes: [] };
    results.push(res);
    const btn = fig && listBtn(fig);
    if (!btn) { res.error = fig ? 'no list button' : 'image not on the page'; continue; }
    const before = new Set([...document.querySelectorAll('a[download][href]')].map(a => a.href));
    fig.scrollIntoView({ block: 'center' });
    await sleepP(40);
    btn.click();
    let rows = [];
    for (let t = 0; t < 50 && !rows.length; t++) { await sleepP(60); rows = rowsNow(before); }
    if (rows.length) { await sleepP(120); rows = rowsNow(before); }
    res.rows = rows.length;
    res.sizes = rows.map(r => `${r.head} ${r.w || '?'}x${r.h || '?'}`);
    const b = best(rows);
    if (b) { res.url = b.url; res.label = b.head; }
    await tryClose();
    if (b && stopAfter && results.filter(x => x.url).length >= stopAfter) break;   // enough good matches (auto mode) - stop checking the rest
    if (!document.contains(fig)) { navigated = true; break; }       // the click changed the page: stop here
  }
  return { ok: true, results, navigated };
}

async function libraryDownload(imgSrc, skipLabels, wantTitle, W, H, blog) {
  const sleepP = ms => new Promise(r => setTimeout(r, ms));
  const log = [];
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const figTitle = f => norm((f.querySelector('.title p') || {}).textContent);
  const findFig = () => {
    const all = [...document.querySelectorAll('figure.image-figure')];
    return all.find(f => { const im = f.querySelector('img'); return im && im.src === imgSrc; })
      || (wantTitle ? all.find(f => figTitle(f) === norm(wantTitle)) : null);
  };
  let fig = findFig();
  for (let k = 0; k < 6 && !fig; k++) { window.scrollTo(0, document.body.scrollHeight); await sleepP(500); fig = findFig(); }
  if (!fig) return { ok: false, error: 'That image is no longer in the library results.', log };
  fig.scrollIntoView({ block: 'center' });
  await sleepP(100);
  const listBtn = () => {
    const bs = [...fig.querySelectorAll('.action-btn button')];
    return bs.find(b => { const p = b.querySelector('path'); return p && /^M7 3a1 1 0 000 2h6/.test(p.getAttribute('d') || ''); }) || bs[bs.length - 1] || null;
  };
  const before = new Set([...document.querySelectorAll('a[download][href]')].map(a => a.href));
  const rowsNow = () => [...document.querySelectorAll('a[download][href]')]
    .filter(a => !a.closest('figure.image-figure') && /^https?:/i.test(a.href) && !before.has(a.href))
    .map(a => {
      const row = a.closest('.bg-gray-100') || (a.parentElement && a.parentElement.parentElement) || a;
      const t = (row.innerText || row.textContent || '').replace(/\s+/g, ' ');
      const d = t.match(/dimensions:\s*(\d{3,5})\s*x\s*(\d{3,5})/i);
      const head = (((row.querySelector('p') || {}).textContent) || '').replace(/\s+/g, ' ').trim();
      return { url: a.href, w: d ? +d[1] : null, h: d ? +d[2] : null, head };
    });
  const rank = l => blog ? (/blog/i.test(l) ? 0 : /banner|feature|header|hero/i.test(l) ? 1 : 5) : (/landing[\s-]*banner/i.test(l) ? 0 : /landing/i.test(l) ? 2 : /banner/i.test(l) && !/blog/i.test(l) ? 1 : /blog/i.test(l) ? 9 : 6);
  const sizeOk = r => r.w && Math.abs(r.w - W) <= 2 && (!blog || (r.h && Math.abs(r.h - H) <= 2));
  const btn = listBtn();
  if (!btn) return { ok: false, noPanel: true, error: 'No list button (sizes panel) on this image.', log };
  btn.click();
  log.push('opened the sizes panel (list button)');
  let rows = [];
  for (let t = 0; t < 60 && !rows.length; t++) { await sleepP(60); rows = rowsNow(); }
  if (rows.length) { await sleepP(150); rows = rowsNow(); }
  if (!rows.length) return { ok: false, noPanel: true, error: 'The sizes panel did not show any download rows.', log };
  const usable = rows.filter(r => sizeOk(r) && rank(r.head) < 9 && !skipLabels.includes(r.head)).sort((x, y) => (rank(x.head) - rank(y.head)) || (Math.abs((x.h || 0) - H) - Math.abs((y.h || 0) - H)));
  if (!usable.length) return { ok: false, exhausted: true, error: 'No ' + (blog ? W + 'x' + H : W + '-wide') + ' size on this image. Sizes it has: ' + rows.map(r => `${r.head} ${r.w || '?'}x${r.h || '?'}`).join(', '), log };
  const chosen = usable[0];
  log.push(`download arrow: "${chosen.head}" ${chosen.w}x${chosen.h} -> ${chosen.url}`);
  let blob;
  try { blob = await (await fetch(chosen.url)).blob(); }
  catch (e) { return { ok: true, label: chosen.head, url: chosen.url, log: [...log, 'the page could not read the link (the extension will fetch it)'] }; }
  if (blob.type && !/^image\//i.test(blob.type)) return { ok: false, label: chosen.head, error: `The download link is not an image (${blob.type}).`, log };
  const bmp = await createImageBitmap(blob).catch(() => null);
  const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  return { ok: true, label: chosen.head, url: chosen.url, dataUrl, mime: blob.type, w: bmp ? bmp.width : null, h: bmp ? bmp.height : null, log };
}


/* Save the finished image to the Downloads folder. Tries the real https link first (no size limit - a big
 * data: URL can be refused by Chrome, which was the silent "not saved" case), then the data: URL.
 * Waits until Chrome says the file is complete and writes the result into the stored state (popup shows it). */
async function saveLocal({ url, dataUrl, mime, filename, host }) {
  if (!filename) return false;
  const ext = /jpe?g/i.test(mime || '') ? 'jpg' : /webp/i.test(mime || '') ? 'webp' : /png/i.test(mime || '') ? 'png'
    : /\.jpe?g(\?|$)/i.test(url || '') ? 'jpg' : /\.webp(\?|$)/i.test(url || '') ? 'webp' : 'png';
  let nm = filename;
  try { nm = await pickDownloadName(filename, ext, host); } catch { /* keep plain name */ }
  const full = `${nm}.${ext}`;
  const sources = [/^https?:/i.test(url || '') ? url : null, dataUrl].filter(Boolean);
  let lastErr = 'no image data';
  for (const src of sources) {
    try {
      const id = await chrome.downloads.download({ url: src, filename: full, conflictAction: 'overwrite', saveAs: false });
      for (let i = 0; i < 150; i++) {
        const [it] = await chrome.downloads.search({ id });
        if (it && it.state === 'complete') { await addLog(`saved ${full} to Downloads`); await setState({ savedAs: full, saveError: '' }); return true; }
        if (it && it.state === 'interrupted') { lastErr = it.error || 'interrupted'; break; }
        await sleep(60);
      }
    } catch (e) { lastErr = e.message; }
  }
  await addLog('could not save to Downloads: ' + lastErr);
  await setState({ savedAs: '', saveError: lastErr });
  return false;
}

/* ================= orchestration ================= */
const near = (w, h, W, H) => w && h && Math.abs(w - W) <= 2 && (BLOG ? Math.abs(h - H) <= 2 : h >= 200);   // landing: 1400 wide, any height (the page uses it as a cover background)

async function fetchImage(url) {
  const blob = await (await fetch(url)).blob();
  if (blob.type && !/^image\//i.test(blob.type)) throw new Error(`the link is not an image (${blob.type})`);
  const bmp = await createImageBitmap(blob);
  return { dataUrl: await bytesToDataUrl(blob), w: bmp.width, h: bmp.height, mime: blob.type || 'image/png' };
}

const CLOUDINARY_COLLECTION_API = 'https://console.cloudinary.com/console/api/v1/collections/public/cc-brand-studio/ea1b600de0a008fb585d6a9850d3b132/search';
function cloudinaryDeliveryUrl(url, width, height) {
  if (!url || !url.includes('/image/upload/')) throw new Error('Cloudinary did not return a usable image URL.');
  return url.replace('/image/upload/', `/image/upload/c_fill,g_auto,w_${width},h_${height}/`);
}
async function cloudinarySearch(query, width, height) {
  // Match the collection page's own search box: its freeText filter becomes a quoted prefix expression, e.g. "2026 hyundai*".
  // Keep a broad filename fallback for long editorial titles that do not match that phrase prefix.
  const stop = new Set(('a an the and or but if then than of for with from to in on at by about into over after before is are was were be been being do does did can could should would will may might how what why when where which who whom whose this that these those it its as not no yes new used vehicle vehicles car cars auto automotive kind take takes get gets your our their they them you we i me my sale review reviews comparison compare vs specs spec').split(' '));
  const words = [...new Set(tokens(query).filter(w => w.length > 1 && !stop.has(w)))].slice(0, 10);
  const requestedYear = tokens(query).find(w => /^20\d{2}$/.test(w)) || '';
  const fetchAssets = async expression => {
    const url = new URL(CLOUDINARY_COLLECTION_API);
    url.searchParams.set('max_results', '60');
    url.searchParams.set('sort_by', 'filename asc');
    if (expression) url.searchParams.set('expression', expression);
    const response = await fetch(url.href);
    if (!response.ok) throw new Error(`Cloudinary search failed (HTTP ${response.status}).`);
    return (await response.json()).assets || [];
  };
  const freeText = String(query || '').trim().replace(/["\\]/g, ' ').replace(/\s+/g, ' ');
  const yearFirstWords = [...new Set([requestedYear, ...words.filter(w => w !== requestedYear)].filter(Boolean))];
  const prefixes = [];
  if (freeText) prefixes.push(`"${freeText}*"`); // exact same query as the Cloudinary search box
  for (let n = yearFirstWords.length; n >= Math.min(2, yearFirstWords.length); n--) {
    const phrase = yearFirstWords.slice(0, n).join(' ');
    if (phrase) prefixes.push(`"${phrase}*"`);
  }
  let assets = [];
  for (const expression of [...new Set(prefixes)]) {
    assets = await fetchAssets(expression);
    if (assets.length) break;
  }
  if (!assets.length && words.length) {
    const modelTerms = words.filter(w => w !== requestedYear);
    if (modelTerms.length > 1) assets = await fetchAssets(modelTerms.map(w => `filename:${w}`).join(' AND '));
    if (!assets.length) assets = await fetchAssets(words.map(w => `filename:${w}`).join(' OR '));
  }
  const ranked = assets.filter(a => a.resource_type === 'image' && a.status === 'active' && a.delivery_urls?.original)
    .map(a => {
      // The collection's visible asset title is the filename (same text shown in its text-content span).
      const title = a.filename || a.display_name || 'Cloudinary image';
      const nameTokens = tokens(title);
      const hit = words.filter(w => nameTokens.includes(w)).length;
      const yearMatch = !!requestedYear && nameTokens.includes(requestedYear);
      const score = (yearMatch ? 10000 : 0) + (words.length ? hit * 50 + (hit / words.length) * 50 : 50);
      const original = a.delivery_urls.original;
      return { title, score, yearMatch, imgSrc: cloudinaryDeliveryUrl(original, 360, 144), landingUrl: cloudinaryDeliveryUrl(original, width, height), width: a.width, height: a.height };
    }).filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score || (b.width * b.height) - (a.width * a.height));
  const yearMatches = ranked.filter(a => a.yearMatch);
  return (yearMatches.length ? yearMatches : ranked).slice(0, 12);
}
async function runCloudinary({ query, width, height, mode, pick, filename, host }) {
  const started = Date.now();
  await chrome.storage.local.set({ [KEY]: { status: 'running', step: pick ? 'Downloading from Cloudinary…' : 'Searching Cloudinary…', query, width, height, imageLibrary: 'cloudinary', candidates: pick ? ((await chrome.storage.local.get(KEY))[KEY] || {}).candidates || [] : [], savedAs: '', saveError: '' } });
  try {
    const candidates = pick ? [pick] : await cloudinarySearch(query, width, height);
    if (!candidates.length) throw new Error(`No Cloudinary images matched “${query}”. Try fewer search words.`);
    if (!pick && mode === 'choose') {
      await setState({ status: 'choose', step: '', imageLibrary: 'cloudinary', error: '', scanSeconds: Math.round((Date.now() - started) / 100) / 10,
        candidates: candidates.map(c => ({ title: c.title, imgSrc: c.imgSrc, score: Math.round(c.score), sizes: [`${width}×${height}`], landingUrl: c.landingUrl })) });
      return;
    }
    const selected = pick || candidates[0];
    const result = await fetchImage(selected.landingUrl);
    if (!near(result.w, result.h, width, height)) throw new Error(`Cloudinary returned ${result.w}×${result.h}; expected ${width}×${height}.`);
    await setState({ status: 'done', step: '', imageLibrary: 'cloudinary', dataUrl: result.dataUrl, width: result.w, height: result.h, mime: result.mime, imageTitle: selected.title, error: '', seconds: Math.round((Date.now() - started) / 1000) });
    if (filename) await saveLocal({ url: selected.landingUrl, dataUrl: result.dataUrl, mime: result.mime, filename, host });
  } catch (err) {
    await setState({ status: 'error', step: '', imageLibrary: 'cloudinary', error: err.message });
  }
}

async function downloadFigure(tabId, fig, width, height, downloads) {
  // 1) the link was already read from the sizes panel during the scan -> just fetch it (instant)
  if (fig.landingUrl) {
    try {
      const r = await fetchImage(fig.landingUrl);
      if (near(r.w, r.h, width, height)) return { ok: true, dataUrl: r.dataUrl, w: r.w, h: r.h, mime: r.mime, label: 'landing', url: fig.landingUrl };
      await addLog(`stored link came out ${r.w}x${r.h}, not ${width}x${height} - opening the library instead`);
    } catch (e) { await addLog('stored link failed (' + e.message + ') - opening the library instead'); }
  }
  // 2) open the image's sizes panel in the library page and use its download arrow
  const skip = [];
  const seen = [];
  let reloaded = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await setState({ step: `Downloading "${fig.title}"… (try ${attempt})` });
    const [{ result: r } = {}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: libraryDownload, args: [fig.imgSrc, skip, fig.title, width, height, BLOG] });
    if (!r) throw new Error('The library page did not respond.');
    for (const l of r.log || []) await addLog(l);
    if (!r.ok && /no longer in the library results/i.test(r.error || '') && !reloaded) {     // the page changed (panel / route): start clean
      reloaded = true;
      await addLog('library page changed - reloading it');
      await chrome.tabs.reload(tabId); await sleep(500); await waitTabComplete(tabId); await sleep(1500);
      continue;
    }
    if (!r.ok && (r.exhausted || r.noPanel)) return { ok: false, why: `${r.error}${seen.length ? ' Sizes downloaded: ' + seen.join(', ') : ''}` };
    let dataUrl = r.dataUrl, w = r.w, h = r.h;
    if (r.ok && r.url && !dataUrl) {
      try { const f = await fetchImage(r.url); dataUrl = f.dataUrl; w = f.w; h = f.h; r.mime = f.mime; }
      catch (e) { await addLog(`link could not be read (${e.message})`); if (r.label) skip.push(r.label); continue; }
    }
    if (!r.ok) { await addLog(r.error); if (r.label) skip.push(r.label); continue; }
    if (near(w, h, width, height)) return { ok: true, dataUrl, w, h, mime: r.mime || 'image/png', label: r.label, url: r.url || '' };
    seen.push(`${r.label}=${w}x${h}`);
    await addLog(`size "${r.label}" came out ${w}x${h}, not ${width}x${height} - trying another size`);
    skip.push(r.label);
  }
  return { ok: false, why: `No ${width}x${height} size worked. Seen: ${seen.join(', ') || 'none'}.` };
}

/* The library window used for "Let me choose the image" is kept open after the scan, so that clicking an image in the
 * popup downloads it at once (no new window, no new search, no new scan). */
let HELD = 'diLandingHeld';
const getHeld = async () => (await chrome.storage.local.get(HELD))[HELD] || null;
const setHeld = h => chrome.storage.local.set({ [HELD]: h });
async function closeHeld() {
  const h = await getHeld();
  await chrome.storage.local.remove(HELD);
  if (h?.winId) await closeHelperWindow(h.winId, h.tabId);
}

async function run({ query, width, height, mode, pick, filename, host, key, source }) {
  const T0 = Date.now();                 // for the time log (seconds this image step took)
  BLOG = key === 'diBlogImage';
  KEY = BLOG ? 'diBlogImage' : 'diLandingImage';
  HELD = BLOG ? 'diBlogHeld' : 'diLandingHeld';
  if (source === 'cloudinary') { await runCloudinary({ query, width, height, mode, pick, filename, host }); return; }
  const prev = (await chrome.storage.local.get(KEY))[KEY] || {};
  await chrome.storage.local.set({ [KEY]: { status: 'running', updatedAt: Date.now(), scanSeconds: pick ? prev.scanSeconds : undefined, step: pick ? 'Downloading…' : 'Opening the image library…', query, width, height, log: [], savedAs: '', saveError: '', candidates: pick ? prev.candidates : [], updatedAt: Date.now() } });
  // a stored download link (read from the sizes panel during the scan): fetch it at once, no window needed
  if (pick && pick.landingUrl) {
    try {
      const r = await fetchImage(pick.landingUrl);
      if (near(r.w, r.h, width, height)) {
        await setState({ status: 'done', step: '', dataUrl: r.dataUrl, width: r.w, height: r.h, mime: r.mime, imageTitle: pick.title, error: '', seconds: Math.round((Date.now() - T0) / 1000) });
        await saveLocal({ url: pick.landingUrl, dataUrl: r.dataUrl, mime: r.mime, filename, host });
        await closeHeld();
        return;
      }
      await addLog(`stored link came out ${r.w}x${r.h} - using the library window instead`);
    } catch (e) { await addLog('stored link failed (' + e.message + ') - using the library window instead'); }
    await setState({ status: 'running', step: 'Downloading…' });
  }
  let win = null, tabId = null, reuse = false, keepOpen = false;
  const downloads = [];
  const onCreated = item => downloads.push(item);
  try { chrome.downloads?.onCreated.addListener(onCreated); } catch { /* optional */ }
  try {
    if (pick) {                                   // the person clicked an image: use the library window that is already open
      const h = await getHeld();
      const t = h && await chrome.tabs.get(h.tabId).catch(() => null);
      if (t) { tabId = h.tabId; win = { id: h.winId }; reuse = true; }
    } else {
      await closeHeld();                          // a new search: drop the old window
    }
    if (!reuse) {
      win = await chrome.windows.create({ url: `${LIBRARY}/?text=${encodeURIComponent(query)}`, focused: true, type: 'normal', width: 1280, height: 900 });
      tabId = win.tabs[0].id;
      await waitTabComplete(tabId);
      await sleep(300);
    }

    let order;                                    // figures to try, best first
    if (pick) {
      order = [pick];
    } else {
      await setState({ step: 'Reading the images in the library…' });
      const [{ result: scan } = {}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: libraryScan, args: [width, BLOG] });
      if (!scan?.ok) throw new Error(scan?.error || 'Could not read the library page.');
      let ranked = rankFigures(scan.figures, query);
      await addLog(`${scan.figures.length} images on the page, ${ranked.length} possible for "${query}"`);
      // open each good match's sizes panel (list button): that shows ALL its sizes and the real download link
      let panelStats = { checked: 0, opened: 0, withLanding: 0, navigated: false };
      if (ranked.length) {
        await setState({ step: 'Checking the sizes of the best matches…' });
        const top = ranked.slice(0, 8);
        const [{ result: ver } = {}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: libraryVerify, args: [top.map(f => f.imgSrc), 40000, width, height, BLOG, mode === 'choose' ? 0 : 3] });
        const byImg = new Map((ver?.results || []).map(r => [r.imgSrc, r]));
        panelStats.navigated = !!ver?.navigated;
        for (const f of top) {
          const r = byImg.get(f.imgSrc);
          if (!r) continue;
          panelStats.checked++;
          if (r.rows) panelStats.opened++;
          if (r.url) { panelStats.withLanding++; f.landingUrl = r.url; f.sizeLabels = [r.label]; f.panelChecked = true; }
          else if (r.rows) { f.panelChecked = true; f.noLanding = true; await addLog(`"${f.title}": no ${width}x${height} size (${r.sizes.join(', ')})`); }
        }
        // keep: images with a confirmed link, or (panel did not open) images whose visible list already shows the landing size
        ranked = ranked.filter(f => f.landingUrl || (!f.noLanding && f.sizeLabels.length));
        ranked.sort((x, y) => (y.full - x.full) || ((y.landingUrl ? 1 : 0) - (x.landingUrl ? 1 : 0)) || (y.score - x.score));
      } else { ranked = []; }
      if (!ranked.length) { const d = scan.diag || {}; d.panel = panelStats; throw new Error(`No image for "${query}" has a ${BLOG ? width + 'x' + height : '1400-wide'} size. Scanned ${d.total ?? scan.figures.length} images; "+ more" lists: ${d.withMore ?? '?'} (could not open: ${d.notOpened ?? '?'}); 1400-wide sizes seen: ${(d.labels1400 || []).join(', ') || 'none'}. Sizes panel: checked ${panelStats.checked}, opened ${panelStats.opened}, with a 1400 landing size ${panelStats.withLanding}${panelStats.navigated ? ' (the page changed when the panel opened)' : ''}. Try other search text (for example the exact model name).`); }
      if (mode === 'choose') {
        await setState({ status: 'choose', step: '', error: '', scanSeconds: Math.round((Date.now() - T0) / 100) / 10, candidates: ranked.slice(0, 12).map(f => ({ title: f.title, imgSrc: f.imgSrc, score: Math.round(f.score), sizes: f.sizeLabels, landingUrl: f.landingUrl || '' })) });
        if (ranked.slice(0, 12).some(f => !f.landingUrl)) { await setHeld({ winId: win.id, tabId, query }); keepOpen = true; }   // window only needed when a link is not stored yet
        return;
      }
      const first = pickAmongBest(ranked);
      order = [first, ...ranked.filter(f => f !== first)].slice(0, 4);
      await addLog(`picked "${first.title}" (random among the best matches)`);
    }

    let lastWhy = '';
    for (const fig of order) {
      const res = await downloadFigure(tabId, fig, width, height, downloads);
      if (res.ok) {
        await setState({ status: 'done', step: '', dataUrl: res.dataUrl, width: res.w, height: res.h, mime: res.mime, imageTitle: fig.title, error: '', seconds: Math.round((Date.now() - T0) / 1000) });
        if (filename) await saveLocal({ url: res.url, dataUrl: res.dataUrl, mime: res.mime, filename, host });   // after a pick AND in auto mode
        return;
      }
      lastWhy = res.why;
      await addLog(`"${fig.title}": ${res.why}`);
    }
    throw new Error(lastWhy || `No ${width}x${height} image found.`);
  } catch (err) {
    if (pick && reuse) {
      // this image did not work: keep the list and the window so another image can be clicked right away
      keepOpen = true;
      try { await chrome.tabs.reload(tabId); await sleep(500); await waitTabComplete(tabId); } catch { /* window gone */ }
      await setState({ status: 'choose', step: '', error: err.message });
    } else {
      await setState({ status: 'error', step: '', error: err.message });
    }
  } finally {
    try { chrome.downloads?.onCreated.removeListener(onCreated); } catch { /* ignore */ }
    if (!keepOpen) {
      await chrome.storage.local.remove(HELD);
      if (win?.id) closeHelperWindow(win.id, tabId);
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'LIB_IMAGE_FETCH') {
    run({ query: message.query, width: message.width || 1400, height: message.height || 500, mode: message.mode === 'choose' ? 'choose' : 'auto', key: message.key, filename: message.filename || '', host: message.host || '', source: message.source || 'dealer' });
    sendResponse({ ok: true });
  } else if (message?.type === 'LIB_IMAGE_DOWNLOAD') {
    run({ query: message.query, width: message.width || 1400, height: message.height || 500, mode: 'auto', key: message.key, filename: message.filename, host: message.host || '', source: message.source || 'dealer', pick: { title: message.title, imgSrc: message.imgSrc, landingUrl: message.landingUrl || '', sizeLabels: [], needsExpand: true } });
    sendResponse({ ok: true });
  }
  return false;
});
