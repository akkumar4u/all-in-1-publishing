const { JSDOM } = require('jsdom');

function check(name, ok, level, detail = '') {
  return { name: `Server QA — ${name}`, ok: !!ok, level: ok ? 'ok' : level, detail };
}

function runContentQa({ title = '', slug = '', metaTitle = '', metaDescription = '', contentHtml = '', buttonsHtml = '', isVrp = false } = {}) {
  const titleText = String(title).trim(), slugText = String(slug).trim();
  const metaTitleText = String(metaTitle).trim(), metaDescriptionText = String(metaDescription).trim();
  const dom = new JSDOM(`<main>${String(contentHtml)}\n${String(buttonsHtml)}</main>`);
  try {
    const root = dom.window.document.querySelector('main');
    const text = root.textContent.replace(/\s+/g, ' ').trim();
    const images = [...root.querySelectorAll('img')];
    const missingAlt = images.filter(image => !image.hasAttribute('alt') || !image.getAttribute('alt').trim()).length;
    const hrefs = [...root.querySelectorAll('a[href]')].map(a => a.getAttribute('href').trim()).filter(Boolean);
    const normalized = hrefs.map(href => href.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase());
    const duplicateLinks = normalized.filter((href, i) => normalized.indexOf(href) !== i).length;
    const placeholders = [...new Set((text.match(/%%[a-z0-9_]+%%/gi) || []).filter(token => !/^%%(?:di_name|di_city|di_state|phone_service|phone_sales|target_city_[12])%%$/i.test(token)))];
    const checks = [
      check('title present', !!titleText, 'error'),
      check('slug present', !!slugText, 'warn', slugText || 'WordPress can generate a slug from the title.'),
      check('meta title length', metaTitleText.length > 0 && metaTitleText.length <= 60, 'warn', `${metaTitleText.length} characters · recommended 1–60`),
      check('meta description length', metaDescriptionText.length > 0 && metaDescriptionText.length <= 160, 'warn', `${metaDescriptionText.length} characters · recommended 1–160`),
      check('content present', !!text, 'error', `${text ? text.split(/\s+/).length : 0} words`),
      check('image alt text', missingAlt === 0, 'warn', missingAlt ? `${missingAlt} image(s) missing alt text` : `${images.length} image(s) checked`),
      check('duplicate links', duplicateLinks === 0, 'warn', duplicateLinks ? `${duplicateLinks} repeated link(s)` : `${normalized.length} links checked`),
      check('unresolved placeholders', placeholders.length === 0, 'warn', placeholders.length ? placeholders.join(', ') : 'No unknown %%...%% tokens found.'),
    ];
    if (isVrp) {
      const first = [...root.children].find(node => node.textContent.trim());
      checks.push(check('VRP heading structure', root.querySelectorAll('h1').length === 0 && first?.tagName === 'H2', 'error', `${root.querySelectorAll('h1').length} H1 · ${root.querySelectorAll('h2').length} H2`));
    }
    return checks;
  } finally { dom.window.close(); }
}

module.exports = { runContentQa };
