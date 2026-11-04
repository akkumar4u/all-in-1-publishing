// Templates use both `Meta Title: value` and a separate `Meta Title` label
// followed by the value. Both forms are metadata and must never enter the
// article HTML.
const fieldPattern = /^(post title|page title|meta title|meta description|seo title|seo description|page slug|url|canonical url|keywords?|focus keyphrase|primary keyword|secondary keywords?|tags|category|author|alt text|featured image(?: alt text)?|image shortcode|buttons?(?:\s+(?:code|html|markup))?|cta\s+buttons?(?:\s+(?:code|html|markup))?|recommended internal links|internal links|external links|publish date|word count|content type)\s*(?:\([^)]*\))?\s*(?::\s*.*)?$/i;
const notePattern = /^note\s*:/i;
// SWITCH: the disclaimer block is currently NOT added to the page (it is still cut out of the article text,
// so it never ends up in the body). Set to true to add the "Disclaimers" copy at the end again.
const BLOG_APPEND_DISCLAIMER = true;
const disclaimersPattern = /^disclaimers?\b/i;
const EMPTY_DISCLAIMER = /^(?:n\/?a|none|no|nil|not applicable|no disclaimers?|[-–—.]+)$/i;
const imageCodePattern = /^image\s*(?:code|shortcode|link)\b/i;
// "Disclaimers (if applicable): Prices exclude tax." — the real text can sit on the SAME line as the label.
// Return a copy of that line without the label (and any comment marker), or null when nothing real is left.
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
const text = value => (value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
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

// A line that's literally raw HTML/code — pasted button markup, a table
// dump, etc. — dropped straight into the doc without a preceding label to
// flag it. Real prose never starts with a literal "<", so this is safe to
// treat as junk wherever it turns up.
function isCodeLikeLine(value) {
  const v = value.trim();
  return v.startsWith('<') || /^\[di-image\b/i.test(v);   // pasted HTML, or an image shortcode like [di-image id='…']
}

function fieldValue(lines, label) {
  const inlinePattern = new RegExp(`^${label}\\s*(?:\\([^)]*\\))?\\s*:\\s*(.*)$`, 'i');
  const labelPattern = new RegExp(`^${label}\\s*(?:\\([^)]*\\))?\\s*$`, 'i');
  const index = lines.findIndex(line => inlinePattern.test(line) || labelPattern.test(line));
  if (index < 0) return '';
  const inlineMatch = lines[index].match(inlinePattern);
  if (inlineMatch?.[1]?.trim()) return inlineMatch[1].trim();

  // A blank metadata field must stay blank. Never take the following label
  // (for example, “Buttons:”) as its value.
  const nextLine = lines[index + 1] || '';
  return fieldPattern.test(nextLine) ? '' : nextLine;
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

const METADATA_LABELS = [
    'Post Title', 'Page Title', 'Meta Title', 'Meta Description', 'SEO Title',
    'SEO Description', 'Page Slug', 'URL', 'Canonical URL', 'Keywords',
    'Keyword', 'Focus Keyphrase', 'Primary Keyword', 'Secondary Keywords',
    'Tags', 'Category', 'Author', 'Alt Text', 'Featured Image Alt Text',
    'Featured Image', 'Image Shortcode', 'CTA Buttons', 'Buttons', 'Button Code', 'CTA Button Code', 'Button HTML', 'CTA Button HTML',
    'Recommended Internal Links', 'Internal Links', 'External Links',
    'Publish Date', 'Word Count', 'Content Type'
];

function metadataValues(lines) {
  const labels = [
    'Post Title', 'Page Title', 'Meta Title', 'Meta Description', 'SEO Title',
    'SEO Description', 'Page Slug', 'URL', 'Canonical URL', 'Keywords',
    'Keyword', 'Focus Keyphrase', 'Primary Keyword', 'Secondary Keywords',
    'Tags', 'Category', 'Author', 'Alt Text', 'Featured Image Alt Text',
    'Featured Image', 'Image Shortcode', 'CTA Buttons', 'Buttons',
    'Recommended Internal Links', 'Internal Links', 'External Links',
    'Publish Date', 'Word Count', 'Content Type'
  ];
  return new Set(labels.map(label => fieldValue(lines, label)).filter(Boolean));
}

// Google Docs' HTML export renders bold/italic runs as <span class="cN">
// with the actual "font-weight:700"/"font-style:italic" declared on .cN in
// a <style> block — not as literal <b>/<strong>/<i>/<em> tags. Reading that
// map (built from the doc's own <style> block before it gets stripped) is
// what lets a plain <span class="c4"> that Google Docs used for bold text
// come back out as <strong> instead of being silently unwrapped.
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
      if (!bold && !italic) continue;
      match[1].split(',').forEach(selector => {
        const clsMatch = selector.trim().match(/^\.([\w-]+)$/);
        if (!clsMatch) return;
        const entry = map[clsMatch[1]] || (map[clsMatch[1]] = {});
        if (bold) entry.bold = true;
        if (italic) entry.italic = true;
      });
    }
  });
  return map;
}

function cleanInline(html = '', formatClassMap = {}) {
  const document = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = document.querySelector('#root');
  [...root.querySelectorAll('*')].reverse().forEach(node => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return;
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      const id = node.getAttribute('id') || '';
      const classes = node.getAttribute('class') || '';
      // A CTA button link (class="button"/"primary-button") is already
      // captured separately as its own field (see extractButtons) and
      // positioned by articleHtml() — leaving it in the inline article text
      // too would both duplicate it and, if it shared a paragraph with real
      // opening copy, previously caused that whole paragraph to be dropped
      // (see isButtonOnlyParagraph below), pushing the CTA insertion point
      // to the next paragraph instead of the true first one. Drop just the
      // button link here and keep the rest of the paragraph's prose.
      if (/\b(button|primary-button)\b/i.test(classes)) {
        node.outerHTML = '';
        return;
      }
      // Google Docs comment references/definitions ("[a]" linking to
      // "#cmnt1"/"#cmnt_ref1", with a matching "cmnt.../cmnt_ref..." id on
      // either side) are doc-authoring artifacts, not real links — drop
      // them entirely rather than carrying them into the article.
      if (/^#?cmnt/i.test(href) || /^cmnt/i.test(id)) {
        node.outerHTML = '';
        return;
      }
      const inner = node.innerHTML;
      // Google wraps links as google.com/url?q=REAL — use the real address; external links open in a new tab, nofollow
      const L = globalThis.diLinkRules ? globalThis.diLinkRules.resolve(href, globalThis.__diOwnHost) : { href, external: false };
      node.outerHTML = href && text(node.textContent) ? `<a href="${escapeHtml(L.href)}"${L.external ? ' target="_blank" rel="nofollow noopener"' : ''}>${inner}</a>` : inner;
      return;
    }
    // Preserve document structure, but rebuild tags without Google Docs'
    // classes/styles. This retains real lists (including nested lists) and
    // real table markup in the final WordPress HTML without carrying over
    // any Google Docs CSS.
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
      // tags (e.g. a whole line in <b>, with the first phrase in a second,
      // redundant <b>) — collapse any same-semantic descendant before
      // wrapping, so this never surfaces as <strong><strong>...</strong></strong>.
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
      return acc;
    }, {});
    let content = node.innerHTML;
    if (fmt.bold) content = `<strong>${content}</strong>`;
    if (fmt.italic) content = `<em>${content}</em>`;
    node.outerHTML = content;
  });
  return root.innerHTML.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function isCommentLine(node) {
  const first = node.firstElementChild;
  if (!first || first.tagName !== 'A') return false;
  const href = first.getAttribute('href') || '';
  const id = first.getAttribute('id') || '';
  return /^#?cmnt/i.test(href) || /^cmnt/i.test(id);
}

// A paragraph made up entirely of CTA button link(s) — e.g. a "[Learn More]
// [Contact Us]" preview line pasted straight into the doc — with no other
// prose is a button preview, not article copy, so drop the whole paragraph
// (its links were already captured separately by extractButtons). A
// paragraph that *also* has real opening copy alongside a button preview
// must NOT be dropped wholesale, though — only the button link inside it
// is stripped (see cleanInline's <a> handling above); the prose stays as
// the article's real first paragraph. Getting this wrong previously meant
// a mixed paragraph got discarded entirely, so the CTA buttons (inserted
// after the doc's first surviving <p>) landed after what was really the
// *second* paragraph instead of the first.
function isButtonOnlyParagraph(node) {
  if (!node.querySelector('a.button, a.primary-button')) return false;
  const clone = node.cloneNode(true);
  clone.querySelectorAll('a').forEach(a => a.remove());
  return !text(clone.textContent);
}

// Google Docs' HTML export gives every bullet point its own separate <ul>
// (one <li> each) rather than one <ul> per logical list, so adjacent
// fragments do need to be grouped back into a single list before
// rendering — but only when they really are the same list. Google Docs
// tags every <ul>/<ol> it emits with the list's own id in its class (e.g.
// "lst-kix_3xq2z8j4-0"); fragments belonging to one list all share that
// id, while two lists that just happen to sit next to each other (the
// writer started a second, separate list) get different ids and must stay
// separate, exactly as Google Docs itself renders them. Only merge on
// tag-adjacency alone — the old, blunter behavior — when neither side has
// a recognizable list id at all (HTML pasted from somewhere other than a
// Google Doc export).
function listKey(node) {
  const own = (node.getAttribute('class') || '').match(/lst-kix_[\w-]+-\d+/);
  if (own) return own[0];
  const li = node.querySelector('li');
  const liMatch = (li?.getAttribute('class') || '').match(/lst-kix_[\w-]+-\d+/);
  return liMatch ? liMatch[0] : null;
}

function groupAdjacentLists(nodeList) {
  const groups = [];
  for (const node of nodeList) {
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

function renderGroups(groups, formatClassMap) {
  return groups.map(group => {
    if (group.items) {
      const items = group.items.map(item => `<li>${cleanInline(item.innerHTML, formatClassMap)}</li>`).join('');
      return items ? `<${group.tag}>${items}</${group.tag}>` : '';
    }
    const html = cleanInline(group.node.innerHTML, formatClassMap);
    return html ? `<${group.tag}>${html}</${group.tag}>` : '';
  }).filter(Boolean).join('\n');
}

function extractButtons(markup = '') {
  const sources = [String(markup || '')];
  for (let i = 0; i < 3; i++) {
    const box = document.createElement('textarea'); box.innerHTML = sources[sources.length - 1];
    if (box.value === sources[sources.length - 1]) break;
    sources.push(box.value);
  }
  const validHref = href => /^(?:https?:\/\/|\/|#|mailto:|tel:)/i.test(String(href || '').trim());
  let links = [];
  for (const source of sources) {
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    links = [...parsed.querySelectorAll('a.button, a.primary-button, a[class*="button"]')].map(link => {
      const href = (link.getAttribute('href') || '').trim();
      const label = cleanNodeText(link);
      const classes = [...link.classList].filter(name => name === 'button' || name === 'primary-button').join(' ');
      return validHref(href) && label ? `<a class="${classes || 'button'}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : '';
    }).filter(Boolean);
    if (links.length) break;
    // Google Docs can corrupt the href with escaped closing/opening span tags.
    // Recover the URL from inside each explicitly labelled button anchor.
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
  return links.length ? `<div class="center">${links.join(' ')}</div>` : '';
}

function parseGoogleDoc(sourceHtml) {
  const document = new DOMParser().parseFromString(sourceHtml, 'text/html');
  // Read the doc's own bold/italic CSS classes before the <style> block
  // that defines them gets stripped out below.
  const formatClassMap = buildFormatClassMap(document);
  document.querySelectorAll('script,style,meta,link').forEach(node => node.remove());
  const blocks = 'p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,table';
  const nodes = [...document.body.querySelectorAll(blocks)].filter(node => !node.parentElement.closest(blocks));
  const lines = nodes.map(node => isCommentLine(node) ? '' : cleanNodeText(node)).filter(Boolean);
  const suppliedTitle = fieldValue(lines, 'Post Title');
  const slug = fieldValue(lines, 'Page Slug').replace(/^\/+|\/+$/g, '');
  const buttonField = ['CTA Buttons', 'Buttons', 'CTA Button Code', 'Button Code', 'CTA Button HTML', 'Button HTML'].map(label => fieldValue(lines, label)).find(Boolean) || '';
  const buttons = extractButtons(sourceHtml) || extractButtons(buttonField);
  const metadata = metadataValues(lines);
  metadata.add(suppliedTitle);
  metadata.add(slug);

  // Same convention as the Comparison Page brief: everything from
  // "Disclaimers (if applicable):" to the end of the doc is normally just
  // comment/footnote definitions, never article copy — but real disclaimer
  // prose there must not be thrown away either.
  let inDisclaimers = false;
  let skipImageCodeLine = false;
  const disclaimerNodes = [];
  const metaPairs = fieldPairs(lines, METADATA_LABELS);
  let prevLine = '';
  // Nothing may disappear silently: lines that look like real copy but were left out are reported to the popup.
  const skipped = [];
  const noteSkip = (why, value) => skipped.push({ why, text: value.length > 110 ? value.slice(0, 110) + '…' : value });
  const articleNodes = nodes.filter(node => {
    const value = text(node.textContent);
    if (!value) return false;
    const before = prevLine; prevLine = value;     // the line just above (same order as `lines`)
    if (isCommentLine(node)) return false;
    if (isCodeLikeLine(value)) { skipImageCodeLine = false; return false; }
    if (skipImageCodeLine) { skipImageCodeLine = false; if (/^\[/.test(value)) return false; }
    // "Image Code: [di-image …]" is a note for the web team, never article copy
    if (imageCodePattern.test(value)) { if (!/^image\s*(?:code|shortcode|link)\b[^:]*:\s*\S/i.test(value)) skipImageCodeLine = true; return false; }
    if (!inDisclaimers && disclaimersPattern.test(value)) {
      inDisclaimers = true;
      const sameLine = disclaimerRemainder(node);        // text typed on the same line as the label is real disclaimer copy (kept WITH its label)
      disclaimerNodes.push(sameLine || node.cloneNode(true));   // label alone: kept only if real lines follow
      return false;
    }
    if (inDisclaimers) { disclaimerNodes.push(node); return false; }
    if (notePattern.test(value)) { noteSkip('starts with "Note:"', value); return false; }
    // CTA source labels and a paragraph made up of *only* button links are
    // metadata, never article content — but a paragraph with real prose
    // alongside a button preview keeps its prose (see isButtonOnlyParagraph
    // above and cleanInline's <a> handling, which strips just the button
    // link out of it).
    if (fieldPattern.test(value)) return false;
    if (/^stop\s*:/i.test(value) || /make sure you are in the appropriate tab/i.test(value)) return false;   // a note for the writer, not content
    if (metaPairs.has(before + '\u0001' + value)) return false;       // the value typed right under its label
    if (isButtonOnlyParagraph(node)) return false;
    return true;
  });
  const h1 = articleNodes.find(node => node.tagName === 'H1');
  // The H1 of the doc is ALWAYS the post title; "Post Title" field / first line are only fallbacks.
  const title = cleanNodeText(h1) || suppliedTitle || cleanNodeText(articleNodes[0]) || 'Untitled post';   // H1 is always the title
  // Without an H1, use the opening line as a fallback title but keep its
  // paragraph in the article instead of silently dropping it.
  const bodyList = h1 ? articleNodes.filter(node => node !== h1) : articleNodes;
  const body = renderGroups(groupAdjacentLists(bodyList), formatClassMap);
  // Only append the disclaimer block when the doc actually had real
  // disclaimer copy under the label — a blank one (or one with only
  // comment/footnote definitions under it) contributes nothing at all.
  const allDisc = disclaimerNodes.filter(n => !EMPTY_DISCLAIMER.test(text(n.textContent)));   // "N/A" / "None" = no disclaimer
  // blank "Disclaimer:" (label only) is removed; with real text the label stays with the text
  const realDisclaimerNodes = allDisc.some(n => !isDisclaimerLabelOnly(n)) ? allDisc : [];
  let disclaimerHtml = renderGroups(groupAdjacentLists(realDisclaimerNodes), formatClassMap);
  if (disclaimerHtml) {
    // <small> around block tags is invalid HTML; wrap the text of each paragraph / list item instead (looks the same)
    const dRoot = new DOMParser().parseFromString(`<div id="d">${disclaimerHtml}</div>`, 'text/html').querySelector('#d');
    dRoot.querySelectorAll('p, li').forEach(el => { if (!el.querySelector(':scope > small')) el.innerHTML = `<small>${el.innerHTML}</small>`; });
    disclaimerHtml = dRoot.innerHTML;
  }
  const fullBody = (BLOG_APPEND_DISCLAIMER && disclaimerHtml)
    ? [body, `<div class="disclaimer">${disclaimerHtml}</div>`].filter(Boolean).join('\n')
    : body;
  return { skipped, title, slug, metaTitle: fieldValue(lines, 'Meta Title'), metaDescription: fieldValue(lines, 'Meta Description'), keyword: fieldValue(lines, 'Keywords'), tags: fieldValue(lines, 'Tags'), category: fieldValue(lines, 'Category'), author: fieldValue(lines, 'Author'), altText: fieldValue(lines, 'Alt Text') || fieldValue(lines, 'Featured Image Alt Text'), imageShortcode: fieldValue(lines, 'Image Shortcode'), buttons, content: fullBody };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'PARSE_GOOGLE_DOC_HTML') return;
  try { globalThis.__diOwnHost = message.ownHost || ''; sendResponse(parseGoogleDoc(message.sourceHtml)); }
  catch (error) { sendResponse({ error: error.message || 'Could not clean the Google Doc HTML.' }); }
  return true;
});
