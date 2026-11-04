/* Blog category picker (a classic script AND a side-effect import of the service worker: it adds one global,
 * diBlogCategory). Every dealer names its categories differently ("Chevy Features", "Chevrolet Features", "Model
 * Features", ...), so nothing is hard-coded per dealer: the real category list of the dealer's WordPress is read
 * (REST) and the best match is chosen from it.
 *
 *   - A blog about car / model FEATURES gets ONE category: the make's own features category when the blog is about
 *     that make ("BMW Features"), otherwise "Model Features" (then "Car / Vehicle Features", then any "... Features").
 *   - Any other blog gets the category that has the same name as the Category written in the Google Doc.
 *   - Your own choice in the popup always wins; "Don't set a category" leaves WordPress's default.
 */
(function (g) {
  const decode = t => String(t == null ? '' : t)
    .replace(/&amp;|&#0*38;/g, '&').replace(/&#0*39;|&#8217;|&#8216;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;|&#8220;|&#8221;/g, '"');
  const flat = t => decode(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const MAKES = [
    ['chevrolet', 'chevy'], ['ford'], ['toyota'], ['honda'], ['kia'], ['hyundai'], ['nissan'], ['subaru'], ['mazda'],
    ['bmw'], ['mercedes benz', 'mercedes'], ['volkswagen', 'vw'], ['cadillac'], ['buick'], ['gmc'], ['jeep'], ['dodge'],
    ['ram'], ['chrysler'], ['lexus'], ['acura'], ['genesis'], ['mini'], ['mitsubishi'], ['volvo'], ['audi'], ['lincoln'],
    ['infiniti'], ['porsche'], ['land rover'], ['jaguar'], ['tesla'], ['fiat'], ['alfa romeo'],
  ];
  const hasWord = (hay, w) => (' ' + hay + ' ').includes(' ' + w + ' ');
  const makesIn = text => { const t = flat(text); return MAKES.filter(a => a.some(w => hasWord(t, w))); };

  const FEATURES = /\bfeatures?\b/;
  const isFeatureBlog = ctx => FEATURES.test(flat(ctx.docCategory)) || FEATURES.test(flat(ctx.title)) || FEATURES.test(flat(ctx.keyword));

  /* cats: [{ id, name, ... }] from /wp/v2/categories.  ctx: { title, docCategory, keyword, chosen }
     -> { ids: [id], names: [name], why: 'text' } */
  function suggest(cats, ctx) {
    ctx = ctx || {};
    const list = (cats || []).map(c => ({ id: c.id, name: decode(c.name), f: flat(c.name) })).filter(c => c.f && c.f !== 'uncategorized');
    const none = why => ({ ids: [], names: [], why });
    if (ctx.chosen === '__none') return none('no category (your choice)');
    if (ctx.chosen && ctx.chosen !== '__auto') {
      const hit = list.find(c => c.f === flat(ctx.chosen));
      if (hit) return { ids: [hit.id], names: [hit.name], why: 'your choice' };
    }
    if (!list.length) return none('the site has no categories to choose from');

    if (isFeatureBlog(ctx)) {
      const feats = list.filter(c => FEATURES.test(c.f));
      if (feats.length) {
        const blogMakes = makesIn([ctx.title, ctx.docCategory, ctx.keyword].join(' '));
        const score = c => {
          let s = 0;
          if (blogMakes.some(a => a.some(w => hasWord(c.f, w)))) s += 100;          // "BMW Features" for a BMW blog
          if (c.f === 'model features') s += 60; else if (/\bmodel\b/.test(c.f)) s += 40;
          else if (/\b(car|vehicle|auto)\b/.test(c.f)) s += 30;
          else if (c.f === 'features') s += 20;
          // a make-specific category of ANOTHER make is the wrong one
          if (MAKES.some(a => a.some(w => hasWord(c.f, w)) && !blogMakes.includes(a))) s -= 80;
          return s - c.f.split(' ').length * 0.1;
        };
        const best = feats.map(c => ({ c, s: score(c) })).sort((a, b) => b.s - a.s)[0].c;
        return { ids: [best.id], names: [best.name], why: 'features blog -> the features category only' };
      }
    }
    const parts = decode(ctx.docCategory || '').split(/[,;|\n]+/).map(flat).filter(Boolean);
    for (const p of parts) {
      const exact = list.find(c => c.f === p);
      const loose = exact || list.find(c => p.length >= 4 && (c.f.includes(p) || (c.f.length >= 4 && p.includes(c.f))));
      if (loose) return { ids: [loose.id], names: [loose.name], why: exact ? 'same name as the Category in the Google Doc' : 'closest to the Category in the Google Doc' };
    }
    return none(parts.length ? `no category on this site matches "${ctx.docCategory}"` : 'the Google Doc has no Category');
  }

  g.diBlogCategory = { suggest, flat, decode, isFeatureBlog };
})(typeof globalThis !== 'undefined' ? globalThis : this);
