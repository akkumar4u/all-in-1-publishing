/* "Hub page Linking Code": the button to add on the hub page for the landing / comparison page being built.
 * Only the URL and the anchor text change:  <a class="button primary-button" href="/new-vehicles/gle/">New GLE Inventory</a>
 * The classes come from the "Button classes" box (remembered; empty = a plain <a href>).
 *   Publish button = the page's real (published) link as WordPress gives it — parent folder included, relative.
 *   Draft button   = the page's draft / preview link as WordPress gives it (/?page_id=123&preview=true), relative.
 * Before WordPress has given a link, the Publish URL falls back to /<slug>/. Anchor text = EXACTLY the page title (the year
 * stays); only odd spaces are made normal. */
(() => {
  const $ = id => document.getElementById(id);
  const anchorEl = $('hub-link-anchor'), urlEl = $('hub-link-url'), codeEl = $('hub-link-code'), classEl = $('hub-link-class');
  const draftBtn = $('hub-link-copy-draft'), publishBtn = $('hub-link-copy-publish'), noteEl = $('hub-link-note');
  const pageTitleEl = $('comparison-page-title'), pageSlugEl = $('comparison-page-slug');
  if (!anchorEl || !urlEl || !codeEl || !draftBtn || !publishBtn || !pageTitleEl || !pageSlugEl) return;

  const esc = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const slugify = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const edited = { anchor: false, url: false };

  // slug from the doc: "/research/cx-5/" or a full URL -> last part, same rule as the page builders
  const slugPart = v => slugify(String(v || '').trim().replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '');

  // every kind of odd space (non-breaking, thin, zero-width... — Google Docs uses them) becomes ONE normal space, and the ends are trimmed
  // The anchor is EXACTLY the page title: nothing is removed or changed (the year stays), only odd spaces are made normal.
  const shortAnchor = t => String(t || '').replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, ' ').replace(/\s{2,}/g, ' ').trim();

  let live = null;          // { path, url, draftUrl, saved, status } read from WordPress by the extension
  let mode = 'publish';     // which code the box shows: 'publish' | 'draft'

  // absolute link on the same site -> relative (/path/?query); anything else is kept
  const toRelative = u => {
    try { const x = new URL(u); return x.pathname + x.search; } catch { return String(u || ''); }
  };
  const normUrl = u => (u && !/^(https?:)?\/\//i.test(u) && !/^\/\?/.test(u) ? '/' + u.replace(/^\/+/, '').replace(/\/*$/, '/') : u);

  // a link that still has WordPress's shortened slug ("abc…xyz") gets the page's real slug in its place
  const mend = p => {
    if (!/\u2026|%E2%80%A6/i.test(p || '')) return p;
    const whole = slugPart(pageSlugEl.value) || slugify(pageTitleEl.value.trim());
    const parts = String(p).split(/[?#]/)[0].split('/').filter(Boolean);
    parts.pop();
    return whole ? '/' + [...parts, whole].join('/') + '/' : '';
  };
  function publishUrl() {
    if (edited.url && urlEl.value.trim()) return normUrl(urlEl.value.trim());
    if (live && live.path) return mend(live.path);
    const slug = slugPart(pageSlugEl.value) || slugify(pageTitleEl.value.trim());
    return slug ? `/${slug}/` : '';
  }
  function draftUrl() { return live && live.draftUrl ? mend(toRelative(live.draftUrl)) : ''; }

  function codeFor(which) {
    const anchor = anchorEl.value.trim();
    const url = which === 'draft' ? (draftUrl() || publishUrl()) : publishUrl();
    const cls = classEl ? classEl.value.trim() : 'button primary-button';
    return url || anchor ? `<a${cls ? ` class="${esc(cls)}"` : ''} href="${esc(url || '/URL/')}">${esc(anchor)}</a>` : '';
  }

  function refresh() {
    const pageTitle = pageTitleEl.value.trim();
    const wantAnchor = shortAnchor(pageTitle);              // the anchor is ALWAYS the page title (never an old / typed value)
    anchorEl.readOnly = true;
    if (anchorEl.value !== wantAnchor) anchorEl.value = wantAnchor;
    if (!edited.url && document.activeElement !== urlEl) urlEl.value = publishUrl();
    const code = codeFor(mode);
    if (codeEl.value !== code) codeEl.value = code;
    if (noteEl) {
      noteEl.textContent = !live
        ? 'Publish link = /slug/ for now. It is replaced by the page\'s real WordPress link (with its parent folder) as soon as the page is filled.'
        : mode === 'draft' && !draftUrl()
          ? 'WordPress has not given a draft link yet — showing the publish URL.'
          : `${mode === 'draft' ? 'Draft' : 'Publish'} code · WordPress link read${live.saved ? (live.status ? ' (' + live.status + ')' : ' after saving') : ' from the draft'}.`;
    }
  }

  classEl?.addEventListener('input', () => { chrome.storage.local.set({ hubLinkClass: classEl.value }); refresh(); });
  chrome.storage.local.get('hubLinkClass').then(d => { if (classEl && typeof d.hubLinkClass === 'string') { classEl.value = d.hubLinkClass; refresh(); } });
  urlEl.addEventListener('input', () => { edited.url = !!urlEl.value.trim(); refresh(); });
  pageTitleEl.addEventListener('input', refresh);
  pageSlugEl.addEventListener('input', refresh);
  setInterval(refresh, 1000);      // title / slug are also filled by code after a Google Doc import

  chrome.storage.local.get('pageLink').then(d => { live = d.pageLink || null; refresh(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.pageLink) { live = changes.pageLink.newValue || null; if (live) edited.url = false; refresh(); }
  });

  async function copyCode(which, btn) {
    mode = which;
    refresh();
    const text = codeEl.value;
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch (e) { codeEl.select(); document.execCommand('copy'); }
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = old; }, 1800);
  }
  draftBtn.addEventListener('click', () => copyCode('draft', draftBtn));
  publishBtn.addEventListener('click', () => copyCode('publish', publishBtn));
  refresh();
})();
