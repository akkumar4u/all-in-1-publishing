import { getSiteIndex, suggestPages } from './links/il_core.js';

const adminOrigins = value => {
  let raw = String(value || '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const admin = new URL(raw);
    const prefix = admin.pathname.replace(/\/wp-admin(?:\/.*)?$/i, '').replace(/\/$/, '');
    return [...new Set([admin.origin + prefix, admin.origin])];
  } catch { return []; }
};

window.__diFindVrpPages = async (adminUrl, query, manualSitemapUrl = '') => {
  const origins = adminOrigins(adminUrl);
  if (!origins.length) throw new Error('Enter the WordPress Admin URL first.');
  let index = { entries: [], info: { tried: [] } };
  for (const base of origins) {
    index = await getSiteIndex(base, manualSitemapUrl);
    if (index.entries.length) break;
  }
  if (!index.entries.length) {
    const tried = [...new Set(index.info.tried || [])].slice(0, 12);
    throw new Error('Could not read any pages from this website’s sitemap. Checked: ' + (tried.join(', ') || 'sitemap endpoints were unreachable'));
  }
  const origin = origins.find(base => index.entries.some(entry => entry.url.startsWith(base))) || origins[origins.length - 1];
  const pages = suggestPages(index.entries, query, 12).map(page => ({
    ...page,
    url: index.entries.find(entry => new URL(entry.url).pathname.replace(/\/$/, '') === page.path.replace(/\/$/, ''))?.url || new URL(page.path, origin).toString(),
  }));
  return { pages, count: index.entries.length };
};

window.__diResolveVrpEditPage = async (adminUrl, pageUrl) => {
  const origins = adminOrigins(adminUrl);
  const selected = new URL(pageUrl);
  const sameHost = host => String(host || '').toLowerCase().replace(/^www\./, '');
  if (!origins.some(base => sameHost(selected.hostname) === sameHost(new URL(base).hostname))) throw new Error('The selected sitemap page is not on this website.');
  const slug = selected.pathname.split('/').filter(Boolean).at(-1);
  if (!slug) throw new Error('The selected sitemap address does not have a page slug.');

  let admin;
  try { admin = new URL(adminUrl.includes('://') ? adminUrl : `https://${adminUrl}`); }
  catch { throw new Error('The WordPress Admin URL is invalid.'); }
  const wpPrefix = admin.pathname.replace(/\/wp-admin\/?$/i, '').replace(/\/$/, '');
  const apiRoots = [...new Set(origins.flatMap(base => {
    const baseUrl = new URL(base);
    return [`${baseUrl.origin}/wp-json/wp/v2/pages`, `${baseUrl.origin}${wpPrefix}/wp-json/wp/v2/pages`];
  }))];

  let page = null;
  for (const root of apiRoots) {
    try {
      const api = new URL(root);
      api.searchParams.set('slug', slug);
      api.searchParams.set('_fields', 'id,link,title');
      const response = await fetch(api, { credentials: 'omit' });
      if (!response.ok) continue;
      const pages = await response.json();
      if (Array.isArray(pages) && pages.length) {
        page = pages.find(item => {
          try { return new URL(item.link).pathname.replace(/\/$/, '') === selected.pathname.replace(/\/$/, ''); }
          catch { return false; }
        }) || pages[0];
        break;
      }
    } catch { /* try the next WordPress REST API root */ }
  }
  if (!page?.id) throw new Error('Could not map this sitemap page to a WordPress page ID. Choose another page or check REST API access.');

  const edit = new URL('post.php', `${admin.origin}${admin.pathname.replace(/\/?$/, '/')}`);
  edit.searchParams.set('post', page.id);
  edit.searchParams.set('action', 'edit');
  return { editUrl: edit.toString(), title: page.title?.rendered || page.title?.raw || slug };
};
