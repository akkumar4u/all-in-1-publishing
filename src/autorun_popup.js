/**
 * Auto-run: one click on "Find" and the rest follows by itself —
 *   ticket read → Google Doc imported (without waiting for the website) → image search starts as soon as the title
 *   is in → Salesforce finishes (website) → Preview → WordPress opens (the image is added at the end if it is not
 *   ready yet) → page filled + Page check.
 * It only clicks the same buttons a person would click and fills the same fields, so every step behaves exactly as
 * it does by hand. Untick "Run everything automatically" to go back to the manual way.
 *
 * The extension does not open any extra window or tab of its own. The progress lives in chrome.storage.session, so if
 * the toolbar popup closes (another window took focus) just click the extension icon again and the run carries on.
 */
import { TASK_TYPES } from './salesforce/sf_classify.js';

const $ = id => document.getElementById(id);
const RUN = 'autoRun';
const SF = 'sfLookupState';
const ME = Math.random().toString(36).slice(2);
let shownPicker = false;   // the image picker was brought into view in this copy of the popup
const box = $('auto-run-box');
const stepsEl = $('auto-run-steps');
const noteEl = $('auto-run-note');
const toggle = $('auto-run');
if (!toggle || !box) throw new Error('auto-run markup missing');

const getRun = async () => (await chrome.storage.session.get(RUN))[RUN] || null;
const putRun = run => chrome.storage.session.set({ [RUN]: run });
const r1 = ms => Math.round(ms / 100) / 10;

function setField(id, value) {
  const el = $(id);
  if (!el || !value) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function clearStatus(...ids) {
  for (const id of ids) { const el = $(id); if (el) { el.textContent = ''; el.className = ''; } }
}

/* ---------- on/off switch (remembered) ---------- */
chrome.storage.local.get('autoRunOn').then(r => { toggle.checked = r.autoRunOn !== false; });
toggle.addEventListener('change', () => chrome.storage.local.set({ autoRunOn: toggle.checked }));

/* ---------- start: the Find button ---------- */
$('sf-run').addEventListener('click', async () => {
  if (!toggle.checked) return;
  const ticket = $('sf-ticket').value.trim().toUpperCase();
  if (!ticket) return;
  await putRun({ active: true, ticket, t0: Date.now(), ms: {}, owner: ME, beat: Date.now() });
  clearStatus('import-status', 'blog-import-status', 'publishing-form-status', 'fill-status');
  // forget the image of the previous task, so nothing old can be used or shown as if it had been picked for this one
  chrome.storage.local.remove(['pageCheck', 'timeLogAuto', 'diLandingImage', 'diBlogImage', 'diLandingHeld', 'diBlogHeld']);
});

$('auto-run-stop').addEventListener('click', async () => {
  const run = await getRun();
  if (!run) return;
  run.active = false; run.stopped = 'Stopped — carry on by hand.';
  await putRun(run);
  render(run);
});

/* ---------- the steps ---------- */
async function tick() {
  const run = await getRun();
  if (!run) { render(null); return; }
  if (!run.active) { render(run); return; }
  if (run.owner !== ME && Date.now() - (run.beat || 0) < 3000) return;   // another copy of the page is driving
  run.owner = ME; run.beat = Date.now();
  const ms = run.ms || (run.ms = {});
  const stop = reason => { run.active = false; run.stopped = reason; saveAutoLog(run); };

  const sf = (await chrome.storage.session.get(SF))[SF];
  if (!sf || sf.ticket !== run.ticket) {
    if (Date.now() - run.t0 > 25000) stop('The Salesforce lookup did not start.');
  } else if (sf.status === 'error') {
    stop('Salesforce lookup failed: ' + (sf.error || 'unknown error'));
  } else {
    const data = sf.status === 'done' ? sf : sf.early;

    // 1. the doc and the task type are known (before the website is) -> fill the form and import the doc at once
    if (data && !run.applied) {
      const task = data.task;
      const type = task && TASK_TYPES[task.key];
      const docUrl = (data.docs && data.docs[0] && data.docs[0].url) || (data.docUrls && data.docUrls[0]);
      if (!task || !type || !type.publishingType) {
        stop(`${task?.label || 'This ticket'} has no automatic flow — finish it by hand (the details are filled in once the lookup ends).`);
      } else if (!docUrl) {
        stop('No Google Doc link was found on the ticket.');
      } else {
        $('sf-auto-import').checked = true;
        clearStatus('import-status', 'blog-import-status');
        window.__sfApplyTask({ adminUrl: sf.status === 'done' ? sf.adminUrl : null, group1: data.group1, subject: data.subject }, task.key, docUrl);
        run.applied = true; run.type = type.publishingType; run.vrp = task.key === 'enhancement:vrp'; ms.docFound = Date.now();
      }
    }

    // 2. Salesforce finished -> the WordPress admin URL
    if (run.active && run.applied && sf.status === 'done' && !run.adminSet) {
      if (!sf.adminUrl) {
        stop('Salesforce found no website for this Account — type the WordPress admin URL and press the buttons by hand.');
      } else {
        setField('publishing-admin-url', sf.adminUrl);
        setField('blog-admin-url', sf.adminUrl);
        chrome.runtime.sendMessage({ type: 'SF_MARK_APPLIED' });
        run.adminSet = true; ms.sfDone = Date.now();
      }
    }

    const isBlog = run.type === 'blog';

    // 3. the doc import finished
    if (run.active && run.applied && !run.imported) {
      const el = $(isBlog ? 'blog-import-status' : 'import-status');
      if (el && el.textContent && /error/.test(el.className)) stop('Google Doc import: ' + el.textContent);
      else if (el && el.textContent && /success/.test(el.className)) { run.imported = true; ms.imported = Date.now(); }
    }

    // 4. title is in -> start the image search (it does not need Salesforce to be finished)
    if (run.active && run.imported && !run.imageStarted && !run.vrp) {
      const p = isBlog ? 'blog-image' : 'landing-image';
      const title = isBlog ? ($('title')?.textContent || '').trim() : ($('comparison-page-title')?.value || '').trim();
      const q = $(p + '-query'), btn = $(p + '-fetch');
      if (title && q && q.value.trim() && btn && !btn.disabled) {
        const ch = $(p + '-choose'); if (ch) ch.checked = true;   // auto-run shows the best images so YOU pick; once picked it downloads and the rest follows
        btn.click(); run.imageStarted = true; ms.imageStarted = Date.now();
      } else if (Date.now() - ms.imported > 10000) {
        run.imageStarted = true; run.imageSkipped = true;
        run.note = 'The image search could not start by itself (no title / search text) — use "Get image" in the popup.';
      }
    }
    if (run.active && run.imageStarted && !run.imageDone && !run.imageSkipped) {
      const key = isBlog ? 'diBlogImage' : 'diLandingImage';
      const st = (await chrome.storage.local.get(key))[key];
      if (st && (st.updatedAt || 0) >= (ms.imageStarted || 0) - 2000) {
        if (st.status === 'done' && st.dataUrl) { run.imageDone = true; ms.imageDone = Date.now(); run.imageWaitingForChoice = false; }
        else if (st.status === 'error') { run.imageDone = true; run.imageFailed = st.error || 'image search failed'; ms.imageDone = Date.now(); }
        else {
          run.imageWaitingForChoice = st.status === 'choose';
          // show the picker (same image options as the manual way) so it is right in front of you, whichever tab is open
          if (run.imageWaitingForChoice && !shownPicker) {
            const grid = $(isBlog ? 'blog-image-choices' : 'landing-image-choices');
            if (grid && !grid.hidden) {
              shownPicker = true;
              if (!isBlog) $('tab-publishing')?.click();
              setTimeout(() => grid.scrollIntoView({ block: 'center' }), 80);
            }
          }
        }
      }
    }

    // 5a. Landing / Comparison: Preview as soon as the doc is in and the admin URL is known
    if (run.active && run.vrp && run.imported && run.adminSet && !run.previewClicked) {
      stop('Doc and website are ready. Choose Create new page or Update existing page, select the sitemap result if updating, then Generate Preview and open WordPress.');
    }
    if (run.active && !isBlog && run.imported && run.adminSet && !run.previewClicked) {
      const hasBody = ($('comparison-cta-body')?.value || '').trim();
      if (($('comparison-page-title')?.value || '').trim() && ($('publishing-admin-url')?.value || '').trim() && (run.type !== 'landing' || hasBody)) {
        $('publishing-generate').click(); run.previewClicked = true; ms.previewClicked = Date.now();
      }
    }
    if (run.active && !isBlog && run.previewClicked && !run.previewed) {
      const el = $('publishing-form-status');
      if (el && el.textContent && /error/.test(el.className)) stop('Preview: ' + el.textContent);
      else if (el && /Preview generated/.test(el.textContent || '')) { run.previewed = true; ms.previewed = Date.now(); }
    }

    // 6. open WordPress. Neither the landing / comparison page nor the blog waits for the image (it is added when it is downloaded).
    if (run.active && !run.opened) {
      if (!isBlog && run.previewed) {
        const b = $('open-wp');
        if (b && !b.disabled) { b.click(); run.opened = true; ms.opened = Date.now(); }
      } else if (isBlog && run.imported && run.adminSet) {
        const b = $('fill');
        if (b && !b.disabled) { b.click(); run.opened = true; ms.opened = Date.now(); }
      }
    }
    if (run.active && run.opened && !isBlog) {
      const el = $('fill-status');
      if (el && el.textContent && /error/.test(el.className)) stop('Open WordPress: ' + el.textContent);
    }

    // 7. the fill finished (it writes the time log last)
    if (run.active && run.opened && !run.filled) {
      const tl = (await chrome.storage.local.get('timeLog')).timeLog;
      if (tl && tl.at > (ms.opened || 0)) { run.filled = true; ms.filled = tl.at; run.active = false; run.done = true; saveAutoLog(run); }
      else if (Date.now() - ms.opened > 8 * 60 * 1000) stop('The WordPress fill did not report back in 8 minutes — check the WordPress tab.');
    }
  }
  await putRun(run);
  render(run);
}

function saveAutoLog(run) {
  const ms = run.ms || {};
  const names = {
    docFound: 'Ticket read — Google Doc found', imported: 'Google Doc imported', imageStarted: 'Image search started',
    sfDone: 'Salesforce finished (website found)', previewed: 'Preview generated', imageDone: 'Image ready',
    opened: 'WordPress opened', filled: 'WordPress page filled + checked',
  };
  const events = Object.keys(names).filter(k => ms[k]).map(k => [ms[k], names[k]]).sort((a, b) => a[0] - b[0]);
  if (!events.length) return;
  let last = run.t0;
  const steps = events.map(([t, label]) => { const s = r1(t - last); last = t; return { label, s }; });
  chrome.storage.local.set({ timeLogAuto: { source: 'Whole task — seconds from one step to the next, from the first click', at: last, total: r1(last - run.t0), steps } });
}

/* ---------- progress display ---------- */
function render(run) {
  if (!run) { box.hidden = true; return; }
  box.hidden = false;
  const ms = run.ms || {};
  const blog = run.type === 'blog';
  const list = [
    ['Ticket read', ms.docFound],
    ['Doc imported', ms.imported],
    ...(run.vrp ? [] : [['Image', run.imageSkipped ? -1 : ms.imageDone]]),
    ['Salesforce done', ms.sfDone],
    ...(blog ? [] : [['Preview', ms.previewed]]),
    ['WordPress opened', ms.opened],
    ['Page filled', ms.filled],
  ];
  let firstPending = true;
  stepsEl.replaceChildren(...list.map(([label, done]) => {
    const s = document.createElement('span');
    const finished = !!done;
    const current = !finished && run.active && firstPending;
    if (!finished) firstPending = false;
    s.className = 'ar-step ' + (finished ? 'ar-done' : current ? 'ar-now' : 'ar-wait');
    s.textContent = (finished ? '✓ ' : current ? '… ' : '○ ') + label;
    return s;
  }));
  const bits = [];
  if (run.stopped) bits.push(run.stopped);
  else if (run.done) bits.push(`Done in ${r1((ms.filled || Date.now()) - run.t0)}s — check the Page check below, then Save Draft / Publish.`);
  if (run.active && run.imageStarted && !run.imageDone && !run.imageSkipped && !run.imageWaitingForChoice) bits.push('Image: choose mode — the best images will appear in the picker for you to click.');
  if (run.active && run.imageWaitingForChoice) bits.push('Choose the image in the picker below — the page waits for it at the end.');
  if (run.imageFailed) bits.push('Image: ' + run.imageFailed);
  if (run.note) bits.push(run.note);
  bits.push(`(extension v${chrome.runtime.getManifest().version})`);
  noteEl.textContent = bits.join(' ');
  noteEl.className = run.stopped ? 'ar-error' : '';
  $('auto-run-stop').hidden = !run.active;
}

setInterval(() => { tick().catch(e => console.warn('auto-run:', e)); }, 600);
getRun().then(render);
