/**
 * Internal links — logic (no UI). Runs in the popup page, which may fetch the dealer's public site.
 *
 *   findCandidates(html)      red anchors (<mark data-il>) + fixed phrases present in the body
 *   resolveCandidate(c, ctx)  works out the page it should point to and VERIFIES it on the live site
 *   applyLinks(html, links)   puts the ticked links into the HTML and removes every red marker
 */
import { FIXED_PAGES, SITEMAP_PATHS, HTML_SITEMAP_PATHS, SKIP_SITEMAP_PATTERN, LIMITS, MAX_SUGGESTIONS, GENERIC_SLUGS, PRIORITY_YEAR, YEAR_BOOST, YEAR_PENALTY } from './il_config.js';

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'in', 'to', 'vs', 'with', 'on', 'your', 'our', 'my', 'us', 'at']);
export const normText = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
export const slugify = s => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const words = s => normText(s).replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w && !STOP.has(w));
const parse = html => new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html').querySelector('#r');
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BAD_PARENT = 'a, mark, h1, h2, h3, h4, h5, h6, script, style';

/* ---- how phrases are compared: "applying for financing" == "Apply for Financing", "parts" == "part", "service center" == "Service Centre" ----
   Every word is cut to a stem (apply/applying -> "appl", finance/financing -> "financ") and matched with the usual endings. */
const SEP = '[\\s\\u00a0\\-\\u2013\\u2014\\u00ae\\u2122&]{1,3}';
const SUF = '(?:y|ie[sd]|ying|ing|ed|es|e|s)?';
export function stem(w) {
  w = String(w).toLowerCase();
  if (w.length <= 3) return w;
  const cut = w.replace(/(ing|ied|ies|ed|es|s)$/, m => (m === 'ied' || m === 'ies') ? 'y' : '');
  if (cut.length >= 3) w = cut;                                   // "used" must not become "us"
  return w.length > 3 ? w.replace(/[ey]$/, '') : w;
}
export const tokensOf = s => { const t = String(s || '').toLowerCase().replace(/[\u2019']/g, '').split(/[^a-z0-9]+/).filter(Boolean); return t.length > 2 && /^(19|20)\d\d$/.test(t[0]) ? t.slice(1) : t; };   // a leading year (2026-...) is not part of how it is written in text
// The model year a page belongs to (from its URL or its names): 2026 -> boost, older -> small penalty, none -> 0
function yearAdj(page) {
  const text = typeof page === 'string' ? page : `${page.url} ${(page.titles || []).join(' ')}`;
  const years = [...new Set((text.match(/(?:^|[^0-9])(20\d{2})(?![0-9])/g) || []).map(m => m.replace(/\D/g, '')))];
  if (!years.length) return 0;
  if (years.includes(PRIORITY_YEAR)) return YEAR_BOOST;
  return years.some(y => y < PRIORITY_YEAR) ? YEAR_PENALTY : 0;
}
const stemSet = s => new Set(tokensOf(s).filter(t => !STOP.has(t)).map(stem));
function phraseRegex(tokens, flags = 'i') {
  const parts = tokens.map(t => { const st = stem(t); return escRe(st) + (st.length >= 3 ? SUF : ''); });
  return new RegExp(`(^|[^A-Za-z0-9])(${parts.join(SEP)})(?![A-Za-z0-9])`, flags);
}
// the text nodes of paragraphs / list items that are not headings, links or red markers
// A paragraph that IS button code (typed in the doc as text, e.g.  <a class="button primary-button" href="/x/">Schedule Service</a> ),
// or a button / call-to-action link: never offer links inside it, or the button's code would be damaged.
const CODE_BLOCK = /<\/?a[\s>]|href\s*=|class\s*=\s*["'][^"']*\bbutton\b|\[(?:button|di_button)|&lt;\/?a[\s&]/i;
const isButtonBlock = block => !!block && (CODE_BLOCK.test(block.textContent || '') || !!block.querySelector('a.button, a[class*="button"], a[class*="btn"], button'));
function textNodesOf(root) {
  const doc = root.ownerDocument, texts = [];
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement.closest(BAD_PARENT) || !n.parentElement.closest('p, li')) continue;
    if (isButtonBlock(n.parentElement.closest('p, li'))) continue;
    if (n.nodeValue.trim().length > 3) texts.push(n);
  }
  return texts;
}
function* occurrences(texts, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const node of texts) {
    g.lastIndex = 0;
    for (let m; (m = g.exec(node.nodeValue)); ) {
      const start = m.index + m[1].length;
      yield { node, start, end: start + m[2].length, text: m[2], block: node.parentElement.closest('p, li') };
      if (m[0].length === 0) g.lastIndex++;
    }
  }
}

/* ---------- 1. candidates ---------- */
// ~3 words before and after the place where the link would go, so the person can judge it in context.
function contextAround(block, phrase, fromMark) {
  const full = (block.textContent || '').replace(/\s+/g, ' ');
  let idx = -1;
  if (fromMark) idx = full.toLowerCase().indexOf(normText(phrase));
  else { const m = new RegExp(`(^|[^A-Za-z0-9])(${escRe(phrase)})(?![A-Za-z0-9])`, 'i').exec(full); if (m) idx = m.index + m[1].length; }
  if (idx < 0) return null;
  const wordsBefore = full.slice(0, idx).trim().split(' ').filter(Boolean);
  const wordsAfter = full.slice(idx + phrase.length).trim().split(' ').filter(Boolean);
  const before = wordsBefore.slice(-3).join(' ');
  const after = full.slice(idx + phrase.length).trim().split(' ').filter(Boolean).slice(0, 3).join(' ');
  return { before, match: full.slice(idx, idx + phrase.length), after, beforeAll: wordsBefore.slice(-8), afterAll: wordsAfter.slice(0, 8) };   // beforeAll / afterAll: the words the person can click to make the link longer
}

export function findCandidates(html) {
  const root = parse(html || '');
  const out = new Map();
  for (const m of root.querySelectorAll('mark[data-il]')) {
    const text = (m.textContent || '').replace(/\s+/g, ' ').trim();
    const key = normText(text);
    if (!key || m.closest('a, h1, h2, h3, h4, h5, h6') || isButtonBlock(m.closest('p, li'))) continue;
    if (!out.has(key)) out.set(key, { key, text, source: 'red', context: contextAround(m.closest('p, li, div') || m, text, true) });
  }
  // fixed pages: every phrase of every group (longest first), first place in the text that is free
  const texts = textNodesOf(root);
  const taken = [];
  const overlaps = o => taken.some(t => t.node === o.node && o.start < t.end && t.start < o.end);
  const phrases = [];
  for (const g of FIXED_PAGES) g.phrases.forEach((ph, i) => phrases.push({ ph, g, tokens: tokensOf(ph), pri: (g.phrases.length - i) * 0.01 }));   // pri: when two phrases of one page are both in the text, the one listed first wins
  phrases.sort((a, b) => b.tokens.length - a.tokens.length || b.ph.length - a.ph.length);
  for (const { g, tokens, pri } of phrases) {
    if (!tokens.length) continue;
    for (const occ of occurrences(texts, phraseRegex(tokens))) {
      if (overlaps(occ)) continue;
      const key = normText(occ.text);
      if (out.has(key)) break;
      taken.push(occ);
      out.set(key, { key, text: occ.text, source: 'fixed', path: g.path, hints: g.hints || [], score: (tokens.length > 1 ? 100 + 8 * tokens.length : 75) + pri,
                     why: `fixed page: ${g.phrases[0]}`, context: contextAround(occ.block, occ.text.replace(/\s+/g, ' '), false) });
      break;
    }
  }
  return [...out.values()];
}

/* ---------- 2. the live site ---------- */
async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), LIMITS.fetchTimeoutMs);
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ctl.signal });
    return { ok: res.ok, status: res.status, url: res.url, text: res.ok ? await res.text() : '' };
  } catch (e) {
    return { ok: false, status: 0, url, text: '', error: e.name === 'AbortError' ? 'timed out' : 'could not reach the site' };
  } finally { clearTimeout(t); }
}

const normHost = h => String(h || '').toLowerCase().replace(/^www\./, '');
const sameSite = (u, origin) => { try { return normHost(new URL(u).hostname) === normHost(new URL(origin).hostname); } catch { return false; } };
const FILE_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|xml|txt|css|js)(\?|$)/i;

/* Everything the site lists: the XML sitemap(s) AND the HTML sitemap page (/sitemap/), merged by page.
   Returns { entries: [{ url, titles: [...] }], urls: [...], info: { xml, html, tried } }.
   The HTML sitemap gives each page's real NAME (its link text), which matches the writing much better than the URL. */
const siteCache = new Map();
export async function getSiteIndex(origin, extraUrl = '') {
  const cacheKey = origin + '|' + extraUrl;
  if (siteCache.has(cacheKey)) return siteCache.get(cacheKey);
  const map = new Map();                 // "/path/" -> { url, titles:Set }
  const info = { xml: 0, html: 0, tried: [] };
  const add = (raw, title, base) => {
    let u; try { u = new URL(raw, base || origin); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || !sameSite(u.href, origin) || u.search || FILE_EXT.test(u.pathname)) return;
    const path = u.pathname.replace(/\/+$/, '') + '/';
    if (path === '/') return;
    if (map.size >= LIMITS.maxPages && !map.has(path)) return;
    const e = map.get(path) || { url: u.origin + path, titles: new Set() };
    const t = (title || '').replace(/\s+/g, ' ').trim();
    if (t && t.length <= 70) e.titles.add(t);
    map.set(path, e);
  };
  // XML sitemap (an index of sitemaps, or a plain list of pages)
  const locs = xml => [...xml.matchAll(/<(?:[\w.-]+:)?loc\b[^>]*>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/(?:[\w.-]+:)?loc\s*>/gi)].map(m => m[1].replace(/&amp;/g, '&'));
  const readXml = async url => {
    const res = await fetchText(url);
    if (!res.ok || !/<(?:[\w.-]+:)?loc\b/i.test(res.text)) {
      info.tried.push(url.replace(origin, '') + (!res.ok ? ' (' + (res.status || res.error) + ')' : ' (no sitemap loc entries)'));
      return false;
    }
    const before = map.size;
    const entries = locs(res.text);
    const children = entries.filter(u => /\.xml(\?|$)/i.test(u) && !SKIP_SITEMAP_PATTERN.test(u)).slice(0, LIMITS.sitemapFiles);
    if (children.length) {
      for (const child of children) {
        const r = await fetchText(child);
        const childLocs = r.ok ? locs(r.text) : [];
        const childBefore = map.size;
        childLocs.filter(u => !/\.xml(\?|$)/i.test(u)).forEach(u => add(u, '', origin));
        info.tried.push(child.replace(origin, '') + (!r.ok ? ' (' + (r.status || r.error) + ')' : ' (' + childLocs.length + ' locs, ' + (map.size - childBefore) + ' pages)'));
      }
    } else entries.filter(u => !/\.xml(\?|$)/i.test(u)).forEach(u => add(u, '', origin));
    info.tried.push(url.replace(origin, '') + ' (' + entries.length + ' locs, ' + (map.size - before) + ' pages)');
    return map.size > 0;
  };
  // HTML sitemap page: every same-site link, with its link text as the page name (+ its sub-sitemaps)
  const htmlSeen = new Set();
  const readHtml = async url => {
    const res = await fetchText(url);
    info.tried.push(url.replace(origin, '') + (res.ok ? '' : ` (${res.status || res.error})`));
    if (!res.ok || !/<a\b/i.test(res.text)) return [];
    htmlSeen.add(res.url);
    const doc = new DOMParser().parseFromString(res.text, 'text/html');
    const subs = [];
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
      const title = (a.textContent || '').trim() || a.getAttribute('title') || '';
      add(href, title, res.url);
      try { const u = new URL(href, res.url); if (sameSite(u.href, origin) && /sitemap/i.test(u.pathname) && !/\.xml$/i.test(u.pathname) && !htmlSeen.has(u.href)) subs.push(u.href); } catch {}
    }
    return subs;
  };
  const readHtmlTree = async url => {
    const subs = await readHtml(url);
    for (const sub of [...new Set(subs)].filter(u => new URL(u).pathname.replace(/\/+$/, '') !== new URL(url).pathname.replace(/\/+$/, '')).slice(0, LIMITS.htmlSubSitemaps)) await readHtml(sub);   // e.g. blog-posts-sitemap, models-sitemap
  };
  const readRobots = async url => {
    const res = await fetchText(url);
    info.tried.push(url.replace(origin, '') + (!res.ok ? ' (' + (res.status || res.error) + ')' : ' (robots.txt)'));
    if (!res.ok) return false;
    const sitemaps = [...res.text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map(match => match[1]);
    for (const sitemap of sitemaps) {
      if (await readXml(sitemap)) return true;
      await readHtmlTree(sitemap);
      if (map.size) return true;
    }
    return false;
  };
  if (extraUrl) {                                            // a sitemap address the person typed in: XML or HTML, we find out
    let u = extraUrl.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = (u.startsWith('/') ? origin : 'https://') + u;
    let isRobots = false;
    try { isRobots = /\/robots\.txt$/i.test(new URL(u).pathname); } catch {}
    if (isRobots) await readRobots(u);
    else if (!(await readXml(u))) await readHtmlTree(u);
    info.typed = map.size;
  }
  // Some dealer platforms publish the sitemap at a custom URL listed in robots.txt.
  // Read it first so we can discover and parse those XML sitemaps too.
  await readRobots(origin + '/robots.txt');
  for (const path of SITEMAP_PATHS) { if (await readXml(origin + path)) break; }
  info.xml = map.size;
  for (const path of HTML_SITEMAP_PATHS) { await readHtmlTree(origin + path); if (htmlSeen.size > (extraUrl ? 1 : 0)) break; }
  info.html = Math.max(0, map.size - info.xml);
  const entries = [...map.values()].map(e => ({ url: e.url, titles: [...e.titles] }));
  const out = { entries, urls: entries.map(e => e.url), info };
  if (entries.length) siteCache.set(cacheKey, out);      // an empty result is never cached: the next check tries again
  return out;
}
export const clearSiteCache = () => siteCache.clear();
export const getSiteUrls = async origin => (await getSiteIndex(origin)).urls;

// Does the live page at `url` exist, and does it talk about `anchorText`?
export async function checkPage(url, anchorText) {
  const res = await fetchText(url);
  if (!res.ok) return { exists: false, status: res.status, reason: res.status ? `page returned HTTP ${res.status}` : res.error };
  const title = (res.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1];
  const h1 = (res.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [, ''])[1].replace(/<[^>]+>/g, ' ');
  const pageWords = new Set(words(`${title} ${h1}`.replace(/&amp;/g, '&')));
  const need = words(anchorText);
  const matches = need.length > 0 && need.every(w => pageWords.has(w));
  return { exists: true, status: res.status, finalUrl: res.url, matches, title: title.replace(/\s+/g, ' ').trim().slice(0, 90) };
}

const relPath = (u, origin) => { try { const x = new URL(u, origin); return sameSite(x.href, origin) ? x.pathname + (x.pathname.endsWith('/') ? '' : '/') : x.href; } catch { return u; } };

/* ---------- 2b. find opportunities on the site's own pages ----------
   For every page in the sitemap, its URL name (e.g. /service-center/ -> "service center") is searched for in the
   body. A phrase that appears in a paragraph / list item (not in a heading or an existing link) is an opportunity.
   Score = how specific the phrase is (more words = better) + how important the page looks (short URL = better).
   The best ones are kept: at most one per paragraph first, one per page, never two overlapping phrases. */
export function siteOpportunities(html, pages, { origin, ownSlug = '', skip = [] }) {
  const root = parse(html || '');
  const texts = textNodesOf(root);
  if (!texts.length) return [];
  const blob = texts.map(n => n.nodeValue.toLowerCase()).join(' \n ');
  const skipKeys = skip.map(k => normText(k).replace(/[^a-z0-9]+/g, ' ').trim());
  const found = [];
  const usedPaths = new Set();
  const broadSingleWords = new Set(['about', 'access', 'blog', 'car', 'cars', 'contact', 'dealer', 'gmc', 'home', 'inventory', 'model', 'models', 'new', 'page', 'parts', 'service', 'special', 'specials', 'used', 'vehicle', 'vehicles']);
  for (const page of pages.slice(0, LIMITS.maxPages)) {
    const rawUrl = typeof page === 'string' ? page : page.url;
    let u; try { u = new URL(rawUrl); } catch { continue; }
    if (!sameSite(u.href, origin)) continue;
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length) continue;
    const last = (segs[segs.length - 1] || '').toLowerCase();
    const path = '/' + segs.join('/') + '/';
    if (usedPaths.has(path) || GENERIC_SLUGS.has(last) || last === ownSlug) continue;
    if (/\d{5,}|[a-hj-npr-z0-9]{17}/i.test(last) || /^(page|feed|wp-)/.test(last) || /-\d$/.test(last) || segs.length > 4) continue;
    usedPaths.add(path);

    // Match both complete page names and useful title/slug phrases. XML sitemaps often have no titles,
    // so two-word slug phrases (and distinctive long words) recover opportunities that exact full-slug
    // matching missed. Generic single words are excluded to avoid noisy links.
    const variants = new Map();
    const addVariant = (tokens, fromTitle, rawName = '') => {
      const useful = tokens.filter(t => !STOP.has(t));
      if (!useful.length || useful.length > 6) return;
      const add = list => {
        const key = list.join(' ');
        if (!key || GENERIC_SLUGS.has(key.replace(/ /g, '-'))) return;
        if (list.length === 1 && (list[0].length < 8 || broadSingleWords.has(list[0]))) return;
        const caps = list.length === 1 && /^[A-Z0-9]{3,5}$/.test(rawName.trim()) && !/^\d+$/.test(rawName.trim());
        if (!variants.has(key)) variants.set(key, { tokens: list, fromTitle, raw: caps ? rawName.trim() : '' });
      };
      add(useful);
      for (let i = 0; i + 1 < useful.length; i++) add(useful.slice(i, i + 2));
      for (const token of useful) add([token]);
    };
    for (const title of (typeof page === 'string' ? [] : page.titles || [])) {
      if (/^(view all|welcome to|home\b|sitemap)/i.test(title)) continue;
      addVariant(tokensOf(title), true, title);
    }
    addVariant(tokensOf(last.replace(/-/g, ' ')), false, last.replace(/-/g, ' '));

    let best = null;
    for (const [phrase, variant] of variants) {
      const { tokens, fromTitle, raw } = variant;
      if (skipKeys.some(k => k === phrase || k.includes(phrase))) continue;
      if (!tokens.every(t => blob.includes(stem(t)))) continue;
      const re = raw ? new RegExp('(^|[^A-Za-z0-9])(' + escRe(raw) + ')(?![A-Za-z0-9])') : phraseRegex(tokens);
      for (const n of texts) {
        const m = re.exec(n.nodeValue);
        if (!m) continue;
        const start = m.index + m[1].length;
        const block = n.parentElement.closest('p, li');
        const score = 50 + tokens.length * 10 + (segs.length <= 2 ? 10 : 0) + (tokens.length === 1 ? -10 : 0) + (fromTitle ? 5 : 0) + (tokens.length === 1 ? 0 : 4) + yearAdj(page);
        if (!best || score > best.score) best = { key: normText(m[2]), text: m[2], source: 'site', path, score, node: n, start, end: start + m[2].length, block,
          why: 'matches your page ' + path + (fromTitle ? ' (“' + ((page.titles || []).find(t => tokensOf(t).filter(x => !STOP.has(x)).join(' ') === phrase) || phrase) + '”)' : ''),
          context: contextAround(block, m[2].replace(/\s+/g, ' '), false) };
        break;
      }
    }
    if (best) found.push(best);
  }
  found.sort((a, b) => b.score - a.score);
  const picked = [], usedKeys = new Set(), pickedPaths = new Set();
  const overlaps = c => picked.some(p => p.node === c.node && c.start < p.end && p.start < c.end);
  const ok = c => !usedKeys.has(c.key) && !pickedPaths.has(c.path) && !overlaps(c);
  const take = c => { picked.push(c); usedKeys.add(c.key); pickedPaths.add(c.path); };
  const blocks = new Set();
  const POOL = 100;
  for (const c of found) if (picked.length < POOL && ok(c) && !blocks.has(c.block)) { take(c); blocks.add(c.block); }
  for (const c of found) if (picked.length < POOL && ok(c)) take(c);
  return picked.map(({ node, block, start, end, ...c }) => c);
}

/* Fixed pages have a default URL, but every site names its pages a little differently (/national-offers/ vs /new-vehicle-specials/).
   When the sitemap has a page called one of the group's hints ("new vehicle specials"), that page's real URL is used. */
export function resolveFixedPaths(cands, entries) {
  const norm = t => [...stemSet(t)].sort().join(' ');
  const idx = entries.map(e => {
    const segs = new URL(e.url).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    return { e, path: '/' + segs.join('/') + '/', depth: segs.length, ok: !/-\d$/.test(last), names: new Set([...e.titles.map(norm), norm(last.replace(/-/g, ' '))]) };
  });
  for (const c of cands) {
    if (c.source !== 'fixed' || !c.hints?.length) continue;
    for (const h of c.hints) {
      const hit = idx.filter(x => x.ok && x.names.has(norm(h))).sort((a, b) => yearAdj(b.e) - yearAdj(a.e) || a.depth - b.depth)[0];
      if (hit) { c.path = hit.path; c.fromSitemap = true; c.why = `fixed page → ${hit.path}`; break; }
    }
  }
  return cands;
}

/* ---------- 2c. suggest pages while a URL is being typed ----------
   "/fin", "apply", "finance apply" ... -> the pages of the site that match, best first: a path that starts with what was typed,
   then pages whose path / name has all the typed words (a word may be only the beginning of a word), current-year pages before older ones. */
export function suggestPages(entries, query, limit = 8, ownSlug = '') {
  const raw = String(query || '').trim().toLowerCase().replace(/^https?:\/\/[^/]+/, '');
  if (!raw) return [];
  const typedPath = raw.startsWith('/') ? raw : '';
  const words = tokensOf(raw).map(stem);
  const out = [];
  for (const e of entries) {
    let u; try { u = new URL(e.url); } catch { continue; }
    const path = u.pathname.toLowerCase();
    const segs = path.split('/').filter(Boolean);
    if (!segs.length || segs[segs.length - 1] === ownSlug || /-\d$/.test(segs[segs.length - 1])) continue;
    const hay = [...stemSet(path.replace(/[\/-]/g, ' ') + ' ' + (e.titles || []).join(' '))];
    const hit = w => hay.some(h => h.startsWith(w) || w.startsWith(h));
    let score = 0;
    if (typedPath.length > 1) {
      if (path.startsWith(typedPath)) score += 60; else if (path.includes(typedPath)) score += 30;
    }
    if (words.length) {
      if (!words.every(hit) && !score) continue;                     // every typed word must be in the page's path or name
      score += words.filter(hit).length * 15;
    } else if (!score && typedPath.length > 1) continue;
    if (typedPath === '/') score = 10;                                // just "/": the main pages
    score += yearAdj(e) - segs.length * 2;
    out.push({ path: '/' + segs.join('/') + '/', title: (e.titles || [])[0] || '', score });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}

/* ---------- 3. verify one candidate ---------- */
// returns { url (relative), status: 'verified' | 'check' | 'missing', reason }
// The sitemap page whose NAME (or URL name) uses the same words as `text`, ignoring endings and filler words.
function bestPageByName(entries, text, ownSlug) {
  const A = stemSet(text);
  if (!A.size) return null;
  let best = null;
  for (const e of entries) {
    const segs = new URL(e.url).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    if (!last || last === ownSlug || GENERIC_SLUGS.has(last) || /-\d$/.test(last)) continue;
    const names = [...e.titles.map(t => ({ t, fromTitle: true })), { t: last.replace(/-/g, ' '), fromTitle: false }];
    for (const { t, fromTitle } of names) {
      const N = stemSet(t);
      if (!N.size) continue;
      const inter = [...A].filter(x => N.has(x)).length;
      const score = inter / (A.size + N.size - inter);
      if (score < 0.6) continue;
      const rank = score * 100 + (fromTitle ? 2 : 0) - segs.length * 0.1 + yearAdj(e) / 2;     // equal names: the current-year page wins
      if (!best || rank > best.rank) best = { entry: e, title: fromTitle ? t : e.titles[0] || t, exact: score === 1, rank };
    }
  }
  return best;
}

export async function resolveCandidate(c, { origin, ownSlug, index: given }) {
  if (c.source === 'site' || (c.source === 'fixed' && c.fromSitemap)) {      // listed in the site's own sitemap = it exists
    return { url: relPath(c.path, origin), status: 'verified', reason: 'page is listed in the site\'s sitemap' };
  }
  if (c.source === 'fixed') {
    const url = relPath(c.path, origin);
    const page = await checkPage(origin + url, c.text);
    if (!page.exists) return { url, status: 'missing', reason: page.reason };
    const landed = relPath(page.finalUrl, origin);
    return landed === url ? { url, status: 'verified', reason: 'page exists' }
                          : { url: landed, status: 'check', reason: `redirects to ${landed}` };
  }
  // red anchor: find the page whose last URL part is the anchor's slug
  const slug = slugify(c.text);
  if (!slug) return { url: '', status: 'missing', reason: 'empty anchor' };
  if (slug === ownSlug) return { url: '', status: 'missing', reason: 'this is the page itself' };
  const index = given || await getSiteIndex(origin);      // the SAME index the panel read (incl. a sitemap address the person typed)
  const urls = index.urls;
  const near = bestPageByName(index.entries, c.text, ownSlug);        // "applying for financing" -> the page named "Apply for Financing"
  if (near) {                                                          // the page is in the sitemap: no live check needed
    return { url: relPath(near.entry.url, origin), status: near.exact ? 'verified' : 'check',
             reason: near.exact ? `page named “${near.title}” in the site's sitemap` : `closest page in the sitemap: “${near.title}” (not the exact words)` };
  }
  const last = u => { try { return new URL(u).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; } };
  let hit = urls.find(u => last(u) === slug);
  let exact = !!hit;
  if (!hit) hit = urls.filter(u => last(u).includes(slug) && last(u) !== ownSlug).sort((a, b) => last(a).length - last(b).length)[0];
  if (!hit && !urls.length) { hit = `${origin}/${slug}/`; exact = true; }       // no sitemap: try the obvious address
  if (!hit) return { url: '', status: 'missing', reason: urls.length ? 'no page on the site has this slug' : 'site sitemap not readable' };
  const page = await checkPage(hit, c.text);
  const url = relPath(hit, origin);
  if (!page.exists) return { url, status: 'missing', reason: page.reason };
  if (exact && page.matches) return { url, status: 'verified', reason: `slug and page title match ("${page.title}")` };
  return { url, status: 'check', reason: exact ? `slug found but the page title doesn't mention it ("${page.title}")` : `closest page: "${page.title}"` };
}

/* ---------- 4. write the links into the HTML ---------- */
// links: Map(key -> { url, source, text }) — only the ticked ones. Always removes every red marker.
// Can `text` become ONE link? It has to sit inside a single piece of paragraph / list text (not split by bold, a line break
// or another link, and not in a heading).
export function textLinkable(html, text) {
  const root = parse(html || '');
  root.querySelectorAll('mark[data-il]').forEach(m => m.replaceWith(...m.childNodes));
  root.normalize();
  const re = new RegExp(`(^|[^A-Za-z0-9])(${String(text).trim().split(/\s+/).map(escRe).join('[\\s\\u00a0]+')})(?![A-Za-z0-9])`, 'i');
  return textNodesOf(root).some(n => re.test(n.nodeValue));
}

export function applyLinks(html, links = new Map(), ownPath = '') {
  if (!html) return html;
  const root = parse(html);
  const doc = root.ownerDocument;
  const usedKeys = new Set();
  const usedUrls = new Set();
  const link = (key, url) => !!url && url !== ownPath && !usedKeys.has(key) && !usedUrls.has(url);

  for (const mark of [...root.querySelectorAll('mark[data-il]')]) {
    const key = normText(mark.textContent);
    const info = links.get(key);
    if (info && link(key, info.url) && !mark.closest('a, h1, h2, h3, h4, h5, h6') && !isButtonBlock(mark.closest('p, li'))) {
      const a = doc.createElement('a');
      a.setAttribute('href', info.url);
      a.innerHTML = mark.innerHTML;
      mark.replaceWith(a);
      usedKeys.add(key); usedUrls.add(info.url);
    } else {
      mark.replaceWith(...mark.childNodes);
    }
  }
  root.normalize();                                            // glue the pieces of text back together (a longer anchor may run across a former red marker)
  // fixed phrases: first occurrence in paragraph / list text
  // longer phrases first, so "apply for financing" is linked as a whole before "financing" is looked at
  for (const [key, info] of [...links].sort((a, b) => (b[1].text || '').length - (a[1].text || '').length)) {
    if (info.source === 'red' || !link(key, info.url)) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9])(${String(info.text).trim().split(/\s+/).map(escRe).join('[\\s\\u00a0]+')})(?![A-Za-z0-9])`, 'i');
    const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement.closest(BAD_PARENT)) continue;
      if (isButtonBlock(n.parentElement.closest('p, li'))) continue;          // never inside a button / its code
      const m = re.exec(n.nodeValue);
      if (!m) continue;
      const start = m.index + m[1].length;
      const after = n.splitText(start);
      after.splitText(m[2].length);
      const a = doc.createElement('a');
      a.setAttribute('href', info.url);
      a.textContent = after.nodeValue;
      after.replaceWith(a);
      usedKeys.add(key); usedUrls.add(info.url);
      break;
    }
  }
  return root.innerHTML;
}
