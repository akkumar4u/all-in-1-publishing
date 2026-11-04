/* Link rules for pasted / imported content (a classic script: it adds one global, diLinkRules).
 *   1. Links that come out of a Google Doc are wrapped: https://www.google.com/url?q=REAL&sa=D&... -> REAL
 *   2. EXTERNAL links (another website than the dealer's) always get target="_blank" and rel="nofollow noopener".
 *      Links to the dealer's own site and relative links (/page/), #anchors, mailto: and tel: are left as they are. */
(function (g) {
  const norm = h => String(h || '').toLowerCase().replace(/^www\./, '');

  function unwrap(href) {
    let cur = String(href || '').trim();
    for (let i = 0; i < 3; i++) {
      if (!/^https?:\/\//i.test(cur)) return cur;
      let u;
      try { u = new URL(cur); } catch { return cur; }
      if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname) || u.pathname !== '/url') return cur;
      const real = u.searchParams.get('q') || u.searchParams.get('url');
      if (!real || !/^https?:\/\//i.test(real)) return cur;
      cur = real;
    }
    return cur;
  }

  function isAbsolute(href) { return /^(https?:)?\/\//i.test(href); }

  function isExternal(href, ownHost) {
    if (!isAbsolute(href)) return false;
    let host;
    try { host = norm(new URL(href, 'https://x.invalid/').hostname); } catch { return false; }
    const own = norm(ownHost);
    return !(own && (host === own || host.endsWith('.' + own)));
  }

  /* what a link should become: { href, external } */
  function resolve(href, ownHost) {
    const real = unwrap(href);
    return { href: real, external: isExternal(real, ownHost) };
  }

  /* fix every <a href> in a piece of HTML (used on the final text, when the dealer's site is known) */
  function fixHtml(html, ownHost) {
    if (!html || !/<a\b/i.test(html)) return html;
    const root = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html').querySelector('#r');
    root.querySelectorAll('a[href]').forEach(a => {
      const r = resolve(a.getAttribute('href'), ownHost);
      if (r.href !== a.getAttribute('href')) a.setAttribute('href', r.href);
      const rel = new Set((a.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
      if (r.external) {
        a.setAttribute('target', '_blank');
        rel.add('nofollow'); rel.add('noopener');
        a.setAttribute('rel', [...rel].join(' '));
      } else if (isAbsolute(r.href) && norm(ownHost)) {      // the dealer's own site: normal link
        if (a.getAttribute('target') === '_blank') a.removeAttribute('target');
        rel.delete('nofollow'); rel.delete('noopener');
        if (rel.size) a.setAttribute('rel', [...rel].join(' ')); else a.removeAttribute('rel');
      }
    });
    return root.innerHTML;
  }

  g.diLinkRules = { unwrap, isExternal, resolve, fixHtml };
})(typeof globalThis !== 'undefined' ? globalThis : this);
