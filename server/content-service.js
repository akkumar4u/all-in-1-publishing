const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const templates = [
  'core/hub-core.js', 'pages/service.js', 'pages/research.js', 'pages/finance.js',
  'pages/comparison.js', 'pages/landing.js', 'hub-templates.js',
];

function makeTemplateContext() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const window = dom.window;
  const context = vm.createContext({
    DOMParser: window.DOMParser, NodeFilter: window.NodeFilter, document: window.document,
    URL, console, chrome: { runtime: { onMessage: { addListener() {} } } },
  });
  try {
    for (const rel of templates) vm.runInContext(fs.readFileSync(path.join(SRC, rel), 'utf8'), context, { filename: rel, timeout: 5000 });
    vm.runInContext(fs.readFileSync(path.join(SRC, 'link_rules.js'), 'utf8'), context, { filename: 'link_rules.js', timeout: 3000 });
    return { dom, context };
  } catch (error) { window.close(); throw error; }
}

function fixLinks(context, html, adminUrl) {
  let host = '';
  try { host = new URL(adminUrl).hostname; } catch { /* optional for manual drafts */ }
  context.__payloadHtml = String(html || '');
  context.__payloadHost = host;
  return vm.runInContext('diLinkRules.fixHtml(__payloadHtml, __payloadHost)', context, { timeout: 5000 });
}

function prepareVrpBody(context, bodyHtml, title) {
  context.__bodyHtml = String(bodyHtml || ''); context.__pageTitle = String(title || '').trim();
  return vm.runInContext(`(() => {
    const root = new DOMParser().parseFromString('<div id="r">' + __bodyHtml + '</div>', 'text/html').querySelector('#r');
    root.querySelectorAll('a.button, a.primary-button, a[class*="button"]').forEach(a => a.remove());
    [...root.querySelectorAll('div, p')].reverse().forEach(n => { if (!n.textContent.trim() && !n.children.length) n.remove(); });
    root.querySelectorAll('h1').forEach(h1 => { const h2 = document.createElement('h2'); for (const a of h1.attributes) h2.setAttribute(a.name, a.value); h2.innerHTML = h1.innerHTML; h1.replaceWith(h2); });
    if (__pageTitle) {
      const first = [...root.children].find(n => n.textContent.trim());
      const norm = t => t.replace(/\\s+/g, ' ').trim().toLowerCase();
      if (!(first && first.tagName === 'H2' && norm(first.textContent) === norm(__pageTitle))) { const h2 = document.createElement('h2'); h2.textContent = __pageTitle; root.prepend(h2); }
    }
    const inner = root.innerHTML;
    return /^\\s*<div[^>]*max-width:\\s*1175px/i.test(inner) ? inner : '<div style="margin-right: auto; margin-left: auto; max-width:1175px;">\\n' + inner + '\\n</div>';
  })()`, context, { timeout: 5000 });
}

function composeBlogContent(bodyHtml, buttonsHtml, imageShortcode, context) {
  context.__blogBody = String(bodyHtml || ''); context.__blogButtons = String(buttonsHtml || ''); context.__blogImage = String(imageShortcode || '');
  return vm.runInContext(`(() => {
    const root = new DOMParser().parseFromString('<div id="r">' + __blogBody + '</div>', 'text/html').querySelector('#r');
    root.querySelectorAll('a.button, a.primary-button, a[class*=button]').forEach(a => a.remove());
    root.querySelectorAll('div.text-center, div.center').forEach(w => { if (!w.textContent.trim() && !w.querySelector('img')) w.remove(); });
    root.querySelectorAll('div.well').forEach(w => { if (/\\[di_posts\\b/i.test(w.textContent)) w.remove(); });
    let article = root.innerHTML.trim();
    if (__blogImage && article.startsWith(__blogImage.trim())) article = article.slice(__blogImage.trim().length).trim();
    let buttons = __blogButtons.trim().replace(/^\\s*(?:buttons?|cta\\s*buttons?|button\\s*code|cta\\s*button\\s*code)\\s*:\\s*/i, '').replace(/<\\/a>\\s*<a\\b/gi, '</a> <a').trim();
    if (buttons) { const end = article.indexOf('</p>'); article = end < 0 ? (buttons + '\\n\\n' + article).trim() : (article.slice(0, end + 4) + '\\n\\n' + buttons + '\\n\\n' + article.slice(end + 4)).trim(); }
    const feed = '<div class="well"><div class="center"><h2>More from %%di_name%%</h2></div>[di_posts posts_per_page="3" excerpt="true" date="false" thumbs="false"]</div>';
    return [__blogImage.trim(), article, feed].filter(Boolean).join('\\n\\n');
  })()`, context, { timeout: 5000 });
}

function buildPublishingPayload(input = {}) {
  const kind = String(input.kind || '');
  const { dom, context } = makeTemplateContext();
  try {
    if (kind === 'hub') {
      context.__hubType = String(input.hubType || ''); context.__hubInputs = input.inputs || {};
      const hub = vm.runInContext('generateHub(__hubType, __hubInputs)', context, { timeout: 7000 });
      return JSON.parse(JSON.stringify({ hub }));
    }
    if (kind === 'blog') {
      const blog = input.blog || {};
      const content = fixLinks(context, composeBlogContent(blog.bodyHtml, blog.buttons, blog.imageShortcode, context), input.adminUrl || '');
      return { blog: { content } };
    }
    if (kind === 'page') {
      const doc = input.doc || {};
      const title = String(doc.title || '').trim();
      const isVrp = !!input.isVrp;
      const body = isVrp ? prepareVrpBody(context, doc.bodyHtml, title) : String(doc.bodyHtml || '');
      const content = fixLinks(context, body, input.adminUrl || '');
      const prepared = {
        title, slug: String(doc.pageSlug || '').trim(), metaTitle: String(doc.metaTitle || '').trim(),
        metaDescription: String(doc.metaDescription || '').trim(), buttonsHtml: String(doc.buttons || ''), content,
        compareRows: Array.isArray(doc.compareRows) ? doc.compareRows : [],
      };
      let hub = null;
      if (input.pageKind) {
        const hubInputs = {
          pageTitle: title, pageSlug: prepared.slug, comparisonMetaTitle: prepared.metaTitle,
          comparisonMetaDescription: prepared.metaDescription, ctaLearnMoreUrl: '', ctaInventoryUrl: '', vehicleName: '',
          ctaBodyContent: content, compareRows: prepared.compareRows, ctaButtonsHtml: prepared.buttonsHtml,
          landingParent: String(input.parent || ''), templateName: isVrp ? 'Lightning' : 'DI Page Composer',
          vrpSeoContent: isVrp, landingBottom: isVrp ? '' : (input.landingBottom === 'form' ? 'form' : 'blog'), landingImage: null,
        };
        context.__pageKind = String(input.pageKind); context.__pageInputs = hubInputs;
        hub = vm.runInContext('generateHub(__pageKind, __pageInputs)', context, { timeout: 7000 });
        hub = JSON.parse(JSON.stringify(hub));
      }
      return { prepared, hub };
    }
    return null;
  } finally { dom.window.close(); }
}

module.exports = { buildPublishingPayload };
