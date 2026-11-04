/* Landing form: Page type (15 types) -> suggested Parent page.
 *
 *  1. "Load parents" reads the dealer site's own pages (public WordPress REST: /wp-json/wp/v2/pages) so the Parent
 *     dropdown shows what really exists on THAT site (parent names differ per dealer: toyota-research,
 *     manufacturer-information, chevrolet-research ...). Nothing is hard-coded per dealer.
 *  2. The chosen Page type decides which page is pre-selected (ordered rules, first rule that matches wins; the make
 *     in the page title, e.g. "Chevrolet", is used for the "<make>-research" style parents).
 *  3. Everything stays editable: pick another page in the dropdown, "No parent", or "Other (type)".
 * The selected value is the parent page TITLE, which is exactly what the Page Attributes filler already matches on.
 */

(function () {   // own scope: the popup's other classic scripts share one global scope
/* ───────────────────────── suggestion engine (pure, testable) ───────────────────────── */

const PAGE_TYPES = [
  ['vehicle-research', 'Vehicle research article'],
  ['model-comparison', 'Model comparison article'],
  ['service-tips', 'Service tips article'],
  ['car-buying', 'Car-buying advice'],
  ['new-inventory', 'New vehicle inventory page'],
  ['used-inventory', 'Used vehicle inventory page'],
  ['parts-ordering', 'Parts ordering page'],
  ['special-offers', 'Special offers page'],
  ['service-dept', 'Service department page'],
  ['vdp', 'Vehicle detail page (VDP)'],
  ['dealership-info', 'Dealership information page'],
  ['finance-dept', 'Finance department page'],
  ['trade-in', 'Trade-in page'],
  ['warranty', 'Warranty and protection page'],
  ['ev-hybrid', 'EV and hybrid guide'],
];

// make -> words that can appear in a parent slug/title
const MAKES = [
  ['chevrolet', 'chevy'], ['ford'], ['toyota'], ['honda'], ['kia'], ['hyundai'], ['nissan'], ['subaru'], ['mazda'],
  ['bmw'], ['mercedes-benz', 'mercedes'], ['volkswagen', 'vw'], ['cadillac'], ['buick'], ['gmc'], ['jeep'], ['dodge'],
  ['ram'], ['chrysler'], ['lexus'], ['acura'], ['genesis'], ['mini'], ['mitsubishi'], ['volvo'], ['audi'], ['lincoln'],
  ['infiniti'], ['porsche'], ['land-rover', 'land rover'], ['jaguar'], ['tesla'], ['fiat'], ['alfa-romeo', 'alfa romeo'],
];

const norm = t => String(t || '').replace(/\u00a0/g, ' ').toLowerCase().replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const flat = t => norm(t).replace(/[^a-z0-9]+/g, ' ').trim();           // "land-rover" / "Land Rover" -> "land rover"

// makes that appear in the page title, in the order they appear
function makesInTitle(title) {
  const t = ' ' + flat(title) + ' ';
  const found = [];
  for (const aliases of MAKES) {
    let at = -1;
    for (const a of aliases) { const i = t.indexOf(' ' + flat(a) + ' '); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (at >= 0) found.push({ at, aliases });
  }
  return found.sort((a, b) => a.at - b.at).map(f => f.aliases);
}

const RESEARCH_WORDS = '(?:research|information|info)';
const makeRule = aliases => `\\b(?:${aliases.map(a => flat(a)).join('|')})\\b.*\\b${RESEARCH_WORDS}\\b`;
const isUsed = title => /\b(used|pre[\s-]?owned|cpo|certified)\b/i.test(title || '');

// ordered rules per type. A rule is a regex tested on the page's slug AND on its title (flattened to words),
// so "^new vehicles$" matches the page "New Vehicles" / slug "new-vehicles" but not "New Vehicle Specials".
function rulesFor(type, ctx) {
  const makeRules = ctx.makes.map(makeRule);
  const newInv = ['^new vehicles?$', '^new (?:cars|inventory|vehicle inventory)$', '^new\\b(?!.*(?:special|offer|coupon))'];
  const usedInv = ['^used vehicles?$', '^(?:used|pre owned) (?:cars|inventory|vehicle inventory)$', '^(?:used|pre owned)\\b(?!.*(?:special|offer|coupon))'];
  const R = {
    'vehicle-research': [...makeRules, `^manufacturer ${RESEARCH_WORDS}$`, `manufacturer ${RESEARCH_WORDS}`, '^vehicle research$', '^research$', '\\bresearch\\b'],
    'model-comparison': ['model comparisons?', '^comparisons?$', ...makeRules, `^manufacturer ${RESEARCH_WORDS}$`, '^research$', '\\bresearch\\b'],
    'service-tips': ['service (?:and|&)? ?parts tips', 'service tips', '\\btips\\b.*\\bservice\\b', '^service (?:and|&) parts$', '^service$'],
    'car-buying': ['car buying tips', 'car buying', 'buying (?:advice|tips|guide)', '^finance$', '\\bfinance\\b(?!.*(?:special|offer|coupon))'],
    'new-inventory': newInv,
    'used-inventory': usedInv,
    'parts-ordering': ['^parts$', '^order parts', 'parts (?:department|center|ordering)', '^parts\\b(?!.*(?:special|offer|coupon))'],
    'special-offers': isUsed(ctx.title)
      ? ['^used (?:vehicle )?specials?', '^specials?$']
      : /\b(service|oil|brake|tire|battery|coupon|maintenance)\b/i.test(ctx.title)
        ? ['^service (?:specials?|coupons?|offers?)', '^specials?$']
        : /\bparts?\b/i.test(ctx.title)
          ? ['^parts (?:specials?|coupons?|offers?)', '^specials?$']
          : ['^new (?:vehicle )?specials?', '^(?:vehicle )?specials?$', '^specials?$', '(?:offers|deals)'],
    'service-dept': ['^service department$', '^service (?:center|department|dept)', '^service$'],
    'vdp': isUsed(ctx.title) ? usedInv : newInv,
    'dealership-info': ['^about us$', 'about us', 'dealership information', '^about\\b'],
    'finance-dept': ['^finance department$', '^finance (?:center|department)', '^finance$', '^finance\\b(?!.*(?:special|offer|coupon|tips|buying))'],
    'trade-in': ['^value your trade', 'value your trade', 'trade in', '^finance$'],
    'warranty': ['vehicle protection', '(?:extended )?warrant', 'protection', '^finance$'],
    'ev-hybrid': ['^ev research', '\\bev\\b.*\\bresearch\\b', 'electric.*research', '^vehicle research$', ...makeRules, '^research$', '\\bresearch\\b'],
  };
  return R[type] || [];
}

// pages: [{ id, parent, slug, title }]  ->  { page, ruleIndex, ruleCount } | null
function suggestParent(type, title, pages) {
  const ctx = { title: title || '', makes: makesInTitle(title) };
  const rules = rulesFor(type, ctx).map(r => new RegExp(r, 'i'));
  if (!rules.length || !pages.length) return null;
  const depthOf = p => { let d = 0, cur = p; const seen = new Set(); while (cur && cur.parent && !seen.has(cur.id)) { seen.add(cur.id); cur = pages.find(x => x.id === cur.parent); d++; } return d; };
  const rows = pages.map(p => ({ p, slug: flat(p.slug), title: flat(p.title), depth: depthOf(p) }));
  // research-style types: a make-specific parent ("Chevrolet Research") is only a candidate when that make is in the title
  if (['vehicle-research', 'model-comparison', 'ev-hybrid'].includes(type)) {
    const mine = new Set(ctx.makes.flat().map(flat));
    const otherMake = r => MAKES.some(al => al.some(a => !mine.has(flat(a)) && new RegExp(`(?:^| )${flat(a)}(?: |$)`).test(r.slug + ' ' + r.title)));
    const kept = rows.filter(r => !otherMake(r));
    if (kept.length) { rows.length = 0; rows.push(...kept); }
  }
  for (let i = 0; i < rules.length; i++) {
    const hits = rows.filter(r => rules[i].test(r.title) || rules[i].test(r.slug));
    if (hits.length) {
      hits.sort((a, b) => a.depth - b.depth || a.slug.length - b.slug.length);   // top-level, shortest first
      return { page: hits[0].p, ruleIndex: i, ruleCount: rules.length };
    }
  }
  return null;
}

if (typeof module !== 'undefined') module.exports = { PAGE_TYPES, suggestParent, makesInTitle, rulesFor };

/* ───────────────────────── popup wiring ───────────────────────── */

if (typeof document !== 'undefined') (() => {
  const $ = id => document.getElementById(id);
  const typeEl = $('landing-page-type'), parentEl = $('landing-parent'), loadBtn = $('landing-parent-load'), noteEl = $('landing-parent-suggest');
  const adminEl = $('publishing-admin-url'), titleEl = $('comparison-page-title');
  if (!typeEl || !parentEl || !loadBtn || !noteEl || !adminEl || !titleEl) return;

  PAGE_TYPES.forEach(([value, label]) => typeEl.add(new Option(label, value)));

  let pages = [];             // loaded for the current site
  let loadedFor = '';         // origin+prefix the pages belong to
  let userPicked = false;     // the person changed the dropdown by hand -> stop auto-suggesting
  let lastSig = '';
  const say = (msg, bad) => { noteEl.textContent = msg; noteEl.style.color = bad ? '#b3261e' : ''; };
  const decode = h => new DOMParser().parseFromString(String(h || ''), 'text/html').documentElement.textContent || '';

  // candidate REST bases for this dealer site, from the saved WordPress admin URL
  function restBases(adminUrl) {
    const u = new URL(adminUrl);
    const i = u.pathname.search(/\/wp-admin/i);
    const prefix = (i >= 0 ? u.pathname.slice(0, i) : u.pathname).replace(/\/+$/, '');
    return [...new Set([`${u.origin}${prefix}`, `${u.origin}${prefix}/wp`, u.origin])];
  }

  async function fetchAllPages(adminUrl) {
    let lastErr = 'no answer';
    for (const base of restBases(adminUrl)) {
      for (const style of ['pretty', 'rest_route']) {
        const out = [];
        try {
          for (let page = 1; page <= 15; page++) {
            const q = `per_page=100&page=${page}&orderby=menu_order&order=asc&_fields=id,parent,slug,title,link`;
            const url = style === 'pretty' ? `${base}/wp-json/wp/v2/pages?${q}` : `${base}/?rest_route=/wp/v2/pages&${q}`;
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) { if (page > 1 && res.status === 400) break; throw new Error(`HTTP ${res.status}`); }
            const rows = await res.json();
            if (!Array.isArray(rows)) throw new Error('not a page list');
            rows.forEach(r => out.push({ id: r.id, parent: r.parent || 0, slug: r.slug || '', title: decode(r.title && r.title.rendered), link: r.link || '' }));
            const total = Number(res.headers.get('X-WP-TotalPages') || 1);
            if (page >= total) break;
          }
          if (out.length) return { base, pages: out };
        } catch (e) { lastErr = e.message; }
      }
    }
    throw new Error(lastErr);
  }

  // parents first, children indented under them
  function ordered(list) {
    const kids = new Map();
    list.forEach(p => { const k = list.some(x => x.id === p.parent) ? p.parent : 0; (kids.get(k) || kids.set(k, []).get(k)).push(p); });
    const out = [];
    const walk = (pid, depth) => (kids.get(pid) || []).forEach(p => { out.push({ p, depth }); walk(p.id, depth + 1); });
    walk(0, 0);
    return out;
  }

  function rebuildOptions() {
    const keep = parentEl.value;
    parentEl.innerHTML = '';
    parentEl.add(new Option('Auto (from the page title)', '__auto'));
    parentEl.add(new Option('No parent', ''));
    ordered(pages).forEach(({ p, depth }) => {
      const path = (() => { try { return new URL(p.link).pathname; } catch (e) { return '/' + p.slug + '/'; } })();
      parentEl.add(new Option(`${'— '.repeat(depth)}${p.title || '(no title)'}   ${path}`, p.title));
    });
    parentEl.add(new Option('Other (type below)…', '__other'));
    if ([...parentEl.options].some(o => o.value === keep)) parentEl.value = keep;
  }

  function applySuggestion(force) {
    const type = typeEl.value;
    if (!type) { say(''); return; }
    if (!pages.length) { say('Parents not loaded yet — click "Load parents".'); return; }
    if (userPicked && !force) return;
    const title = titleEl.value || '';
    const s = suggestParent(type, title, pages);
    const typeLabel = (PAGE_TYPES.find(t => t[0] === type) || [])[1] || type;
    if (s) {
      parentEl.value = s.page.title;
      parentEl.dispatchEvent(new Event('change'));
      say(`Suggested for "${typeLabel}": ${s.page.title}  (rule ${s.ruleIndex + 1} of ${s.ruleCount}) — change it in the dropdown if it is not right.`);
    } else {
      parentEl.value = '';
      parentEl.dispatchEvent(new Event('change'));
      say(`No matching parent found on this site for "${typeLabel}" — pick it manually (currently: No parent).`, true);
    }
  }

  async function load(manual) {
    const admin = adminEl.value.trim();
    if (!admin) { say('Fill the WordPress admin URL first.', true); return false; }
    let key;
    try { key = restBases(admin)[0]; } catch (e) { say('The WordPress admin URL is not a valid URL.', true); return false; }
    if (!manual && pages.length && loadedFor === key) return true;
    loadBtn.disabled = true; say('Reading pages from the site…');
    try {
      const { pages: rows } = await fetchAllPages(admin);
      pages = rows; loadedFor = key;
      rebuildOptions();
      say(`Loaded ${rows.length} pages from the site.`);
      return true;
    } catch (e) {
      say(`Could not read the site's pages (${e.message}). Pick the parent manually or use "Other".`, true);
      return false;
    } finally { loadBtn.disabled = false; }
  }

  loadBtn.addEventListener('click', async () => { if (await load(true)) applySuggestion(true); });
  typeEl.addEventListener('change', async () => {
    userPicked = false;
    if (!typeEl.value) { say(''); return; }
    if (await load(false)) applySuggestion(true);
  });
  parentEl.addEventListener('change', e => { if (e.isTrusted) userPicked = true; });   // only a real click counts
  titleEl.addEventListener('input', () => applySuggestion(false));
  // the popup restores the last saved parent value; if that page is not in the (not yet loaded) list the dropdown would go
  // blank and silently mean "No parent" — fall back to Auto instead
  const fixBlank = () => { if (parentEl.selectedIndex < 0) parentEl.value = '__auto'; };
  [300, 900, 2000].forEach(ms => setTimeout(fixBlank, ms));
  setInterval(() => {      // the title is also filled by code after a Google Doc import (the make may change the suggestion)
    fixBlank();
    const sig = titleEl.value;
    if (sig !== lastSig) { lastSig = sig; applySuggestion(false); }
  }, 1500);
})();
})();
