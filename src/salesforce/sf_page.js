/**
 * Code that runs INSIDE the Salesforce page (injected with chrome.scripting).
 * One self-contained function: Chrome copies only this function into the page, so
 * every helper it needs is defined inside it. `action` picks what to do.
 * Returns plain JSON: { ok, data?, error?, log[] }.
 */
export async function sfPageRun(action, cfg, params) {
  const log = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  // Text a person actually SEES: skips Salesforce's hidden "assistive" labels and icon buttons
  // (this is where the stray "Preview" next to an account name comes from).
  const visibleText = el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement && n.parentElement.closest('.slds-assistive-text, [class*="assistive" i], button')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const parts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue);
    return norm(parts.join(' ')).replace(/\s*Preview\s*$/, '');
  };

  // Every element, including ones inside (open) shadow roots.
  function deepAll() {
    const out = [];
    const walk = root => {
      for (const el of root.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  }
  async function waitFor(fn, timeoutMs, stepMs = 100) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch { /* keep polling */ }
      await sleep(stepMs);
    }
    return null;
  }
  const isVisible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const absUrl = href => { try { return new URL(href, location.href).toString(); } catch { return null; } };
  const pressEnter = el => {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true, cancelable: true,
      }));
    }
  };
  const DOC_RE = /https?:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{15,})[^\s"'<>)]*/g;

  /* ---- Google Doc links -------------------------------------------------------------------
   * The link lives in the ticket's "Details" field. Its text is different on every ticket
   * ("Content Bank: <url>", "Template: <url>", "Publish this document:\n<url>", "n/a" ...) so we
   * do NOT depend on any wording: we read the whole Details field as lines of text (plus every
   * <a href> in it), pull out every Google Doc URL, and remember the words in front of it
   * as a label so the person can tell them apart.
   */
  const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
  const BLOCK = /^(P|DIV|LI|UL|OL|BR|TR|TD|TH|H[1-6]|SECTION|ARTICLE|PRE|BLOCKQUOTE|LIGHTNING-FORMATTED-RICH-TEXT|LIGHTNING-FORMATTED-TEXT)$/;
  // Text of an element, with a line break at <br> and block boundaries (so a URL never runs into
  // the next line), looking inside shadow roots too.
  function structuredText(root) {
    let out = '';
    const walk = node => {
      if (node.nodeType === 3) { out += node.nodeValue; return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      const tag = node.tagName || '';
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      const block = BLOCK.test(tag);
      if (block) out += '\n';
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const c of node.childNodes) walk(c);
      if (block) out += '\n';
    };
    walk(root);
    return out.replace(ZERO_WIDTH, '').replace(/\u00A0/g, ' ');
  }
  const fullUrl = u => u.replace(/&amp;/g, '&').replace(/[.,;:!?\])]+$/, '');   // the link exactly as written in the ticket
  const cleanLabel = t => (t || '').replace(/[\s:|\-–—]+$/, '').replace(/^[\s|:\-–—]+/, '').replace(/\s+/g, ' ').trim().slice(-60);

const docKey = (id, url) => id + '|' + ((String(url).match(/[?&]tab=(t\.[A-Za-z0-9]+)/) || [])[1] || '');   // same doc, different TAB = different link
  // Every Google Doc in a block of text, each with the words that introduce it.
  function docsFromText(text, found) {
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      for (const m of line.matchAll(DOC_RE)) {
        const id = m[1];
        let before = line.slice(0, m.index);
        before = before.split('|').pop();                       // "... | Content Bank: " -> " Content Bank: "
        let label = cleanLabel(before);
        if (!label) {                                            // label on the line above ("Publish this document:")
          for (let j = idx - 1; j >= 0; j--) { const prev = lines[j].trim(); if (prev) { if (!/https?:\/\//i.test(prev) && /:$/.test(prev)) label = cleanLabel(prev.split('|').pop()); break; } }
        }
        const key = docKey(id, m[0]);
        if (!found.has(key)) found.set(key, { url: fullUrl(m[0]), label });
        else if (!found.get(key).label && label) found.get(key).label = label;
      }
    });
  }

  // The element(s) that hold the "Details" field.
  function detailsScopes() {
    const out = [];
    const labels = deepAll().filter(el => el.children.length <= 1 && norm(el.textContent).toLowerCase() === 'details' && isVisible(el)
      && !el.closest('[role="tab"], [role="tablist"], nav, header'));
    for (const lab of labels) {
      const box = lab.closest('.slds-form-element, records-record-layout-item, [class*="record-layout-item"]');
      if (box && !out.includes(box)) out.push(box);
    }
    return out;
  }

  function findDocs() {
    const found = new Map();
    const scopes = detailsScopes();
    const scan = root => {
      for (const el of [root, ...root.querySelectorAll('a[href]')]) {
        if (el.tagName === 'A') {
          const href = el.getAttribute('href') || '';
          const m = new RegExp(DOC_RE.source).exec(href);
          if (m && !found.has(docKey(m[1], m[0]))) found.set(docKey(m[1], m[0]), { url: fullUrl(m[0]), label: '' });
        }
      }
      docsFromText(structuredText(root), found);
    };
    scopes.forEach(scan);
    let source = 'Details field';
    if (!found.size) {                                  // fallback: anywhere on the ticket page
      scan(document.body);
      for (const el of deepAll()) if (el.shadowRoot) docsFromText(structuredText(el.shadowRoot), found);
      source = 'whole page';
    }
    const detailsText = scopes.map(b => norm(structuredText(b))).join(' || ').slice(0, 300);
    return { docs: [...found.values()].map(({ url, label }) => ({ url, label })), source, detailsText, scopes: scopes.length };
  }

  // Value shown next to a field label (works for links and plain text).
  function valueByLabel(label) {
    const want = label.toLowerCase();
    const labels = deepAll().filter(el => el.children.length <= 1 && norm(el.textContent).toLowerCase() === want &&
      isVisible(el) && !el.closest('th, thead, [role="columnheader"], [role="tab"], [role="tablist"], nav, header, [class*="related" i], [class*="feed" i], [class*="timeline" i], .forceBaseListView'));
    for (const lab of labels) {
      let p = lab;
      for (let i = 0; i < 5; i++) {
        p = p.parentElement || (p.getRootNode() && p.getRootNode().host) || null;
        if (!p) break;
        const cands = [...p.querySelectorAll('a[href], lightning-formatted-url, lightning-formatted-text, .slds-form-element__static')]
          .filter(c => c !== lab && !lab.contains(c) && !c.contains(lab) && isVisible(c) &&
            !c.closest('[class*="related" i], [class*="feed" i], [class*="timeline" i], .forceBaseListView'));
        for (const c of cands) {
          const a = c.tagName === 'A' ? c : c.querySelector('a[href]');
          const text = norm(c.textContent);
          if (text || a) return { text, href: a ? a.getAttribute('href') : null, node: a || c };
        }
      }
    }
    return null;
  }

  // Website on the hover card (Aura: div.forceListRecordItem > Website + a.uiOutputURL) or on the Account page.
  function readWebsiteField() {
    const isExternal = h => {
      try { const u = new URL(h, location.href); return /^https?:$/.test(u.protocol) && !cfg.ignoredWebsiteHosts.some(d => u.hostname === d || u.hostname.endsWith('.' + d)); }
      catch { return false; }
    };
    const want = (cfg.websiteLabel || 'Website').toLowerCase();
    // Label elements called "Website": the Account page's highlights panel (<div title="Website" class="slds-item_label">), the
    // Details tab and the hover card. Visible ones first; a field that Lightning has collapsed (compact header after a scroll) still counts.
    const all = deepAll().filter(el => el.children.length <= 1 && (norm(el.textContent).toLowerCase() === want || (el.getAttribute('title') || '').toLowerCase() === want) &&
      !el.closest('th, thead, [role="columnheader"], [role="tab"], [role="tablist"]'));
    const labels = all.filter(isVisible);
    for (const lab of labels) {
      const box = lab.closest('.forceListRecordItem, .slds-form-element, records-record-layout-item, [class*="record-layout-item"]') || lab.parentElement;
      if (!box) continue;
      const a = [...box.querySelectorAll('a[href]')].find(x => isExternal(x.getAttribute('href')));
      if (a) return { href: a.getAttribute('href'), text: norm(a.textContent) };
      const val = box.querySelector('.slds-item_detail, .test-id__field-value, lightning-formatted-url, .slds-form-element__static');
      const txt = val && norm(val.textContent);
      if (txt && /[a-z0-9-]+\.[a-z]{2,}/i.test(txt)) return { href: null, text: txt };
    }
    return null;
  }

  function findAccountLink() {
    const byLabel = valueByLabel(cfg.accountLabel);
    if (byLabel && byLabel.href && /\/lightning\/r\//.test(byLabel.href)) {
      return { href: absUrl(byLabel.href), name: visibleText(byLabel.node) || byLabel.text };
    }
    const a = deepAll().find(el => el.tagName === 'A' && isVisible(el) && !el.closest('nav, header, [role="navigation"], [role="banner"], [role="menu"], [role="listbox"], [class*="related" i], [class*="feed" i], [class*="timeline" i]') && /\/lightning\/r\/Account\//.test(el.getAttribute('href') || ''));
    return a ? { href: absUrl(a.getAttribute('href')), name: visibleText(a) } : null;
  }

  // Reads a record FIELD by its label: finds the visible field box whose label is exactly `label`
  // (the box that holds the label AND its value), then returns only the value text. Ignores hidden
  // tabs, related lists, feed items, table headers and the "Edit <label>" button text.
  function readFieldStrict(label) {
    const want = label.toLowerCase();
    const boxSel = '.slds-form-element, records-record-layout-item, [class*="record-layout-item"], .forceListRecordItem';
    const labelEls = deepAll().filter(el => el.children.length <= 1 && norm(el.textContent).toLowerCase() === want &&
      isVisible(el) && !el.closest('th, thead, [role="columnheader"], [role="tab"], [role="tablist"], nav, header'));
    const results = [];
    for (const lab of labelEls) {
      const box = lab.closest(boxSel);
      if (!box) continue;
      const valEl = box.querySelector('.test-id__field-value, lightning-formatted-text, lightning-formatted-rich-text, .slds-form-element__static, .slds-item_detail');
      if (!valEl || valEl.contains(lab)) continue;
      let t = visibleText(valEl);
      if (!t) t = norm(valEl.textContent).replace(new RegExp('\\s*Edit ' + label + '\\s*$', 'i'), '');
      if (!t) continue;
      const inMain = !box.closest('[class*="related" i], [class*="feed" i], [class*="timeline" i], .forceBaseListView');
      results.push({ t, score: (inMain ? 10 : 0) + (box.querySelector('.test-id__field-value') ? 5 : 0) });
    }
    results.sort((a, b) => b.score - a.score);
    return results.length ? results[0].t : null;
  }

  function readSubject() {
    for (const label of cfg.subjectLabels || []) {
      const strict = readFieldStrict(label);
      if (strict) return strict;
    }
    for (const label of cfg.subjectLabels || []) {      // old loose reader as a last resort
      const v = valueByLabel(label);
      const t = v && visibleText(v.node);
      if (t) return t;
    }
    return null;
  }

  // Looks for "Group 1" in the ticket's own content (not the global header / menus).
  function findGroup1() {
    const re = new RegExp(cfg.group1Pattern, 'i');
    for (const el of deepAll()) {
      if (el.children.length !== 0) continue;
      const text = norm(el.textContent);
      if (!text || text.length > 120 || !re.test(text)) continue;
      if (el.closest('nav, header, [role="navigation"], [role="banner"], [role="menu"], [role="listbox"]')) continue;
      if (!isVisible(el) || el.getBoundingClientRect().top < 110) continue;
      const box = el.closest('.slds-form-element, [class*="record-layout-item"], [class*="highlights"]') || el.parentElement || el;
      return { is: true, evidence: visibleText(box).slice(0, 100) };
    }
    return { is: false, evidence: '' };
  }

  function scrollEverything() {
    for (const el of deepAll()) {
      if (el.scrollHeight > el.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
        el.scrollTop = el.scrollHeight;
      }
    }
    window.scrollTo(0, document.body.scrollHeight);
  }


  /* ---- search helpers (shared by several actions) ---- */
  // The REAL search box is an editable text field. The "Search: All" scope picker next to it is a
  // read-only field whose label also says "Search", so it must be rejected explicitly.
  const isScopePicker = el =>
    el.readOnly || el.hasAttribute('readonly') ||
    !!el.closest('[class*="SearchScope"], [class*="searchScope"], [class*="scope-selector"], [class*="ScopeSelector"]');
  const isSearchInput = el => el.tagName === 'INPUT' && isVisible(el) && !isScopePicker(el) && !el.disabled &&
    ['search', 'text'].includes((el.getAttribute('type') || 'text').toLowerCase()) &&
    (el.type === 'search' || /search/i.test(el.getAttribute('placeholder') || '') || /search/i.test(el.getAttribute('aria-label') || ''));
  // A page can hold several search-looking fields (list filters, app launcher, the "Search: All"
  // scope picker...). The GLOBAL search box is the one that APPEARS when the header Search button
  // is clicked (or the header field itself, when the header holds a real input). So: remember which
  // fields exist before the click (markPre), then pick from the ones that are new. Never "the first
  // search-looking field on the page".
  const clsOf = el => (typeof el.className === 'string' ? el.className : '');
  const describe = el => {
    if (!el) return 'nothing';
    const r = el.getBoundingClientRect();
    const own = clsOf(el).split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    const anc = [];
    for (let p = el.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) anc.push(clsOf(p).split(/\s+/).filter(Boolean)[0] || p.tagName.toLowerCase());
    const ph = el.getAttribute('placeholder'), aria = el.getAttribute('aria-label');
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${own ? '.' + own : ''}[type=${el.getAttribute('type') || 'text'}]` +
      (ph ? `[ph="${ph}"]` : '') + (aria ? `[aria="${aria}"]` : '') +
      ` at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${anc.join(' < ')}`;
  };
  const scoreInput = el => (el.type === 'search' ? 4 : 0) + (/search/i.test(el.getAttribute('placeholder') || '') ? 2 : 0) +
    (el.closest('[role="search"], [role="dialog"], [class*="search" i]') ? 3 : 0);
  const rankInputs = list => [...list].sort((a, b) => scoreInput(b) - scoreInput(a) ||
    b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null;
  const markPre = () => deepAll().filter(isSearchInput).forEach(el => el.setAttribute('data-sfx-pre', '1'));
  const chooseSearchInput = (triggerTop, allowExisting) => {
    const cands = deepAll().filter(isSearchInput);
    // New since the click, and up in the header area (the search dialog opens at the top).
    let pick = rankInputs(cands.filter(el => !el.hasAttribute('data-sfx-pre') && el.getBoundingClientRect().top < 260));
    if (!pick && allowExisting) {
      const pool = triggerTop != null
        ? cands.filter(el => Math.abs(el.getBoundingClientRect().top - triggerTop) < 60)  // same row as the header button
        : cands.filter(el => el.getBoundingClientRect().top < 260);
      pick = rankInputs(pool);
    }
    if (pick) {
      deepAll().filter(el => el.hasAttribute('data-sfx-target')).forEach(el => el.removeAttribute('data-sfx-target'));
      pick.setAttribute('data-sfx-target', '1');
    }
    return pick;
  };
  // Every later step uses THIS marked field, so it can't drift to a different one.
  const getTarget = () => deepAll().find(el => el.hasAttribute('data-sfx-target') && isVisible(el)) || null;
  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  const visibleInputsDesc = () => deepAll().filter(el => el.tagName === 'INPUT' && isVisible(el)).slice(0, 6).map(describe);

  // The header "Search..." box: a wide clickable element near the top of the page.
  // Lightning usually renders it as a button; some orgs show a real input instead.
  const findTrigger = () => {
    const cands = deepAll().filter(el => {
      if (!(el.matches('button, input, [role="button"], [role="combobox"], a') && isVisible(el))) return false;
      if (isScopePicker(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.top > 110) return false;
      const label = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), norm(el.textContent).slice(0, 40)].join(' ');
      return /search/i.test(label) || /search/i.test(el.className || '');
    });
    cands.sort((x, y) => y.getBoundingClientRect().width - x.getBoundingClientRect().width);
    return cands[0] || null;
  };

  const makeTicketRe = ticket => {
    const esc = ticket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^A-Z0-9])' + esc + '([^A-Z0-9]|$)', 'i');
  };
  // Text of an element with a space between separate pieces ("ST-02061755" + "Service Task"),
  // because nested blocks otherwise run together as "ST-02061755Service Task".
  const spacedText = el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue);
    return norm(parts.join(' '));
  };
  const findSuggestionRow = (ticket, belowTop) => {
    const ticketRe = makeTicketRe(ticket);
    const cands = deepAll().filter(el => {
      if (el.tagName === 'INPUT' || (el.textContent || '').length > 300) return false;
      if (belowTop != null && el.getBoundingClientRect().top < belowTop - 5) return false;
      const t = spacedText(el);
      return ticketRe.test(t) && /service task/i.test(t) && isVisible(el);
    });
    return cands.find(el => !cands.some(o => o !== el && el.contains(o))) || null; // smallest element holding both
  };

  const centerOf = el => {
    el.scrollIntoView && el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };

  /* ---------------------------------------------------------------- actions */

  /* ---- locate actions: return coordinates so the extension can use TRUSTED input ---- */

  /* is the Lightning page really built? (no spinner, header search button there) - the key lets the caller see if it still moves */
  if (action === 'pageReady') {
    const cls = el => String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '');
    const spinners = deepAll().filter(el => /spinner/i.test(el.tagName + ' ' + cls(el)) && isVisible(el));
    const trig = findTrigger();
    const r = trig ? trig.getBoundingClientRect() : null;
    return { ok: document.readyState === 'complete' && !!trig && spinners.length === 0,
             data: { key: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width)].join(',') : '', spinners: spinners.length }, log };
  }

  if (action === 'locateSearchTrigger') {
    const el = findTrigger();
    if (!el) return { ok: false, data: { inputs: visibleInputsDesc() }, log };
    markPre();                                   // remember which fields exist BEFORE the click
    const r = el.getBoundingClientRect();
    return { ok: true, data: { ...centerOf(el), top: Math.round(r.top), tag: el.tagName, desc: describe(el) }, log };
  }

  if (action === 'locateSearchInput') {
    const el = chooseSearchInput(params.triggerTop ?? null, !!params.allowExisting);
    return el ? { ok: true, data: { ...centerOf(el), desc: describe(el) }, log }
              : { ok: false, data: { inputs: visibleInputsDesc() }, log };
  }

  if (action === 'locateTarget') {
    const el = getTarget();
    return el ? { ok: true, data: centerOf(el), log } : { ok: false, log };
  }

  if (action === 'focusSearchInput') {
    const el = getTarget();
    if (!el) return { ok: false, log };
    el.focus();
    const active = deepActive();
    return { ok: true, data: { focused: active === el, active: describe(active) }, log };
  }

  if (action === 'readSearchValue') {
    const el = getTarget();
    return el ? { ok: true, data: { value: el.value, active: describe(deepActive()) }, log } : { ok: false, log };
  }

  if (action === 'clearSearchInput') {
    const el = getTarget();
    if (!el) return { ok: false, log };
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return { ok: true, log };
  }

  if (action === 'locateSuggestion') {
    const target = getTarget();
    const belowTop = target ? target.getBoundingClientRect().bottom : null;
    const row = findSuggestionRow(params.ticket, belowTop);
    if (row) return { ok: true, data: { ...centerOf(row), text: spacedText(row).slice(0, 120) }, log };
    // Not found: report what is showing just below the search box, to make problems easy to diagnose.
    const seen = belowTop == null ? [] : deepAll()
      .filter(el => el.children.length <= 2 && isVisible(el))
      .filter(el => { const t = el.getBoundingClientRect().top; return t >= belowTop - 5 && t < belowTop + 500; })
      .map(el => spacedText(el)).filter(t => t.length >= 3 && t.length <= 80);
    return { ok: false, data: { seen: [...new Set(seen)].slice(0, 8) }, log };
  }

  if (action === 'search') {
    const trigger = findTrigger();
    let input = null;
    if (trigger) {
      markPre();
      const top = Math.round(trigger.getBoundingClientRect().top);
      trigger.click();
      log.push(`Clicked the header search box: ${describe(trigger)}`);
      input = (await waitFor(() => chooseSearchInput(top, false), 5000)) || (await waitFor(() => chooseSearchInput(top, true), 4000));
    } else {
      input = await waitFor(() => chooseSearchInput(null, true), cfg.timeouts.searchMs);
    }
    if (!input) return { ok: false, error: `Could not find the Salesforce search box. Fields on the page: ${visibleInputsDesc().join(' ; ') || 'none'}`, log };
    log.push(`Typing into: ${describe(input)}`);
    input.focus();
    input.value = params.ticket;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    log.push(`Typed ${params.ticket}`);

    // Preferred path (what you do by hand): click the suggestion row that appears under the box,
    // e.g. "ST-02061755 / Service Task • Enhancement: …". It must contain the exact ticket number.
    const suggestionRow = () => findSuggestionRow(params.ticket, input.getBoundingClientRect().bottom);
    const row = await waitFor(suggestionRow, 7000);
    if (row) {
      // Click events bubble upward, so start on the innermost row; if nothing happens, try the
      // wrapper (li / link) and the ticket-number text itself — handlers live in different places.
      const ticketRe = makeTicketRe(params.ticket);
      const titleNode = [...row.querySelectorAll('*')].find(el => el.children.length === 0 && ticketRe.test(norm(el.textContent)));
      const wrapper = row.closest('a, li, [role="option"], [role="presentation"]');
      const targets = [row, wrapper, titleNode].filter((el, i, all) => el && all.indexOf(el) === i);
      const ticketPageUrl = () => (location.href.includes(`/lightning/r/${cfg.ticketObject}/`) ? location.href : null);
      let href = null;
      for (const target of targets) {
        for (const type of ['mousedown', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, view: window }));
        }
        log.push('Clicked the ticket suggestion');
        href = await waitFor(ticketPageUrl, 3500);
        if (href) break;
      }
      if (href) return { ok: true, data: { href }, log };
      log.push('Suggestion click did not open the ticket — pressing Enter instead');
    } else {
      log.push('No suggestion row appeared — pressing Enter instead');
    }
    pressEnter(input);
    return { ok: true, log };
  }

  if (action === 'findTicketLink') {
    const want = params.ticket.toLowerCase();
    const links = () => deepAll().filter(el => el.tagName === 'A' && (el.getAttribute('href') || '').includes(`/${cfg.ticketObject}/`));
    const exact = () => links().find(a => norm(a.textContent).toLowerCase() === want);
    let hit = await waitFor(exact, 9000);
    if (!hit) {
      // Results page may be showing other objects first — switch to the ticket object's tab.
      // Click the innermost element with that label; the click bubbles up to any wrapper's handler.
      const labelled = deepAll().filter(el => /^service tasks?$/i.test(norm(el.textContent)) && isVisible(el));
      const scope = labelled.find(el => !labelled.some(o => o !== el && el.contains(o)));
      if (scope) { scope.click(); log.push('Switched search scope to Service Tasks'); }
      hit = await waitFor(exact, cfg.timeouts.searchMs);
    }
    if (!hit) {
      const found = [...new Set(links().map(a => norm(a.textContent)))].slice(0, 5);
      return { ok: false, error: `Ticket ${params.ticket} not found in search results.` + (found.length ? ` Saw: ${found.join(', ')}` : ''), log };
    }
    return { ok: true, data: { href: absUrl(hit.getAttribute('href')) }, log };
  }

  if (action === 'readTicket') {
    // A background/hidden window makes Lightning skip rendering the record, so wait until it is visible.
    await waitFor(() => document.visibilityState === 'visible', 8000);
    log.push(`Ticket page: ${location.pathname} | visibility: ${document.visibilityState} | title: ${document.title}`);
    // Wait for the record itself to appear (a field label), not just the tab bar.
    await waitFor(() => deepAll().some(el => el.children.length <= 1 && /^(subject|account|status)$/i.test(norm(el.textContent)) && isVisible(el)), cfg.timeouts.detailsMs);
    await waitFor(() => deepAll().some(el => el.getAttribute('role') === 'tab'), cfg.timeouts.detailsMs);
    const detailsTab = deepAll().find(el => el.getAttribute('role') === 'tab' &&
      (el.getAttribute('data-label') === 'Details' || norm(el.textContent) === 'Details'));
    if (detailsTab && detailsTab.getAttribute('aria-selected') !== 'true') {
      detailsTab.click();
      log.push('Opened the Details tab');
    }
    const start = Date.now();
    const end = start + cfg.timeouts.detailsMs;
    let docs = [];
    let docInfo = { source: '', detailsText: '', scopes: 0 };
    let account = null;
    let subject = null;
    while (Date.now() < end) {
      scrollEverything();
      docInfo = findDocs();
      docs = docInfo.docs;
      account = findAccountLink();
      subject = subject || readSubject();
      const elapsed = Date.now() - start;
      // Hub tickets have no Google Doc, so don't wait forever for one once the rest is in.
      if (account && (docs.length || elapsed > 10000) && (subject || elapsed > 8000)) break;
      await sleep(120);
    }
    const group1 = findGroup1();
    log.push(`Details field: ${docInfo.scopes ? 'found' : 'NOT found'}; text: "${docInfo.detailsText || '(empty)'}"`);
    log.push(`Google Doc links found: ${docs.length}${docs.length ? ' (' + docs.map(d => (d.label || 'no label')).join(', ') + ') in ' + docInfo.source : ''}; account: ${account ? account.name || 'yes' : 'no'}; ` +
      `subject: ${subject || 'not found'}; Group 1: ${group1.is ? 'yes (' + group1.evidence + ')' : 'no'}`);
    return { ok: true, data: { docs, account, subject, group1 }, log };
  }

  if (action === 'hoverAccount') {
    const accountId = (params.accountHref.match(/\/Account\/([A-Za-z0-9]+)/) || [])[1];
    const link = deepAll().find(el => el.tagName === 'A' && accountId && (el.getAttribute('href') || '').includes(accountId));
    if (!link) return { ok: true, data: { website: null }, log: ['Account link not found for hover'] };
    const popSel = '.slds-popover, section[role="dialog"], [class*="hovercard" i], [class*="hoverCard" i], [class*="popover" i]';
    const before = new Set(deepAll().filter(el => el.matches(popSel)));
    link.scrollIntoView({ block: 'center' });
    const r = link.getBoundingClientRect();
    const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, composed: true, cancelable: true, view: window, clientX: r.left + 5, clientY: r.top + 5,
    }));
    for (const t of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'mousemove']) fire(link, t);
    link.focus && link.focus();
    const external = a => {
      try {
        const h = new URL(a.getAttribute('href'), location.href).hostname;
        return /^https?:/i.test(a.getAttribute('href') || '') && !cfg.ignoredWebsiteHosts.some(d => h === d || h.endsWith('.' + d));
      } catch { return false; }
    };
    const card = await waitFor(() => {
      const direct = readWebsiteField();                       // hover card rows (forceListRecordItem) show up as normal elements
      if (direct) return direct;
      for (const pop of deepAll().filter(el => el.matches(popSel) && !before.has(el) && isVisible(el))) {
        const ext = [...pop.querySelectorAll('a[href]')].find(external);
        if (ext) return { href: ext.getAttribute('href'), text: norm(ext.textContent) };
        const m = norm(pop.textContent).match(/website\s*:?\s*((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\S*)/i);
        if (m) return { href: null, text: m[1] };
      }
      return null;
    }, cfg.timeouts.hoverMs);
    fire(link, 'mouseleave'); fire(link, 'mouseout');
    log.push(card ? 'Website read from the Account hover card' : 'Hover card did not show a website');
    return { ok: true, data: { website: card }, log };
  }

  // Open the Account by clicking its link inside the already-running Salesforce app (no full page reload,
  // which re-boots all of Lightning). Reports whether the app really moved to the Account page.
  if (action === 'openAccountInApp') {
    const accountId = (params.accountHref.match(/\/Account\/([A-Za-z0-9]+)/) || [])[1];
    const link = deepAll().find(el => el.tagName === 'A' && accountId && (el.getAttribute('href') || '').includes(accountId));
    if (!link) return { ok: true, data: { navigated: false }, log: ['Account link not found for in-app open'] };
    link.scrollIntoView({ block: 'center' });
    link.click();
    const moved = await waitFor(() => (accountId && location.pathname.includes('/Account/' + accountId)) || null, 3500, 150);
    log.push(moved ? 'Opened the Account inside Salesforce (no reload)' : 'In-app Account open did not move the page');
    return { ok: true, data: { navigated: !!moved }, log };
  }

  if (action === 'readAccountWebsite') {
    // Open at the TOP: scrolling to the bottom makes Lightning collapse the highlights panel (where Website is shown).
    const toTop = () => { for (const el of deepAll()) { if (el.scrollTop > 0) el.scrollTop = 0; } window.scrollTo(0, 0); };
    const isExt = h => { try { const u = new URL(h, location.href); return /^https?:$/.test(u.protocol) && !cfg.ignoredWebsiteHosts.some(d => u.hostname === d || u.hostname.endsWith('.' + d)); } catch { return false; } };
    let round = 0;
    const found = await waitFor(() => {
      if (round++ % 4 === 0) toTop();
      const direct = readWebsiteField();
      if (direct) return direct;
      const v = valueByLabel(cfg.websiteLabel);
      if (v && (v.href || v.text) && (!v.href || isExt(v.href))) return { href: v.href, text: v.text };
      // last resort: the one outside link that is rendered as a Salesforce URL field
      const urlLink = deepAll().find(el => el.tagName === 'A' && el.closest('.forceOutputURL, lightning-formatted-url, .uiOutputURL') && isExt(el.getAttribute('href') || ''));
      return urlLink ? { href: urlLink.getAttribute('href'), text: norm(urlLink.textContent) } : null;
    }, cfg.timeouts.accountPageMs, 400);
    if (found) log.push('Website read from the Account page');
    else {
      const labelsN = deepAll().filter(el => el.children.length <= 1 && norm(el.textContent).toLowerCase() === (cfg.websiteLabel || 'Website').toLowerCase()).length;
      const extN = deepAll().filter(el => el.tagName === 'A' && isExt(el.getAttribute('href') || '')).length;
      log.push(`No Website field found on the Account page (page: ${location.pathname.slice(0, 60)}; elements labelled "Website": ${labelsN}; outside links: ${extN}; page title: ${document.title.slice(0, 50)})`);
    }
    return { ok: true, data: { website: found }, log };
  }

  return { ok: false, error: `Unknown action ${action}`, log };
}
