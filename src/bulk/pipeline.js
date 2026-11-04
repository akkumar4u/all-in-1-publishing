/* One ticket, start to finish, WITHOUT touching WordPress:
 *   Salesforce ticket (subject, account, website, doc)  ->  Google Doc (title, slug, meta, content)
 *   ->  the page exactly as the side panel would build it  ->  checks  ->  one sheet row + the full page.
 * It reuses the extension's own pieces (SF_START / IMPORT_COMPARISON_DOC / the page generators / link rules),
 * so a ticket fetched here is the same page you would get from the side panel. */
import { classifyTask, TASK_TYPES } from '../salesforce/sf_classify.js';
import { checkPage } from '../links/il_core.js';

const send = msg => new Promise(resolve => chrome.runtime.sendMessage(msg, r => resolve(r || { ok: false, error: chrome.runtime.lastError?.message || 'The extension did not answer.' })));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const secs = ms => Math.round(ms / 100) / 10;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------------- Salesforce ---------------- */
async function lookup(ticket, onStep, shouldStop) {
  const expected = String(ticket || '').trim().toUpperCase();
  const waitUntil = Date.now() + 240000;
  while (true) {
    const current = (await send({ type: 'SF_GET_STATE' })).state;
    if (!current || current.status !== 'running') break;
    if (Date.now() >= waitUntil) throw new Error('Another Salesforce lookup is still running. This ticket was not started, to avoid mixing ticket data.');
    if (shouldStop()) throw new Error('Stopped while waiting for the previous Salesforce lookup.');
    onStep('Waiting for the previous Salesforce lookup to finish…');
    await sleep(2000);
  }
  await send({ type: 'SF_RESET' });
  const st = await send({ type: 'SF_START', ticket, bulkBatch: true });
  if (!st.ok) throw new Error(st.error || 'Could not start the Salesforce lookup.');
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    await sleep(1200);
    if (shouldStop()) throw new Error('Stopped.');
    const current = (await send({ type: 'SF_GET_STATE' })).state;
    if (!current) continue;
    if (current.ticket && String(current.ticket).trim().toUpperCase() !== expected) {
      throw new Error('Salesforce returned data for ' + current.ticket + ' while fetching ' + expected + '. This result was rejected to protect ticket data.');
    }
    if (current.step) onStep('Salesforce: ' + current.step);
    if (current.status === 'error') throw new Error((current.error || 'The Salesforce lookup failed.') + (current.needsLogin ? ' — log in to Salesforce in this Chrome, then fetch again.' : ''));
    if (current.status === 'done') return current;
  }
  throw new Error('Salesforce did not finish within 4 minutes.');
}

/* ---------------- content helpers ---------------- */
const rootOf = html => new DOMParser().parseFromString(`<div id="r">${html || ''}</div>`, 'text/html').querySelector('#r');

/* VRP copy: no buttons, no empty blocks, every H1 becomes an H2, and the page title is the first H2
   (the Google Doc importer keeps the H1 out of the body, so it is put back as the opening H2). Same as the side panel. */
function vrpContent(bodyHtml, title) {
  const root = rootOf(bodyHtml);
  root.querySelectorAll('a.button, a.primary-button, a[class*="button"]').forEach(a => a.remove());
  [...root.querySelectorAll('div, p')].reverse().forEach(n => { if (!n.textContent.trim() && !n.children.length) n.remove(); });
  root.querySelectorAll('h1').forEach(h1 => {
    const h2 = document.createElement('h2');
    for (const a of h1.attributes) h2.setAttribute(a.name, a.value);
    h2.innerHTML = h1.innerHTML;
    h1.replaceWith(h2);
  });
  if (title) {
    const first = [...root.children].find(n => n.textContent.trim());
    const norm = t => t.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!(first && first.tagName === 'H2' && norm(first.textContent) === norm(title))) {
      const h2 = document.createElement('h2');
      h2.textContent = title;
      root.prepend(h2);
    }
  }
  return root.innerHTML;
}

export function prepareImportedDoc(doc, { isVrp = false, adminUrl = '' } = {}) {
  const title = (doc.title || '').trim();
  const content0 = isVrp ? vrpContent(doc.bodyHtml || '', title) : (doc.bodyHtml || '');
  const content = withLinkRules(content0, adminUrl);
  return { title, slug: (doc.pageSlug || '').trim(), metaTitle: (doc.metaTitle || '').trim(), metaDescription: (doc.metaDescription || '').trim(), buttonsHtml: doc.buttons || '', content, stats: analyse(content, adminUrl) };
}

const withLinkRules = (html, adminUrl) => {
  let host = '';
  try { host = new URL((adminUrl || '').trim()).hostname; } catch { /* no admin url */ }
  return window.diLinkRules ? window.diLinkRules.fixHtml(html, host) : html;
};

function decodeButtonMarkup(markup) {
  let decoded = String(markup || '');
  for (let i = 0; i < 3; i++) {
    const box = document.createElement('textarea');
    box.innerHTML = decoded;
    if (box.value === decoded) break;
    decoded = box.value;
  }
  return decoded.replace(/^\s*(?:buttons?|cta\s*buttons?|button\s*code|cta\s*button\s*code)\s*:\s*/i, '').trim();
}

export function normalizeButtonMarkup(markup) { return decodeButtonMarkup(markup); }

export async function fetchBlogCategories(adminUrl) {
  try {
    const admin = new URL(adminUrl);
    const basePath = admin.pathname.replace(/\/?wp-admin(?:\/.*)?$/i, '').replace(/\/$/, '');
    const roots = [...new Set([`${admin.origin}${basePath}/wp-json/`, `${admin.origin}/wp-json/`, `${admin.origin}${basePath}/?rest_route=/`, `${admin.origin}/?rest_route=/`])];
    for (const root of roots) {
      const categories = [];
      try {
        for (let page = 1; page <= 5; page++) {
          const query = 'per_page=100&page=' + page + '&_fields=id,name,slug,parent,count';
          const url = root.includes('rest_route=') ? root + 'wp/v2/categories&' + query : root + 'wp/v2/categories?' + query;
          const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const list = await res.json();
          if (!Array.isArray(list)) throw new Error('Unexpected category response');
          categories.push(...list);
          if (list.length < 100) break;
        }
        if (categories.length) return categories.map(c => ({ id: Number(c.id), name: String(c.name || ''), slug: String(c.slug || ''), parent: Number(c.parent || 0) }));
      } catch { /* try the next WordPress REST root */ }
    }
  } catch { /* malformed or missing site URL */ }
  return [];
}

export async function resolveWebsiteRedirect(website) {
  let start;
  try {
    const raw = String(website || '').trim();
    start = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (!/^https?:$/.test(start.protocol)) return '';
  } catch { return ''; }
  const comparable = value => { try { const u = new URL(value); return u.origin.toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search; } catch { return ''; } };
  const probe = async method => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(start.href, { method, redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: controller.signal, ...(method === 'GET' ? { headers: { Range: 'bytes=0-0' } } : {}) });
      const finalUrl = response.url || start.href;
      if (method === 'GET') response.body?.cancel().catch(() => {});
      if (response.redirected || comparable(finalUrl) !== comparable(start.href)) return finalUrl;
      if (method === 'HEAD' && [403, 405, 501].includes(response.status)) return null;
      return '';
    } catch { return null; }
    finally { clearTimeout(timer); }
  };
  const head = await probe('HEAD');
  return head === null ? (await probe('GET') || '') : head;
}

export async function fetchWebsitePages(adminUrl) {
  try {
    const admin = new URL(adminUrl);
    const basePath = admin.pathname.replace(/\/?wp-admin(?:\/.*)?$/i, '').replace(/\/$/, '');
    const cacheKey = 'bulkWpPages:v2:' + admin.origin + basePath;
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (cached?.at && Date.now() - cached.at < 6 * 60 * 60 * 1000 && Array.isArray(cached.pages)) return cached.pages;
    const roots = [...new Set([`${admin.origin}${basePath}/wp-json/`, `${admin.origin}/wp-json/`, `${admin.origin}${basePath}/?rest_route=/`, `${admin.origin}/?rest_route=/`])];
    for (const root of roots) {
      const pages = [];
      try {
        for (let page = 1; page <= 20; page++) {
          const query = 'per_page=100&page=' + page + '&_fields=id,title,slug,parent,link';
          const url = root.includes('rest_route=') ? root + 'wp/v2/pages&' + query : root + 'wp/v2/pages?' + query;
          const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const list = await res.json();
          if (!Array.isArray(list)) throw new Error('Unexpected page response');
          pages.push(...list.map(p => ({ id: Number(p.id), title: String(p.title?.rendered || p.title || '').replace(/<[^>]*>/g, '').trim(), slug: String(p.slug || ''), parent: Number(p.parent || 0), link: String(p.link || '') })).filter(p => p.id && p.title));
          if (list.length < 100) break;
        }
        if (pages.length) { await chrome.storage.local.set({ [cacheKey]: { at: Date.now(), pages } }); return pages; }
      } catch { /* try another REST root */ }
    }
  } catch { /* missing or malformed WordPress URL */ }
  return [];
}

export function chooseParentPage(pages, taskKey, subject, title) {
  if (!pages.length) return '';
  const norm = value => String(value || '').normalize('NFKD').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  const condition = /\bused\b|pre[ -]?owned/i.test(`${subject} ${title}`) ? 'used' : /\bnew\b/i.test(`${subject} ${title}`) ? 'new' : '';
  const preferred = taskKey === 'enhancement:vrp'
    ? condition === 'used' ? ['Used Vehicles', 'Pre-Owned Vehicles', 'Used Inventory', 'Pre-Owned Inventory'] : condition === 'new' ? ['New Vehicles', 'New Inventory'] : []
    : taskKey === 'hub:research' ? ['Make Research', 'Research']
    : taskKey === 'hub:service' ? ['Service & Parts Information', 'Service and Parts Information', 'Service & Parts', 'Service and Parts']
    : taskKey === 'hub:finance' ? ['Finance & Insurance Information', 'Finance and Insurance Information', 'Finance & Insurance', 'Finance and Insurance']
    : [];
  for (const wanted of preferred) {
    const match = pages.find(page => norm(page.title) === norm(wanted));
    if (match) return match.title;
  }
  return '';
}

export function suggestedBlogCategory(categories, blog) {
  const list = categories.filter(c => c.id && c.name && !/^uncategorized$/i.test(c.name));
  const target = String(blog.category || '').trim().toLowerCase();
  const exact = target && list.find(c => c.name.trim().toLowerCase() === target);
  if (exact) return exact;
  const feature = list.filter(c => /\bfeatures?\b/i.test(c.name));
  const make = String(blog.title || '').match(/\b(?:Acura|Audi|BMW|Buick|Cadillac|Chevrolet|Chrysler|Dodge|Ford|GMC|Honda|Hyundai|Jeep|Kia|Lexus|Mazda|Mercedes(?:-Benz)?|Mitsubishi|Nissan|Ram|Subaru|Toyota|Volkswagen|Volvo)\b/i)?.[0];
  const preferred = make && feature.find(c => c.name.toLowerCase().includes(make.toLowerCase()));
  return preferred || feature.find(c => /^features?$/i.test(c.name.trim())) || feature.find(c => /model features/i.test(c.name)) || feature[0] || null;
}


export function composeBlogContent(bodyHtml = '', buttonsHtml = '', imageShortcode = '') {
  const root = rootOf(bodyHtml);
  root.querySelectorAll('a.button, a.primary-button, a[class*=button]').forEach(a => a.remove());
  root.querySelectorAll('div.text-center, div.center').forEach(w => { if (!w.textContent.trim() && !w.querySelector('img')) w.remove(); });
  root.querySelectorAll('div.well').forEach(w => { if (/\[di_posts\b/i.test(w.textContent)) w.remove(); });
  let article = root.innerHTML.trim();
  const shortcode = String(imageShortcode || '').trim();
  if (shortcode && article.startsWith(shortcode)) article = article.slice(shortcode.length).trim();
  const buttons = normalizeButtonMarkup(buttonsHtml).replace(/<\/a>\s*<a\b/gi, '</a> <a').trim();
  if (buttons) {
    const firstParagraphEnd = article.indexOf('</p>');
    article = firstParagraphEnd === -1
      ? `${buttons}\n\n${article}`.trim()
      : `${article.slice(0, firstParagraphEnd + 4)}\n\n${buttons}\n\n${article.slice(firstParagraphEnd + 4)}`.trim();
  }
  const feed = '<div class="well"><div class="center"><h2>More from %%di_name%%</h2></div>[di_posts posts_per_page="3" excerpt="true" date="false" thumbs="false"]</div>';
  return [shortcode, article, feed].filter(Boolean).join('\n\n');
}

export async function verifyButtonUrls(buttonsHtml, websiteUrl) {
  const decoded = decodeButtonMarkup(buttonsHtml);
  const doc = new DOMParser().parseFromString(decoded, 'text/html');
  let anchors = [...doc.querySelectorAll('a.button, a.primary-button, a[class*="button"]')];
  if (!anchors.length) anchors = [...doc.querySelectorAll('a')];
  if (!anchors.length) {
    return String(buttonsHtml || '').trim()
      ? [{ name: 'Button Code', ok: false, level: 'error', detail: 'No <a href="…"> button link was found in this code.' }]
      : [];
  }
  let origin = '';
  try { origin = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(websiteUrl || '') ? websiteUrl : 'https://' + (websiteUrl || '')).origin; } catch {}
  return Promise.all([...new Set(anchors.map(a => (a.getAttribute('href') || '').trim()))].map(async (href, index) => {
    const anchor = anchors.find(a => (a.getAttribute('href') || '').trim() === href);
    const label = (anchor?.textContent || '').trim() || href || 'link ' + (index + 1);
    const name = 'Button URL — ' + label;
    if (!href) return { name, ok: false, level: 'error', detail: 'No href was set.' };
    if (/^(mailto:|tel:|#|javascript:)/i.test(href)) return null;
    if (!origin) return { name, ok: false, level: 'warn', detail: 'Could not check: dealer website URL is missing.' };
    let target;
    try { target = new URL(href, origin).href; }
    catch { return { name, ok: false, level: 'error', detail: 'Invalid URL: ' + href }; }
    const result = await checkPage(target, label);
    const redirected = !!result.finalUrl && result.finalUrl.replace(/\/$/, '') !== target.replace(/\/$/, '');
    if (redirected) {
      return { name, ok: false, level: 'error', detail: 'Redirected · HTTP ' + (result.status || 'unknown') + ' · ' + target + ' → ' + result.finalUrl };
    }
    if (result.exists) {
      return { name, ok: true, level: 'ok', detail: 'HTTP ' + result.status + ' · working · ' + target };
    }
    const status = Number(result.status || 0);
    return { name, ok: false, level: status >= 400 ? 'error' : 'warn', detail: (status ? 'HTTP ' + status : 'Could not verify') + ' · ' + (result.reason || 'request failed') + ' · ' + target };
  })).then(rows => rows.filter(Boolean));
}
export function analyse(html, adminUrl) {
  const root = rootOf(html);
  let own = '';
  try { own = new URL(adminUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* none */ }
  const text = root.textContent.replace(/\s+/g, ' ').trim();
  let internal = 0, external = 0, noFollowMissing = 0;
  root.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (/^(mailto:|tel:|#)/i.test(href)) return;
    if (/^(https?:)?\/\//i.test(href)) {
      let h = '';
      try { h = new URL(href, 'https://x.invalid').hostname.replace(/^www\./, '').toLowerCase(); } catch { /* bad link */ }
      if (own && (h === own || h.endsWith('.' + own))) internal++;
      else { external++; if (!/nofollow/i.test(a.getAttribute('rel') || '')) noFollowMissing++; }
    } else internal++;
  });
  const first = [...root.children].find(n => n.textContent.trim());
  return {
    words: text ? text.split(' ').length : 0, chars: text.length,
    h1: root.querySelectorAll('h1').length, h2: root.querySelectorAll('h2').length,
    internal, external, noFollowMissing, startsWithH2: first?.tagName === 'H2',
  };
}

/* ---------------- one ticket ---------------- */
export async function runTicket(ticket, { onStep = () => {}, shouldStop = () => false, docUrlOverride = '', taskKeyOverride = '' } = {}) {
  const t0 = Date.now();
  const row = { Ticket: ticket, Status: 'Fetching', 'Fetched At': new Date().toISOString(), 'Task Type':'', Subject:'', Account:'', Website:'', 'WP Admin URL':'', 'Salesforce URL':'', 'Group 1':'', 'Doc URL':'', 'Page Title':'', Slug:'', 'Meta Title':'', 'Meta Title Chars':'', 'Meta Description':'', 'Meta Desc Chars':'', Template:'', 'Parent Page':'', 'Content Words':0, 'Content Chars':0, 'H2 Count':0, 'Internal Links':0, 'External Links':0, Checks:'', Notes:'', 'Published URL':'' };
  const checks = [];
  const add = (name, ok, level, detail) => checks.push({ name, ok: !!ok, level: ok ? 'ok' : level, detail: detail || '' });
  const warnings = [];
  const pkg = { hub: null, imported: null, checks, steps: [] };

  /* 1. Salesforce */
  const tSf = Date.now();
  let sf;
  try { sf = await lookup(ticket, onStep, shouldStop); }
  catch (e) {
    row.Status = 'Failed'; row.Notes = e.message; row['Total Secs'] = secs(Date.now() - t0);
    return { row, pkg, error: e.message };
  }
  row['Salesforce Secs'] = secs(Date.now() - tSf);
  const subject = sf.subject || '';
  const task = classifyTask({ subject, group1: !!sf.group1?.is });
  const key = taskKeyOverride || sf.task?.key || task.key;
  const taskType = TASK_TYPES[key] || task;
  const isHubTemplate = ['hub:service', 'hub:research', 'hub:finance'].includes(key);
  const docUrl = String(docUrlOverride || (sf.docUrls && sf.docUrls[0]) || sf.docs?.[0]?.url || '').trim();
  const admin = sf.adminUrl || '';
  Object.assign(row, {
    'Task Type': taskType.label || sf.task?.label || task.label || '', Subject: subject, Account: sf.accountName || '', Website: sf.website || '',
    'WP Admin URL': admin, 'Salesforce URL': sf.ticketUrl || '', 'Group 1': sf.group1?.is ? 'Yes' : 'No', 'Doc URL': docUrl,
  });
  (sf.warnings || []).forEach(w => warnings.push(w));
  if ((sf.docUrls || []).length > 1) warnings.push(`${sf.docUrls.length} Google Docs are linked — the first one was used.`);

  add('Ticket read from Salesforce', true, 'error');
  add('Task type recognised', !!key && taskType.category !== 'unknown', 'warn', taskType.label || task.label);
  add('Google Doc linked', isHubTemplate || !!docUrl, 'error', docUrl || (isHubTemplate ? 'Hub template generated without a Google Doc.' : 'No Google Doc link on the ticket.'));
  add('Website / WordPress admin found', !!admin, 'error', admin || 'The Account has no website, so the admin URL is unknown.');

  const [sitePages, websiteRedirect] = await Promise.all([admin ? fetchWebsitePages(admin) : [], sf.website ? resolveWebsiteRedirect(sf.website) : '']);
  pkg.websiteRedirect = websiteRedirect || '';
  const siteParent = chooseParentPage(sitePages, key, subject, '');
  row['Parent Page'] = siteParent;

  /* 2. Google Doc import for the supported bulk publishing types. */
  const docTypes = ['enhancement:vrp', 'publishing:landing', 'publishing:comparison', 'publishing:blog', 'hub:service', 'hub:research', 'hub:finance'];
  let doc = null;
  if (isHubTemplate) {
    const hubType = taskType.hubType;
    const cleanSubject = subject.replace(/\b(hub|page|publishing|enhancement|service and parts information|service and parts|make research|research|finance and insurance information|finance and insurance)\b/gi, ' ').replace(/[-–—:|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const brandName = hubType === 'research' ? (cleanSubject || String(sf.accountName || '').replace(/\b(dealer(ship)?|motors?|automotive|auto)\b/gi, '').trim()) : '';
    try {
      const hub = generateHub(hubType, { brandName });
      hub.adminUrl = admin;
      hub.bulkHubTemplate = true;
      const parent = siteParent || hub.parentSlug || '';
      hub.parentSlug = parent || null;
      pkg.hub = hub; pkg.canDraft = true;
      const body = (hub.sections || []).map(section => section.html || '').join('\n');
      const stats = analyse(body, admin);
      checks.push(...await verifyButtonUrls(body, admin || sf.website || ''));
      Object.assign(row, { 'Page Title': hub.title || '', Slug: hub.slug || '', 'Meta Title': hub.metaTitle || '', 'Meta Title Chars': (hub.metaTitle || '').length, 'Meta Description': hub.metaDescription || '', 'Meta Desc Chars': (hub.metaDescription || '').length, Template: hub.templateName || 'DI Page Composer', 'Parent Page': parent, 'Content Words': stats.words, 'Content Chars': stats.chars, 'H2 Count': stats.h2, 'Internal Links': stats.internal, 'External Links': stats.external });
      add('Hub page template built', !!hub.title && !!hub.sections?.length, 'error', taskType.label);
    } catch (error) { add('Hub page template built', false, 'error', error.message); warnings.push('Could not build this Hub page: ' + error.message); }
  } else if (docUrl && docTypes.includes(key)) {
    onStep('Reading the Google Doc…');
    const tDoc = Date.now();
    const isBlog = key === 'publishing:blog';
    const r = isBlog
      ? await send({ type: 'IMPORT_GOOGLE_DOC', documentUrl: docUrl, adminUrl: admin, landingBottom: 'blog', returnOnly: true })
      : await send({ type: 'IMPORT_COMPARISON_DOC', documentUrl: docUrl });
    row['Doc Secs'] = secs(Date.now() - tDoc);
    if (!r.ok) { add('Google Doc imported', false, 'error', r.error || 'Could not import the document.'); warnings.push(r.error || 'Doc import failed.'); }
    else if (isBlog) {
      const blog = r.draft || {};
      blog.categoryOptions = await fetchBlogCategories(admin);
      const suggestedCategory = suggestedBlogCategory(blog.categoryOptions, blog);
      blog.categoryIds = suggestedCategory ? [suggestedCategory.id] : [];
      blog.categoryName = suggestedCategory?.name || '';
      doc = { ...blog, pageSlug: blog.slug || '', bodyHtml: composeBlogContent(blog.bodyHtml || '', blog.buttons || '', blog.imageShortcode || ''), buttons: blog.buttons || '' };
      doc.blogDraft = blog;
    } else doc = r;
  } else if (docUrl) {
    warnings.push(`${row['Task Type'] || 'This type'} is not fetched in bulk yet (Blog / Hub / other types: use the side panel). Ticket details were saved.`);
  }

  if (doc) {
    const isVrp = key === 'enhancement:vrp';
    const isBlog = key === 'publishing:blog';
    const title = (doc.title || '').trim();
    const content0 = isVrp ? vrpContent(doc.bodyHtml || '', title) : (doc.bodyHtml || '');
    const content = withLinkRules(content0, admin);
    const a = analyse(content, admin);
    const metaTitle = (doc.metaTitle || '').trim();
    const metaDesc = (doc.metaDescription || '').trim();
    const slug = (doc.pageSlug || '').trim();
    const condition = /\bused\b|pre[ -]?owned/i.test(`${subject} ${title}`) ? 'used' : /\bnew\b/i.test(`${subject} ${title}`) ? 'new' : '';
    const parent = isVrp ? (siteParent || (condition === 'used' ? 'Used Vehicles' : condition === 'new' ? 'New Vehicles' : '')) : siteParent;
    const isLanding = key === 'publishing:landing';
    const isComparison = key === 'publishing:comparison';
    const bottom = sf.group1?.is ? 'form' : 'blog';

    if (doc.buttons) { onStep('Checking Button Code URLs…'); checks.push(...await verifyButtonUrls(doc.buttons, admin || sf.website || '')); }
    add('Page title (H1 in the doc)', !!title, 'error', title);
    add('Page slug in the doc', !!slug, 'warn', slug || 'None — the slug would be made from the title.');
    add('Meta title present', !!metaTitle, 'error');
    add('Meta title length (≤ 60)', !metaTitle || metaTitle.length <= 60, 'warn', `${metaTitle.length} characters`);
    add('Meta description present', !!metaDesc, 'error');
    add('Meta description length (≤ 160)', !metaDesc || metaDesc.length <= 160, 'warn', `${metaDesc.length} characters`);
    add('Content found', a.words > 0, 'error', `${a.words} words`);
    if (isVrp) {
      add('Content starts with an H2', a.startsWithH2, 'warn');
      add('No H1 left in the content', a.h1 === 0, 'error');
      add('New or used clear from the subject', !!parent, 'error', parent ? `${parent} parent page` : 'The subject says neither new nor used — choose the parent by hand.');
    }
    add('External links have nofollow', a.noFollowMissing === 0, 'warn', a.noFollowMissing ? `${a.noFollowMissing} without` : `${a.external} external`);
    if (Array.isArray(doc.skipped) && doc.skipped.length) {
      add('Nothing skipped from the doc', false, 'warn', doc.skipped.map(s => `“${s.text}” (${s.why})`).join(' · '));
    }

    Object.assign(row, {
      'Page Title': title, Slug: slug, 'Meta Title': metaTitle, 'Meta Title Chars': metaTitle.length,
      'Meta Description': metaDesc, 'Meta Desc Chars': metaDesc.length,
      Template: isVrp ? 'Lightning' : (isLanding || isComparison ? 'DI Page Composer' : isBlog ? 'Blog' : ''), 'Parent Page': parent,
      'Content Words': a.words, 'Content Chars': a.chars, 'H2 Count': a.h2, 'Internal Links': a.internal, 'External Links': a.external,
    });
    pkg.imported = { title, slug, metaTitle, metaDescription: metaDesc, buttonsHtml: doc.buttons || '', contentHtml: content, disclaimerFound: !!doc.disclaimerFound, skipped: doc.skipped || [] };
    if (isBlog) {
      pkg.blog = { ...(doc.blogDraft || {}), title, slug, metaTitle, metaDescription: metaDesc, buttons: doc.buttons || '', content, adminUrl: admin, bulkTicket: ticket };
      pkg.canDraft = true;
    }

    if ((isVrp || isLanding || isComparison) && title && content) {
      try {
        const pageKind = isComparison ? 'comparison' : 'landing';
        pkg.hub = generateHub(pageKind, {
          pageTitle: title, pageSlug: slug, comparisonMetaTitle: metaTitle, comparisonMetaDescription: metaDesc,
          ctaLearnMoreUrl: '', ctaInventoryUrl: '', vehicleName: '', ctaBodyContent: content,
          compareRows: doc.compareRows || [], ctaButtonsHtml: doc.buttons || '', suppressCtaButtons: !doc.buttons, landingParent: parent,
          templateName: isVrp ? 'Lightning' : 'DI Page Composer', vrpSeoContent: isVrp,
          landingBottom: isVrp ? '' : bottom, landingImage: null,
        });
        pkg.hub.adminUrl = admin; pkg.hub.bulkNoImage = !isVrp;
        pkg.canDraft = true;
      } catch (e) { add('Page built', false, 'error', e.message); }
    }
  }

  const bad = checks.filter(c => c.level === 'error' && !c.ok).length;
  const warn = checks.filter(c => c.level === 'warn').length;
  const good = checks.filter(c => c.ok).length;
  row.Checks = `${good} OK · ${warn} warning${warn === 1 ? '' : 's'} · ${bad} error${bad === 1 ? '' : 's'}`;
  row.Warnings = warnings.join(' | ');
  row.Status = bad || (!doc && !isHubTemplate) ? 'Needs attention' : 'Ready for review';
  if (!doc && docUrl && !docTypes.includes(key)) row.Status = 'Fetched';
  row['Draft Status'] = '';
  row['Total Secs'] = secs(Date.now() - t0);
  pkg.warnings = warnings;
  pkg.sitePages = sitePages;
  pkg.canDraft = !!(pkg.hub || pkg.blog);
  return { row, pkg, error: '' };
}

export { esc };
