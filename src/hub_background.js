import { siteSlug } from './images/img_name.js';
import { openInNormalWindow } from './win_util.js';
import { startTimeLog } from './timelog.js';
const HUB_KEY = 'pendingHubPage';
const STATUS_KEY = 'hubFillStatus';
const TAB_KEY = 'hubTargetTabId';
const RUN_KEY = 'hubRunStarted';
const LATE_IMG_KEY = 'hubLateImage';
const GOOGLE_DOC_ID = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;
const PARSER_DOCUMENT = 'parser.html';
let parserDocumentPromise;

/* ------------------------------------------------------------------ */
/*  Google Doc import (Comparison Page title + Yoast meta)             */
/*                                                                      */
/*  Fetches the doc's exported HTML directly from the background       */
/*  service worker, so it rides on the browser's existing Google       */
/*  session cookies — no OAuth needed, same approach as the Auto       */
/*  Publishing extension. An offscreen document (which has a real      */
/*  DOM/DOMParser, unlike the service worker) does the actual parsing. */
/* ------------------------------------------------------------------ */

async function parseComparisonDocInExtension(sourceHtml) {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(PARSER_DOCUMENT)],
  });
  if (!contexts.length) {
    parserDocumentPromise ||= chrome.offscreen.createDocument({
      url: PARSER_DOCUMENT,
      reasons: ['DOM_PARSER'],
      justification: 'Parse the comparison page Google Doc (title + meta) before filling WordPress.',
    }).finally(() => { parserDocumentPromise = undefined; });
    await parserDocumentPromise;
  }
  return chrome.runtime.sendMessage({ type: 'PARSE_COMPARISON_DOC_HTML', sourceHtml });
}

/* ------------------------------------------------------------------ */
/*  URL helpers                                                        */
/* ------------------------------------------------------------------ */

function newPageUrl(adminUrl) {
  const url = new URL(adminUrl);
  if (!/\/wp-admin(?:\/|$)/i.test(url.pathname)) {
    const base = url.pathname.replace(/\/+$/, '');
    url.pathname = `${base}/wp/wp-admin`.replace(/\/+/g, '/');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/post-new.php`;
  url.search = 'post_type=page';
  url.hash = '';
  return url.toString();
}

function isNewPageUrl(tabUrl, adminUrl) {
  try {
    const tab = new URL(tabUrl);
    const admin = new URL(adminUrl);
    return (
      tab.origin === admin.origin &&
      /\/wp-admin\/post-new\.php$/i.test(tab.pathname) &&
      tab.searchParams.get('post_type') === 'page'
    );
  } catch { return false; }
}

function isHubTargetUrl(tabUrl, hub) {
  if (!hub?.vrpExistingPage) return isNewPageUrl(tabUrl, hub?.adminUrl || '');
  try {
    const actual = new URL(tabUrl);
    const expected = new URL(hub.existingPageUrl);
    return actual.origin === expected.origin
      && actual.pathname === expected.pathname
      && actual.searchParams.get('action') === 'edit'
      && actual.searchParams.get('post') === expected.searchParams.get('post');
  } catch { return false; }
}

const swWait = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/*  Trusted-click support via chrome.debugger                          */
/*                                                                      */
/*  Why this exists: ACF's "Add Row" popup never opened for any        */
/*  variant of synthetic dispatchEvent(mousedown/mouseup/click),        */
/*  confirmed by a live run that reported "popup never became          */
/*  visible" for every row. Script-dispatched events always have       */
/*  isTrusted === false, and whatever is gating that popup (ACF        */
/*  itself, jQuery UI's sortable claiming mousedown, or the DI theme's  */
/*  own JS) appears to require a real one. chrome.debugger's Input     */
/*  domain injects input at the OS/compositor level — the page sees    */
/*  isTrusted: true, indistinguishable from an actual mouse click.      */
/* ------------------------------------------------------------------ */

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already detached (e.g. user closed the "debugging this browser" bar) — fine */
  }
}

async function trustedClick(tabId, x, y) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0,
  });
  await swWait(40);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await swWait(60);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
}

async function execIn(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return result[0]?.result;
}

/* ------------------------------------------------------------------ */
/*  Message handlers                                                   */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return false;

  if (message.type === 'SAVE_ADMIN_URL') {
    try {
      const adminUrl = new URL(message.adminUrl || '').toString().replace(/\/$/, '');
      // Hub Publisher and Blog Publishing are almost always the same
      // WordPress site, so saving it in one place should save it for the
      // other too, instead of keeping two separate "Save WordPress URL"s
      // that never see each other.
      chrome.storage.local.set({ hubAdminUrl: adminUrl, wordPressAdminUrl: adminUrl })
        .then(() => sendResponse({ ok: true, adminUrl }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
    } catch {
      sendResponse({ ok: false, error: 'Enter a valid WordPress admin URL.' });
    }
    return true;
  }

  if (message.type === 'STORE_HUB_PAGE') {
    const hub = message.hub;
    if (!hub?.title) {
      sendResponse({ ok: false, error: 'Hub page data is missing a title.' });
      return;
    }
    chrome.storage.session.set({ [HUB_KEY]: hub, [STATUS_KEY]: null, [RUN_KEY]: false })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_HUB_PAGE') {
    chrome.storage.session.get([HUB_KEY, STATUS_KEY])
      .then(stored => sendResponse({
        ok: true,
        hub: stored[HUB_KEY] || null,
        status: stored[STATUS_KEY] || null,
      }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'OPEN_HUB_PAGE') {
    chrome.storage.session.get(HUB_KEY).then(async stored => {
      const hub = stored[HUB_KEY];
      if (!hub) throw new Error('No hub page is queued. Generate a preview first.');
      const status = await chrome.storage.session.get(STATUS_KEY);
      if (status[STATUS_KEY]?.filled) {
        throw new Error('This hub page was already filled. Clear it before creating another.');
      }
      const adminUrl = message.adminUrl || hub.adminUrl;
      if (!adminUrl) throw new Error('WordPress admin URL is required.');
      hub.adminUrl = adminUrl;
      await chrome.storage.session.set({ [HUB_KEY]: hub, [RUN_KEY]: false, hubOpenedAt: Date.now() });
      // never inside the Image Library / Salesforce helper window (closing that window would close this tab too)
      const targetUrl = hub.vrpExistingPage ? hub.existingPageUrl : newPageUrl(adminUrl);
      const tab = await openInNormalWindow(targetUrl, { background: !!hub.autoDraft });
      await chrome.storage.session.set({ [TAB_KEY]: tab.id });
      sendResponse({ ok: true, tabId: tab.id });
    }).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'CLEAR_HUB_PAGE') {
    chrome.storage.session.remove([HUB_KEY, TAB_KEY, STATUS_KEY, RUN_KEY])
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'CHECK_PUBLISHED_WORDPRESS_URL') {
    (async () => {
      const postId = Number(message.postId || 0);
      if (!postId) throw new Error('WordPress post ID is missing.');
      const admin = new URL(message.adminUrl || '');
      const sitePath = admin.pathname.replace(/\/(?:wp\/)?wp-admin(?:\/.*)?$/i, '').replace(/\/$/, '');
      const siteRoot = admin.origin + sitePath;
      const objectType = message.objectType === 'post' ? 'posts' : 'pages';
      const apiPath = `/wp/v2/${objectType}/${postId}?_fields=status,link,date_gmt`;
      const candidates = [
        `${siteRoot}/wp-json${apiPath}`,
        `${admin.origin}/wp-json${apiPath}`,
        `${siteRoot}/?rest_route=${encodeURIComponent(apiPath)}`,
        `${admin.origin}/?rest_route=${encodeURIComponent(apiPath)}`,
      ];
      let lastError = '';
      for (const url of [...new Set(candidates)]) {
        try {
          const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (!response.ok) { lastError = `WordPress REST API HTTP ${response.status}`; continue; }
          const data = await response.json();
          if (data?.status === 'publish' && /^https?:\/\//i.test(data.link || '')) return { ok: true, published: true, url: data.link, publishedAt: data.date_gmt || '' };
          if (data?.status) return { ok: true, published: false, status: data.status };
        } catch (error) { lastError = error.message; }
      }
      return { ok: false, error: lastError || 'Could not read the WordPress REST API.' };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'IMPORT_COMPARISON_DOC') {
    const { documentUrl } = message;
    if (!documentUrl) {
      sendResponse({ ok: false, error: 'Enter a Google Doc URL.' });
      return true;
    }
    const TL = startTimeLog('timeLogImport', 'Google Doc import');
    (async () => {
      const match = documentUrl.match(GOOGLE_DOC_ID);
      if (!match) throw new Error('Please enter a valid Google Docs link.');
      // A link to a specific tab (?tab=t.abc) must export THAT tab, otherwise the text is missing.
      const tabParam = (documentUrl.match(/[?&]tab=(t\.[A-Za-z0-9]+)/) || [])[1];
      // t.0 (the FIRST tab) needs the parameter too: without it Google sends every tab of the doc, and the other tabs' text
      // (and their "Disclaimer:") ends up in the content.
      const baseExport = `https://docs.google.com/document/d/${match[1]}/export?format=html`;
      const exportUrl = baseExport + (tabParam ? `&tab=${tabParam}` : '');
      const response = await fetch(exportUrl);
      TL.lap('Download the Google Doc');
      if (!response.ok) {
        throw new Error(
          `Google Docs returned HTTP ${response.status}. Confirm you're signed into the Google ` +
          'account that can view this doc in Chrome, or share it as "Anyone with the link".'
        );
      }
      const html = await response.text();
      if (/accounts\.google\.com\/(ServiceLogin|v3\/signin)/i.test(html) && !/<h1|<p[ >]/i.test(html.replace(/accounts\.google\.com[^"']*/g, ''))) {
        throw new Error('Google asked for sign-in instead of returning the doc. Share it as "Anyone with the link" or sign in to Google in Chrome.');
      }
      const data = await parseComparisonDocInExtension(html);
      TL.lap('Read + parse the doc');
      if (data?.error) throw new Error(data.error);
      if (tabParam) {                                   // is the tab really exported on its own? (the whole doc would be longer)
        try {
          const whole = await (await fetch(baseExport)).text();
          data.tabNote = whole.length > html.length * 1.02
            ? ` Tab ${tabParam}: only this tab was read.`
            : ` ⚠ Tab ${tabParam}: Google gave the same text with and without the tab — fine for a one-tab doc, but if the doc has several tabs check that the content is only from the tab you linked.`;
        } catch { /* the note is only a help */ }
      }
      // No H1 is fine (landing docs often have the title only in the ticket) — the popup asks for it.
      return data;
    })()
      .then(data => sendResponse({ ok: true, ...data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

/* ------------------------------------------------------------------ */
/*  Tab listener — orchestrates the whole fill                         */
/*                                                                      */
/*  1. In-page JS fills title/template/parent/slug, waits for the      */
/*     DI Page Composer field to appear.                               */
/*  2. For each content section: in-page JS locates the Add Row        */
/*     button and reports its on-screen coordinates -> background      */
/*     sends a TRUSTED click via chrome.debugger -> in-page JS locates */
/*     the popup's layout link and reports its coordinates ->          */
/*     background sends a trusted click on that too -> in-page JS      */
/*     waits for the genuinely new row and fills its fields.           */
/*  3. In-page JS fills CSS overrides + Yoast meta.                    */
/*  Never touches #save-post — EXCEPT a VRP page started from the Bulk */
/*  dashboard (hub.autoDraft): only after every page check passed,     */
/*  only "Save Draft", never Publish.                                   */
/* ------------------------------------------------------------------ */

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  const stored = await chrome.storage.session.get([HUB_KEY, TAB_KEY, RUN_KEY, 'hubOpenedAt']);
  const hub = stored[HUB_KEY];
  if (!hub || stored[TAB_KEY] !== tabId) return;
  if (stored[RUN_KEY]) return; // already ran on this tab, don't re-trigger on unrelated reloads
  if (!isHubTargetUrl(tab.url, hub)) return;

  await chrome.storage.session.set({ [RUN_KEY]: true });
  chrome.storage.local.remove(['pageCheck', 'pageLink']).catch(() => {});   // a new run never shows the previous page's check / link

  const log = [];
  // The status is also painted on the WordPress page itself (small box, bottom right) so you can see where the run is,
  // and the WordPress tab is kept as the visible tab of its window.
  let bulkReported = false;
  const setStatus = async (ok, message) => {
    await chrome.storage.session.set({ [STATUS_KEY]: { ok, message } });
    if (hub.autoDraft && ok === false && !bulkReported) {          // Bulk dashboard: tell it about ANY failure, so it never waits for nothing
      bulkReported = true;
      await chrome.storage.local.set({ bulkDraftResult: { ticket: hub.bulkTicket || '', at: Date.now(), ok: false, error: String(message || 'The WordPress fill failed.'), seconds: Math.round((Date.now() - runStart) / 100) / 10 } });
    }
    try {
      if (!hub.autoDraft) await chrome.tabs.update(tabId, { active: true });
      await execIn(tabId, paintProgress, [message, ok]);
    } catch (e) { /* the tab went away or is still loading */ }
  };
  // bring the WordPress window to the front once, at the start — unless you are choosing the image in the library right now
  try {
    const libNow = (await chrome.storage.local.get('diLandingImage')).diLandingImage;
    if (!hub.autoDraft && tab.windowId != null && !(libNow && libNow.status === 'choose')) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) { /* optional */ }
  // TIME LOG: every step with its seconds, saved to chrome.storage.local so it is still there after the popup closed
  const timing = [];
  const runStart = stored.hubOpenedAt || Date.now();
  const mark = (label, t0) => timing.push({ label, s: Math.round((Date.now() - t0) / 100) / 10 });
  const saveTimeLog = () => chrome.storage.local.set({ timeLog: { source: 'Landing / Comparison / Hub', at: Date.now(), total: Math.round((Date.now() - runStart) / 100) / 10, steps: timing } });

  if (stored.hubOpenedAt) mark('WordPress page load (tab opened → ready)', stored.hubOpenedAt);

  let debuggerAttached = false;

  try {
    await setStatus(true, hub.vrpSeoContent
      ? 'Filling title, Lightning template, and parent…'
      : 'Filling title, template, parent — waiting for DI Page Composer to load…');

    /* 1. Basics */
    const tBasics = Date.now();
    const basics = await execIn(tabId, fillBasics, [hub]);
    mark('Title / template / parent / slug (incl. waiting for DI Page Composer)', tBasics);
    log.push(...(basics?.log || []));
    // WordPress admin notices such as "Core Components: The plugin has been paused" — say so in the log, with the link to turn it on
    let pausedNote = '';
    try {
      const paused = (await execIn(tabId, detectPausedPlugins)) || [];
      for (const p of paused) log.push(`⚠ Plugin paused on this site: "${p.plugin}"${p.link ? ` — turn it on: ${p.link}` : ''} (if rows, fields or the page itself look wrong, this is the first thing to check)`);
      if (paused.length) pausedNote = ` Note: ${paused.map(p => '"' + p.plugin + '"').join(', ')} ${paused.length > 1 ? 'are' : 'is'} paused on this site (WordPress admin notice).`;
    } catch { /* only a hint */ }
    if (basics?.parentUsed) hub.parentSlug = basics.parentUsed;   // the page check compares against what was really picked
    if (!basics?.ok) {
      await setStatus(false, (basics?.message || 'Could not fill page basics.') + pausedNote);
      return;
    }

    /* 1b. Meta title + description go in right away (they are already known) — no waiting for the rows to be built.
           The same fill runs again at the end (step 3), which keeps them if Yoast re-syncs while the page is built. */
    const metaHub = hub.vrpExistingPage ? { ...hub, title: '' } : hub;
    try {
      const tMetaEarly = Date.now();
      const early = await execIn(tabId, fillCssAndYoast, [{ ...metaHub, sections: [] }]);
      mark('Meta title + description (filled early)', tMetaEarly);
      log.push('early: ' + ((early?.log || []).join(', ') || 'no meta fill'));
    } catch (e) { log.push('early meta fill skipped: ' + e.message); }

    if (hub.vrpSeoContent) {
      await setStatus(true, 'Filling Lightning VRP SEO Content and checking page details…');
      const tContent = Date.now();
      const contentResult = await execIn(tabId, fillVrpSeoContent, [hub]);
      mark('Lightning VRP SEO Content', tContent);
      if (!contentResult?.ok) {
        await setStatus(false, `${contentResult?.error || 'Could not fill Lightning VRP SEO Content.'} Actions: ${log.join(', ')}`);
        await saveTimeLog();
        return;
      }
      log.push(`Lightning VRP SEO Content filled (${contentResult.chars} characters)`);
      const tMeta = Date.now();
      const metaResult = await execIn(tabId, fillCssAndYoast, [metaHub]);
      mark('Yoast meta title + description', tMeta);
      log.push(...(metaResult?.log || []));
      if (!hub.vrpExistingPage) {
        const slugCheck = await execIn(tabId, reassertSlug, [hub.slug]);
        log.push(slugCheck?.ok ? `slug "${hub.slug}" confirmed` : `slug could not be confirmed (${slugCheck?.now || 'field missing'})`);
      }
      const page = await execIn(tabId, verifyVrpPage, [hub]);
      const checks = page?.checks || [];
      const bad = checks.filter(check => !check.ok);
      const checkSummary = bad.length ? `${bad.length} of ${checks.length} need attention (${bad.map(check => check.name).join('; ')})` : `all ${checks.length} OK`;
      await chrome.storage.local.set({ pageCheck: { at: Date.now(), title: hub.title || '', checks } });
      await saveTimeLog();
      let draft = null;
      if (hub.autoDraft) {
        if (bad.length) {
          draft = { ok: false, error: `Not saved — ${bad.length} page check${bad.length > 1 ? 's' : ''} need attention: ${bad.map(check => check.name).join('; ')}. Fix it in WordPress and save by hand, or fix the doc and fetch again.` };
        } else {
          await setStatus(true, `All ${checks.length} page checks OK — saving the draft…`);
          const tDraft = Date.now();
          draft = await saveDraftAndWait(tabId);
          mark('Save Draft', tDraft);
          await saveTimeLog();
        }
        bulkReported = true;
        await chrome.storage.local.set({ bulkDraftResult: {
          ticket: hub.bulkTicket || '', at: Date.now(), ok: !!draft.ok, error: draft.error || '', parentPage: hub.parentSlug || '',
          editUrl: draft.info?.editUrl || '', previewUrl: draft.info?.previewUrl || '', postId: draft.info?.postId || '',
          notice: draft.info?.notice || '', seconds: Math.round((Date.now() - runStart) / 100) / 10,
          checks: checks.map(check => ({ name: check.name, ok: check.ok })),
        } });
      }
      const tail = hub.autoDraft
        ? (draft.ok ? ' SAVED AS A DRAFT (not published).' : ` DRAFT NOT SAVED: ${draft.error}`)
        : ' Nothing was saved — review and click Save Draft / Publish when ready.';
      await setStatus(hub.autoDraft ? !!draft.ok : !bad.length, `VRP page details filled. PAGE CHECK: ${checkSummary}. Content is in Lightning VRP SEO Content; no image or blog row was added.${tail} Actions: ${log.join(', ')}`);
      return;
    }

    /* 2. Attach the debugger once, use it for every row's two clicks */
    const tAttach = Date.now();
    const attachResult = await attachDebugger(tabId);
    mark('Attach debugger', tAttach);
    if (!attachResult.ok) {
      log.push(`Could not attach debugger for trusted clicks (${attachResult.error}). ` +
        'Close DevTools on this tab if it is open, then try again.');
      await setStatus(false,
        `Built basics only. Actions: ${log.join(', ')}. ` +
        'Row automation needs the debugger permission and failed to attach — see message above.');
      return;
    }
    debuggerAttached = true;

    await setStatus(true, 'DI Page Composer detected — building rows (using trusted clicks)…');

    const buildStart = Date.now();
    // PAGE CHECK: a read-only list of OK / not-OK results shown in the popup, so the page does not have to be checked by hand
    const checks = [];
    const addCheck = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail || '') });
    const builtLabels = new Set();
    let nestedWanted = 0, nestedDone = 0;
    // The banner image is read again here, at publish time: the stored page snapshot was taken at Preview,
    // possibly before the Image Library had finished (or before it was run at all).
    const imgSection = hub.bulkNoImage ? null : (hub.sections || []).find(x => x.id === 'landingimage' || x.id === 'imagery');   // landing page row / comparison page row
    // Reads the Image Library result into the banner section. True when a finished image is there.
    const loadLibraryImage = async () => {
      const st = await chrome.storage.local.get(['diLandingImage', 'diLandingImageAlt']);
      const lib = st.diLandingImage;
      if (lib && lib.status === 'done' && lib.dataUrl) {
        const was = imgSection.image;
        imgSection.image = {
          dataUrl: lib.dataUrl, width: lib.width, height: lib.height,
          alt: (was && was.alt) || st.diLandingImageAlt || lib.query || hub.title,
          filename: hub.slug || (was && was.filename) || 'landing-banner',
        };
        log.push(`Image Library: using \"${lib.query || 'last image'}\" (${lib.width || '?'}x${lib.height || '?'}) as ${imgSection.image.filename}`);
      } else if (imgSection.image && imgSection.image.dataUrl) {
        imgSection.image.filename = hub.slug || imgSection.image.filename;
      }
      return !!(imgSection.image && imgSection.image.dataUrl);
    };
    // Clean names + save the image as a file on this computer (needed by the Add Media upload).
    const prepareImage = async () => {
      // clean names: if this site's media library already has a file with this name, add the domain name to it
      try {
        const host = new URL((await chrome.tabs.get(tabId)).url).hostname;
        const site = siteSlug(host);
        const base = imgSection.image.filename;
        const tNameCheck = Date.now();
        const chk = await execIn(tabId, wpMediaNameTaken, [base]);
        mark('Image: media-library name check', tNameCheck);
        if (chk?.taken && site && !base.endsWith('-' + site)) {
          imgSection.image.filename = `${base}-${site}`;
          log.push(`media library already has \"${base}\" - using \"${imgSection.image.filename}\" instead`);
          const chk2 = await execIn(tabId, wpMediaNameTaken, [imgSection.image.filename]);
          if (chk2?.taken) log.push(`note: \"${imgSection.image.filename}\" is in the media library too - WordPress will add a number`);
        } else if (!chk?.checked) {
          log.push(`could not check the media library for \"${base}\" (${chk?.error || 'no answer'})`);
        }
      } catch (e) { log.push('media name check skipped: ' + e.message); }
      const tSave = Date.now();
      const savedNow = await saveImageToDisk(tabId, imgSection.image);
      mark('Image: save as a file on the computer', tSave);
      imgSection.image.saved = savedNow;
      log.push(savedNow.ok ? `image saved as a file: ${savedNow.path}` : `IMAGE FILE NOT SAVED: ${savedNow.error}`);
      addCheck('Image file saved on this computer', savedNow.ok, savedNow.ok ? savedNow.path : savedNow.error);
    };
    // The image that is added at the very end when it was still being fetched/chosen while its row was built.
    let deferredImage = null;
    let lateImage = null;
    await chrome.storage.session.remove(LATE_IMG_KEY);   // a new run forgets the previous page's waiting image
    if (imgSection) {
      if (await loadLibraryImage()) await prepareImage();
      else {
        const lib = (await chrome.storage.local.get('diLandingImage')).diLandingImage;
        log.push(`Image Library: no finished image yet (status: ${lib?.status || 'none'})`);
      }
    }

    const sections = (hub.sections || []).filter(s => s.id !== 'css' && s.autoBuild !== false);
    let builtCount = 0;
    const contentRows = [];
    const expectedRowOrder = [];   // rows in the order the page SHOULD have them (title row first ... contact form / blog feed last)

    for (const baseSection of sections) {
      const rowStart = Date.now();
      let section = baseSection;
      // say where the run is, so you can follow it on the WordPress page (the new row appears at the bottom)
      await setStatus(true, `Building the page — row ${builtCount + 1} of ${sections.length}: ${baseSection.label}. Watch the WordPress tab; nothing is saved automatically.`);
      // (a banner image is inserted after its row exists — see below)
      const config = section.config || {};
      const rowType = config.rowType || 'Full Width WYSIWYG';

      // Snapshot which rows exist right now (by data-id — object references
      // can't survive across separate executeScript calls).
      const beforeIds = (await execIn(tabId, snapshotRowIds)) || [];

      // Open the "add row" popup and pick the layout. A click can miss if the page was still shifting
      // (the editor in the previous row resizing), so each step is retried before giving up.
      let popupRect = null;
      let addRowRect = null;
      for (let attempt = 1; attempt <= 3 && !popupRect?.found; attempt++) {
        addRowRect = await execIn(tabId, getAddRowButtonRect);
        if (!addRowRect?.found) { await swWait(300); continue; }
        await trustedClick(tabId, addRowRect.x, addRowRect.y);
        popupRect = await execIn(tabId, getPopupLayoutLinkRect, [rowType]);
        if (!popupRect?.found) {
          log.push(`${section.label}: popup did not open (try ${attempt}/3)`);
          await swWait(300);
        }
      }
      if (!addRowRect?.found && !popupRect?.found) {
        log.push(`${section.label}: SKIP — Add Row button not found (${addRowRect?.reason || 'unknown reason'})`);
        continue;
      }
      if (!popupRect?.found) {
        log.push(`${section.label}: FAILED to open/select layout "${rowType}" (${popupRect?.reason || 'unknown reason'})`);
        continue;
      }
      await trustedClick(tabId, popupRect.x, popupRect.y);
      log.push(`${section.label}: type "${rowType}" selected`);

      let fillResult = await execIn(tabId, waitForNewRowAndFill, [beforeIds, popupRect.slug, section]);
      if (!fillResult?.success) {
        // The popup may still be open (the layout click missed) — click the layout once more.
        const again = await execIn(tabId, getPopupLayoutLinkRect, [rowType]);
        if (again?.found) {
          await trustedClick(tabId, again.x, again.y);
          fillResult = await execIn(tabId, waitForNewRowAndFill, [beforeIds, again.slug, section]);
        }
      }
      if (fillResult?.success) {
        builtCount++;
        builtLabels.add(section.label);
        if (fillResult.rowId) expectedRowOrder.push({ label: section.label, rowId: fillResult.rowId });
        log.push(...(fillResult.log || []));
        log.push(`${section.label}: ${Math.round((Date.now() - rowStart) / 1000)}s`);
        mark(`Row: ${section.label}`, rowStart);
        if (!hub.bulkNoImage && (section.id === 'landingimage' || section.id === 'imagery') && !(section.image && section.image.dataUrl)) {
          const libNow = (await chrome.storage.local.get('diLandingImage')).diLandingImage;
          const fresh = libNow && Date.now() - (libNow.updatedAt || 0) < 5 * 60 * 1000;
          if (fillResult.rowId && fresh && (libNow.status === 'running' || libNow.status === 'choose')) {
            deferredImage = { section, rowId: fillResult.rowId };
            log.push(`${section.label}: the image is still being ${libNow.status === 'choose' ? 'chosen' : 'fetched'} — it is added at the end, when it is ready`);
          } else {
            if (fillResult.rowId) { lateImage = { tabId, rowId: fillResult.rowId, slug: hub.slug, title: hub.title, since: Date.now() }; await chrome.storage.session.set({ [LATE_IMG_KEY]: lateImage }); }
            addCheck('Banner image', false, 'no image yet — it is added by itself as soon as an image is downloaded');
            log.push(`${section.label}: NO IMAGE — nothing was picked in the popup's Image Library (it must show the chosen image before you press Publish), row left blank`);
          }
        }
        if (fillResult.rowId && section.image && section.image.dataUrl) {
          const ins = await insertBannerImage(tabId, fillResult.rowId, section.image);
          log.push(`${section.label}: Add Media → ${(ins.steps || []).join(' → ')}`);
          if (ins.ok) {
            log.push(`${section.label}: image inserted with alt "${section.image.alt}"`);
            addCheck('Banner image uploaded + inserted', true, `alt "${section.image.alt}"`);
          } else {
            addCheck('Banner image uploaded + inserted', false, `${ins.error || 'Add Media failed'} — add it by hand`);
            // No <img> code is pasted into the editor: the image goes in only through Add Media (upload / select the file).
            const where = ins.saved?.ok ? `the image file is at ${ins.saved.path}` : 'the image could not be saved as a file';
            log.push(`${section.label}: Add Media flow failed (${ins.error}) — row left blank; ${where}. Add it by hand: Add Media → Upload files → that file.`);
          }
        }
        if (fillResult.rowId && section.html && section.fillMethod !== 'label') {
          const chk = await execIn(tabId, ensureRowContent, [fillResult.rowId, section.html]);
          log.push(`${section.label}: content check — ${chk?.ok ? 'OK (' + chk.how + ')' : 'BLANK: ' + (chk?.how || 'unknown')}`);
          contentRows.push({ label: section.label, rowId: fillResult.rowId, html: section.html });
        }

        // Nested rows (e.g. Direct Compare Data Row's "Data" entries) —
        // scoped to this specific row's own repeater so they never collide
        // with the outer DI Page Composer field's Add Row button.
        if (Array.isArray(section.nestedRows) && section.nestedRows.length) {
          if (!fillResult.rowId) {
            log.push(`${section.label}: nested rows SKIPPED — could not identify the row's data-id`);
          } else {
            // 1) add every Data entry (empty), 2) fill them TOP TO BOTTOM with the doc table's rows in order. Where WordPress puts
            //    a new entry (top or bottom of the list) therefore no longer matters: the first row of the table is always the first entry.
            const idsBeforeAll = (await execIn(tabId, snapshotNestedRowIds, [fillResult.rowId])) || [];
            const toFill = [];
            for (const nested of section.nestedRows) {
              const nestedType = (typeof nested === 'string' ? nested : nested.rowType) || 'Data';
              const nestedAddRect = await execIn(tabId, getNestedAddRowButtonRect, [fillResult.rowId]);
              if (!nestedAddRect?.found) {
                log.push(`${section.label}: nested "${nestedType}" row SKIPPED — ${nestedAddRect?.reason || 'add button not found'}`);
                continue;
              }
              await trustedClick(tabId, nestedAddRect.x, nestedAddRect.y);

              const nestedPopupRect = await execIn(tabId, getPopupLayoutLinkRect, [nestedType]);
              if (!nestedPopupRect?.found) {
                log.push(`${section.label}: nested "${nestedType}" row FAILED to select layout (${nestedPopupRect?.reason || 'unknown reason'})`);
                continue;
              }
              await trustedClick(tabId, nestedPopupRect.x, nestedPopupRect.y);
              log.push(`${section.label}: nested "${nestedType}" row added`);
              await swWait(150);
              if (typeof nested === 'object' && (nested.left || nested.middle || nested.right)) toFill.push(nested);
            }
            await swWait(300);
            const idsAfterAll = (await execIn(tabId, snapshotNestedRowIds, [fillResult.rowId])) || [];
            const newIds = idsAfterAll.filter(id => !idsBeforeAll.includes(id));     // top-to-bottom, as they are on the page
            if (newIds.length !== toFill.length) {
              log.push(`${section.label}: ${toFill.length} table rows to fill but ${newIds.length} new Data entries on the page`);
            }
            for (let i = 0; i < toFill.length && i < newIds.length; i++) {
              nestedWanted++;
              const nestedFill = await execIn(tabId, fillNestedDataRow, [fillResult.rowId, idsBeforeAll, toFill[i], newIds[i]]);
              if (nestedFill?.success) {
                nestedDone++;
                log.push(`${section.label}: table row ${i + 1} → Data entry ${i + 1} filled (Left/Middle/Right)`);
              } else {
                log.push(`${section.label}: table row ${i + 1} added but could not be filled — fill by hand (${nestedFill?.reason || 'Left Data/Middle Label/Right Data fields not found'})`);
              }
            }
          }
        }
      } else {
        log.push(`${section.label}: FAILED — no new visible row appeared after the trusted click ` +
          '(the click registered differently than expected — see note below)');
      }
    }

    // The image was still being fetched when its row was built: all rows are done now, so wait for it and insert it.
    if (deferredImage) {
      const tWaitImg = Date.now();
      let lib = null;
      while (Date.now() - tWaitImg < 150000) {
        lib = (await chrome.storage.local.get('diLandingImage')).diLandingImage;
        if (lib && ((lib.status === 'done' && lib.dataUrl) || lib.status === 'error')) break;
        await swWait(1000);
      }
      mark('Image: waited for the Image Library (after all rows were built)', tWaitImg);
      const sec = deferredImage.section;
      if (await loadLibraryImage()) {
        await prepareImage();
        const tInsImg = Date.now();
        const ins = await insertBannerImage(tabId, deferredImage.rowId, sec.image);
        log.push(`${sec.label}: Add Media → ${(ins.steps || []).join(' → ')}`);
        if (ins.ok) {
          log.push(`${sec.label}: image inserted with alt \"${sec.image.alt}\"`);
          addCheck('Banner image uploaded + inserted', true, `alt \"${sec.image.alt}\"`);
        } else {
          addCheck('Banner image uploaded + inserted', false, `${ins.error || 'Add Media failed'} — add it by hand`);
          log.push(`${sec.label}: Add Media flow failed (${ins.error}) — row left blank; add it by hand: Add Media → Upload files → the saved image file.`);
        }
        mark(`${sec.label}: Add Media image upload/insert`, tInsImg);
      } else {
        lateImage = { tabId, rowId: deferredImage.rowId, slug: hub.slug, title: hub.title, since: Date.now() };
        await chrome.storage.session.set({ [LATE_IMG_KEY]: lateImage });
        addCheck('Banner image', false, (lib?.status === 'error' ? `the Image Library failed: ${lib.error || 'unknown error'}` : 'the image was not ready in time (waited 2.5 minutes)') + ' — it is added by itself as soon as an image is downloaded');
        log.push(`${sec.label}: NO IMAGE — the Image Library gave no image in time, row left blank`);
      }
    }

    // Row order guard: WordPress/ACF can end up with a row above/below where it belongs (e.g. the Page Title row pushed
    // down, or the contact form / blog feed above the content). Put every built row back in the order it was built in.
    if (expectedRowOrder.length > 1) {
      try {
        const ord = await execIn(tabId, fixRowOrder, [expectedRowOrder.map(r => r.rowId)]);
        if (ord?.moved) log.push(`row order: was wrong, fixed (${ord.before.join(' > ')} → ${ord.after.join(' > ')})`);
        else log.push(`row order: OK${ord?.note ? ' (' + ord.note + ')' : ''}`);
        addCheck('Rows are in the right order', !!ord?.ok, ord?.note || (ord?.moved ? 'reordered' : ''));
      } catch (e) { log.push('row order check skipped: ' + e.message); }
    }

    // Final guard: every content row must still hold its text now that all rows are built.
    for (const row of contentRows) {
      const chk = await execIn(tabId, ensureRowContent, [row.rowId, row.html]);
      addCheck(`Text in "${row.label}"`, !!chk?.ok, chk?.how || '');
      if (chk && !(chk.how === 'already there')) log.push(`${row.label}: final check — ${chk.ok ? 'refilled' : 'STILL BLANK: ' + chk.how}`);
      else if (!chk?.ok) log.push(`${row.label}: final check — STILL BLANK`);
    }


    /* 3. CSS overrides + Yoast */
    const tFinish = Date.now();
    const finishing = await execIn(tabId, fillCssAndYoast, [hub]);
    mark('CSS overrides + Yoast', tFinish);
    log.push(...(finishing?.log || []));

    // WordPress can quietly swap the slug back to the title-based one while the page is being built.
    const slugCheck = await execIn(tabId, reassertSlug, [hub.slug]);
    log.push(slugCheck?.ok
      ? (slugCheck.changed ? `slug "${hub.slug}" restored (WordPress had changed it)` : `slug "${hub.slug}" confirmed`)
      : `slug: could not confirm "${hub.slug}" (field shows "${slugCheck?.now}") — set it manually`);
    // The page's link (draft permalink) for the popup — read only
    try {
      const pl = await execIn(tabId, readPagePermalink, [hub.slug, hub.title]);
      if (pl?.url) { await storePageLink(pl, hub.title, false); log.push(`page link: ${pl.url}`); }
      else log.push('page link: not available yet (WordPress shows it after the first save)');
    } catch (e) { log.push('page link skipped: ' + e.message); }
    await setStatus(true, 'All rows built — filling the meta title / description and checking the page…');
    // PAGE CHECK — read only: what is on the WordPress page now vs. what the doc / popup asked for
    let checkSummary = 'not run';
    try {
      for (const s of sections) if (!builtLabels.has(s.label)) addCheck(`Row "${s.label}"`, false, 'was not built — add it by hand');
      if (nestedWanted) addCheck('Comparison data rows filled', nestedDone === nestedWanted, `${nestedDone} of ${nestedWanted}`);
      const slim = { title: hub.title, slug: hub.slug, templateName: hub.templateName, parentSlug: hub.parentSlug, metaTitle: hub.metaTitle, metaDescription: hub.metaDescription };
      const page = await execIn(tabId, verifyPage, [slim, sections.length]);
      for (const c of (page?.checks || [])) checks.push(c);
      const bad = checks.filter(c => !c.ok);
      checkSummary = bad.length ? `${bad.length} of ${checks.length} need attention (${bad.map(c => c.name).join('; ')})` : `all ${checks.length} OK`;
      await chrome.storage.local.set({ pageCheck: { at: Date.now(), title: hub.title || '', checks } });
    } catch (e) { log.push('page check skipped: ' + e.message); }
    log.push(`total build time ${Math.round((Date.now() - buildStart) / 1000)}s`);
    await saveTimeLog();

    await detachDebugger(tabId);
    debuggerAttached = false;

    const ok = builtCount > 0;
    let bulkDraft = null;
    if (hub.autoDraft) {
      const failed = checks.filter(c => !c.ok);
      if (!ok) bulkDraft = { ok:false, error:'No page rows were built; nothing was saved.' };
      else if (failed.length) bulkDraft = { ok:false, error:`Not saved — ${failed.length} page check${failed.length===1?'':'s'} need attention: ${failed.map(c=>c.name).join('; ')}.` };
      else {
        await setStatus(true, 'Page checks passed — saving the WordPress draft…');
        bulkDraft = await saveDraftAndWait(tabId);
      }
      bulkReported = true;
      await chrome.storage.local.set({ bulkDraftResult: { ticket:hub.bulkTicket||'', at:Date.now(), ok:!!bulkDraft.ok, error:bulkDraft.error||'', parentPage:hub.parentSlug||'', editUrl:bulkDraft.info?.editUrl||'', previewUrl:bulkDraft.info?.previewUrl||'', postId:bulkDraft.info?.postId||'', notice:bulkDraft.info?.notice||'', seconds:Math.round((Date.now()-runStart)/100)/10, checks:checks.map(c=>({name:c.name,ok:c.ok})) } });
    }
    const tail = hub.autoDraft ? (bulkDraft?.ok ? ' SAVED AS A DRAFT (not published).' : ` DRAFT NOT SAVED: ${bulkDraft?.error||'checks did not pass'}`) : ' Nothing was saved — review the page and click Save Draft / Publish when ready.';
    await setStatus(hub.autoDraft ? !!bulkDraft?.ok : ok, ok
      ? `Built ${builtCount}/${sections.length} rows. Actions: ${log.join(', ')}. PAGE CHECK: ${checkSummary}.${tail}`
      : `Built 0/${sections.length} rows even with trusted clicks. Actions: ${log.join(', ')}. Keep the WordPress tab focused and in the foreground during the run and try again.`);
  } catch (err) {
    console.error('Hub Publisher — fill error:', err);
    if (debuggerAttached) await detachDebugger(tabId);
    await setStatus(false, `Error: ${err.message}. Actions so far: ${log.join(', ') || '(none)'}.`);
    try { await saveTimeLog(); } catch (e) { /* ignore */ }
  }
});

/* ================================================================== */
/*  Injected functions — each one is serialized independently, so     */
/*  small helpers are duplicated rather than shared via closure.       */
/* ================================================================== */

/* ---- progress box painted on the WordPress page (injected) ---- */
function paintProgress(text, ok) {
  const id = 'di-ext-progress';
  let b = document.getElementById(id);
  if (!b) {
    b = document.createElement('div');
    b.id = id;
    b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;color:#fff;font:600 13px/1.45 "Segoe UI",Arial,sans-serif;' +
      'padding:10px 14px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:340px;pointer-events:none;';
    (document.body || document.documentElement).appendChild(b);
  }
  b.textContent = 'All in 1 tool: ' + String(text || '').slice(0, 170);
  b.style.background = ok === false ? '#b3261e' : '#0b5a4a';
  clearTimeout(window.__diProgressTimer);
  window.__diProgressTimer = setTimeout(() => { const x = document.getElementById(id); if (x) x.remove(); }, 40000);   // gone 40s after the last update
}

/* ---- 1. Title / template / parent / slug, wait for DI Page Composer ---- */
function fillBasics(hub) {
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const setValue = (el, value) => {
    if (!el || value == null) return false;
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const selectOption = (el, match) => {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return false;
    const wanted = match.toLowerCase();
    for (const opt of el.options) {
      if (opt.text.toLowerCase().includes(wanted) || opt.value.toLowerCase().includes(wanted)) {
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  };

  // Prefers an exact (trimmed, case-insensitive) text match before falling back
  // to a substring match — avoids e.g. "General Service" winning over plain "Service".
  const selectExactThenContains = (el, wanted) => {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return false;
    // child pages are indented with &nbsp; / dashes in the dropdown — strip that before comparing
    const norm = t => (t || '').replace(/\u00a0/g, ' ').replace(/^[\s\-\u2013\u2014]+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = norm(wanted);
    for (const opt of el.options) {
      if (norm(opt.text) === target) {
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return selectOption(el, wanted);
  };

  // Dealer-aware parent: choose from the real #parent_id options (child pages are indented with &nbsp; / dashes).
  const pickParentFromPage = h => {
    const el = document.querySelector('#parent_id');
    if (!el) return '';
    const flat = t => (t || '').replace(/\u00a0/g, ' ').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();
    const opts = [...el.options].filter(o => o.value && o.value !== '0' && flat(o.text));
    const title = ' ' + flat(h.title) + ' ';
    const MAKES = ['chevrolet', 'chevy', 'ford', 'toyota', 'honda', 'kia', 'hyundai', 'nissan', 'subaru', 'mazda', 'bmw', 'mercedes benz', 'mercedes', 'volkswagen', 'vw', 'cadillac', 'buick', 'gmc', 'jeep', 'dodge', 'ram', 'chrysler', 'lexus', 'acura', 'genesis', 'mini', 'mitsubishi', 'volvo', 'audi', 'lincoln', 'infiniti', 'porsche', 'land rover', 'jaguar', 'tesla', 'fiat', 'alfa romeo'];
    const makes = MAKES.filter(m => title.includes(' ' + m + ' ')).sort((a, b) => title.indexOf(' ' + a + ' ') - title.indexOf(' ' + b + ' '));
    const RW = '(?:research|information|info)';
    const rules = [];
    if (/\b(vs|versus|compar\w*)\b/i.test(h.title || '')) rules.push(/\bmodel comparisons?\b/, /^comparisons?$/);
    makes.forEach(m => rules.push(new RegExp('\\b' + m + '\\b.*\\b' + RW + '\\b')));
    rules.push(new RegExp('^manufacturer ' + RW + '$'), new RegExp('manufacturer ' + RW), /^vehicle research$/, /^research( hub)?$/, /\bresearch\b/);
    for (const re of rules) {
      const hit = opts.find(o => re.test(flat(o.text)));
      if (hit) {
        el.value = hit.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return hit.text.replace(/\u00a0/g, ' ').replace(/^[\s\-\u2013\u2014]+/, '').trim();
      }
    }
    return '';
  };

  const findAddRowButtons = () => {
    const isVisible = (el) => !!el && el.offsetParent !== null;
    const notClone = (el) => !el.closest('.acf-clone, .clones, .tmpl-clone');
    // Excludes Add Row buttons that belong to a NESTED flexible-content field
    // (e.g. the Direct Compare Data Row's own "Add Data Row" repeater) — any
    // such button sits inside a `.layout` row of the outer field, which the
    // outer field's own Add Row button never does.
    const notNestedField = (el) => !el.closest('.acf-flexible-content .layout');

    const selectors = [
      '.acf-flexible-content .acf-actions [data-name="add-layout"]',
      '.acf-flexible-content .acf-actions [data-event="add-layout"]',
      '.acf-flexible-content [data-name="add-layout"]',
      '.acf-flexible-content [data-event="add-layout"]',
      '.acf-flexible-content .acf-actions a.button',
      '.acf-flexible-content .acf-actions .acf-button',
    ];

    const candidates = [];
    for (const sel of selectors) {
      candidates.push(...document.querySelectorAll(sel));
    }
    // Fallback: anything inside a flexible-content field whose visible text says "Add Row".
    document.querySelectorAll('.acf-flexible-content a, .acf-flexible-content button').forEach(el => {
      if (/add\s*row/i.test(el.textContent || '')) candidates.push(el);
    });

    // De-dupe while preserving order, then keep only real, visible, non-clone,
    // top-level (non-nested-field) buttons.
    const seen = new Set();
    return candidates.filter(el => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      return notClone(el) && isVisible(el) && notNestedField(el);
    });
  };

  const findAddRowButton = () => findAddRowButtons()[0] || null;

  return (async () => {
    const log = [];

    if (hub.vrpSeoContent && hub.vrpExistingPage) {
      for (let i = 0; i < 100 && !document.querySelector('#lvrpSeoContentEditor'); i++) await wait(100);
      if (!document.querySelector('#lvrpSeoContentEditor')) {
        return { ok: false, log, message: 'The selected existing page does not have a Lightning VRP SEO Content editor.' };
      }
      log.push('existing page kept as-is; Lightning VRP SEO Content editor detected');
      return { ok: true, log };
    }

    if (setValue('#title', hub.title)) log.push('title');

    let templateOk = !hub.templateName, templateOptions = [];
    if (hub.templateName) {
      // the template is found by name; a site that names it a little differently ("Page Composer") still works
      templateOk = selectOption('#page_template', hub.templateName) || (!hub.vrpSeoContent && selectOption('#page_template', 'composer'));
      templateOptions = [...document.querySelectorAll('#page_template option')].map(o => (o.text || '').trim()).filter(Boolean);
      if (templateOk) log.push('template');
      else log.push(`template: "${hub.templateName}" is NOT in this site's Page Template list (${templateOptions.join(' | ') || 'no Page Template box found on this page'})`);
    }

    let parentUsed = '';
    // VRP page: the parent is the site's New or Used page. Names are tried in this order and must match EXACTLY, so a
    // page like "New Vehicles Specials" is never picked by mistake. Nothing found -> parent stays empty and the log says so.
    const vrpKind = hub.vrpSeoContent
      ? (/\b(used|pre[\s-]?owned)\b/i.test(hub.parentSlug || '') ? 'used' : /\bnew\b/i.test(hub.parentSlug || '') ? 'new' : '')
      : '';
    if (vrpKind) {
      const names = vrpKind === 'used'
        ? ['Used Vehicles', 'Pre-Owned Vehicles', 'Used Inventory', 'Pre-Owned Inventory']
        : ['New Vehicles', 'New Inventory'];
      const parentEl = document.querySelector('#parent_id');
      const clean = t => (t || '').replace(/\u00a0/g, ' ').replace(/^[\s\-\u2013\u2014]+/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      let picked = null;
      if (parentEl) {
        for (const name of names) {
          picked = [...parentEl.options].find(o => o.value && o.value !== '0' && clean(o.text) === clean(name));
          if (picked) break;
        }
      }
      if (picked) {
        parentEl.value = picked.value;
        parentEl.dispatchEvent(new Event('change', { bubbles: true }));
        parentUsed = picked.text.replace(/\u00a0/g, ' ').replace(/^[\s\-\u2013\u2014]+/, '').trim();
        log.push(`parent "${parentUsed}" (${vrpKind} vehicles)`);
      } else {
        log.push(`parent: none of ${names.join(' / ')} exists in Page Attributes — choose the parent manually`);
      }
    } else if (hub.parentSlug) {
      if (selectExactThenContains('#parent_id', hub.parentSlug)) {
        log.push('parent');
      } else {
        // The popup's "Auto" parent is a generic name (e.g. "Manufacturer Information") but parent pages are named
        // differently on every dealer site (e.g. "Cadillac Research"). The real list is right here in Page Attributes,
        // so choose from it with the same rules as the "Load parents" button.
        const alt = hub.vrpSeoContent ? '' : pickParentFromPage(hub);
        if (alt) {
          parentUsed = alt;
          log.push(`parent: "${hub.parentSlug}" is not on this site — picked "${alt}" from its Page Attributes list`);
        } else {
          log.push(`parent: could not find a Page Attributes option matching "${hub.parentSlug}" — set it manually`);
        }
      }
    } else if (!hub.vrpSeoContent) {
      // Bulk Landing / Comparison packages can arrive without an explicit parent. Keep the existing dealer-aware
      // suggestion active in that case instead of silently leaving WordPress at No Parent.
      const alt = pickParentFromPage(hub);
      if (alt) {
        parentUsed = alt;
        log.push('parent: auto-selected "' + alt + '" from the dealer Page Attributes list');
      } else {
        log.push('parent: no matching dealer/research page found — left as No Parent');
      }
    } else {
      log.push('parent: left as default (No Parent)');
    }

    if (hub.vrpSeoContent) {
      if (hub.slug) {
        const hiddenName = document.querySelector('#post_name');
        if (hiddenName) {
          setValue(hiddenName, hub.slug);
          log.push('slug (set directly, re-checked at the end)');
        }
      }
      for (let i = 0; i < 100 && !document.querySelector('#lvrpSeoContentEditor'); i++) await wait(100);
      if (!document.querySelector('#lvrpSeoContentEditor')) {
        return { ok: false, log, templateOk, message: 'Lightning template selected, but the Lightning VRP SEO Content editor (#lvrpSeoContentEditor) was not found.' };
      }
      log.push('Lightning VRP SEO Content editor detected');
      return { ok: true, log, parentUsed };
    }

    let addRowBtn = null;
    for (let i = 0; i < 130; i++) {
      addRowBtn = findAddRowButton();
      if (addRowBtn) break;
      await wait(150);
    }
    if (!addRowBtn) {
      return {
        ok: false, log, templateOk,
        message: templateOk
          ? 'DI Page Composer never appeared after selecting the template (waited 20s). Check that the Page Composer field group is tied to this template.'
          : `This site has no "${hub.templateName}" page template to choose (its Page Template list: ${templateOptions.join(' | ') || 'not found'}), so the Page Composer rows never appear. ` +
            'That template is normally added by the Dealer Inspire "Core Components" plugin — if the admin shows "The plugin has been paused", turn it on and run again.',
      };
    }
    log.push('DI Page Composer detected');

    document.querySelector('#title')?.dispatchEvent(new Event('blur', { bubbles: true }));
    // The slug used to be typed through WordPress's slug editor, which only appears after WordPress's own
    // autosave has created a draft — waiting for it cost several seconds before any row was built. The value
    // WordPress actually saves is the hidden #post_name field, so set that directly now; the end of the run
    // re-checks it (reassertSlug) after the autosave has long finished.
    if (hub.slug) {
      const hiddenName = document.querySelector('#post_name');
      if (hiddenName) {
        setValue(hiddenName, hub.slug);
        log.push('slug (set directly, re-checked at the end)');
      } else {
        log.push('slug: #post_name not there yet — it is set at the end of the run');
      }
    }

    return { ok: true, log, parentUsed };
  })();
}

/* ---- VRP Enhancement: write Doc HTML into the Lightning-specific SEO editor. ---- */
function fillVrpSeoContent(hub) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  return (async () => {
    const ta = document.querySelector('#lvrpSeoContentEditor');
    if (!ta) return { ok: false, error: 'Lightning VRP SEO Content editor was not found.' };
    const html = hub.vrpContentHtml || '';
    if (!html.trim()) return { ok: false, error: 'Google Doc content is empty.' };
    for (let attempt = 0; attempt < 6; attempt++) {
      const editor = window.tinymce?.get?.(ta.id);
      if (editor && editor.initialized && !editor.removed && !ta.closest('.wp-editor-wrap')?.classList.contains('html-active')) {
        editor.setContent(html);
        editor.save();
        editor.fire('change');
      } else {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(ta, html); else ta.value = html;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await wait(120);
      const activeEditor = window.tinymce?.get?.(ta.id);
      const current = activeEditor?.initialized && !ta.closest('.wp-editor-wrap')?.classList.contains('html-active')
        ? activeEditor.getContent() : ta.value;
      const plain = value => (value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, '').trim();
      if (plain(current).length >= Math.min(plain(html).length, 20)) return { ok: true, chars: plain(current).length };
    }
    return { ok: false, error: 'Content did not stay in the Lightning VRP SEO Content editor.' };
  })();
}

function verifyVrpPage(hub) {
  const checks = [];
  const norm = value => (value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail || '') });
  if (!hub.vrpExistingPage) {
    const title = document.querySelector('#title')?.value || '';
    add('Page title', norm(title) === norm(hub.title), title);
    const slug = document.querySelector('#post_name')?.value || '';
    add('Page slug', norm(slug).replace(/^\/+|\/+$/g, '') === norm(hub.slug).replace(/^\/+|\/+$/g, ''), slug);
    const template = document.querySelector('#page_template');
    const selectedTemplate = template?.options?.[template.selectedIndex];
    add('Template', !!selectedTemplate && (/lightning/i.test(selectedTemplate.text) || /lightning/i.test(selectedTemplate.value)), selectedTemplate?.text || 'template field not found');
    const parent = document.querySelector('#parent_id');
    const selectedParent = parent?.options?.[parent.selectedIndex];
    const selectedParentName = norm(selectedParent?.text).replace(/^[\s\-\u2013\u2014]+/, '');
    add('Parent page', !!selectedParent && selectedParentName.toLowerCase() === norm(hub.parentSlug).toLowerCase(), selectedParent?.text || 'no parent selected');
  }
  const editor = document.querySelector('#lvrpSeoContentEditor');
  const editorValue = editor?.value || '';
  const plain = value => norm((value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '));
  add('Lightning VRP SEO Content', !!editor && plain(editorValue).length >= Math.min(plain(hub.vrpContentHtml).length, 20), editor ? `${plain(editorValue).length} content characters` : 'editor not found');
  const yoast = document.querySelector('#yoast_wpseo_title')?.value || '';
  if (hub.metaTitle) add('Meta title (Yoast)', norm(yoast) === norm(hub.metaTitle), yoast);
  const desc = document.querySelector('#yoast_wpseo_metadesc')?.value || '';
  if (hub.metaDescription) add('Meta description (Yoast)', norm(desc) === norm(hub.metaDescription), desc);
  return { checks };
}

/* ---- Save Draft (Bulk dashboard only) -------------------------------------------------------------------------
 * Clicks the classic editor's "Save Draft" button (#save-post) — never Publish — then waits for WordPress to reload
 * the page as post.php?post=ID and confirms the status really is "draft". */
function clickSaveDraft() {
  const btn = document.querySelector('#save-post');
  if (!btn) return { ok: false, error: 'The "Save Draft" button was not found (a different editor?) — save the page by hand.' };
  if (btn.disabled) return { ok: false, error: 'The "Save Draft" button is disabled — save the page by hand.' };
  const status = (document.querySelector('#original_post_status') || document.querySelector('#post_status'))?.value || '';
  if (status && status !== 'draft' && status !== 'auto-draft') return { ok: false, error: `The page status is "${status}", not a draft — nothing was saved.` };
  setTimeout(() => btn.click(), 60);          // after this script has answered (the page reloads when it is saved)
  return { ok: true };
}

function readSavedDraft() {
  const q = sel => document.querySelector(sel);
  const u = new URL(location.href);
  return {
    postId: u.searchParams.get('post') || q('#post_ID')?.value || '',
    status: (q('#original_post_status') || q('#post_status'))?.value || '',
    title: q('#title')?.value || '',
    notice: [...document.querySelectorAll('#message p, .notice-error p, .notice-success p, .updated p')].map(n => n.textContent.trim()).filter(Boolean).slice(0, 3).join(' | '),
    previewUrl: q('#post-preview')?.href || '',
    editUrl: location.href.replace(/&message=\d+/, ''),
  };
}

async function saveDraftAndWait(tabId) {
  let click;
  try { click = await execIn(tabId, clickSaveDraft); } catch (e) { return { ok: false, error: 'Could not click Save Draft: ' + e.message }; }
  if (!click?.ok) return { ok: false, error: click?.error || 'Could not click Save Draft.' };
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise(r => setTimeout(r, 900));
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return { ok: false, error: 'The WordPress tab was closed before the draft was confirmed.' }; }
    if (tab.status === 'complete' && /\/wp-admin\/post\.php/i.test(tab.url || '') && /[?&]post=\d+/.test(tab.url || '')) {
      let info;
      try { info = await execIn(tabId, readSavedDraft); } catch (e) { return { ok: false, error: 'Saved, but the result could not be read: ' + e.message }; }
      if (info?.status !== 'draft') return { ok: false, info, error: `WordPress reloaded, but the page status is "${info?.status || 'unknown'}", not "draft" — open the page and check it.` };
      return { ok: true, info };
    }
  }
  return { ok: false, error: 'WordPress did not confirm the save within 60 seconds — open the page and check whether the draft was saved.' };
}

/* ---- Where is this row's own "Add Media" button? (data-editor matches the row's editor, e.g. acf-editor-45) ---- */
function getMediaButtonRect(rowId) {
  return (async () => {
    const row = document.querySelector(`.layout[data-id="${rowId}"]`);
    if (!row) return { found: false, reason: 'image row not found' };
    const ta = row.querySelector('textarea.wp-editor-area') || row.querySelector('.acf-editor-wrap textarea');
    const mine = ta && ta.id ? row.querySelector(`.insert-media[data-editor="${ta.id}"]`) : null;
    const btn = mine || row.querySelector('.wp-media-buttons .insert-media, button.insert-media');
    if (!btn) return { found: false, reason: 'no "Add Media" button in the image row' };
    let last = null, still = 0;
    for (let i = 0; i < 30 && still < 2; i++) {
      btn.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise(r => setTimeout(r, 40));
      const r0 = btn.getBoundingClientRect();
      const key = [Math.round(r0.left), Math.round(r0.top), Math.round(r0.width), Math.round(r0.height)].join(',');
      still = key === last ? still + 1 : 0;
      last = key;
    }
    const rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) return { found: false, reason: 'Add Media button has zero size (editor not ready?)' };
    return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })();
}

/* ---- Put the banner in through WordPress's own "Add Media" window, the way a person does ----
 * 1. the image is saved as a real file (Downloads/di-landing/…)            [saveImageToDisk]
 * 2. Add Media is clicked (real click) and the "Upload files" tab opened   [openMediaUploadTab]
 * 3. the file is handed to the "Select Files" file chooser through the debugger, i.e. a genuine file pick
 *                                                                          [setFileViaDebugger]
 * 4. wait for the upload, fill Alt text / Title, pick the size, Insert into page   [finishMediaInsert] */

/* page side: step 2 — open the window and the upload tab, wait for the Select Files input */
async function openMediaUploadTab(rowId, alreadyClicked) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); } return null; };
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const steps = [];
  try {
    const row = document.querySelector(`.layout[data-id="${rowId}"]`);
    if (!row) return { ok: false, error: 'image row not found', steps };
    const findModal = () => [...document.querySelectorAll('.media-modal')].find(visible);
    let modal = alreadyClicked ? await until(findModal, 6000) : null;
    if (modal) steps.push('Add Media opened (real click)');
    if (!modal) {
      const ta = row.querySelector('textarea.wp-editor-area');
      const btn = (ta && ta.id && row.querySelector(`.insert-media[data-editor="${ta.id}"]`)) || row.querySelector('.wp-media-buttons .insert-media, button.insert-media');
      if (!btn) return { ok: false, error: 'no "Add Media" button in the image row', steps };
      row.scrollIntoView({ block: 'center' });
      await sleep(60);
      btn.click();
      steps.push('Add Media clicked (script click)');
      modal = await until(findModal, 10000);
    }
    if (!modal) return { ok: false, error: 'the Add Media window did not open', steps };
    const tab = modal.querySelector('#menu-item-upload') || [...modal.querySelectorAll('.media-menu-item')].find(b => /upload/i.test(b.textContent));
    if (tab) { tab.click(); steps.push('Upload files tab'); await sleep(150); }
    const input = await until(() => modal.querySelector('input[type="file"]'), 8000);
    if (!input) return { ok: false, error: 'no Select Files input in the upload tab', steps };
    steps.push('Select Files ready');
    return { ok: true, steps };
  } catch (e) { return { ok: false, error: e.message, steps }; }
}

/* page side: step 3 fallback — hand the file over from the page itself (file input, drop, wp uploader) */
async function provideFileViaScript(image) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); } return null; };
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const steps = [];
  try {
    const modal = [...document.querySelectorAll('.media-modal')].find(visible);
    if (!modal) return { ok: false, error: 'Add Media window is not open', steps };
    const [h, b] = String(image.dataUrl).split(',');
    const mime = (h.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(b || ''); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const file = new File([arr], `${image.filename || 'landing-banner'}.${ext}`, { type: mime });
    const started = () => modal.querySelector('.attachment.uploading, .media-uploader-status .media-progress-bar, .attachment-details');
    try {
      const input = modal.querySelector('input[type="file"]');
      const dt = new DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      steps.push('file put in the file input');
    } catch (e) { steps.push('file input failed: ' + e.message); }
    if (!(await until(started, 8000))) {
      try {
        const dt = new DataTransfer(); dt.items.add(file);
        const target = modal.querySelector('.uploader-inline, .drag-drop-area, .media-frame-content') || modal;
        for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        steps.push('file dropped on the upload area');
      } catch (e) { steps.push('drop failed: ' + e.message); }
    }
    if (!(await until(started, 8000))) {
      try {
        const up = window.wp && wp.media && wp.media.frame && wp.media.frame.uploader && wp.media.frame.uploader.uploader;
        const pl = up && (up.uploader || up);
        if (pl && pl.addFile) { pl.addFile(file); steps.push('file added through the wp.media uploader'); } else steps.push('wp.media uploader not reachable');
      } catch (e) { steps.push('wp uploader failed: ' + e.message); }
    }
    return { ok: true, steps };
  } catch (e) { return { ok: false, error: e.message, steps }; }
}

/* page side: step 4 — wait for the upload, Alt text / Title, size, Insert into page */
async function finishMediaInsert(rowId, image, waitMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); } return null; };
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };
  const ALT = '[data-setting="alt"] textarea, [data-setting="alt"] input, #attachment-details-alt-text, #attachment-details-two-column-alt-text';
  const steps = [];
  try {
    const modal = [...document.querySelectorAll('.media-modal')].find(visible);
    if (!modal) return { ok: false, error: 'Add Media window is not open', steps };
    const details = await until(() => {
      const d = modal.querySelector('.attachment-details');
      const busy = modal.querySelector('.attachment.uploading, .media-uploader-status .upload-details:not([style*="display: none"]) .media-progress-bar');
      return d && visible(d) && !busy && d.querySelector(ALT) ? d : null;
    }, waitMs || 90000, 100);
    if (!details) return { ok: false, code: 'noupload', error: 'the upload did not finish (no attachment details appeared)', steps };
    steps.push('upload finished');
    await sleep(100);
    setValue(details.querySelector(ALT), image.alt); steps.push('alt text set');
    const title = details.querySelector('[data-setting="title"] input, #attachment-details-title, #attachment-details-two-column-title');
    if (title) { setValue(title, image.alt); steps.push('title set'); }
    await sleep(450);                                   // WordPress saves each field after a short delay
    // size: the 1400-wide option if there is one, otherwise Full Size
    const sel = modal.querySelector('select.size, .attachment-display-settings select[name="size"]');
    if (sel) {
      const opts = [...sel.options];
      const best = opts.find(o => /\b1400\b/.test(o.textContent)) || opts.find(o => o.value === 'full') || opts[opts.length - 1];
      if (best) { sel.value = best.value; sel.dispatchEvent(new Event('change', { bubbles: true })); steps.push(`size "${best.textContent.trim()}"`); }
      await sleep(80);
    }
    const ins = modal.querySelector('.media-button-insert');
    if (!ins) return { ok: false, error: 'no "Insert into page" button', steps };
    await until(() => !ins.disabled, 5000);
    // WordPress inserts into the "active editor". The image row is built before the other rows and filled last, so make
    // sure the active editor is THIS row's editor (not the last row that was built) just before Insert.
    try {
      const rowNow = document.querySelector(`.layout[data-id="${rowId}"]`);
      const taNow = rowNow && rowNow.querySelector('textarea.wp-editor-area');
      if (taNow && taNow.id) { window.wpActiveEditor = taNow.id; steps.push('active editor set to the image row'); }
    } catch (e) { /* optional */ }
    ins.click();
    steps.push('Insert into page clicked');
    if (!(await until(() => !visible(modal), 10000))) return { ok: false, error: 'the Add Media window did not close after Insert', steps };
    await sleep(120);
    const readRow = () => {
      const row = document.querySelector(`.layout[data-id="${rowId}"]`);
      const ta = row && row.querySelector('textarea.wp-editor-area');
      const ed = ta && ta.id && window.tinymce && window.tinymce.get ? window.tinymce.get(ta.id) : null;
      const visual = ed && ed.initialized ? ed.getContent() : '';
      const text = ta ? ta.value : '';
      return /<img\b/i.test(visual) ? visual : /<img\b/i.test(text) ? text : (visual || text);
    };
    const content = await until(() => { const c = readRow(); return /<img\b/i.test(c) ? c : null; }, 5000, 150) || readRow();
    if (!/<img\b/i.test(content)) return { ok: false, error: 'Insert did not put an image in the editor', steps };
    return { ok: true, steps, content: content.slice(0, 200) };
  } catch (e) { return { ok: false, error: e.message, steps }; }
}

/* page side: close a window that was left open, so it cannot block the rest of the build */
async function closeMediaModal() {
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  for (let i = 0; i < 3; i++) {
    const m = [...document.querySelectorAll('.media-modal')].find(visible);
    if (!m) return true;
    const x = m.querySelector('.media-modal-close');
    if (x) x.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

/* page side: does this site's media library already hold a file called <base>.<ext>?  (checked through WordPress itself) */
async function wpMediaNameTaken(base) {
  const out = { taken: false, checked: false };
  try {
    const adminBase = location.origin + location.pathname.replace(/\/wp-admin\/.*$/, '/wp-admin/');
    const stripExt = n => String(n || '').split('?')[0].split('/').pop().replace(/\.[a-z0-9]+$/i, '').replace(/-scaled$/i, '').toLowerCase();
    const want = String(base || '').toLowerCase();
    const queries = [want, want.replace(/-/g, ' ')];
    for (const q of queries) {
      const body = new URLSearchParams({ action: 'query-attachments' });
      body.append('query[s]', q); body.append('query[posts_per_page]', '60'); body.append('query[post_mime_type]', 'image');
      const res = await fetch(adminBase + 'admin-ajax.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const j = await res.json().catch(() => null);
      if (j && j.success && Array.isArray(j.data)) {
        out.checked = true;
        if (j.data.some(it => stripExt(it.filename) === want || stripExt(it.url) === want)) { out.taken = true; return out; }
      }
    }
    if (!out.checked) out.error = 'the media library did not answer';
  } catch (e) { out.error = e.message; }
  return out;
}

/* extension side: step 1 — save the image as a real file and return its full path */
async function saveImageToDisk(tabId, image) {
  const m = /^data:([^;,]+)/.exec(image.dataUrl || '');
  const ext = m && /jpe?g/.test(m[1]) ? 'jpg' : m && /webp/.test(m[1]) ? 'webp' : 'png';
  const name = `di-landing/${image.filename || 'landing-banner'}.${ext}`;
  let id = null;
  try {
    id = await chrome.downloads.download({ url: image.dataUrl, filename: name, conflictAction: 'overwrite', saveAs: false });
  } catch (e) {
    // a very large data: URL is refused — let the page make a blob: URL instead and download that
    const blobUrl = await execIn(tabId, async (dataUrl) => {
      const [h, b] = String(dataUrl).split(',');
      const mime = (h.match(/data:([^;]+)/) || [])[1] || 'image/png';
      const bin = atob(b || ''); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([arr], { type: mime }));
    }, [image.dataUrl]);
    try { id = await chrome.downloads.download({ url: blobUrl, filename: name, conflictAction: 'overwrite', saveAs: false }); }
    catch (e2) { return { ok: false, error: `could not save the image as a file (${e2.message})` }; }
  }
  for (let i = 0; i < 250; i++) {
    const [it] = await chrome.downloads.search({ id });
    if (it && it.state === 'complete' && it.filename) return { ok: true, id, path: it.filename };
    if (it && it.state === 'interrupted') return { ok: false, error: `saving the image was interrupted (${it.error || 'unknown'})` };
    await swWait(60);
  }
  return { ok: false, error: 'saving the image as a file took too long' };
}

/* extension side: step 3 — a genuine file pick: give the file to the Select Files input through the debugger */
async function setFileViaDebugger(tabId, path) {
  try {
    try { await chrome.debugger.sendCommand({ tabId }, 'DOM.enable'); } catch { /* already on */ }
    const ev = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(() => { const vis = el => el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const m = [...document.querySelectorAll('.media-modal')].find(vis);
        return m ? m.querySelector('input[type="file"]') : null; })()`,
      returnByValue: false,
    });
    const objectId = ev && ev.result && ev.result.objectId;
    if (!objectId) return { ok: false, error: 'Select Files input not found' };
    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { objectId, files: [path] });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

/* extension side: the whole banner flow for one row */
async function insertBannerImage(tabId, rowId, image) {
  const steps = [];
  const saved = (image.saved && image.saved.ok) ? image.saved : await saveImageToDisk(tabId, image);
  steps.push(saved.ok ? `image saved as a file (${saved.path})` : `image file not saved: ${saved.error}`);

  const mb = await execIn(tabId, getMediaButtonRect, [rowId]);
  if (mb?.found) await trustedClick(tabId, mb.x, mb.y);
  else steps.push(`Add Media button not located (${mb?.reason || 'unknown'})`);
  const opened = await execIn(tabId, openMediaUploadTab, [rowId, !!mb?.found]);
  steps.push(...(opened?.steps || []));
  const fail = async (error) => { await execIn(tabId, closeMediaModal).catch(() => {}); return { ok: false, error, steps, saved }; };
  if (!opened?.ok) return fail(opened?.error || 'could not open the Add Media window');

  let viaDebugger = false;
  if (saved.ok) {
    const picked = await setFileViaDebugger(tabId, saved.path);
    steps.push(picked.ok ? 'file picked in Select Files (real file chooser)' : `real file pick failed: ${picked.error}`);
    viaDebugger = picked.ok;
  }
  if (!viaDebugger) {
    const sc = await execIn(tabId, provideFileViaScript, [image]);
    steps.push(...(sc?.steps || []), ...(sc?.ok ? [] : [`script hand-over failed: ${sc?.error}`]));
  }
  let fin = await execIn(tabId, finishMediaInsert, [rowId, image, viaDebugger ? 30000 : 90000]);
  steps.push(...(fin?.steps || []));
  if (!fin?.ok && fin?.code === 'noupload' && viaDebugger) {          // the real pick did nothing — try the in-page routes
    const sc = await execIn(tabId, provideFileViaScript, [image]);
    steps.push('retrying from the page:', ...(sc?.steps || []));
    fin = await execIn(tabId, finishMediaInsert, [rowId, image, 90000]);
    steps.push(...(fin?.steps || []));
  }
  if (!fin?.ok) return fail(fin?.error || 'unknown');
  if (saved.ok) { chrome.downloads.removeFile(saved.id).catch(() => {}); chrome.downloads.erase({ id: saved.id }).catch(() => {}); }
  return { ok: true, steps, saved };
}

/* ---- Upload the banner image to THIS site's media library (with alt text) and return the <img> markup ---- */
async function uploadMediaImage(image) {
  const dataUrlToBlob = u => { const [h, b] = String(u).split(','); const mime = (h.match(/data:([^;]+)/) || [])[1] || 'image/png'; const bin = atob(b || ''); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: mime }); };
  const out = { ok: false, tried: [] };
  try {
    const blob = dataUrlToBlob(image.dataUrl);
    const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
    const filename = `${image.filename || 'landing-banner'}.${ext}`;
    const file = new File([blob], filename, { type: blob.type || 'image/png' });
    const adminBase = location.origin + location.pathname.replace(/\/wp-admin\/.*$/, '/wp-admin/');
    const siteBase = adminBase.replace(/wp-admin\/$/, '');
    const esc = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const markup = (id, url) => `<img class="alignnone size-medium wp-image-${id}" src="${url}" alt="${esc(image.alt)}" width="${image.width}" height="${image.height}" />`;

    // 1) REST API
    let nonce = window.wpApiSettings && window.wpApiSettings.nonce;
    if (!nonce) {
      try { const t = (await (await fetch(adminBase + 'admin-ajax.php?action=rest-nonce', { credentials: 'same-origin' })).text()).trim(); if (/^[a-f0-9]{6,}$/i.test(t)) nonce = t; } catch (e) { /* ignore */ }
    }
    if (nonce) {
      const roots = [window.wpApiSettings && window.wpApiSettings.root, siteBase + 'wp-json/', location.origin + '/wp-json/', siteBase + '?rest_route=/', location.origin + '/?rest_route=/'].filter(Boolean);
      for (const root of [...new Set(roots)]) {
        const fd = new FormData();
        fd.append('file', file, filename); fd.append('alt_text', image.alt); fd.append('title', image.alt);
        const url = root.includes('rest_route=') ? `${root}wp/v2/media`.replace('rest_route=/wp/v2', 'rest_route=/wp/v2') : `${root.replace(/\/?$/, '/')}wp/v2/media`;
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'X-WP-Nonce': nonce }, credentials: 'same-origin', body: fd });
          if (res.ok) { const j = await res.json(); return { ok: true, how: 'rest', id: j.id, url: j.source_url, html: markup(j.id, j.source_url) }; }
          out.tried.push(`REST ${res.status}`);
        } catch (e) { out.tried.push('REST ' + e.message); }
      }
    }
    // 2) classic upload endpoint + save-attachment (alt text)
    const mp = window._wpPluploadSettings && window._wpPluploadSettings.defaults && window._wpPluploadSettings.defaults.multipart_params;
    if (mp && mp._wpnonce) {
      const fd = new FormData();
      fd.append('name', filename); fd.append('action', 'upload-attachment'); fd.append('_wpnonce', mp._wpnonce); fd.append('async-upload', file, filename);
      const res = await fetch(adminBase + 'async-upload.php', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = await res.json().catch(() => null);
      if (j && j.success) {
        const d = j.data;
        if (d.nonces && d.nonces.update) {
          const body = new URLSearchParams({ action: 'save-attachment', id: d.id, nonce: d.nonces.update, post_id: '0' });
          body.append('changes[alt]', image.alt); body.append('changes[title]', image.alt);
          await fetch(adminBase + 'admin-ajax.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        }
        return { ok: true, how: 'upload', id: d.id, url: d.url, html: markup(d.id, d.url) };
      }
      out.tried.push('async-upload ' + res.status);
    }
    out.error = 'no upload route worked: ' + (out.tried.join('; ') || 'no nonce found');
  } catch (e) { out.error = e.message; }
  return out;
}

/* ---- Slug guard: the slug was typed in at the start; make sure it is still the Google Doc's slug at the end ---- */
function reassertSlug(slug) {
  if (!slug) return { ok: true, note: 'no slug to set' };
  const hidden = document.querySelector('#post_name');
  let changed = false;
  if (hidden && hidden.value !== slug) {
    hidden.value = slug;
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
    changed = true;
  }
  const shown = document.querySelector('#editable-post-name');
  if (shown && shown.textContent !== slug) shown.textContent = slug;
  const full = document.querySelector('#editable-post-name-full');
  if (full) full.textContent = slug;
  return { ok: !!hidden && hidden.value === slug, changed, now: hidden ? hidden.value : '(no #post_name field)' };
}

/* ---- 2. Snapshot which rows currently exist (by data-id) ---- */
/* ---- PAGE CHECK (read-only, runs in the page): compares what is on the WordPress page with what was asked for.
   Returns { checks: [{ name, ok, detail }] }. Changes nothing. ---- */
function verifyPage(want, expectedRows) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  const norm = t => (t || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const low = t => norm(t).toLowerCase();
  const stripDashes = t => norm(t).replace(/^[\s\-\u2013\u2014]+/, '');

  const titleEl = document.querySelector('#title');
  add('Page title', titleEl && norm(titleEl.value) === norm(want.title), titleEl ? norm(titleEl.value) : 'title field not found');

  if (want.slug) {
    const slugEl = document.querySelector('#post_name');
    const clean = v => norm(v).replace(/^\/+|\/+$/g, '');
    add('Page slug', slugEl && clean(slugEl.value) === clean(want.slug), slugEl ? (clean(slugEl.value) || '(empty)') : 'slug field not found');
  }
  if (want.templateName) {
    const sel = document.querySelector('#page_template');
    const opt = sel && sel.options[sel.selectedIndex];
    add('Template', opt && (low(opt.text).includes(low(want.templateName)) || low(opt.value).includes(low(want.templateName))), opt ? norm(opt.text) : 'template field not found');
  }
  if (want.parentSlug) {
    const sel = document.querySelector('#parent_id');
    const opt = sel && sel.options[sel.selectedIndex];
    const got = opt ? stripDashes(opt.text) : '';
    add('Parent page', opt && opt.value !== '' && (low(got) === low(want.parentSlug) || low(got).includes(low(want.parentSlug))), got || 'no parent selected');
  }

  // Yoast: its own data store first, the hidden form fields as a backup
  let ys = null;
  try { ys = window.wp && window.wp.data && window.wp.data.select && window.wp.data.select('yoast-seo/editor'); } catch (e) { ys = null; }
  const readY = (getter, fieldSel) => {
    let v = '';
    try { v = (ys && ys[getter] && ys[getter]()) || ''; } catch (e) { v = ''; }
    return norm(v || (document.querySelector(fieldSel) && document.querySelector(fieldSel).value) || '');
  };
  const wantTitle = norm(want.metaTitle || want.title || '');
  const gotTitle = readY('getSeoTitle', '#yoast_wpseo_title');
  if (wantTitle) add('Meta title (Yoast)', gotTitle === wantTitle, gotTitle ? `${gotTitle}  (${gotTitle.length} characters)` : 'empty — set it in the Yoast box');
  if (want.metaDescription) {
    const wantDesc = norm(want.metaDescription);
    const gotDesc = readY('getDescription', '#yoast_wpseo_metadesc');
    add('Meta description (Yoast)', gotDesc === wantDesc, gotDesc ? `${gotDesc.slice(0, 90)}${gotDesc.length > 90 ? '…' : ''}  (${gotDesc.length} characters)` : 'empty — set it in the Yoast box');
  } else {
    add('Meta description (Yoast)', true, 'none in the doc — nothing to check');
  }

  const rows = [...document.querySelectorAll('.acf-flexible-content .layout')]
    .filter(r => !r.closest('.clones, .acf-clone') && r.offsetParent !== null && !(r.parentElement && r.parentElement.closest('.layout')));
  add('Rows on the page', rows.length === expectedRows, `${rows.length} row${rows.length === 1 ? '' : 's'} (expected ${expectedRows})`);
  return { checks };
}

// WordPress admin notices like "Core Components: The plugin has been paused. ... Turn it on" -> [{ plugin, link }]
function detectPausedPlugins() {
  const out = [], seen = new Set();
  for (const n of document.querySelectorAll('.notice, .update-nag, .error, [class*="notice"]')) {
    const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/\bpaused\b/i.test(t) || t.length > 600) continue;
    const names = [...t.matchAll(/([A-Za-z0-9][A-Za-z0-9 .&'-]{1,60}?):\s*(?:Only[^.]*\.\s*)?The plugin has been paused/gi)].map(m => m[1].trim());
    const links = [...n.querySelectorAll('a[href]')].filter(a => /turn it on|resume|enable|activate/i.test(a.textContent)).map(a => a.href);
    (names.length ? names : [t.slice(0, 60)]).forEach((plugin, i) => {
      const key = plugin + '|' + (links[i] || '');
      if (!seen.has(key)) { seen.add(key); out.push({ plugin, link: links[i] || links[0] || '' }); }
    });
  }
  return out;
}

/* ---- Puts the built rows back in the order they were built in (page title first ... form/feed last).
   Runs inside the WordPress page. Moves the .layout elements inside their shared container, then tells ACF the
   order changed so it is saved that way. ---- */
function fixRowOrder(expectedIds) {
  const rows = expectedIds.map(id => document.querySelector(`.layout[data-id="${id}"]`));
  if (rows.some(r => !r)) return { ok: false, moved: false, note: 'a built row was not found on the page' };
  const parent = rows[0].parentElement;
  if (!rows.every(r => r.parentElement === parent)) return { ok: false, moved: false, note: 'rows are in different containers' };
  const nameOf = r => (r.getAttribute('data-layout') || '').replace(/_/g, ' ') || r.dataset.id;
  const current = [...parent.children].filter(c => expectedIds.includes(c.dataset.id)).map(c => c.dataset.id);
  if (current.join() === expectedIds.join()) return { ok: true, moved: false };
  const before = current.map(id => nameOf(document.querySelector(`.layout[data-id="${id}"]`)));
  // keep any other children (clones, etc.) where they are: only re-append our rows, in order, before the first non-row node after them
  const lastRow = [...parent.children].filter(c => expectedIds.includes(c.dataset.id)).pop();
  const anchor = lastRow ? lastRow.nextElementSibling : null;
  for (const r of rows) parent.insertBefore(r, anchor);
  try {
    const $ = window.jQuery || window.$;
    if ($ && window.acf) {
      const $values = $(parent);
      $values.trigger('sortstop');
      if (window.acf.doAction) window.acf.doAction('sortstop', $values);
      const field = window.acf.getField && window.acf.getField($(parent).closest('.acf-field-flexible-content'));
      if (field && field.render) field.render();
    }
  } catch { /* ordering in the page is already right; ACF reads the DOM order on save */ }
  const after = expectedIds.map(id => nameOf(document.querySelector(`.layout[data-id="${id}"]`)));
  return { ok: true, moved: true, before, after };
}

function snapshotRowIds() {
  const rows = [...document.querySelectorAll('.acf-flexible-content .layout[data-layout], .acf-flexible-content .layout')]
    .filter(row => !row.closest('.clones, .acf-clone') && row.offsetParent !== null);
  return rows.map(r => r.dataset.id || '').filter(Boolean);
}

/* ---- 2b. Same snapshot, scoped to one row's own nested repeater (e.g. the
   Direct Compare Data Row's "Data" entries) — identified by its data-id,
   so it never picks up rows belonging to the outer DI Page Composer field. ---- */
function snapshotNestedRowIds(rowId) {
  const row = document.querySelector(`.layout[data-id="${rowId}"]`);
  if (!row) return [];
  const nested = [...row.querySelectorAll('.acf-flexible-content .layout')]
    .filter(r => !r.closest('.clones, .acf-clone') && r.offsetParent !== null);
  return nested.map(r => r.dataset.id || '').filter(Boolean);
}

/* ---- 3. Find the Add Row button, scroll it fully into view, report its
   viewport-relative center coordinates (what chrome.debugger's Input
   domain expects) ---- */
function getAddRowButtonRect() {
  const findAddRowButtons = () => {
    const isVisible = (el) => !!el && el.offsetParent !== null;
    const notClone = (el) => !el.closest('.acf-clone, .clones, .tmpl-clone');
    // Same nested-field exclusion as fillBasics — without this, once the
    // Direct Compare Data Row exists, its own "Add Data Row" button (inside
    // a `.layout` of the outer field) sorts before the outer field's real
    // Add Row button and gets clicked for every section built after it.
    const notNestedField = (el) => !el.closest('.acf-flexible-content .layout');

    const selectors = [
      '.acf-flexible-content .acf-actions [data-name="add-layout"]',
      '.acf-flexible-content .acf-actions [data-event="add-layout"]',
      '.acf-flexible-content [data-name="add-layout"]',
      '.acf-flexible-content [data-event="add-layout"]',
      '.acf-flexible-content .acf-actions a.button',
      '.acf-flexible-content .acf-actions .acf-button',
    ];

    const candidates = [];
    for (const sel of selectors) {
      candidates.push(...document.querySelectorAll(sel));
    }
    document.querySelectorAll('.acf-flexible-content a, .acf-flexible-content button').forEach(el => {
      if (/add\s*row/i.test(el.textContent || '')) candidates.push(el);
    });

    const seen = new Set();
    return candidates.filter(el => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      return notClone(el) && isVisible(el) && notNestedField(el);
    });
  };

  return (async () => {
    const btns = findAddRowButtons();
    if (!btns.length) {
      const anyFlexField = !!document.querySelector('.acf-flexible-content');
      return {
        found: false,
        reason: anyFlexField
          ? 'a .acf-flexible-content field exists but no visible top-level Add Row button/link matched any selector or "Add Row" text'
          : 'no .acf-flexible-content field found on the page at all',
      };
    }
    const btn = btns[0];
    // Wait until the button stops moving (an editor above it may still be resizing) before reporting it.
    let last = null, still = 0;
    for (let i = 0; i < 40 && still < 2; i++) {
      btn.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise(r => setTimeout(r, 40));
      const r0 = btn.getBoundingClientRect();
      const key = [Math.round(r0.left), Math.round(r0.top), Math.round(r0.width), Math.round(r0.height)].join(',');
      still = key === last ? still + 1 : 0;
      last = key;
    }
    const rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) return { found: false, reason: 'matched button has zero size' };
    return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })();
}

/* ---- 3b. Scoped version for a nested flexible-content field (e.g. the
   Direct Compare Data Row's own "Add Data Row" repeater) — searches only
   inside the given row, identified by its data-id ---- */
function getNestedAddRowButtonRect(rowId) {
  const isVisible = (el) => !!el && el.offsetParent !== null;
  const notClone = (el) => !el.closest('.acf-clone, .clones, .tmpl-clone');

  return (async () => {
    const row = document.querySelector(`.layout[data-id="${rowId}"]`);
    if (!row) return { found: false, reason: `row with data-id "${rowId}" not found on page` };

    const selectors = [
      '.acf-flexible-content .acf-actions [data-name="add-layout"]',
      '.acf-flexible-content .acf-actions [data-event="add-layout"]',
      '.acf-flexible-content [data-name="add-layout"]',
      '.acf-flexible-content [data-event="add-layout"]',
      '.acf-flexible-content .acf-actions a.button',
      '.acf-flexible-content .acf-actions .acf-button',
    ];

    const candidates = [];
    for (const sel of selectors) candidates.push(...row.querySelectorAll(sel));
    row.querySelectorAll('a, button').forEach(el => {
      if (/add\s*(data\s*)?row/i.test(el.textContent || '')) candidates.push(el);
    });

    const seen = new Set();
    const btns = candidates.filter(el => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      return notClone(el) && isVisible(el);
    });

    if (!btns.length) {
      return { found: false, reason: 'row found but no visible nested Add Row button inside it' };
    }
    const btn = btns[0];
    btn.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise(r => setTimeout(r, 50));
    const rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) return { found: false, reason: 'matched nested button has zero size' };
    return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })();
}

/* ---- 4. Wait for the popup to become genuinely visible, find the
   matching layout link, scroll it into view, report coordinates ---- */
function getPopupLayoutLinkRect(rowType) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const isVisible = (el) => !!el && el.offsetParent !== null &&
    getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';

  return (async () => {
    let popup = null;
    for (let i = 0; i < 20; i++) {
      const named = document.querySelector('.acf-fc-popup, .acf-tooltip');
      if (named && isVisible(named) && named.querySelectorAll('a[data-layout]').length) {
        popup = named;
        break;
      }
      // Fallback: any visible container (of any class) that holds data-layout links —
      // covers themes/ACF versions that don't use .acf-fc-popup/.acf-tooltip as the wrapper.
      const anyLayoutLink = [...document.querySelectorAll('a[data-layout]')]
        .find(a => isVisible(a));
      if (anyLayoutLink) {
        popup = anyLayoutLink.closest('ul, div') || document;
        break;
      }
      await wait(50);
    }
    if (!popup) return { found: false, reason: 'popup never became visible after the click' };

    const links = [...popup.querySelectorAll('a[data-layout]')];
    if (!links.length) return { found: false, reason: 'popup visible but no layout links inside it' };

    const wanted = rowType.trim().toLowerCase();
    const wantedSlug = wanted.replace(/[\s/]+/g, '_');
    const target =
      links.find(a => (a.textContent || '').trim().toLowerCase() === wanted) ||
      links.find(a => (a.dataset.layout || '').toLowerCase() === wantedSlug) ||
      links.find(a => (a.textContent || '').trim().toLowerCase().includes(wanted));

    if (!target) {
      return { found: false, reason: `no link matched "${rowType}" among [${links.map(l => l.dataset.layout).join(', ')}]` };
    }

    let lastKey = null, still = 0;
    for (let i = 0; i < 20 && still < 2; i++) {
      target.scrollIntoView({ block: 'center', inline: 'center' });
      await wait(30);
      const r0 = target.getBoundingClientRect();
      const key = [Math.round(r0.left), Math.round(r0.top)].join(',');
      still = key === lastKey ? still + 1 : 0;
      lastKey = key;
    }
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return { found: false, reason: 'matched link has no visible size' };

    return {
      found: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      slug: target.dataset.layout || wantedSlug,
    };
  })();
}

/* ---- 5. Wait for a genuinely new visible row (by data-id, vs. the
   snapshot taken before clicking), then fill its fields ---- */
function waitForNewRowAndFill(beforeIds, slugHint, section) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const beforeSet = new Set(beforeIds || []);

  const setValue = (el, value) => {
    if (!el || value == null) return false;
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const selectOption = (el, match) => {
    if (!el || el.tagName !== 'SELECT') return false;
    const wanted = match.toLowerCase();
    for (const opt of el.options) {
      if (opt.text.toLowerCase().includes(wanted) || opt.value.toLowerCase().includes(wanted)) {
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  };

  const findByLabel = (container, labelText) => {
    const lower = labelText.toLowerCase();
    const labels = [...(container || document).querySelectorAll('label, .label, th, dt, strong, b, p, span')];
    for (const lbl of labels) {
      if (!lbl.textContent.trim().toLowerCase().includes(lower)) continue;
      if (lbl.htmlFor) {
        const target = document.getElementById(lbl.htmlFor);
        if (target) return target;
      }
      const parent = lbl.closest('tr, div, li, dd, .field, .form-group, .option-group, .acf-field');
      if (parent) {
        const input = parent.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select');
        if (input) return input;
        const checkbox = parent.querySelector('input[type="checkbox"]');
        if (checkbox) return checkbox;
      }
      const next = lbl.nextElementSibling;
      if (next && (next.tagName === 'INPUT' || next.tagName === 'TEXTAREA' || next.tagName === 'SELECT')) {
        return next;
      }
    }
    return null;
  };

  const checkBox = (container, labelText) => {
    const el = findByLabel(container, labelText);
    if (el && el.type === 'checkbox' && !el.checked) {
      el.click();
      return true;
    }
    if (container) {
      const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
      for (const box of boxes) {
        const parent = box.closest('tr, div, li, label, .field, .acf-field');
        if (parent && parent.textContent.toLowerCase().includes(labelText.toLowerCase())) {
          if (!box.checked) box.click();
          return true;
        }
      }
    }
    return false;
  };

  const setFieldByLabel = (container, labelText, value) => {
    const el = findByLabel(container, labelText);
    if (!el) return false;
    return setValue(el, value);
  };

  const selectByLabel = (container, labelText, optionText) => {
    const el = findByLabel(container, labelText);
    if (!el || el.tagName !== 'SELECT') return false;
    return selectOption(el, optionText);
  };

  // Puts HTML into a row's WYSIWYG so it STAYS there. The editor (TinyMCE) is created a moment after
  // the row appears; writing only into the hidden textarea before that lets the editor start up
  // empty and overwrite it on save — that was the "blank content" bug. So: wait for the editor,
  // set it through the editor, then read it back and retry if it came out empty.
  const setWysiwyg = async (container, html) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const plain = v => (v || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, '').trim();
    const want = plain(html);
    const ta = container.querySelector('textarea.wp-editor-area') || container.querySelector('.acf-editor-wrap textarea') || container.querySelector('textarea');
    if (!ta) return { ok: false, how: 'no textarea in the row' };
    const wrap = ta.closest('.wp-editor-wrap');
    const getEditor = () => {
      const e = ta.id && window.tinymce && window.tinymce.get ? window.tinymce.get(ta.id) : null;
      return e && !e.removed && e.initialized ? e : null;
    };
    const textMode = () => !!(wrap && wrap.classList.contains('html-active'));
    const writeTextarea = () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, html); else ta.value = html;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    };
    let how = 'textarea';
    for (let attempt = 0; attempt < 4; attempt++) {
      let editor = null;
      for (let i = 0; i < 120; i++) {
        editor = getEditor();
        if (editor || textMode()) break;
        if (i >= 6 && !window.tinymce) break;          // no TinyMCE on this page at all
        await sleep(80);
      }
      if (editor && !textMode()) {
        editor.setContent(html);
        editor.save();                                  // copies it into the textarea too
        editor.fire('change');
        how = 'editor';
      } else {
        writeTextarea();
        how = 'textarea';
      }
      await sleep(100);
      const ed = getEditor();
      const rawNow = ed && !textMode() ? ed.getContent() : ta.value;
      const got = plain(rawNow);
      const imgOk = !/<img\b/i.test(html) || /<img\b/i.test(rawNow);
      if (imgOk && (!want || got.length >= Math.min(want.length, 20))) return { ok: true, how, chars: got.length, attempts: attempt + 1 };
    }
    return { ok: false, how: 'content was still blank after 4 tries' };
  };

  const getLayoutRows = () =>
    [...document.querySelectorAll('.acf-flexible-content .layout[data-layout], .acf-flexible-content .layout')]
      .filter(row => !row.closest('.clones, .acf-clone') && row.offsetParent !== null);

  return (async () => {
    const log = [];
    let newRow = null;

    for (let i = 0; i < 20 && !newRow; i++) {
      const rowsNow = getLayoutRows();
      const candidates = rowsNow.filter(r => !beforeSet.has(r.dataset.id || ''));
      if (candidates.length) {
        newRow = (slugHint && candidates.find(r => (r.dataset.layout || '') === slugHint)) || candidates[candidates.length - 1];
        break;
      }
      await wait(80);
    }

    if (!newRow) {
      return { success: false, log: [`${section.label}: no new row appeared even after the trusted click`] };
    }

    const rowId = newRow.dataset.id || null;
    const ctx = newRow;
    const config = section.config || {};

    if (config.maxWidthContainer) {
      // The row's width tick box ("Max Width Container" / "Full Width ..."). Find it by the text of its OWN label, tick it the way a
      // person would (box, then its label / switch), and check it really is ticked. Say so in the log when it is not.
      const NAMES = ['max width container', 'max width', 'max_width', 'full width image', 'full width', 'fullwidth', 'container'];
      const labelOf = box => {
        const bits = [];
        const lab = box.id ? document.querySelector(`label[for="${CSS.escape(box.id)}"]`) : null;
        if (lab) bits.push(lab.textContent);
        const wrap = box.closest('label'); if (wrap) bits.push(wrap.textContent);
        const field = box.closest('.acf-field');
        if (field) { const fl = field.querySelector(':scope > .acf-label label, :scope > .acf-label'); if (fl) bits.push(fl.textContent); }
        bits.push(box.name || '', box.id || '', box.getAttribute('aria-label') || '');
        return bits.join(' | ').replace(/\s+/g, ' ').toLowerCase();
      };
      const boxes = [...ctx.querySelectorAll('input[type="checkbox"]')].filter(b => !b.closest('.acf-fc-layout-controls'));
      let target = null;
      for (const n of NAMES) { target = boxes.find(b => labelOf(b).includes(n)); if (target) break; }
      if (!target) {
        log.push(`${section.label}: COULD NOT find the width tick box (Max Width / Full Width) — tick it by hand. Tick boxes in this row: ${boxes.map(b => '"' + (labelOf(b).split(' | ')[0] || b.name || b.id) + '"').join(', ') || 'none'}`);
      } else {
        if (!target.checked) { target.click(); await wait(60); }
        if (!target.checked) { const sw = target.closest('label, .acf-switch, .acf-true-false'); if (sw) { sw.click(); await wait(60); } }
        if (!target.checked) { target.checked = true; target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true })); }
        log.push(target.checked ? `${section.label}: width box ticked ✓ ("${(labelOf(target).split(' | ')[0] || target.name).trim()}")` : `${section.label}: the width tick box would not stay ticked — tick it by hand`);
      }
    }
    await wait(40);

    if (section.fillMethod === 'label' && section.fieldLabel) {
      const titleSet =
        setFieldByLabel(ctx, section.fieldLabel, section.html) ||
        setFieldByLabel(ctx, 'Title', section.html);
      if (titleSet) {
        log.push(`${section.label}: title set`);
      } else {
        log.push(`${section.label}: COULD NOT find a "${section.fieldLabel}" field to set — set it manually`);
      }
    } else if (section.html) {
      const res = await setWysiwyg(ctx, section.html);
      if (res.ok) {
        log.push(`${section.label}: content pasted (${res.how}, ${res.chars} chars)`);
      } else {
        log.push(`${section.label}: COULD NOT paste content — ${res.how}`);
      }
    } else {
      log.push(`${section.label}: row added (no content to auto-fill for this row yet — build it manually)`);
    }
    await wait(120);

    if (config.rowPadding) {
      const padSet =
        setFieldByLabel(ctx, 'Row Padding', config.rowPadding) ||
        setFieldByLabel(ctx, 'Padding', config.rowPadding) ||
        setFieldByLabel(ctx, 'row_padding', config.rowPadding);
      if (padSet) log.push(`${section.label}: padding ${config.rowPadding}`);
    }

    if (config.customClass) {
      const classSet =
        setFieldByLabel(ctx, 'Custom Class', config.customClass) ||
        setFieldByLabel(ctx, 'Class', config.customClass) ||
        setFieldByLabel(ctx, 'custom_class', config.customClass) ||
        setFieldByLabel(ctx, 'CSS Class', config.customClass);
      if (classSet) log.push(`${section.label}: class "${config.customClass}"`);
    }

    if (config.backgroundImageUrl) {
      const bgSet =
        setFieldByLabel(ctx, 'Background Image', config.backgroundImageUrl) ||
        setFieldByLabel(ctx, 'BG Image', config.backgroundImageUrl) ||
        setFieldByLabel(ctx, 'Background Image as URL', config.backgroundImageUrl) ||
        setFieldByLabel(ctx, 'bg_image', config.backgroundImageUrl);
      if (bgSet) log.push(`${section.label}: bg image set`);
    }

    if (config.bgImgSizing) {
      selectByLabel(ctx, 'BG Img Sizing', config.bgImgSizing) ||
        selectByLabel(ctx, 'Sizing', config.bgImgSizing) ||
        selectByLabel(ctx, 'Background Size', config.bgImgSizing);
    }

    if (config.backgroundAttachment) {
      selectByLabel(ctx, 'Background Attachment', config.backgroundAttachment) ||
        selectByLabel(ctx, 'Attachment', config.backgroundAttachment);
    }

    await wait(120);
    return { success: true, log, rowId };
  })();
}

function ensureRowContent(rowId, html) {
  return (async () => {
    const container = document.querySelector(`.layout[data-id="${rowId}"]`);
    if (!container) return { ok: false, how: 'row not found' };
  // Puts HTML into a row's WYSIWYG so it STAYS there. The editor (TinyMCE) is created a moment after
  // the row appears; writing only into the hidden textarea before that lets the editor start up
  // empty and overwrite it on save — that was the "blank content" bug. So: wait for the editor,
  // set it through the editor, then read it back and retry if it came out empty.
  const setWysiwyg = async (container, html) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const plain = v => (v || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, '').trim();
    const want = plain(html);
    const ta = container.querySelector('textarea.wp-editor-area') || container.querySelector('.acf-editor-wrap textarea') || container.querySelector('textarea');
    if (!ta) return { ok: false, how: 'no textarea in the row' };
    const wrap = ta.closest('.wp-editor-wrap');
    const getEditor = () => {
      const e = ta.id && window.tinymce && window.tinymce.get ? window.tinymce.get(ta.id) : null;
      return e && !e.removed && e.initialized ? e : null;
    };
    const textMode = () => !!(wrap && wrap.classList.contains('html-active'));
    const writeTextarea = () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, html); else ta.value = html;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    };
    let how = 'textarea';
    for (let attempt = 0; attempt < 4; attempt++) {
      let editor = null;
      for (let i = 0; i < 120; i++) {
        editor = getEditor();
        if (editor || textMode()) break;
        if (i >= 6 && !window.tinymce) break;          // no TinyMCE on this page at all
        await sleep(80);
      }
      if (editor && !textMode()) {
        editor.setContent(html);
        editor.save();                                  // copies it into the textarea too
        editor.fire('change');
        how = 'editor';
      } else {
        writeTextarea();
        how = 'textarea';
      }
      await sleep(100);
      const ed = getEditor();
      const rawNow = ed && !textMode() ? ed.getContent() : ta.value;
      const got = plain(rawNow);
      const imgOk = !/<img\b/i.test(html) || /<img\b/i.test(rawNow);
      if (imgOk && (!want || got.length >= Math.min(want.length, 20))) return { ok: true, how, chars: got.length, attempts: attempt + 1 };
    }
    return { ok: false, how: 'content was still blank after 4 tries' };
  };

    // Already there? then leave it alone.
    const ta0 = container.querySelector('textarea.wp-editor-area') || container.querySelector('textarea');
    const ed0 = ta0 && ta0.id && window.tinymce && window.tinymce.get ? window.tinymce.get(ta0.id) : null;
    const now = (ed0 && ed0.initialized && !ed0.removed && !(ta0.closest('.wp-editor-wrap')?.classList.contains('html-active')))
      ? ed0.getContent() : (ta0 ? ta0.value : '');
    const plain0 = v => (v || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, '').trim();
    const needImg = /<img\b/i.test(html) && !/<img\b/i.test(now);
    if (!needImg && plain0(now).length >= Math.min(plain0(html).length, 20)) return { ok: true, how: 'already there', chars: plain0(now).length };
    return setWysiwyg(container, html);
  })();
}

/* ---- 5b. Fill one nested "Data" entry (Direct Compare Data Row's own
   repeater) with the imported comparison table's Left Data / Middle Label /
   Right Data — same new-row-by-data-id detection as waitForNewRowAndFill,
   just scoped inside the parent row instead of the page's top-level field. ---- */
function fillNestedDataRow(rowId, beforeNestedIds, nestedData, targetId) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const beforeSet = new Set(beforeNestedIds || []);

  const setValue = (el, value) => {
    if (!el || value == null) return false;
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const findByLabel = (container, labelText) => {
    const lower = labelText.toLowerCase();
    const labels = [...(container || document).querySelectorAll('label, .label, th, dt, strong, b, p, span')];
    for (const lbl of labels) {
      if (!lbl.textContent.trim().toLowerCase().includes(lower)) continue;
      if (lbl.htmlFor) {
        const target = document.getElementById(lbl.htmlFor);
        if (target) return target;
      }
      const parent = lbl.closest('tr, div, li, dd, .field, .form-group, .option-group, .acf-field');
      if (parent) {
        const input = parent.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select');
        if (input) return input;
      }
      const next = lbl.nextElementSibling;
      if (next && (next.tagName === 'INPUT' || next.tagName === 'TEXTAREA' || next.tagName === 'SELECT')) {
        return next;
      }
    }
    return null;
  };

  const setFieldByLabel = (container, labelText, value) => {
    const el = findByLabel(container, labelText);
    if (!el) return false;
    return setValue(el, value);
  };

  return (async () => {
    const parentRow = document.querySelector(`.layout[data-id="${rowId}"]`);
    if (!parentRow) return { success: false, reason: `parent row "${rowId}" not found on page` };

    let newRow = null;
    if (targetId) {                 // the exact entry to fill (found by its position on the page)
      for (let i = 0; i < 20 && !newRow; i++) { newRow = parentRow.querySelector(`.layout[data-id="${targetId}"]`); if (!newRow) await wait(80); }
      if (!newRow) return { success: false, reason: `Data entry "${targetId}" not found on page` };
    }
    for (let i = 0; i < 20 && !newRow; i++) {
      const nestedNow = [...parentRow.querySelectorAll('.acf-flexible-content .layout')]
        .filter(r => !r.closest('.clones, .acf-clone') && r.offsetParent !== null);
      const candidates = nestedNow.filter(r => !beforeSet.has(r.dataset.id || ''));
      if (candidates.length) {
        newRow = candidates[candidates.length - 1];
        break;
      }
      await wait(80);
    }
    if (!newRow) return { success: false, reason: 'no new nested "Data" row appeared after the trusted click' };

    await wait(80);
    // Field labels come straight from the "Add Data" popup: Left Data /
    // Middle Label / Right Data (see hub-templates.js compareRows shape).
    const leftSet = setFieldByLabel(newRow, 'Left Data', nestedData.left || '');
    const middleSet = setFieldByLabel(newRow, 'Middle Label', nestedData.middle || '');
    const rightSet = setFieldByLabel(newRow, 'Right Data', nestedData.right || '');

    return {
      success: leftSet || middleSet || rightSet,
      left: leftSet,
      middle: middleSet,
      right: rightSet,
      rowId: newRow.dataset.id || null,
    };
  })();
}

/* ---- 6. CSS overrides + Yoast meta ---- */
function fillCssAndYoast(hub) {
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const setValue = (el, value) => {
    if (!el || value == null) return false;
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const findByLabel = (container, labelText, requireTextarea) => {
    const lower = labelText.toLowerCase();
    const labels = [...(container || document).querySelectorAll('label, .label, th, dt, strong, b, p, span')];
    for (const lbl of labels) {
      const labelWords = lbl.textContent.trim().toLowerCase();
      if (!labelWords.includes(lower)) continue;
      if (lbl.htmlFor) {
        const target = document.getElementById(lbl.htmlFor);
        if (target && (!requireTextarea || target.tagName === 'TEXTAREA')) return target;
      }
      const parent = lbl.closest('tr, div, li, dd, .field, .form-group, .option-group, .acf-field');
      if (parent) {
        const input = parent.querySelector(requireTextarea ? 'textarea, select' : 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select');
        if (input) return input;
      }
    }
    return null;
  };

  return (async () => {
    const log = [];

    const cssSection = (hub.sections || []).find(s => s.id === 'css');
    if (cssSection?.html) {
      const isVisible = (el) => !!el && el.offsetParent !== null;
      const notClone = (el) => !el.closest('.acf-clone, .clones, .tmpl-clone');

      // Prefer a CSS field that lives inside the same DI Page Composer field group
      // (the flexible-content field), since that's where "after the last row" puts it.
      const scopes = [
        ...document.querySelectorAll('.acf-flexible-content'),
        document, // fall back to whole page if not found scoped
      ];

      let cssTarget = null;
      let matchedVia = '';

      outer:
      for (const scope of scopes) {
        const bySelector = [
          ...scope.querySelectorAll('textarea[id*="css" i], textarea[name*="css" i], textarea[class*="css" i]'),
          ...scope.querySelectorAll('textarea[id*="override" i], textarea[name*="override" i]'),
          ...scope.querySelectorAll('[data-name*="css" i] textarea'),
        ].filter(el => notClone(el) && isVisible(el));
        if (bySelector.length) {
          cssTarget = bySelector[0];
          matchedVia = 'selector';
          break outer;
        }

        // Require a textarea match here, not any input — a bare "CSS"
        // substring also matches each row's own "CSS Class" label, which is
        // a plain text input for that row's styling, not the page-level CSS
        // field. Restricting to textarea rules that false match out
        // entirely instead of relying on scope/label-text specificity.
        const viaLabel =
          findByLabel(scope, 'CSS Overrides', true) ||
          findByLabel(scope, 'CSS Override', true) ||
          findByLabel(scope, 'Custom CSS', true) ||
          (scope === document ? findByLabel(scope, 'CSS', true) : null);
        if (viaLabel && notClone(viaLabel) && isVisible(viaLabel)) {
          cssTarget = viaLabel;
          matchedVia = 'label';
          break outer;
        }
      }

      if (cssTarget) {
        setValue(cssTarget, cssSection.html);

        // If this field is CodeMirror-enhanced, setting the raw textarea's value
        // alone won't update what's visually shown — push it into CodeMirror too.
        const cm = cssTarget.nextElementSibling?.classList?.contains('CodeMirror')
          ? cssTarget.nextElementSibling.CodeMirror
          : cssTarget.CodeMirror || window.wp?.codeEditor?.instances?.get?.(cssTarget)?.codemirror;
        if (cm && typeof cm.setValue === 'function') {
          cm.setValue(cssSection.html);
          cm.save?.();
          cm.refresh?.(); // repaint — CodeMirror can leave stale content on screen after a programmatic setValue
          log.push(`CSS overrides set (via ${matchedVia}, synced to CodeMirror)`);
        } else {
          log.push(`CSS overrides set (via ${matchedVia})`);
        }
      } else {
        log.push('CSS overrides: field not found (tried selector match and label match, scoped to DI Page Composer first, then whole page)');
      }
    }

    const yoastTitle = hub.metaTitle || hub.title || '';
    const yoastDesc = hub.metaDescription || '';

    // Same approach Auto Publishing uses for its blog posts: Yoast's modern
    // panel is a React app that (a) mounts asynchronously, so a single
    // attempt right after clicking "Edit snippet" can run before the fields
    // exist yet, and (b) treats its own `yoast-seo/editor` data store — not
    // just the classic hidden inputs — as the source of truth. Writing only
    // the DOM fields once let Yoast silently re-sync them back to empty.

    const fieldsForLabel = labelText => {
      const wanted = labelText.toLowerCase();
      const labels = [...document.querySelectorAll('label')]
        .filter(label => label.textContent.replace(/\s+/g, ' ').trim().toLowerCase().includes(wanted));
      const fields = labels.flatMap(label => {
        const associated = label.htmlFor ? document.getElementById(label.htmlFor) : null;
        return [associated, ...label.querySelectorAll('input, textarea, [contenteditable="true"]')].filter(Boolean);
      });
      return [...new Set([
        ...fields,
        ...document.querySelectorAll(`input[aria-label*="${labelText}" i], textarea[aria-label*="${labelText}" i], [contenteditable="true"][aria-label*="${labelText}" i]`)
      ])];
    };

    const writeYoastFields = () => {
      const titleWritten = [
        '#yoast_wpseo_title',
        'input[name="yoast_wpseo_title"]',
        'input[name="_yoast_wpseo_title"]',
        'input[id*="yoast"][id*="title"]',
        'input[name*="yoast"][name*="title"]'
      ].map(sel => setValue(sel, yoastTitle)).some(Boolean);
      const descWritten = [
        '#yoast_wpseo_metadesc',
        'textarea[name="yoast_wpseo_metadesc"]',
        'textarea[name="_yoast_wpseo_metadesc"]',
        'textarea[id*="yoast"][id*="desc"]',
        'textarea[name*="yoast"][name*="desc"]'
      ].map(sel => setValue(sel, yoastDesc)).some(Boolean);
      // Current Yoast screens often render React inputs without the older
      // Yoast IDs. Their visible labels are a direct, stable fallback.
      const labelledTitleWritten = fieldsForLabel('SEO title').map(f => setValue(f, yoastTitle)).some(Boolean);
      const labelledDescWritten = fieldsForLabel('Meta description').map(f => setValue(f, yoastDesc)).some(Boolean);
      return titleWritten || descWritten || labelledTitleWritten || labelledDescWritten;
    };

    // Recent Yoast versions treat this store — not the hidden inputs — as the
    // source of truth for the snippet editor's title/description.
    const updateYoastStore = () => {
      const dispatcher = window.wp?.data?.dispatch?.('yoast-seo/editor');
      if (!dispatcher?.updateData) return false;
      dispatcher.updateData({ title: yoastTitle, description: yoastDesc });
      return true;
    };

    // The "Edit snippet" button (and the SEO title/Meta description fields
    // behind it) only exist in the DOM once the Yoast SEO panel is the
    // active sidebar/tab — on a fresh page nobody has opened it yet.
    const openYoastSnippet = () => {
      if (document.querySelector('#yoast_wpseo_title, #yoast_wpseo_metadesc, input[name="yoast_wpseo_title"], textarea[name="yoast_wpseo_metadesc"]') ||
        fieldsForLabel('SEO title').length || fieldsForLabel('Meta description').length) {
        return false;
      }
      const sidebarAlreadyOpen = document.querySelector('.yoast-seo-panel, #yoast-seo-metabox-root, [id^="yoast-seo-panel"]');
      if (!sidebarAlreadyOpen) {
        const sidebarButton = [...document.querySelectorAll('button, [role="button"]')].find(el => {
          const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
          return (label.includes('yoast seo') || label === 'seo') && el.offsetParent !== null;
        });
        sidebarButton?.click();
      }
      const snippetButton = [...document.querySelectorAll('button, a, [role="button"]')].find(el => {
        const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
        return /edit\s*(the\s*)?snippet|snippet\s*(editor|preview)/.test(label) && el.offsetParent !== null;
      });
      if (!snippetButton) return false;
      snippetButton.click();
      return true;
    };

    const waitForYoastEditor = async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (window.wp?.data?.dispatch?.('yoast-seo/editor')) return true;
        await wait(100);
      }
      return false;
    };

    // Yoast mounts asynchronously and can replace/re-sync its hidden fields
    // after the page is edited — reapply the values on a few passes while it
    // finishes mounting, same retry approach Auto Publishing uses.
    await waitForYoastEditor();
    let yoastStoreWritten = false;
    let yoastFieldWritten = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      openYoastSnippet();
      yoastStoreWritten = updateYoastStore() || yoastStoreWritten;
      yoastFieldWritten = writeYoastFields() || yoastFieldWritten;
      if (attempt < 3) await wait(120);
    }

    if (yoastStoreWritten || yoastFieldWritten) {
      log.push('Yoast title & meta description');
    } else {
      log.push('Yoast title/meta description: fields not found (Yoast may not be active on this page, or its panel never opened)');
    }

    return { log };
  })();
}
/* ================================================================== */
/*  Page link: the page's URL (relative path + full link) in the popup  */
/* ================================================================== */

/* page side: the permalink WordPress shows under the title (after the first save / autosave), or ask WordPress for it */
async function readPagePermalink(slug, title) {
  // WordPress shows a long slug SHORTENED with an ellipsis ("2026-toyota-camr…6-toyota-corolla") in #editable-post-name; the whole slug
  // is in #editable-post-name-full (and in the #post_name field). Put the whole slug back before reading the link.
  const fullSlug = root => ((root.querySelector('#editable-post-name-full')?.textContent || '').trim()
    || (document.querySelector('#post_name')?.value || '').trim() || (slug || '').trim());
  const fromHtml = root => {
    const a = root.querySelector('#sample-permalink a') || root.querySelector('#sample-permalink');
    let t = '';
    if (a) {
      const clone = a.cloneNode(true);
      const shown = clone.querySelector('#editable-post-name');
      const whole = fullSlug(root);
      if (shown && whole) shown.textContent = whole;
      t = (clone.textContent || '').replace(/\s+/g, '').trim();
      if (/[\u2026]|\.\.\./.test(t) && whole) {            // still shortened (other WordPress markup): swap the last part for the whole slug
        try { const u = new URL(t.replace(/\u2026.*$/, '')); const parts = u.pathname.split('/').filter(Boolean); parts.pop(); t = u.origin + '/' + [...parts, whole].join('/') + '/'; } catch { /* keep t */ }
      }
    }
    if (t && !/[\u2026]/.test(t) && /^https?:\/\//i.test(t)) return t;
    const h = a && a.getAttribute && a.getAttribute('href');
    return h && /^https?:\/\//i.test(h) && !/[?&](p|page_id|preview)=/i.test(h) ? h : '';
  };
  const viewHref = root => {
    const a = root.querySelector('#sample-permalink a') || root.querySelector('#sample-permalink');
    const h = a && a.getAttribute && a.getAttribute('href');
    return h && /^https?:\/\//i.test(h) ? h : '';
  };
  const status = () => (document.querySelector('#post-status-display')?.textContent || '').trim();
  try {
    let url = fromHtml(document);
    let view = viewHref(document);
    if (!url) {
      const nonce = document.querySelector('#samplepermalinknonce')?.value;
      const id = document.querySelector('#post_ID')?.value;
      if (nonce && id) {
        const adminBase = location.origin + location.pathname.replace(/\/wp-admin\/.*$/, '/wp-admin/');
        const body = new URLSearchParams({ action: 'sample-permalink', post_id: id, new_title: title || '', new_slug: slug || '', samplepermalinknonce: nonce });
        const res = await fetch(adminBase + 'admin-ajax.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        const html = await res.text();
        const doc = new DOMParser().parseFromString('<div id="x"><span id="sample-permalink">' + html + '</span></div>', 'text/html');
        url = fromHtml(doc);
        view = view || viewHref(doc);
      }
    }
    return { url, view, status: status() };
  } catch (e) { return { url: '', status: '', error: e.message }; }
}

async function storePageLink(pl, title, saved) {
  let path = '';
  try { path = new URL(pl.url).pathname; } catch { path = pl.url; }
  await chrome.storage.local.set({ pageLink: { at: Date.now(), title: title || '', url: pl.url, path, draftUrl: pl.view || '', status: pl.status || '', saved: !!saved } });
}

/* after Save Draft / Publish WordPress reloads the edit screen: read the link again (it is the real one now) */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url || !/\/wp-admin\/post\.php\?[^#]*action=edit/.test(tab.url)) return;
  const stored = await chrome.storage.session.get(TAB_KEY);
  if (stored[TAB_KEY] !== tabId) return;
  try {
    const pl = await execIn(tabId, readPagePermalink, ['', '']);
    if (pl?.url) await storePageLink(pl, (await chrome.storage.local.get('pageLink')).pageLink?.title || '', true);
  } catch { /* the tab went away */ }
});

/* ================================================================== */
/*  Image downloaded AFTER the page was filled -> it is added by itself  */
/* ================================================================== */
let lateImageBusy = false;
async function addImageLater(pend, lib) {
  const tab = await chrome.tabs.get(pend.tabId).catch(() => null);
  if (!tab) return;
  const setMsg = (ok, message) => chrome.storage.session.set({ [STATUS_KEY]: { ok, message } });
  const setCheck = async (ok, detail) => {
    const cur = (await chrome.storage.local.get('pageCheck')).pageCheck;
    if (!cur || !Array.isArray(cur.checks)) return;
    const checks = cur.checks.filter(c => !/^Banner image/i.test(c.name));
    checks.push({ name: 'Banner image uploaded + inserted', ok, detail });
    await chrome.storage.local.set({ pageCheck: { ...cur, at: Date.now(), checks } });
  };
  let attached = false;
  try {
    await setMsg(true, 'The image was downloaded after the page was filled — adding it to the image row now…');
    await chrome.tabs.update(pend.tabId, { active: true }).catch(() => {});
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await swWait(400);
    const alt = (await chrome.storage.local.get('diLandingImageAlt')).diLandingImageAlt;
    const image = { dataUrl: lib.dataUrl, width: lib.width, height: lib.height, alt: alt || lib.query || pend.title, filename: pend.slug || 'landing-banner' };
    try {                                     // same clean-name rule as the normal run
      const site = siteSlug(new URL(tab.url).hostname);
      const chk = await execIn(pend.tabId, wpMediaNameTaken, [image.filename]);
      if (chk?.taken && site && !image.filename.endsWith('-' + site)) image.filename = `${image.filename}-${site}`;
    } catch { /* keep the plain name */ }
    image.saved = await saveImageToDisk(pend.tabId, image);
    const att = await attachDebugger(pend.tabId);
    attached = att.ok;
    if (!att.ok) throw new Error(`could not attach the debugger (${att.error}) — close DevTools on the WordPress tab`);
    const ins = await insertBannerImage(pend.tabId, pend.rowId, image);
    if (ins.ok) {
      await setCheck(true, `alt "${image.alt}" (added after the fill)`);
      await setMsg(true, `Image added to the page (alt "${image.alt}"). Nothing was saved — review the page and click Save Draft / Publish when ready.`);
    } else {
      await setCheck(false, `${ins.error || 'Add Media failed'} — add it by hand${ins.saved?.ok ? ': ' + ins.saved.path : ''}`);
      await setMsg(false, `The image could not be added (${ins.error || 'Add Media failed'}). Add it by hand: Add Media → Upload files → ${ins.saved?.ok ? ins.saved.path : 'the saved image'}.`);
    }
  } catch (e) {
    await setCheck(false, `${e.message} — add it by hand`);
    await setMsg(false, `The image could not be added (${e.message}). Add it by hand.`);
  } finally {
    if (attached) await detachDebugger(pend.tabId);
  }
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.diLandingImage || lateImageBusy) return;
  const lib = changes.diLandingImage.newValue;
  if (!lib || lib.status !== 'done' || !lib.dataUrl) return;
  const pend = (await chrome.storage.session.get(LATE_IMG_KEY))[LATE_IMG_KEY];
  if (!pend || (lib.updatedAt || 0) <= pend.since) return;
  lateImageBusy = true;
  try {
    await chrome.storage.session.remove(LATE_IMG_KEY);
    await addImageLater(pend, lib);
  } finally { lateImageBusy = false; }
});

/* ------------------------------------------------------------------ */
/*  Safety net: if the WordPress tab this extension itself opened gets */
/*  closed mid-fill (before the try/finally above reaches its own      */
/*  detachDebugger call), Chrome ends that debugger session on its     */
/*  own the moment the tab closes — a debugger target can't outlive    */
/*  its tab. This listener's only job is to stop stale bookkeeping:    */
/*  clear TAB_KEY/RUN_KEY so a *different*, unrelated tab can never be */
/*  mistaken for the fill target on some future update event. Ignores  */
/*  every tab close except the one this run is actually tracking.      */
/* ------------------------------------------------------------------ */
chrome.tabs.onRemoved.addListener(async tabId => {
  const stored = await chrome.storage.session.get(TAB_KEY);
  if (stored[TAB_KEY] !== tabId) return;
  await chrome.storage.session.remove([TAB_KEY, RUN_KEY]);
});
