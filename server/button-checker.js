const dns = require('node:dns').promises;
const net = require('node:net');
const { JSDOM } = require('jsdom');

function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const n = address.split('.').map(Number);
    if (n.length !== 4 || n.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
    const [a, b] = n;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0));
  }
  if (family === 6) {
    const value = address.toLowerCase();
    if (value.startsWith('::ffff:')) {
      const mapped = value.slice(7);
      if (net.isIP(mapped) === 4) return publicAddress(mapped);
      const parts = mapped.split(':').slice(-2).map(x => parseInt(x, 16));
      if (parts.length === 2 && parts.every(Number.isFinite)) {
        return publicAddress(`${parts[0] >> 8}.${parts[0] & 255}.${parts[1] >> 8}.${parts[1] & 255}`);
      }
      return false;
    }
    // Public IPv6 unicast space is 2000::/3; this excludes loopback, link-local,
    // unique-local, multicast, and unspecified addresses.
    return /^[23]/.test(value);
  }
  return false;
}

async function assertPublicHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Private or local host is not allowed.');
  }
  if (net.isIP(host)) {
    if (!publicAddress(host)) throw new Error('Private or local host is not allowed.');
    return;
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => !publicAddress(record.address))) {
    throw new Error('Private or local host is not allowed.');
  }
}

function decodeMarkup(markup) {
  let decoded = String(markup || '');
  for (let i = 0; i < 3; i++) {
    const dom = new JSDOM('<!doctype html><textarea></textarea>');
    const field = dom.window.document.querySelector('textarea');
    field.innerHTML = decoded;
    const next = field.value;
    dom.window.close();
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.replace(/^\s*(?:buttons?|cta\s*buttons?|button\s*code|cta\s*button\s*code)\s*:\s*/i, '').trim();
}

async function inspectUrl(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { status: 0, reason: 'Unsupported or unsafe URL.' };
    }
    await assertPublicHost(parsed.hostname);
    let response = await fetch(parsed.href, {
      method: 'HEAD', redirect: 'manual', signal: controller.signal,
      headers: { 'User-Agent': 'ContentStudio-LinkCheck/1.0' },
    });
    if (response.status === 405 || response.status === 501) {
      await response.body?.cancel().catch(() => {});
      response = await fetch(parsed.href, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': 'ContentStudio-LinkCheck/1.0', Range: 'bytes=0-0' },
      });
    }
    const status = response.status;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    return { status, location: location ? new URL(location, parsed).href : '', reason: '' };
  } catch (error) {
    return { status: 0, reason: error?.name === 'AbortError' ? 'request timed out' : error?.message || 'request failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(target, label, index, allowedOrigin) {
  const name = `Button URL — ${label || target || `link ${index + 1}`}`;
  if (!target) return { name, ok: false, level: 'error', detail: 'No href was set.' };
  if (/^(mailto:|tel:|#|javascript:)/i.test(target)) return null;
  let url;
  try { url = new URL(target); }
  catch { return { name, ok: false, level: 'error', detail: 'Invalid URL: ' + target }; }
  if (url.origin !== allowedOrigin) {
    return { name, ok: false, level: 'warn', detail: 'External URL not checked by the private server · ' + url.href };
  }
  const result = await inspectUrl(url.href);
  if (result.location) {
    return { name, ok: false, level: 'error', detail: `Redirected · HTTP ${result.status} · ${url.href} → ${result.location}` };
  }
  if (result.status >= 200 && result.status < 400) {
    return { name, ok: true, level: 'ok', detail: `HTTP ${result.status} · working · ${url.href}` };
  }
  const status = Number(result.status || 0);
  const inconclusive = [401, 403, 408, 429].includes(status) || status >= 500 || status === 0;
  const level = inconclusive ? 'warn' : status >= 400 ? 'error' : 'warn';
  const reason = status === 403 ? 'site blocked the automated check; URL is unconfirmed, not confirmed broken'
    : status === 401 ? 'page requires authorization; URL is unconfirmed'
    : status === 429 ? 'site rate-limited the check; URL is unconfirmed'
    : status >= 500 ? 'site returned a server error; URL is unconfirmed'
    : result.reason || 'request failed';
  return { name, ok: false, level, detail: `${status ? 'HTTP ' + status : 'Could not verify'} · ${reason} · ${url.href}` };
}

async function verifyButtonUrls(buttonsHtml, websiteUrl) {
  const decoded = decodeMarkup(buttonsHtml);
  const dom = new JSDOM(decoded);
  try {
    let anchors = [...dom.window.document.querySelectorAll('a.button, a.primary-button, a[class*="button"]')];
    if (!anchors.length) anchors = [...dom.window.document.querySelectorAll('a')];
    if (!anchors.length) {
      return String(buttonsHtml || '').trim()
        ? [{ name: 'Button Code', ok: false, level: 'error', detail: 'No <a href="…"> button link was found in this code.' }]
        : [];
    }
    let origin;
    try {
      const site = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(websiteUrl || '') ? websiteUrl : 'https://' + (websiteUrl || ''));
      if (!['http:', 'https:'].includes(site.protocol) || site.username || site.password) throw new Error('invalid website URL');
      origin = site.origin;
    }
    catch { return anchors.map((a, i) => ({ name: `Button URL — ${(a.textContent || '').trim() || `link ${i + 1}`}`, ok: false, level: 'warn', detail: 'Could not check: dealer website URL is missing.' })); }
    const entries = [...new Map(anchors.map(a => {
      const href = (a.getAttribute('href') || '').trim();
      return [href, { href, label: (a.textContent || '').trim() || href }];
    })).values()];
    if (entries.length > 12) entries.length = 12;
    const checks = await Promise.all(entries.map(({ href, label }, i) => {
      if (!href) return checkOne('', label, i, origin);
      if (/^(mailto:|tel:|#|javascript:)/i.test(href)) return null;
      let target;
      try { target = new URL(href, origin).href; }
      catch { return checkOne(href, label, i, origin); }
      return checkOne(target, label, i, origin);
    }));
    return checks.filter(Boolean);
  } finally {
    dom.window.close();
  }
}

module.exports = { verifyButtonUrls, assertPublicHost };
