/* Blog "Category" box in the popup: reads the dealer's categories from WordPress (public REST, like the parent pages
 * of the landing form), shows which one will be used for THIS blog, lets you change it. The choice is saved as
 * blogCategoryChoice and used when the post is filled (the fill also works without this box: it reads the same list
 * from the WordPress editor itself). */
(() => {
  const $ = id => document.getElementById(id);
  const sel = $('blog-category'), loadBtn = $('blog-category-load'), note = $('blog-category-note'), adminEl = $('blog-admin-url');
  if (!sel || !loadBtn || !note || !adminEl || !globalThis.diBlogCategory) return;
  const B = globalThis.diBlogCategory;

  let cats = [], draft = null, loadedFor = '';

  const baseOf = v => { try { const u = new URL((v || '').trim()); return u.origin + u.pathname.replace(/\/wp-admin.*$/i, '').replace(/\/$/, ''); } catch { return ''; } };
  const say = (t, bad) => { note.textContent = t || ''; note.style.color = bad ? '#b3261e' : ''; };

  async function fetchCategories(base) {
    for (const style of ['pretty', 'query']) {
      const out = [];
      try {
        for (let page = 1; page <= 5; page++) {
          const q = `per_page=100&page=${page}&_fields=id,name,slug,parent,count`;
          const url = style === 'pretty' ? `${base}/wp-json/wp/v2/categories?${q}` : `${base}/?rest_route=/wp/v2/categories&${q}`;
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) { if (page > 1 && res.status === 400) break; throw new Error('HTTP ' + res.status); }
          const arr = await res.json();
          if (!Array.isArray(arr)) throw new Error('not a list');
          out.push(...arr);
          if (arr.length < 100) break;
        }
        if (out.length) return out;
      } catch (e) { /* try the other URL style */ }
    }
    return [];
  }

  const current = () => sel.value || '__auto';
  function autoPick() {
    if (!cats.length) return null;
    return B.suggest(cats, { title: draft && draft.title, docCategory: draft && draft.category, keyword: draft && draft.keyword, chosen: current() });
  }
  function describe() {
    if (!cats.length) { say(draft ? 'Not loaded yet — the category is also picked from the WordPress editor when the post is filled.' : ''); return; }
    const pick = autoPick();
    say(pick && pick.names.length ? `Will use: ${pick.names.join(', ')} (${pick.why})` : `No category will be set (${pick ? pick.why : 'nothing to match'}).`);
  }
  async function save() {
    await chrome.storage.local.set({ blogCategoryChoice: { value: current(), title: (draft && draft.title) || '' } });
    describe();
  }

  async function load(manual) {
    const base = baseOf(adminEl.value);
    if (!base) { if (manual) say('Enter the WordPress admin URL first.', true); return; }
    loadBtn.disabled = true; say('Reading categories from the site…');
    try {
      const got = await fetchCategories(base);
      if (!got.length) { say('Could not read the categories (the site may block the public list). They are read from the WordPress editor when the post is filled.', true); return; }
      cats = got; loadedFor = base;
      const keep = current();
      sel.replaceChildren(
        new Option('Auto — features blog → the features category', '__auto'),
        new Option("Don't set a category", '__none'),
        ...cats.map(c => new Option(B.decode(c.name), B.decode(c.name))).filter(o => B.flat(o.value) !== 'uncategorized')
      );
      sel.value = [...sel.options].some(o => o.value === keep) ? keep : '__auto';
      await save();
    } finally { loadBtn.disabled = false; }
  }

  sel.addEventListener('change', save);
  loadBtn.addEventListener('click', () => load(true));

  function setDraft(d) {
    const changed = (d && d.title) !== (draft && draft.title);
    draft = d || null;
    if (changed) { sel.value = '__auto'; chrome.storage.local.remove('blogCategoryChoice'); }
    describe();
    if (draft && !cats.length && baseOf(adminEl.value) && loadedFor !== baseOf(adminEl.value)) load(false);
    else if (draft && cats.length) save();
  }
  chrome.runtime.sendMessage({ type: 'GET_PENDING_DRAFT' }, r => { if (r && r.ok) setDraft(r.draft); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.pendingWordPressDraft) setDraft(changes.pendingWordPressDraft.newValue);
  });
})();
