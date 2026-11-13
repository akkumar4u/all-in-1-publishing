const { JSDOM } = require('jsdom');
const { assertPublicHost } = require('./button-checker');

async function getPublicPage(rawUrl) {
  let current;
  try { current = new URL(String(rawUrl || '')); }
  catch { throw new Error('Published URL is not valid.'); }
  if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) throw new Error('Only public HTTP or HTTPS URLs can be checked.');
  const redirects = [];
  for (let hop = 0; hop <= 8; hop++) {
    await assertPublicHost(current.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(current.href, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/html', 'User-Agent': 'ContentStudio-PublishedCheck/1.0' } });
    } finally { clearTimeout(timer); }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) return { status: response.status, finalUrl: current.href, redirects, html: '' };
      if (hop === 8) throw new Error('Page redirected too many times.');
      const next = new URL(location, current);
      if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) throw new Error('The redirect target is not a safe public URL.');
      redirects.push({ status: response.status, url: current.href, to: next.href });
      current = next;
      continue;
    }
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) { await response.body?.cancel().catch(() => {}); return { status: response.status, finalUrl: current.href, redirects, html: '' }; }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 2 * 1024 * 1024) { await response.body?.cancel().catch(() => {}); throw new Error('Published page is larger than the 2 MB check limit.'); }
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, finalUrl: current.href, redirects, html: '' };
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Published page is larger than the 2 MB check limit.'); }
      chunks.push(Buffer.from(value));
    }
    return { status: response.status, finalUrl: current.href, redirects, html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Page could not be checked.');
}

async function verifyPublishedPage(url, expectedTitle = '') {
  const page = await getPublicPage(url);
  const checks = [];
  const add = (name, ok, level, detail = '') => checks.push({ name: `Published page — ${name}`, ok: !!ok, level: ok ? 'ok' : level, detail });
  add('HTTP response', page.status >= 200 && page.status < 300, 'error', `HTTP ${page.status} · ${page.finalUrl}`);
  add('redirect destination', page.redirects.length === 0, 'warn', page.redirects.length ? page.redirects.map(r => `${r.status}: ${r.url} → ${r.to}`).join(' · ') : 'No redirects');
  if (page.html) {
    const dom = new JSDOM(page.html);
    try {
      const doc = dom.window.document;
      const canonical = doc.querySelector('link[rel~="canonical"]')?.href || '';
      const h1 = doc.querySelector('h1')?.textContent.trim() || '';
      add('page content', !!h1, 'warn', h1 ? `H1: ${h1}` : 'No H1 was found in the public HTML.');
      if (expectedTitle) add('expected title', h1.toLowerCase().includes(String(expectedTitle).trim().toLowerCase()), 'warn', h1 ? `Found H1: ${h1}` : 'No H1 to compare.');
      add('canonical URL', !canonical || new URL(canonical, page.finalUrl).origin === new URL(page.finalUrl).origin, 'warn', canonical || 'No canonical tag found.');
    } finally { dom.window.close(); }
  } else add('HTML response', false, 'warn', 'The URL did not return an HTML page.');
  return { finalUrl: page.finalUrl, checks };
}

module.exports = { verifyPublishedPage };
