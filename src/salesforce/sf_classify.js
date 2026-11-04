/**
 * Works out WHAT KIND of task a Salesforce ticket is, from its subject line.
 * Pure functions (no browser, no Chrome) — all the keyword rules live in this one file.
 *
 *   Publishing : Blog, Landing Page, Comparison, Inventory Page Creation
 *   Enhancement: Landing Page, Inventory Page Optimization, VRP Enhancement   (content + meta tags only)
 *   Hub Pages  : Service & Parts Information, Make Research, Finance & Insurance Information
 *
 * Group 1 tickets are mostly landing pages: if the subject does not mention "blog", it is a landing page.
 */

// `publishingType` / `hubType` = the value to select in the popup's dropdowns.
// `automated: false` = identified and shown, but there is no automatic flow for it yet.
export const TASK_TYPES = {
  'publishing:blog':               { category: 'publishing',  label: 'Publishing — Blog',                       publishingType: 'blog' },
  'publishing:landing':            { category: 'publishing',  label: 'Publishing — Landing Page',               publishingType: 'landing' },
  'publishing:comparison':         { category: 'publishing',  label: 'Publishing — Comparison',                 publishingType: 'comparison' },
  'publishing:inventory-creation': { category: 'publishing',  label: 'Publishing — Inventory Page Creation',    automated: false },
  'enhancement:landing':           { category: 'enhancement', label: 'Enhancement — Landing Page',              publishingType: 'page-enhancement' },
  'enhancement:inventory':         { category: 'enhancement', label: 'Enhancement — Inventory Page Optimization', publishingType: 'page-enhancement' },
  'enhancement:vrp':               { category: 'enhancement', label: 'Enhancement — VRP Enhancement',           publishingType: 'landing' },
  'hub:service':                   { category: 'hub',         label: 'Hub — Service & Parts Information',       hubType: 'service' },
  'hub:research':                  { category: 'hub',         label: 'Hub — Make Research',                     hubType: 'research' },
  'hub:finance':                   { category: 'hub',         label: 'Hub — Finance & Insurance Information',   hubType: 'finance' },
};

const norm = s => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();

export function classifyTask({ subject, group1 = false } = {}) {
  const t = norm(subject);
  if (!t) return { key: null, category: 'unknown', label: 'Not sure', confidence: 'low', reason: 'The ticket subject could not be read.' };

  const hit = (key, confidence, reason) => ({ key, category: TASK_TYPES[key].category, label: TASK_TYPES[key].label, confidence, reason });

  // 1. Enhancement (content + meta tags only — a different flow from publishing)
  if (/\benhancement\b/.test(t)) {
    if (/\bvrp\b|vehicle results?/.test(t)) return hit('enhancement:vrp', 'high', 'Subject says Enhancement and mentions VRP.');
    if (/inventory/.test(t))                 return hit('enhancement:inventory', 'high', 'Subject says Enhancement and mentions inventory.');
    return hit('enhancement:landing', 'medium', 'Subject says Enhancement (no VRP / inventory) → Landing Page enhancement.');
  }

  // 2. Hub pages
  if (/service and parts|service hub/.test(t))                       return hit('hub:service', 'high', 'Subject mentions Service & Parts.');
  if (/make research|research hub/.test(t))                          return hit('hub:research', 'high', 'Subject mentions Make Research.');
  if (/finance and insurance|finance hub|f and i hub/.test(t))       return hit('hub:finance', 'high', 'Subject mentions Finance & Insurance.');

  // 3. Publishing
  if (/inventory/.test(t))                                           return hit('publishing:inventory-creation', 'medium', 'Subject mentions inventory.');
  if (/comparison|\bvs\.?\b|versus|compared? to/.test(t))            return hit('publishing:comparison', 'high', 'Subject looks like a comparison.');
  if (/\bblog(s)?\b/.test(t))                                        return hit('publishing:blog', 'high', 'Subject mentions blog.');
  // No "blog" in the subject → Landing Page (always true for Group 1).
  return hit('publishing:landing', group1 ? 'high' : 'medium',
    group1 ? 'Group 1 ticket and the subject does not mention blog → Landing Page.'
           : 'The subject does not mention blog → Landing Page.');
}

/**
 * "Okoboji Motor CompanyPreview" → "Okoboji Motor Company".
 * Salesforce's hover icon next to a lookup carries a hidden "Preview" label that can end up
 * glued to the name.
 */
export function cleanAccountName(name) {
  return (name || '').replace(/\s*Preview\s*$/, '').replace(/\s+/g, ' ').trim();
}
