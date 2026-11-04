/**
 * Clean file names for the banner image.
 *   - siteSlug("www.mattmcdonaldchevy.com") -> "mattmcdonaldchevy"   (the domain name, no www / no .com)
 *   - pickDownloadName: if the same file name was already saved to Downloads, add the domain name instead of "(1)".
 */
export function siteSlug(host) {
  // never name a file after Google Docs / Salesforce / the extension itself - only the dealer's own site
  if (/(^|\.)(google|googleusercontent|force|salesforce|chrome-extension)(\.|$)/i.test(String(host || ''))) return '';
  const h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  const parts = h.split('.').filter(Boolean);
  let name = parts[0] || '';
  if (parts.length >= 3 && /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) name = parts[parts.length - 3];
  else if (parts.length >= 2) name = parts[parts.length - 2];
  return name.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function downloadExists(name) {
  try {
    const items = await chrome.downloads.search({ filenameRegex: '(^|[\\\\/])' + esc(name) + '$', limit: 25 });
    return items.some(i => i.state === 'complete' && i.exists !== false);
  } catch { return false; }
}

/** base = "2026-chevrolet-colorado", ext = "jpg" -> a base name that is free (or the domain-suffixed one) */
export async function pickDownloadName(base, ext, host) {
  if (!(await downloadExists(`${base}.${ext}`))) return base;
  const site = siteSlug(host);
  return site && !base.endsWith('-' + site) ? `${base}-${site}` : base;      // already saved -> add the domain name
}
