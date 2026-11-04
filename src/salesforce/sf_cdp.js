/**
 * Backup reader for the ticket page. Used only when the normal in-page reader found no Google Doc.
 *
 * Why: the in-page reader can only see what the page lets a script see. Chrome's DevTools
 * protocol (the same one sf_search.js already uses) gets the page's FULL tree — including
 * closed shadow roots and iframes — so a Details value hidden from normal scripts is still read.
 * Pure text processing here; nothing is clicked.
 */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const BLOCK = /^(P|DIV|LI|UL|OL|BR|TR|TD|TH|H[1-6]|SECTION|ARTICLE|PRE|BLOCKQUOTE|LIGHTNING-FORMATTED-RICH-TEXT|LIGHTNING-FORMATTED-TEXT|LIGHTNING-FORMATTED-URL|RECORDS-RECORD-LAYOUT-ITEM|LIGHTNING-OUTPUT-FIELD)$/;
const DOC_RE = /https?:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{15,})[^\s"'<>)]*/g;

const attrsOf = n => { const o = {}; const a = n.attributes || []; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };
const fullUrl = u => u.replace(/&amp;/g, '&').replace(/[.,;:!?\])]+$/, '');
const cleanLabel = t => (t || '').replace(/[\s:|\-–—]+$/, '').replace(/^[\s|:\-–—]+/, '').replace(/\s+/g, ' ').trim().slice(-60);

export async function readTicketViaCdp({ send, log }) {
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });

  let text = '';
  const hrefs = [];
  let accountHref = null;
  const walk = node => {
    if (!node) return;
    if (node.nodeType === 3) { text += node.nodeValue || ''; return; }
    const name = node.nodeName || '';
    if (name === 'SCRIPT' || name === 'STYLE' || name === 'NOSCRIPT') return;
    const block = BLOCK.test(name);
    if (block) text += '\n';
    if (name === 'A') {
      const h = attrsOf(node).href || '';
      if (h) hrefs.push(h);
      if (!accountHref && /\/lightning\/r\/Account\//.test(h)) accountHref = h;
    }
    for (const s of node.shadowRoots || []) walk(s);
    if (node.contentDocument) walk(node.contentDocument);
    for (const c of node.children || []) walk(c);
    if (block) text += '\n';
  };
  walk(root);
  text = text.replace(ZERO_WIDTH, '').replace(/\u00A0/g, ' ');

  const docKey = (id, url) => id + '|' + ((String(url).match(/[?&]tab=(t\.[A-Za-z0-9]+)/) || [])[1] || '');   // same doc, different TAB = different link
// Every Google Doc, labelled by the words in front of it.
  const found = new Map();
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(DOC_RE)) {
      let label = cleanLabel(line.slice(0, m.index).split('|').pop());
      if (!label) {
        for (let j = idx - 1; j >= 0; j--) {
          const prev = lines[j].trim();
          if (prev) { if (!/https?:\/\//i.test(prev) && /:$/.test(prev)) label = cleanLabel(prev.split('|').pop()); break; }
        }
      }
      if (!found.has(docKey(m[1], m[0]))) found.set(docKey(m[1], m[0]), { url: fullUrl(m[0]), label });
    }
  });
  for (const h of hrefs) {
    const m = new RegExp(DOC_RE.source).exec(h);
    if (m && !found.has(docKey(m[1], m[0]))) found.set(docKey(m[1], m[0]), { url: fullUrl(m[0]), label: '' });
  }

  // "Subject" / "Account" label, value is the next non-empty line.
  const after = labelWanted => {
    const want = labelWanted.toLowerCase();
    const i = lines.findIndex(l => l.trim().toLowerCase() === want);
    if (i < 0) return null;
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) { const v = lines[j].trim(); if (v) return v; }
    return null;
  };

  const clean = lines.map(l => l.trim()).filter(Boolean);
  const detailsIdx = clean.findIndex(l => l.toLowerCase() === 'details');
  const sample = (detailsIdx >= 0 ? clean.slice(detailsIdx, detailsIdx + 6) : clean.slice(0, 6)).join(' ¶ ').slice(0, 300);
  await log(`Backup reader: page text ${text.length} chars; ${hrefs.length} links; Details text: "${sample}"`);

  return {
    docs: [...found.values()],
    subject: after('Subject'),
    accountName: after('Account'),
    accountHref,
    pageText: clean.slice(0, 80).join(' | ').slice(0, 1200),
  };
}
