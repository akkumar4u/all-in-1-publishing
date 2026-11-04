// Runs inside an offscreen document (has a real DOM/DOMParser, unlike the
// background service worker). Pulls what the Comparison Page needs: the H1
// title, the "Meta Title"/"Meta Description" labeled fields, the body copy
// (everything that isn't the title/metadata/table), and — if the doc has
// one — the comparison table's rows (Left | Middle | Right).
//
// This file is loaded as its own ES module (see parser.html), so these
// helpers are intentionally self-contained duplicates of similar-looking
// ones in blog_parser.js rather than shared — Comparison Page parsing can
// change here without ever touching Blog Publishing's behavior.
const text = value => (value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
// Google Docs comment markers ("[a]" -> href "#cmntN" / id "cmnt_refN", and the same pair on the definition side) sit
// INSIDE lines. They are never part of a title, meta title, meta description, slug or any other imported value.
const cleanNodeText = node => {
  if (!node) return '';
  const clone = node.cloneNode(true);
  clone.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    const id = a.getAttribute('id') || '';
    if (/^#?cmnt/i.test(href) || /^cmnt/i.test(id)) a.remove();
  });
  return text(clone.textContent);
};
const escapeHtml = value => (value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// Metadata label lines (with or without an inline value) that must never be
// treated as body content, plus the "Comparison Chart" line that's a
// doc-authoring instruction for the table, not page copy. Brief templates
// carry a lot more of these than just the title/meta fields — Keywords,
// Page Slug, Image Shortcode, Buttons, and Recommended Internal Links all
// show up as label lines above the real body copy.
const fieldPattern = /^(post title|page title|meta title|meta description|seo title|seo description|keywords?|focus keyphrase|primary keyword|secondary keywords?|page slug|url slug|slug|permalink|page url|url|canonical url|image shortcode|image code|image link|featured image(?: alt text)?|buttons?(?:\s+(?:code|html|markup))?|cta\s+buttons?(?:\s+(?:code|html|markup))?|recommended internal links|internal links|external links|publish date|word count|content type|comparison chart)\s*(?:\([^)]*\))?\s*(?::\s*.*)?$/i;
const chartLabelPattern = /^comparison chart\b/i;
// A "Note:" line is always writer guidance (style guide reminders, "these
// links are suggestions", etc.) — never page copy, wherever it appears.
const notePattern = /^note\s*:/i;
// Everything from "Disclaimers (if applicable):" to the end of the doc is
// normally just the writer's comment/footnote definitions (each line
// starting with a "[a]"-style link back to a "cmnt..." id) — never page
// copy. But a doc can genuinely have real disclaimer copy typed there
// instead; that must not be thrown away. isCommentLine tells the two
// apart: a comment reference or comment definition always starts with an
// <a> tag whose id and/or href is one of Google Docs' own "cmnt.../
// cmnt_ref..." pair (in-text markers link forward to "#cmntN" and carry
// id="cmnt_refN"; the definitions at the bottom do the reverse) — real
// disclaimer prose never starts that way. This check applies wherever a
// comment thread shows up in the doc, not just under a Disclaimers
// heading — a stray comment definition floating elsewhere must never
// become page content either.
const disclaimersPattern = /^disclaimers?\b/i;
// SWITCH: the disclaimer block is currently NOT added to the page (it is still cut out of the article text,
// so it never ends up in the body). Set to true to add the "Disclaimers" copy at the end again.
const HUB_APPEND_DISCLAIMER = true;
// "Disclaimers (if applicable): Prices exclude tax." — the real text can sit on the SAME line as the
// label. Return a copy of that line with the label (and any comment marker) cut off, or null if
// nothing real is left (blank label -> the disclaimer is dropped, as intended).
function disclaimerRemainder(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('a[href^="#cmnt"], a[id^="cmnt"], sup').forEach(el => el.remove());
  const full = clone.cloneNode(true);                 // the line AS WRITTEN, "Disclaimer:" label included — this is what is kept
  let toStrip = ((clone.textContent || '').match(/^\s*disclaimers?\s*(?:\([^)]*\))?\s*:?\s*/i) || [''])[0].length;
  const walker = clone.ownerDocument.createTreeWalker(clone, 4 /* NodeFilter.SHOW_TEXT */);
  let t;
  while (toStrip > 0 && (t = walker.nextNode())) {
    const cut = Math.min(toStrip, t.nodeValue.length);
    t.nodeValue = t.nodeValue.slice(cut);
    toStrip -= cut;
  }
  const rest = (clone.textContent || '').replace(/\[[a-z]{1,2}\]/gi, '').trim();
  return rest && !EMPTY_DISCLAIMER.test(rest) ? full : null;   // real text after the label -> keep the whole line; blank label -> drop
}
// A line that is only the label ("Disclaimer:" / "Disclaimers (if applicable):") with nothing after it.
const isDisclaimerLabelOnly = n => /^disclaimers?\s*(?:\([^)]*\))?\s*:?\s*$/i.test(((n.textContent || '').replace(/\u00a0/g, ' ').replace(/\[[a-z]{1,2}\]/gi, '').replace(/\s+/g, ' ')).trim());

const EMPTY_DISCLAIMER = /^(?:n\/?a|none|no|nil|not applicable|no disclaimers?|[-–—.]+)$/i;

// A Disclaimer that the writer put inside a table cell (a one-cell "box" at the bottom of the doc is common)
// is invisible to the normal block scan, because everything inside tables is treated as the comparison
// chart. Pull those out first: the label is dropped, the real text is kept, and a table that is nothing
// but a disclaimer box is removed so it is never mistaken for comparison data.
function extractTableDisclaimers(doc) {
  const found = [];
  for (const table of [...doc.body.querySelectorAll('table')]) {
    if (table.parentElement && table.parentElement.closest('table')) continue;     // only outermost tables
    const cells = [...table.querySelectorAll('td, th')];
    const cell = cells.find(c => disclaimersPattern.test(text(c.textContent)));
    if (!cell) continue;
    const blocksIn = [...cell.querySelectorAll('p, ul, ol')].filter(n => !n.parentElement.closest('p, ul, ol'));
    const real = [];
    blocksIn.forEach((n, i) => {
      if (i === 0 && disclaimersPattern.test(text(n.textContent))) {
        const rest = disclaimerRemainder(n);
        real.push(rest || n.cloneNode(true));   // label alone is dropped later unless real text follows
      } else if (text(n.textContent) && !isCommentLine(n)) {
        real.push(n);
      }
    });
    found.push(...real);
    const othersEmpty = cells.every(c => c === cell || !text(c.textContent));
    if (othersEmpty) table.remove(); else cell.remove();
  }
  return found;
}

function isCommentLine(node) {
  const first = node.firstElementChild;
  if (!first || first.tagName !== 'A') return false;
  const href = first.getAttribute('href') || '';
  const id = first.getAttribute('id') || '';
  return /^#?cmnt/i.test(href) || /^cmnt/i.test(id);
}
const buttonsLabelPattern = /^(?:cta\s+)?buttons?\b/i;
const recommendedLinksPattern = /^recommended internal links\b/i;

// A line that's literally raw HTML/code — pasted button markup, a table
// dump, etc. — dropped straight into the doc without a preceding
// "Buttons:"/"Comparison Chart:" label to flag it. Real prose never starts
// with a literal "<", so this is safe to treat as junk wherever it turns up.
function isCodeLikeLine(value) {
  const v = value.trim();
  return v.startsWith('<') || /^\[di-image\b/i.test(v);   // pasted HTML, or an image shortcode like [di-image id='…']
}
const normTitle = v => (v || '').replace(/[\u2018\u2019\u201c\u201d]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const imageCodePattern = /^image\s*(?:code|shortcode|link)\b/i;

// A paragraph made up entirely of link(s) — e.g. a "[Learn More] [View
// Inventory]" preview line — with no surrounding prose is a button/link
// preview, not body copy.
function isLinkOnlyParagraph(node) {
  if (!node.querySelector('a')) return false;
  const clone = node.cloneNode(true);
  clone.querySelectorAll('a').forEach(a => a.remove());
  return !text(clone.textContent);
}

// "Meta Description" alone on a line has its value on the NEXT line (that is how fieldValue() reads it). Only THAT
// (label line -> value line) pair is front-matter. A paragraph elsewhere that merely has the same text as a field value
// (an intro paragraph that equals the meta description, say) is real copy and must never be dropped.
function fieldPairs(lines, labels) {
  const pairs = new Set();
  for (const label of labels) {
    const inlinePattern = new RegExp(`^${label}\\s*(?:\\([^)]*\\))?\\s*:\\s*(.*)$`, 'i');
    const labelPattern = new RegExp(`^${label}\\s*(?:\\([^)]*\\))?\\s*$`, 'i');
    const index = lines.findIndex(line => inlinePattern.test(line) || labelPattern.test(line));
    if (index < 0) continue;
    if (lines[index].match(inlinePattern)?.[1]?.trim()) continue;      // value is on the label line itself (that whole line is dropped as a field line)
    const next = lines[index + 1];
    if (next && !fieldPattern.test(next)) pairs.add(lines[index] + '\u0001' + next);
  }
  return pairs;
}

function fieldValue(lines, label) {
  const inlinePattern = new RegExp(`^${label}\\s*(?:\\([^)]*\\))?\\s*:\\s*(.*)$`, 'i');
  const labelPattern = new RegExp(`^${label}\\s*(?:\\([^)]*\\))?\\s*$`, 'i');
  const index = lines.findIndex(line => inlinePattern.test(line) || labelPattern.test(line));
  if (index < 0) return '';
  const inlineMatch = lines[index].match(inlinePattern);
  if (inlineMatch?.[1]?.trim()) return inlineMatch[1].trim();
  // A blank metadata field must stay blank — never take the next label
  // (e.g. the next field's name) as its value.
  const nextLine = lines[index + 1] || '';
  const looksLikeAnotherLabel = fieldPattern.test(nextLine);
  return looksLikeAnotherLabel ? '' : nextLine;
}

// Google Docs' HTML export renders bold/italic runs as <span class="cN">
// with the actual "font-weight:700"/"font-style:italic" declared on .cN in
// a <style> block — not as literal <b>/<strong>/<i>/<em> tags. Reading that
// map (built from the doc's own <style> block before it gets stripped) is
// what lets a plain <span class="c4"> that Google Docs used for bold text
// come back out as <strong> instead of being silently unwrapped.
// Is the text colour in this CSS red? Writers mark internal-link anchor text in red in the doc.
// Covers pure red, dark red and the lighter reds of the Docs palette; not orange/pink/brown.
function isRedStyle(css) {
  const m = (css || '').match(/(?:^|[;\s])color\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))/i);
  if (!m) return false;
  let r, g, b;
  const v = m[1];
  if (v[0] === '#') {
    const h = v.length === 4 ? v.slice(1).split('').map(c => c + c).join('') : v.slice(1, 7);
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    [r, g, b] = v.replace(/rgba?\(|\)/g, '').split(',').map(n => parseFloat(n));
  }
  return [r, g, b].every(Number.isFinite) && r >= 150 && g <= 120 && b <= 120 && r - g >= 70 && r - b >= 70;
}

function buildFormatClassMap(doc) {
  const map = {};
  doc.querySelectorAll('style').forEach(styleEl => {
    const css = styleEl.textContent || '';
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = ruleRe.exec(css))) {
      const body = match[2];
      const bold = /font-weight\s*:\s*(?:7\d\d|8\d\d|900|bold)\b/i.test(body);
      const italic = /font-style\s*:\s*italic\b/i.test(body);
      const red = isRedStyle(body);
      if (!bold && !italic && !red) continue;
      match[1].split(',').forEach(selector => {
        const clsMatch = selector.trim().match(/^\.([\w-]+)$/);
        if (!clsMatch) return;
        const entry = map[clsMatch[1]] || (map[clsMatch[1]] = {});
        if (bold) entry.bold = true;
        if (italic) entry.italic = true;
        if (red) entry.red = true;
      });
    }
  });
  return map;
}

function cleanInline(html = '', formatClassMap = {}) {
  const parsed = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = parsed.querySelector('#root');
  [...root.querySelectorAll('*')].reverse().forEach(node => {
    const tag = node.tagName.toLowerCase();
    const inner = node.innerHTML;
    if (tag === 'br') return;
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      const id = node.getAttribute('id') || '';
      // Google Docs comment references ("[a]" linking to "#cmnt1", with a
      // matching "cmnt_ref..." id) are doc-authoring artifacts, not real
      // links — drop them entirely rather than carrying them into the page.
      if (/^#?cmnt/i.test(href) || /^cmnt_ref/i.test(id)) {
        node.outerHTML = '';
        return;
      }
      const innerNoMarks = inner.replace(/<\/?mark\b[^>]*>/g, '');   // already a link: not an anchor candidate
      // Google wraps links as google.com/url?q=REAL — use the real address; external links open in a new tab, nofollow
      const L = globalThis.diLinkRules ? globalThis.diLinkRules.resolve(href, globalThis.__diOwnHost) : { href, external: false };
      node.outerHTML = href && text(node.textContent) ? `<a href="${escapeHtml(L.href)}"${L.external ? ' target="_blank" rel="nofollow noopener"' : ''}>${innerNoMarks}</a>` : innerNoMarks;
      return;
    }
    // Keep semantic document structure but discard Google Docs-specific
    // classes and styles. Lists and tables therefore survive extraction as
    // clean HTML, with no copied CSS.
    if (['ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'blockquote'].includes(tag)) {
      node.outerHTML = `<${tag}>${node.innerHTML}</${tag}>`;
      return;
    }
    if (tag === 'hr') {
      node.outerHTML = '<hr>';
      return;
    }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      node.outerHTML = src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">` : '';
      return;
    }
    const semantic = { b: 'strong', strong: 'strong', i: 'em', em: 'em', s: 'del', strike: 'del', del: 'del', code: 'code' }[tag];
    if (semantic) {
      // Google Docs sometimes exports overlapping bold/italic runs as nested
      // tags — collapse any same-semantic descendant before wrapping, so this
      // never surfaces as <strong><strong>...</strong></strong>.
      [...node.querySelectorAll(semantic)].forEach(dup => dup.replaceWith(...dup.childNodes));
      node.outerHTML = `<${semantic}>${node.innerHTML}</${semantic}>`;
      return;
    }
    // Not a semantic tag — most commonly a Google Docs run <span class="cN">.
    // Check its classes against the doc's own bold/italic style map before
    // unwrapping it, so formatting Google Docs expressed only through CSS
    // (not through a literal <b>/<i> tag) isn't lost.
    const classes = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const fmt = classes.reduce((acc, cls) => {
      const entry = formatClassMap[cls];
      if (entry?.bold) acc.bold = true;
      if (entry?.italic) acc.italic = true;
      if (entry?.red) acc.red = true;
      return acc;
    }, {});
    if (!fmt.red && isRedStyle(node.getAttribute('style') || '')) fmt.red = true;
    let content = inner;
    if (fmt.bold) content = `<strong>${content}</strong>`;
    if (fmt.italic) content = `<em>${content}</em>`;
    // Red text = internal-link anchor. Short phrases only: long red text is a writer's note, not an anchor.
    const redText = text(node.textContent);
    if (fmt.red && redText && redText.length <= 70 && redText.split(' ').length <= 9) content = `<mark data-il="1">${content}</mark>`;
    node.outerHTML = content;
  });
  return root.innerHTML.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractButtons(markup = '') {
  if (!markup) return '';
  const sources = [String(markup)];
  for (let i = 0; i < 3; i++) {
    const box = document.createElement('textarea'); box.innerHTML = sources[sources.length - 1];
    if (box.value === sources[sources.length - 1]) break;
    sources.push(box.value);
  }
  const validHref = href => /^(?:https?:\/\/|\/|#|mailto:|tel:)/i.test(String(href || '').trim());
  let links = [];
  for (const source of sources) {
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    links = [...parsed.querySelectorAll('a.button, a.primary-button, a[class*="button"]')]
      .map(link => {
        const href = (link.getAttribute('href') || '').trim();
        const label = text(link.textContent);
        const classes = [...link.classList].filter(name => /button/i.test(name)).join(' ');
        return validHref(href) && label
          ? `<a class="${escapeHtml(classes || 'button')}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
          : '';
      }).filter(Boolean);
    if (links.length) break;
    const recovered = [...source.matchAll(/<a\b[\s\S]*?<\/a>/gi)].map(([block]) => {
      const opening = (block.match(/^<a\b[\s\S]*?>/i) || [''])[0];
      if (!/\bclass\s*=\s*["'][^"']*\b(?:button|primary-button)\b/i.test(opening)) return '';
      const searchText = block.replace(/<\/?[^>]+>/g, ' ');
      const href = (searchText.match(/https?:\/\/[^\s"'<>]+|\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+/i) || [''])[0];
      const beforeClose = block.slice(0, block.toLowerCase().lastIndexOf('</a>'));
      const labelText = beforeClose.slice(beforeClose.lastIndexOf('>') + 1);
      const label = new DOMParser().parseFromString(labelText, 'text/html').body.textContent.replace(/[<>"'&]/g, '').trim();
      return validHref(href) && label ? `<a class="button primary-button" href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : '';
    }).filter(Boolean);
    if (recovered.length) { links = recovered; break; }
  }

  return links.length ? `<div class="text-center">${links.join(' ')}</div>` : '';
}

function extractCompareRows(doc) {
  const table = doc.body.querySelector('table');
  if (!table) return [];

  // The first row is the comparison header. Store its values as explicit
  // <strong> markup so the Direct Compare Data Row renders the vehicle names
  // as bold (for example: <strong>Defender</strong>).
  return [...table.querySelectorAll('tr')]
    .map((tr, rowIndex) => {
      const cells = [...tr.querySelectorAll('td,th')];
      const values = cells.map(cell => {
        const value = text(cell.textContent);
        return rowIndex === 0 && value
          ? `<strong>${escapeHtml(value)}</strong>`
          : value;
      });
      const [left = '', middle = '', right = ''] = values;
      return { rowType: 'Data', left, middle, right };
    })
    .filter(row => row.left || row.middle || row.right);
}

function parseComparisonDoc(sourceHtml) {
  const doc = new DOMParser().parseFromString(sourceHtml, 'text/html');
  // Read the doc's own bold/italic CSS classes before the <style> block
  // that defines them gets stripped out below.
  const formatClassMap = buildFormatClassMap(doc);
  doc.querySelectorAll('script,style,meta,link').forEach(node => node.remove());
  const tableDisclaimerNodes = extractTableDisclaimers(doc);   // disclaimers typed inside a table cell

  // Some docs put several metadata fields in ONE paragraph ("Meta Title: … Meta Description: … Page Slug: …
  // Buttons: <div…>") or on soft line breaks inside one paragraph. Split such a paragraph into one line
  // per field so every field is read on its own (otherwise Meta Title swallows everything after it and
  // Page Slug is never found).
  {
    const LABELS = 'post title|page title|meta title|meta description|seo title|seo description|keywords?|focus keyphrase|primary keyword|secondary keywords?|page slug|url slug|permalink|page url|canonical url|image shortcode|image code|image link|featured image(?: alt text)?|buttons?(?:\s+(?:code|html|markup))?|cta\s+buttons?(?:\s+(?:code|html|markup))?|recommended internal links|internal links|external links|disclaimers?';
    const labelRe = new RegExp(`(?:^|\\s)(?:${LABELS})\\s*(?:\\([^)]*\\))?\\s*:`, 'gi');
    for (const para of [...doc.body.querySelectorAll('p')]) {
      if (para.closest('table')) continue;
      const clone = para.cloneNode(true);
      clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      const raw = (clone.textContent || '').replace(/\u00A0/g, ' ');
      const starts = [...raw.matchAll(labelRe)].map(m => m.index + (m[0].match(/^\s*/)[0].length));
      if (starts.length < 2) continue;
      const pieces = starts.map((st, i) => raw.slice(st, i + 1 < starts.length ? starts[i + 1] : raw.length).replace(/\s+/g, ' ').trim()).filter(Boolean);
      const lead = raw.slice(0, starts[0]).replace(/\s+/g, ' ').trim();
      if (lead) pieces.unshift(lead);
      const frag = doc.createDocumentFragment();
      for (const piece of pieces) { const np = doc.createElement('p'); np.textContent = piece; frag.appendChild(np); }
      para.replaceWith(frag);
    }
  }
  const blocks = 'p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote';
  // Exclude anything inside the comparison table (Google Docs wraps each
  // cell's text in its own <p>) and anything nested inside another block
  // (e.g. a <p> inside a <blockquote> or <li>) — those aren't doc-level
  // content lines, they're table data or already covered by their parent.
  const nodes = [...doc.body.querySelectorAll(blocks)]
    .filter(node => !node.closest('table'))
    .filter(node => !node.parentElement.closest(blocks));
  // comment-definition lines ("[a] the writer's comment…") never enter the metadata, and comment markers are cut out of every line
  const lines = nodes.filter(node => !isCommentLine(node)).map(cleanNodeText).filter(Boolean);

  const h1 = nodes.find(node => node.tagName === 'H1');
  const suppliedTitle = fieldValue(lines, 'Post Title');
  const suppliedPageTitle = fieldValue(lines, 'Page Title');
  // The page title: the H1 first. Without an H1: a "Post Title:/Page Title:" line, then the doc's "Title"-style line (Google Docs'
  // Title style is not an H1), then the first plain line above the "Store: / Meta Title: ..." lines. A "STOP: please make sure you
  // are in the appropriate tab" notice is never a title.
  const isNotice = v => /^stop\s*:/i.test(v) || /make sure you are in the appropriate tab/i.test(v);
  const titleStyleNode = nodes.find(n => n.tagName !== 'H1' && /(?:^|\s)title(?:\s|$)/i.test(n.getAttribute('class') || '') && cleanNodeText(n) && !isNotice(cleanNodeText(n)));
  const firstPlainLine = (() => {
    for (const n of nodes) {
      if (isCommentLine(n)) continue;
      const v = cleanNodeText(n);
      if (!v || isNotice(v)) continue;
      if (/^[A-Za-z][A-Za-z ()\/&-]{1,40}\s*:/.test(v)) return '';          // the label lines began: no plain title line above them
      return v.length <= 120 ? v : '';
    }
    return '';
  })();
  const title = cleanNodeText(h1) || suppliedTitle || suppliedPageTitle || cleanNodeText(titleStyleNode) || firstPlainLine || '';   // the H1 is ALWAYS the page title
  const metaTitle = fieldValue(lines, 'Meta Title');
  const metaDescription = fieldValue(lines, 'Meta Description');
  // The writer's slug: any of these labels. A full URL or path is cut down to its path.
  const slugSource = ['Page Slug', 'URL Slug', 'Slug', 'Permalink', 'Page URL'].map(l => fieldValue(lines, l)).find(v => v && v.trim()) || '';
  const pageSlug = slugSource.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '');
  const metadataLabels = [
    'Post Title', 'Page Title', 'Meta Title', 'Meta Description', 'SEO Title',
    'SEO Description', 'Keywords', 'Keyword', 'Focus Keyphrase', 'Primary Keyword',
    'Secondary Keywords', 'Page Slug', 'URL Slug', 'Slug', 'Permalink', 'Page URL', 'URL', 'Canonical URL', 'Image Shortcode', 'Image Code', 'Image Link',
    'Featured Image', 'Featured Image Alt Text', 'Buttons', 'Button Code', 'Button HTML', 'CTA Buttons', 'CTA Button Code', 'CTA Button HTML',
    'Recommended Internal Links', 'Internal Links', 'External Links', 'Publish Date',
    'Word Count', 'Content Type'
  ];
  const metadataValues = new Set([
    suppliedTitle, metaTitle, metaDescription,
    ...metadataLabels.map(label => fieldValue(lines, label)),
  ].filter(Boolean));

  // Everything left over — after removing the title, the metadata
  // labels/values, the "Comparison Chart" instruction line, and the whole
  // front-matter block templates carry above the real copy (Keywords, the
  // button-preview line, style-guide Notes, Page Slug, Image Shortcode,
  // Buttons + its code, Recommended Internal Links + its suggestion list) —
  // plus the trailing Disclaimers/footnote block — is the page's real body
  // copy. The table (and where it sits: above, below, or splitting the copy
  // in two) never affects this: table nodes were already excluded above.
  const collectBody = (nodeList) => {
  const metaPairs = fieldPairs(nodeList.filter(node => !isCommentLine(node)).map(cleanNodeText).filter(Boolean), metadataLabels);
  let prevLine = '';
  // Nothing may disappear silently: lines that look like real copy but were left out are reported to the popup.
  const skipped = [];
  const noteSkip = (why, value) => skipped.push({ why, text: value.length > 110 ? value.slice(0, 110) + '…' : value });
  let inFrontMatter = true;
  let skipNext = 0;
  let expectListSkip = false;
  let inDisclaimers = false;
  const bodyNodes = [];
  const disclaimerNodes = [];
  for (const node of nodeList) {
    const value = cleanNodeText(node);
    const before = prevLine; if (value) prevLine = value;          // the line just above (same order as the label/value pairs)
    if (node === h1) continue;          // the (first) H1 is the page title: set separately, never part of the content
    if (!value) continue;
    if (isNotice(value)) continue;       // "STOP: PLEASE MAKE SURE YOU ARE IN THE APPROPRIATE TAB..." is a note for the writer
    // Google Docs' "Title" style paragraph, or a plain copy of the page title as the first line of copy
    if (/(?:^|\s)title(?:\s|$)/i.test(node.getAttribute('class') || '') && node.tagName !== 'H2') continue;
    if (title && bodyNodes.length === 0 && normTitle(value) === normTitle(title)) continue;
    if (/^(?:post\s+title|page\s+title|title)\s*:/i.test(value) && bodyNodes.length === 0) continue;

    // A comment thread — its in-text reference marker or its definition at
    // the bottom — is never page content, no matter where it turns up.
    if (isCommentLine(node)) continue;
    // Raw HTML/code pasted straight into the doc (buttons markup, a table
    // dump) is never page content either, wherever it appears.
    // (If this is the code line that a "Buttons:" label said to skip, that skip is now used up —
    // otherwise the first real paragraph of the page would be swallowed instead.)
    if (isCodeLikeLine(value)) { if (skipNext > 0) skipNext -= 1; continue; }

    // "Image Code: [di-image …]" is a note for the web team, never page copy — wherever it turns up
    // (the line itself, and the code on the next line if the label is on its own).
    if (imageCodePattern.test(value)) {
      if (!/^image\s*(?:code|shortcode|link)\b[^:]*:\s*\S/i.test(value)) skipNext = 1;
      continue;
    }

    if (!inDisclaimers && disclaimersPattern.test(value)) {
      const sameLine = disclaimerRemainder(node);
      if (sameLine) disclaimerNodes.push(sameLine);
      else disclaimerNodes.push(node.cloneNode(true));   // label alone: kept only if real disclaimer lines follow (see below)
      // A Disclaimer line up in the metadata block (before any page copy) is just that one line (or nothing
      // if blank) — the page copy that follows is NOT disclaimer. Further down, everything under the label is.
      if (!(inFrontMatter && bodyNodes.length === 0)) inDisclaimers = true;
      continue; // the label itself is never page copy; text on the same line is kept
    }
    if (inDisclaimers) {
      disclaimerNodes.push(node); // comment-definition lines already filtered out above
      continue;
    }

    if (skipNext > 0) {
      skipNext = 0;
      // only the code line a label announced is skipped; ANY other line is real copy and is never swallowed
      if (/^[<\[]/.test(value) || /\b(?:href|class)\s*=/.test(value)) continue;
    }

    if (inFrontMatter) {
      const tag = node.tagName.toLowerCase();
      if ((tag === 'ul' || tag === 'ol') && expectListSkip) {
        expectListSkip = false;
        continue;
      }
      const isFrontMatterLine = fieldPattern.test(value) || chartLabelPattern.test(value)
        || notePattern.test(value) || metaPairs.has(before + '\u0001' + value) || isLinkOnlyParagraph(node);
      if (isFrontMatterLine) {
        if (notePattern.test(value)) noteSkip('starts with "Note:"', value);
        else if (isLinkOnlyParagraph(node) && !fieldPattern.test(value)) noteSkip('only links (button preview?)', value);
        if (buttonsLabelPattern.test(value) && !/^(?:cta\s+)?buttons?\b[^:]*:\s*\S/i.test(value)) skipNext = 1; // code on the NEXT line (if it is on this line there is nothing to skip)
        if (recommendedLinksPattern.test(value)) expectListSkip = true; // the suggested-links list
        continue;
      }
      inFrontMatter = false; // first real body node
    }

    if (fieldPattern.test(value) || metaPairs.has(before + '\u0001' + value)) continue;
    bodyNodes.push(node);
  }

  return { bodyNodes, disclaimerNodes, skipped };
  };
  let { bodyNodes, disclaimerNodes, skipped } = collectBody(nodes);

  // Google Docs' HTML export gives every bullet point its own separate <ul>
  // (one <li> each) rather than one <ul> per logical list, so adjacent
  // fragments do need to be grouped back into a single list before
  // rendering — but only when they really are the same list. Google Docs
  // tags every <ul>/<ol> it emits with the list's own id in its class
  // (e.g. "lst-kix_3xq2z8j4-0"); fragments that belong to one list all
  // share that id, while two lists that just happen to sit next to each
  // other in the doc (the writer started a second, separate list) get
  // different ids and must stay separate, exactly as Google Docs itself
  // renders them. Only merge on tag-adjacency alone — the old, blunter
  // behavior — when neither side has a recognizable list id at all (HTML
  // pasted from somewhere other than a Google Doc export).
  function listKey(node) {
    const own = (node.getAttribute('class') || '').match(/lst-kix_[\w-]+-\d+/);
    if (own) return own[0];
    const li = node.querySelector('li');
    const liMatch = (li?.getAttribute('class') || '').match(/lst-kix_[\w-]+-\d+/);
    return liMatch ? liMatch[0] : null;
  }

  function groupAdjacentLists(list) {
    const groups = [];
    for (const node of list) {
      const tag = node.tagName.toLowerCase();
      const prevGroup = groups[groups.length - 1];
      if ((tag === 'ul' || tag === 'ol') && prevGroup?.tag === tag) {
        const key = listKey(node);
        const sameList = key && prevGroup.listKey ? key === prevGroup.listKey : !key && !prevGroup.listKey;
        if (sameList) {
          prevGroup.items.push(...[...node.children].filter(item => item.tagName === 'LI'));
          continue;
        }
        groups.push({ tag, items: [...node.children].filter(item => item.tagName === 'LI'), listKey: key });
      } else if (tag === 'ul' || tag === 'ol') {
        groups.push({ tag, items: [...node.children].filter(item => item.tagName === 'LI'), listKey: listKey(node) });
      } else {
        groups.push({ tag, node });
      }
    }
    return groups;
  }

  const renderNodes = list => groupAdjacentLists(list).map(group => {
    if (group.items) {
      const items = group.items.map(item => `<li>${cleanInline(item.innerHTML, formatClassMap)}</li>`).join('');
      return items ? `<${group.tag}>${items}</${group.tag}>` : '';
    }
    const html = cleanInline(group.node.innerHTML, formatClassMap);
    return html ? `<${group.tag}>${html}</${group.tag}>` : '';
  }).filter(Boolean).join('\n');

  let bodyHtml = renderNodes(bodyNodes);

  // Landing docs often keep their copy inside a layout table, which is skipped above (it is how the
  // comparison table is kept out of the body). If nothing at all was found, read inside tables too.
  if (!bodyHtml.trim()) {
    const allNodes = [...doc.body.querySelectorAll(blocks)].filter(node => !node.parentElement.closest(blocks));
    ({ bodyNodes, disclaimerNodes, skipped } = collectBody(allNodes));
    bodyHtml = renderNodes(bodyNodes);
  }

  // Preserve CTA buttons from the Google Doc itself. This supports both
  // actual button links in the exported HTML and raw button HTML stored
  // under a Buttons/CTA Buttons field.
  const sourceButtons = extractButtons(doc.body.innerHTML);
  const contentLines = [...doc.body.querySelectorAll('p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote')]
    .map(node => cleanNodeText(node));
  const buttonField = ['Buttons', 'Button Code', 'Button HTML', 'CTA Buttons', 'CTA Button Code', 'CTA Button HTML'].map(label => fieldValue(contentLines, label)).find(Boolean) || '';
  const buttons = sourceButtons || extractButtons(buttonField);
  // Only append the disclaimer block when the doc actually had real
  // disclaimer copy under the label — a blank "Disclaimers (if applicable):"
  // (or one with only comment/footnote definitions under it) contributes
  // nothing at all, matching the "(if applicable)" wording.
  // Lines that just say "N/A" / "None" are the same as no disclaimer.
  const allDisc = [...disclaimerNodes, ...tableDisclaimerNodes].filter(n => !EMPTY_DISCLAIMER.test(text(n.textContent)));
  // A blank "Disclaimer:" (label only, nothing under it) is removed. With real text, the label stays WITH the text.
  const realDisclaimerNodes = allDisc.some(n => !isDisclaimerLabelOnly(n)) ? allDisc : [];
  let disclaimerHtml = renderNodes(realDisclaimerNodes);
  if (disclaimerHtml) {
    // Keep the writer's disclaimer formatting as-authored. In particular, do not
    // add <small> around paragraphs or list items: it makes the disclaimer hard to read.
    const dRoot = new DOMParser().parseFromString(`<div id="d">${disclaimerHtml}</div>`, 'text/html').querySelector('#d');
    dRoot.querySelectorAll('small').forEach(small => small.replaceWith(...small.childNodes));
    disclaimerHtml = dRoot.innerHTML;
  }
  const fullBodyHtml = (HUB_APPEND_DISCLAIMER && disclaimerHtml)
    ? [bodyHtml, `<div class="disclaimer">${disclaimerHtml}</div>`].filter(Boolean).join('\n')
    : bodyHtml;

  return {
    title,
    metaTitle,
    metaDescription,
    pageSlug,
    bodyHtml: fullBodyHtml,
    disclaimerFound: !!disclaimerHtml && HUB_APPEND_DISCLAIMER,
    disclaimerSkipped: !!disclaimerHtml && !HUB_APPEND_DISCLAIMER,   // found in the doc but deliberately not added
    skipped,                                                         // copy-like lines left out of the body (shown in the popup)
    buttons,
    compareRows: extractCompareRows(doc),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'PARSE_COMPARISON_DOC_HTML') return;
  try {
    globalThis.__diOwnHost = message.ownHost || '';
    sendResponse(parseComparisonDoc(message.sourceHtml));
  } catch (error) {
    sendResponse({ error: error.message || 'Could not read the Google Doc.' });
  }
  return true;
});
