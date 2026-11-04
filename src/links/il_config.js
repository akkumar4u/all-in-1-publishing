/**
 * Internal links — settings. Edit ONLY this file to change which fixed pages get linked.
 *
 * FIXED_PAGES: pages that almost every dealer site has. Each group lists the PHRASES that should link to the page
 * (endings do not matter: "apply for finance" also finds "applying for financing").
 *   path   the usual URL, used when the sitemap does not say otherwise
 *   hints  names to look for in the site's sitemap; if a page with one of these names exists, ITS real URL is used
 * A page that does not exist on the site is never suggested. Nothing is added unless the link is ticked in the panel.
 */
export const FIXED_PAGES = [
  { id: 'contact',        phrases: ['contact us', 'reach out to', 'get in touch'],                          path: '/contact-us/',                 hints: ['contact us', 'contact'] },
  { id: 'trade',          phrases: ['value your trade'],                                                    path: '/value-your-trade/',           hints: ['value your trade'] },
  { id: 'apply-finance',  phrases: ['apply for financing', 'apply for finance'],                            path: '/finance/apply-for-financing/', hints: ['apply for financing', 'finance application'] },
  { id: 'finance',        phrases: ['finance center', 'finance department', 'financing', 'finance'],       path: '/finance/',                    hints: ['finance', 'finance center', 'finance department'] },
  { id: 'schedule',       phrases: ['schedule service', 'service appointment'],                             path: '/service/schedule-service/',   hints: ['schedule service', 'schedule service appointment'] },
  { id: 'service-specials', phrases: ['service specials', 'service offers'],                                path: '/service/service-specials/',   hints: ['service specials', 'service offers'] },
  { id: 'service',        phrases: ['service center', 'service department', 'service'],                    path: '/service/',                    hints: ['service', 'service center', 'service department'] },
  { id: 'parts-specials', phrases: ['parts specials', 'parts special'],                                     path: '/parts/parts-specials/',       hints: ['parts specials', 'parts coupons'] },
  { id: 'parts',          phrases: ['parts center', 'parts department', 'parts'],                           path: '/parts/',                      hints: ['parts', 'parts center', 'parts department'] },
  { id: 'new-specials',   phrases: ['new vehicle specials', 'new specials', 'new vehicle offers'],          path: '/new-vehicle-specials/',       hints: ['new vehicle specials', 'new vehicle offers', 'national offers', 'new specials'] },
  { id: 'staff',          phrases: ['meet our team', 'meet our staff', 'our team', 'our staff', 'team', 'staff'], path: '/about-us/staff/',        hints: ['meet our staff', 'staff', 'meet our team', 'our team', 'meet the team'] },
  { id: 'cpo',            phrases: ['certified pre-owned', 'certified pre-owned vehicles'],                 path: '/used-vehicles/certified-pre-owned-vehicles/', hints: ['certified pre-owned vehicles', 'certified pre-owned'] },
  { id: 'new',            phrases: ['new vehicles', 'new inventory'],                                       path: '/new-vehicles/',               hints: ['new vehicles', 'new inventory'] },
  { id: 'used',           phrases: ['pre-owned vehicles', 'used vehicles', 'pre-owned inventory', 'used inventory'], path: '/used-vehicles/',     hints: ['pre-owned vehicles', 'used vehicles'] },
];

// Sitemaps tried (in this order) to find the page a red anchor should point to.
export const SITEMAP_PATHS = ['/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap.xml'];

// HTML sitemap pages (a normal page that lists the site's links, with each page's NAME as the link text). Read in addition to the XML.
export const HTML_SITEMAP_PATHS = ['/sitemap/', '/sitemap', '/site-map/', '/sitemap.html'];

// Sitemap files that never hold pages worth linking to.
export const SKIP_SITEMAP_PATTERN = /author|tag|category|attachment|image|media|user/i;

// Red anchors / phrases are linked at most once each, and one URL is linked at most once per page.
// Pages of the CURRENT model year are preferred when two pages could take the same link (e.g. /2026-toyota-camry/ over /toyota-camry/);
// pages of an older year are slightly less preferred. Set PRIORITY_YEAR to a fixed year (e.g. '2026') to pin it.
export const PRIORITY_YEAR = String(new Date().getFullYear());
export const YEAR_BOOST = 25;      // added to a site match of that year
export const YEAR_PENALTY = -15;   // added to a site match of an older year

// How many link suggestions are offered per page (red anchors from the doc always count first).
export const MAX_SUGGESTIONS = 7;

// Sitemap pages that are never good link targets (matched against the LAST part of the URL).
export const GENERIC_SLUGS = new Set(['blog', 'news', 'about', 'about-us', 'contact', 'contact-us', 'home', 'privacy', 'privacy-policy', 'terms', 'terms-of-use',
  'sitemap', 'search', 'login', 'cart', 'page', 'category', 'tag', 'author', 'accessibility', 'thank-you', 'unsubscribe', 'cookie-policy', 'ada']);

export const LIMITS = { sitemapFiles: 10, htmlSubSitemaps: 3, maxPages: 4000, concurrentChecks: 4, fetchTimeoutMs: 12000 };
