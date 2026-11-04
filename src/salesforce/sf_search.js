/**
 * Searching for a ticket with TRUSTED input (real mouse clicks + real keystrokes sent
 * through chrome.debugger). Salesforce's search box and suggestion dropdown ignore
 * synthetic events created by page scripts, so typing "from inside the page" does nothing.
 *
 * Everything the browser provides is passed in, so this file has no Chrome dependencies:
 *   send(method, params)  -> Chrome DevTools Protocol command on the helper tab
 *   runPage(action, args) -> runs a sf_page.js action in the page, returns { ok, data }
 *   getUrl()              -> the helper tab's current URL
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function poll(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

export async function trustedSearch({ send, runPage, getUrl, ticket, cfg, log }) {
  // Make the page behave as if its window has focus (the helper window is opened unfocused).
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const typeText = async (text, delayMs = 35) => {
    for (const ch of text) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await sleep(delayMs);
    }
  };
  const pressBackspace = async () => {
    const base = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  let lastActive = '';
  const readValue = async () => {
    const r = await runPage('readSearchValue');
    if (r.ok) lastActive = r.data.active;
    return r.ok ? r.data.value : null;
  };
  // Triple-click selects everything in the field; Backspace removes it.
  const clearField = async () => {
    const f = await runPage('locateTarget');
    if (f.ok) {
      const { x, y } = f.data;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 3 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 3 });
      await pressBackspace();
    }
    if ((await readValue()) !== '') await runPage('clearSearchInput');
  };
  const focusField = async () => {
    const f = await runPage('locateTarget');        // re-measure: the box may have moved while opening
    if (f.ok) await click(f.data.x, f.data.y);
    await sleep(200);
    // Keyboard input goes to whatever has focus — make sure that is the search box, not a neighbour
    // such as the "Search: All" options picker.
    const foc = await runPage('focusSearchInput');
    if (foc.ok && !foc.data.focused) log(`Keyboard focus was on ${foc.data.active}, not the search box`);
    await sleep(80);
  };
  const pressEnter = async () => {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  // 0. Wait until the page is REALLY ready: loaded, no spinner, and the header search button has stopped moving.
  //    (A fixed 5s was too slow when the page was quick and too fast when it was slow; this waits only as long as needed.)
  const startingUrl = (await getUrl()) || '';
  log('Waiting for the Salesforce page to finish loading');
  await sleep(1200);
  {
    let lastKey = null, stable = 0;
    const endReady = Date.now() + cfg.timeouts.searchSettleMs;
    while (Date.now() < endReady && stable < 2) {
      const r = await runPage('pageReady');
      if (r.ok) { stable = r.data.key === lastKey ? stable + 1 : 0; lastKey = r.data.key; } else { stable = 0; lastKey = null; }
      await sleep(350);
    }
    log(stable >= 2 ? 'Page is ready' : 'Page not confirmed ready - continuing anyway');
  }

  // 1. Open the GLOBAL search by clicking the header "Search..." button. If the box does not open
  //    (the page was not fully alive yet), click again - up to 3 tries.
  let field = null, trigger = null;
  const find = (triggerTop, allowExisting) => async () => {
    const r = await runPage('locateSearchInput', { triggerTop, allowExisting });
    return r.ok ? r : null;
  };
  for (let attempt = 1; attempt <= 3 && !field; attempt++) {
    trigger = await poll(async () => { const r = await runPage('locateSearchTrigger'); return r.ok ? r : null; }, cfg.timeouts.searchMs);
    if (!trigger) {
      const t = await runPage('locateSearchTrigger');
      const seen = t.data?.inputs?.length ? ` Fields on the page: ${t.data.inputs.join(' ; ')}` : '';
      return { ok: false, error: `Could not find the Salesforce search button in the page header.${seen}` };
    }
    await click(trigger.data.x, trigger.data.y);
    log(`Clicked the header search box (try ${attempt}): ${trigger.data.desc}`);
    const isInlineInput = trigger.data.tag === 'INPUT';
    field = await poll(find(trigger.data.top, isInlineInput), 3500);
    if (!field) field = await poll(find(trigger.data.top, true), 1500);
    if (!field) { log('The search box did not open - trying again'); await sleep(900); }
  }
  if (!field) {
    const r = await runPage('locateSearchInput', { triggerTop: trigger?.data?.top, allowExisting: true });
    const seen = r.data?.inputs?.length ? r.data.inputs.join(' ; ') : 'none';
    return { ok: false, error: `The search box did not open after clicking the header button. Fields on the page: ${seen}` };
  }
  log(`Typing into: ${field.data.desc}`);

  // 2. Let the search box finish opening, then type like a person — and CHECK what landed in the
  //    box. (Seen in practice: the first letter was swallowed, so "ST-0206…" became "T-0206…" and
  //    the search found nothing.)
  await sleep(500);
  await clearField();
  await focusField();
  await typeText(ticket);
  let value = await readValue();
  for (let attempt = 1; attempt <= 2 && value !== ticket; attempt++) {
    log(`The search box contained "${value}" instead of "${ticket}" (keyboard focus: ${lastActive}) — retyping`);
    await clearField();
    await focusField();
    await typeText(ticket, 40);
    value = await readValue();
  }
  if (value !== ticket) {
    log('Typing keeps losing characters — pasting the text instead');
    await clearField();
    await focusField();
    await send('Input.insertText', { text: ticket });
    await sleep(100);
    value = await readValue();
  }
  if (value !== ticket) {
    return { ok: false, error: `Could not type the ticket number into the search box (it contains "${value}").` };
  }
  log(`Typed ${ticket}`);

  // 3. The suggestion list keeps refreshing while Salesforce searches, so wait until the "Service Task" row
  //    has STOPPED moving, hover over it (the row only reacts after a real hover), then click - retry up to 3 times.
  let last = null;
  const stableRow = async () => {
    let prev = null, cur = null, same = 0;
    const end = Date.now() + 9000;
    while (Date.now() < end) {
      const r = await runPage('locateSuggestion', { ticket });
      last = r;
      if (r.ok) {
        const key = `${r.data.x},${r.data.y}`;
        same = key === prev ? same + 1 : 0;
        prev = key; cur = r;
        if (same >= 2) return cur;
      } else { prev = null; same = 0; cur = null; }
      await sleep(250);
    }
    return cur;
  };
  let opened = null, hint = null, sawRow = false;
  for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
    const row = await stableRow();
    if (!row) break;
    sawRow = true;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.data.x - 6, y: row.data.y });
    await sleep(120);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.data.x, y: row.data.y });     // hover first
    await sleep(350);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row.data.x, y: row.data.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(90);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row.data.x, y: row.data.y, button: 'left', buttons: 0, clickCount: 1 });
    log(`Hovered + clicked suggestion (try ${attempt}): ${row.data.text}`);
    hint = (/service task\s*[•·|–-]?\s*(.+)$/i.exec(row.data.text || '') || [])[1] || null;
    opened = await poll(async () => {
      const url = (await getUrl()) || '';
      return url !== startingUrl && url.includes(`/lightning/r/${cfg.ticketObject}/`) ? url : null;
    }, 5000, 200);
    if (!opened) log('The click did not open the ticket - trying again');
  }
  if (opened) return { ok: true, href: opened, hint };
  if (sawRow) log('Suggestion clicks did not open the ticket — pressing Enter instead');
  else {
    const seen = last?.data?.seen?.length ? last.data.seen.join(' | ') : 'nothing';
    log(`No matching suggestion appeared (dropdown showed: ${seen}) — pressing Enter instead`);
  }

  // 4. Fallback: Enter opens the full search-results page.
  await pressEnter();
  return { ok: true, usedEnter: true };
}
