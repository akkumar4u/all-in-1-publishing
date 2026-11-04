import { startTimeLog } from './timelog.js';
import { openInNormalWindow } from './win_util.js';
import './blog_category.js';   // sets globalThis.diBlogCategory
const DRAFT_KEY = 'pendingWordPressDraft';
const STATUS_KEY = 'lastFillStatus';
const TARGET_TAB_KEY = 'pendingWordPressDraftTabId';
const AUTO_SAVE_KEY = 'pendingWordPressDraftAutoSave';
const LATE_BLOG_IMG_KEY = 'blogLateImage';
const BLOG_IMAGE_KEY = 'diBlogImage';   // the 1000x400 image picked in the popup (images/img_popup.js)
const GOOGLE_DOC_ID = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;
const PARSER_DOCUMENT = 'parser.html';
let parserDocumentPromise;

async function parseGoogleDocInExtension(sourceHtml, adminUrl) {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(PARSER_DOCUMENT)]
  });
  if (!contexts.length) {
    parserDocumentPromise ||= chrome.offscreen.createDocument({
      url: PARSER_DOCUMENT,
      reasons: ['DOM_PARSER'],
      justification: 'Clean Google Docs HTML before adding it to a WordPress draft.'
    }).finally(() => { parserDocumentPromise = undefined; });
    await parserDocumentPromise;
  }
  let ownHost = '';
  try { ownHost = new URL(adminUrl || '').hostname; } catch { /* no admin URL */ }
  return chrome.runtime.sendMessage({ type: 'PARSE_GOOGLE_DOC_HTML', sourceHtml, ownHost });
}

function postNewUrl(adminUrl) {
  const url = new URL(adminUrl);
  if (!/\/wp-admin(?:\/|$)/i.test(url.pathname)) {
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = `${basePath}/wp/wp-admin`.replace(/\/+/g, '/');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/post-new.php`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function isNewBlogPostUrl(tabUrl, adminUrl) {
  const url = new URL(tabUrl);
  const admin = new URL(adminUrl);

  // Never run on post.php (an existing post/page) or on page creation. This
  // workflow is deliberately limited to WordPress's "Add New Post" screen.
  return url.origin === admin.origin &&
    /\/wp-admin\/post-new\.php$/i.test(url.pathname) &&
    (url.searchParams.get('post_type') || 'post') === 'post';
}

function articleHtml(content = '', buttons = '', imageShortcode = '', landingBottom = 'blog') {
  let article = content;
  buttons = buttons.replace(/<\/a>\s*<a\b/gi, '</a> <a').trim();
  if (buttons) {
    const firstParagraphEnd = article.indexOf('</p>');
    article = firstParagraphEnd === -1
      ? `${buttons}\n\n${article}`.trim()
      : `${article.slice(0, firstParagraphEnd + 4)}\n\n${buttons}\n\n${article.slice(firstParagraphEnd + 4)}`.trim();
  }
  const bottomRow = landingBottom === 'form'
    ? '[gravityform id="3" title="true" description="true"]'
    : '<div class="well"><div class="center"><h2>More from %%di_name%%</h2></div>[di_posts posts_per_page="3" excerpt="true" date="false" thumbs="false"]</div>';
  return [imageShortcode, article, bottomRow].filter(Boolean).join('\n\n');
}

function prettifyHtml(html = '') {
  const blockTags = 'div|p|h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|pre|hr|section|article|header|footer|nav|figure|figcaption';

  let result = html
    .replace(/>(\s*)</g, '>\n<')
    .replace(new RegExp(`(<(?:${blockTags})[\\s>])`, 'gi'), '\n$1')
    .replace(new RegExp(`(</(?:${blockTags})>)`, 'gi'), '\n$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = result.split('\n');
  let depth = 0;
  const indented = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';

    const isSelfClosing = /^<(?:hr|br|img|input|meta|link)\b[^>]*\/?>$/i.test(trimmed);
    const isClosing = /^<\//.test(trimmed);
    const isOpening = /^<(?!\/)/.test(trimmed) && !isSelfClosing && !/<\/[^>]+>\s*$/.test(trimmed);
    const isComplete = /^<(\w+)[^>]*>.*<\/\1>$/s.test(trimmed);

    if (isClosing && !isComplete) depth = Math.max(0, depth - 1);
    const indent = '  '.repeat(depth);
    if (isOpening && !isComplete) depth += 1;

    return indent + trimmed;
  });

  return indented.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_PENDING_DRAFT') {
    chrome.storage.local.get(DRAFT_KEY)
      .then(async stored => {
        const status = await chrome.storage.local.get(STATUS_KEY);
        sendResponse({ ok: true, draft: stored[DRAFT_KEY] || null, status: status[STATUS_KEY] || null });
      })
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'QUEUE_WORDPRESS_DRAFT') {
    const draft = message.draft;
    if (!draft?.adminUrl || !draft?.title) {
      sendResponse({ ok: false, error: 'A WordPress admin URL and post title are required.' });
      return;
    }

    chrome.storage.local.set({ [DRAFT_KEY]: draft, [STATUS_KEY]: null })
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'IMPORT_GOOGLE_DOC') {
    const { documentUrl, adminUrl, landingBottom = 'blog' } = message;
    if (!documentUrl || !adminUrl) {
      sendResponse({ ok: false, error: 'Enter both the Google Doc URL and WordPress admin URL.' });
      return;
    }
    const TL = startTimeLog('timeLogImport', 'Google Doc import (Blog)');
    (async () => {
      const match = documentUrl.match(GOOGLE_DOC_ID);
      if (!match) throw new Error('Please enter a valid Google Docs link.');
      // A link to a specific tab (?tab=t.abc) must export THAT tab only (a doc can hold several tabs).
      const tabParam = (documentUrl.match(/[?&]tab=(t\.[A-Za-z0-9]+)/) || [])[1];
      const response = await fetch(`https://docs.google.com/document/d/${match[1]}/export?format=html` + (tabParam ? `&tab=${tabParam}` : ''));
      TL.lap('Download the Google Doc');
      if (!response.ok) throw new Error(`Google Docs returned HTTP ${response.status}. Confirm the document is shared as “Anyone with the link” → Viewer, then try again.`);
      const data = await parseGoogleDocInExtension(await response.text(), adminUrl);
      TL.lap('Read + parse the doc');
      if (data.error) throw new Error(data.error);
        if (!data.title) throw new Error('The Google Doc did not include a blog title.');
        const draft = { ...data, bodyHtml: data.content || '', content: prettifyHtml(articleHtml(data.content, data.buttons, data.imageShortcode, landingBottom)), adminUrl };
        if (message.returnOnly) return draft; // Bulk review needs an isolated package; do not replace the side-panel queue.
        await chrome.storage.local.remove([BLOG_IMAGE_KEY, 'diBlogImageAlt', 'diBlogHeld']);   // a new blog never inherits the previous blog's image
        await chrome.storage.local.set({ [DRAFT_KEY]: draft, [STATUS_KEY]: null });
        // Keep Hub Publisher's saved admin URL in sync too — same site, one URL.
        await chrome.storage.local.set({ wordPressAdminUrl: adminUrl, hubAdminUrl: adminUrl });
        return draft;
    })().then(draft => sendResponse({ ok: true, draft }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'SAVE_WORDPRESS_ADMIN_URL') {
    try {
      const adminUrl = new URL(message.adminUrl || '').toString().replace(/\/$/, '');
      // Same site as Hub Publisher, so keep both saved URLs in sync.
      chrome.storage.local.set({ wordPressAdminUrl: adminUrl, hubAdminUrl: adminUrl })
        .then(() => sendResponse({ ok: true, adminUrl }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
    } catch {
      sendResponse({ ok: false, error: 'Enter a valid WordPress admin URL.' });
    }
    return true;
  }

  // Content review deliberately updates only the HTML that will be written
  // into WordPress. Title, slug, SEO fields, category, buttons and every
  // other imported value remain exactly as originally parsed.
  if (message?.type === 'UPDATE_PENDING_DRAFT_CONTENT') {
    chrome.storage.local.get([DRAFT_KEY, STATUS_KEY]).then(async stored => {
      const draft = stored[DRAFT_KEY];
      if (!draft) throw new Error('No blog draft is queued. Import the Google Doc again first.');
      if (stored[STATUS_KEY]?.filled) throw new Error('This draft was already filled. Clear it before changing its content.');
      draft.content = String(message.content || '');
      await chrome.storage.local.set({ [DRAFT_KEY]: draft });
      sendResponse({ ok: true });
    }).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'CLEAR_PENDING_DRAFT') {
    chrome.storage.local.remove([DRAFT_KEY, TARGET_TAB_KEY, STATUS_KEY, AUTO_SAVE_KEY, BLOG_IMAGE_KEY, 'diBlogImageAlt', 'diBlogHeld'])
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'OPEN_PENDING_DRAFT') {
    chrome.storage.local.get(DRAFT_KEY).then(async stored => {
      const draft = stored[DRAFT_KEY];
      if (!draft) throw new Error('No post is queued. Return to Auto Publishing and click Send to WP.');
      const status = await chrome.storage.local.get(STATUS_KEY);
      if (status[STATUS_KEY]?.filled) {
        throw new Error('This draft was already filled. Save it in WordPress, then clear it from the extension before importing another document.');
      }
      const tab = await openInNormalWindow(postNewUrl(draft.adminUrl));
      await chrome.storage.local.set({ [TARGET_TAB_KEY]: tab.id, [AUTO_SAVE_KEY]: !!message.autoSaveDraft });
      sendResponse({ ok: true, tabId: tab.id });
    }).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  const stored = await chrome.storage.local.get([DRAFT_KEY, TARGET_TAB_KEY, AUTO_SAVE_KEY]);
  const draft = stored[DRAFT_KEY];
  if (!draft || stored[TARGET_TAB_KEY] !== tabId || !isNewBlogPostUrl(tab.url, draft.adminUrl)) return;

  // progress box on the WordPress page + keep this tab visible (same as the landing / comparison fill)
  const paint = async (text, ok = true) => {
    try {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: paintBlogProgress, args: [text, ok] });
    } catch (e) { /* the tab is still loading or went away */ }
  };
  try {
    const libNow0 = (await chrome.storage.local.get(BLOG_IMAGE_KEY))[BLOG_IMAGE_KEY];
    if (tab.windowId != null && !(libNow0 && libNow0.status === 'choose')) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) { /* optional */ }
  await chrome.storage.session.remove(LATE_BLOG_IMG_KEY);   // a new fill forgets the previous post's waiting image
  await paint('Blog post — reading the site\'s categories…');

  try {
    // Blog image: upload the 1000x400 image to THIS site's media library (with alt text) and put it at the very
    // start of the post content, above everything else. Skipped quietly if no image was picked.
    let fillDraft = draft;
    let imageNote = '';
    const blogStart = Date.now();
    const steps = [];
    const markB = (label, t0) => steps.push({ label, s: Math.round((Date.now() - t0) / 100) / 10 });
    const imgStore = await chrome.storage.local.get([BLOG_IMAGE_KEY, 'diBlogImageAlt']);
    const lib = imgStore[BLOG_IMAGE_KEY];
    if (lib && lib.status === 'done' && lib.dataUrl) {
      const slugify = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const image = {
        dataUrl: lib.dataUrl, width: lib.width, height: lib.height,
        alt: imgStore.diBlogImageAlt || draft.altText || lib.query || draft.title || '',
        filename: slugify(draft.slug) || slugify(draft.title) || 'blog-image'
      };
      try {
        const tUp = Date.now();
        const up = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: uploadBlogImage, args: [image] }))[0]?.result;
        markB('Blog image: upload to media library', tUp);
        if (up?.ok) {
          fillDraft = { ...draft, content: `${up.html}\n\n${draft.content || ''}`.trim(), featuredMediaId: up.id, featuredMediaUrl: up.url };
          imageNote = ` Blog image (${image.width}x${image.height}) uploaded with alt text and added at the start of the post.`;
          await chrome.storage.local.remove([BLOG_IMAGE_KEY, 'diBlogImageAlt', 'diBlogHeld']);
        } else {
          imageNote = ` The blog image could NOT be uploaded (${up?.error || 'no answer from the page'}) — add it by hand.`;
        }
      } catch (e) { imageNote = ` The blog image could NOT be uploaded (${e.message}) — add it by hand.`; }
    }
    // The image is still being searched / chosen: fill the post now, the image is added by itself when it is downloaded
    if (!(lib && lib.status === 'done' && lib.dataUrl) && lib && (lib.status === 'running' || lib.status === 'choose') && Date.now() - (lib.updatedAt || 0) < 10 * 60 * 1000) {
      await chrome.storage.session.set({ [LATE_BLOG_IMG_KEY]: { tabId, since: Date.now(), slug: draft.slug, title: draft.title, alt: draft.altText, autoSave: !!stored[AUTO_SAVE_KEY] } });
      imageNote += ' The blog image is still being ' + (lib.status === 'choose' ? 'chosen' : 'fetched') + ' — it is added to the post by itself as soon as it is downloaded.';
    }
    // Category: read the site's real list from WordPress and pick (features blog -> the features category only)
    let categoryNote = '';
    try {
      const tCat = Date.now();
      const catRes = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fetchSiteCategories }))[0]?.result;
      const saved = (await chrome.storage.local.get('blogCategoryChoice')).blogCategoryChoice;
      const chosen = saved && saved.title === (draft.title || '') ? saved.value : '__auto';
      const explicitIds = Array.isArray(fillDraft.categoryIds) ? fillDraft.categoryIds : [];
      const explicitNames = (fillDraft.categoryOptions || []).filter(c => explicitIds.includes(Number(c.id))).map(c => c.name);
      const pick = fillDraft.categoryChoiceSet
        ? { ids: explicitIds, names: explicitNames, why: 'selected in the bulk dashboard' }
        : explicitIds.length
          ? { ids: explicitIds, names: explicitNames, why: 'selected from the website categories' }
          : catRes?.ok && globalThis.diBlogCategory
            ? globalThis.diBlogCategory.suggest(catRes.cats, { title: draft.title, docCategory: draft.category, keyword: draft.keyword, chosen })
            : null;
      if (pick && pick.ids.length) {
        fillDraft = { ...fillDraft, categoryIds: pick.ids };
        categoryNote = ` Category: ${pick.names.join(', ')} (${pick.why}).`;
      } else {
        categoryNote = pick ? ` No category was set (${pick.why}).` : ' The categories could not be read from the site — choose the category by hand.';
      }
      markB('Category: read the site list + pick', tCat);
    } catch (e) { categoryNote = ` Category skipped (${e.message}) — choose it by hand.`; }
    await paint('Blog post — filling title, content, SEO fields and category…');
    const tFill = Date.now();
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: fillGutenbergDraft,
      args: [fillDraft, !!stored[AUTO_SAVE_KEY]]
    });
    markB('Fill title / content / SEO / featured image', tFill);
    await chrome.storage.local.set({ timeLog: { source: 'Blog', at: Date.now(), total: Math.round((Date.now() - blogStart) / 100) / 10, steps } });
    // Lock the draft after filling so it cannot fill a second editor, but keep
    // its content until the user has saved the WordPress draft and clears it.
    await chrome.storage.local.remove([TARGET_TAB_KEY, AUTO_SAVE_KEY]);
    const fillResult = result[0]?.result;
    const editorName = fillResult?.editor || 'WordPress';
    const yoastOk = fillResult?.yoast !== false;
    const savedDraft = fillResult?.saved === true;
    const yoastCaveat = ' The Yoast SEO title/description could not be set automatically — open the Yoast SEO panel in the sidebar and fill those two fields by hand, then save again.';
    imageNote += categoryNote;
    if (fillDraft.featuredMediaId) imageNote += fillResult?.featured ? ' The same image was set as the Featured image.' : ' The Featured image could NOT be set automatically — click "Set featured image" and choose the same image.';
    const message = (savedDraft
      ? `Draft filled and saved as a WordPress draft in the ${editorName} editor.${yoastOk ? '' : yoastCaveat}`
      : yoastOk
      ? `Draft fields filled in the ${editorName} editor. Save it in WordPress, then click Clear queued draft here.`
      : `Draft filled in the ${editorName} editor, but the Yoast SEO title/description could not be set automatically. Open the Yoast SEO panel in the sidebar, fill those two fields by hand, then save. (Check this tab's DevTools console for "[Auto Publishing]" logs to see why.)`) + imageNote;
    await chrome.storage.local.set({
      [STATUS_KEY]: { ok: yoastOk, filled: true, saved: savedDraft, message }
    });
    if (draft.bulkTicket) {
      const postId = Number(fillResult?.postId || 0);
      const admin = new URL(draft.adminUrl);
      const sitePath = admin.pathname.replace(/\/wp-admin(?:\/.*)?$/i, '').replace(/\/$/, '');
      const editUrl = postId ? `${admin.origin}${sitePath}/wp-admin/post.php?post=${postId}&action=edit` : '';
      const previewUrl = fillResult?.previewUrl || (postId ? `${admin.origin}${sitePath}/?p=${postId}&preview=true` : '');
      await chrome.storage.local.set({ bulkDraftResult: {
        ticket: draft.bulkTicket, at: Date.now(), ok: savedDraft,
        error: savedDraft ? '' : `Blog fields were filled but WordPress did not confirm the draft save. ${message}`,
        editUrl, previewUrl, notice: message, postId,
      } });
    }
    await paint(message.slice(0, 160), yoastOk);
  } catch (error) {
    console.error('Could not fill the WordPress editor:', error);
    const failureMessage = `Could not fill the editor: ${error.message}`;
    await chrome.storage.local.set({
      [STATUS_KEY]: { ok: false, message: failureMessage }
    });
    if (draft.bulkTicket) await chrome.storage.local.set({ bulkDraftResult: { ticket: draft.bulkTicket, at: Date.now(), ok: false, error: failureMessage } });
  }
});

/* Runs INSIDE the WordPress tab: small progress box (bottom right), ignores clicks, gone 40s after the last update */
function paintBlogProgress(text, ok) {
  const id = 'di-ext-progress';
  let b = document.getElementById(id);
  if (!b) {
    b = document.createElement('div');
    b.id = id;
    b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;color:#fff;font:600 13px/1.45 "Segoe UI",Arial,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:340px;pointer-events:none;';
    (document.body || document.documentElement).appendChild(b);
  }
  b.textContent = 'All in 1 tool: ' + String(text || '').slice(0, 170);
  b.style.background = ok === false ? '#b3261e' : '#0b5a4a';
  clearTimeout(window.__diProgressTimer);
  window.__diProgressTimer = setTimeout(() => { const x = document.getElementById(id); if (x) x.remove(); }, 40000);
}

/* Runs INSIDE the WordPress tab: the site's category list (the admin is logged in; REST is tried with its nonce first) */
async function fetchSiteCategories() {
  const nonce = window.wpApiSettings && window.wpApiSettings.nonce;
  const roots = [window.wpApiSettings && window.wpApiSettings.root, location.origin + '/wp-json/', location.origin + '/?rest_route=/'].filter(Boolean);
  for (const root of [...new Set(roots)]) {
    const out = [];
    try {
      for (let page = 1; page <= 5; page++) {
        const q = `per_page=100&page=${page}&_fields=id,name,slug,parent,count`;
        const url = root.includes('rest_route=') ? `${root}wp/v2/categories&${q}` : `${root.replace(/\/?$/, '/')}wp/v2/categories?${q}`;
        const res = await fetch(url, { credentials: 'same-origin', headers: nonce ? { 'X-WP-Nonce': nonce } : {} });
        if (!res.ok) { if (page > 1 && res.status === 400) break; throw new Error('HTTP ' + res.status); }
        const arr = await res.json();
        if (!Array.isArray(arr)) throw new Error('not a list');
        out.push(...arr);
        if (arr.length < 100) break;
      }
      if (out.length) return { ok: true, cats: out };
    } catch (e) { /* next root */ }
  }
  return { ok: false, cats: [] };
}

/* Runs INSIDE the WordPress tab: put the uploaded image at the very start of the post and make it the featured image */
async function insertBlogImageIntoEditor(up, autoSave) {
  const wpd = window.wp && window.wp.data;
  if (wpd && wpd.dispatch && wpd.dispatch('core/editor')) {
    const cur = (wpd.select('core/editor').getEditedPostContent && wpd.select('core/editor').getEditedPostContent()) || '';
    wpd.dispatch('core/editor').editPost({ content: `${up.html}\n\n${cur}`.trim(), featured_media: up.id });
    let saved = false;
    if (autoSave && wpd.dispatch('core/editor').savePost) {
      await wpd.dispatch('core/editor').savePost();
      for (let i = 0; i < 30 && wpd.select('core/editor').isSavingPost && wpd.select('core/editor').isSavingPost(); i++) await new Promise(r => setTimeout(r, 300));
      saved = !(wpd.select('core/editor').isEditedPostDirty && wpd.select('core/editor').isEditedPostDirty());
    }
    return { ok: true, editor: 'Gutenberg', featured: Number(wpd.select('core/editor').getEditedPostAttribute('featured_media')) === Number(up.id), saved };
  }
  const ed = window.tinymce && window.tinymce.get && window.tinymce.get('content');
  if (ed) {
    ed.setContent(`${up.html}\n${ed.getContent()}`);
    ed.fire('change');
    const thumb = document.querySelector('#_thumbnail_id');
    if (thumb) thumb.value = String(up.id);
    return { ok: true, editor: 'Classic', featured: !!thumb, saved: false };
  }
  return { ok: false, error: 'no editor found' };
}

/* The blog image that finished AFTER the post was filled is added by itself */
let lateBlogBusy = false;
async function addBlogImageLater(pend, lib) {
  const tab = await chrome.tabs.get(pend.tabId).catch(() => null);
  if (!tab) return;
  const say = async (ok, message) => {
    const cur = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] || {};
    await chrome.storage.local.set({ [STATUS_KEY]: { ...cur, ok, filled: true, message } });
    try { await chrome.scripting.executeScript({ target: { tabId: pend.tabId }, world: 'MAIN', func: paintBlogProgress, args: [message.slice(0, 160), ok] }); } catch (e) { /* ignore */ }
  };
  try {
    await chrome.tabs.update(pend.tabId, { active: true }).catch(() => {});
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await say(true, 'The blog image was downloaded after the post was filled — adding it to the post now…');
    const imgStore = await chrome.storage.local.get('diBlogImageAlt');
    const slugify = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const image = {
      dataUrl: lib.dataUrl, width: lib.width, height: lib.height,
      alt: imgStore.diBlogImageAlt || pend.alt || lib.query || pend.title || '',
      filename: slugify(pend.slug) || slugify(pend.title) || 'blog-image'
    };
    const up = (await chrome.scripting.executeScript({ target: { tabId: pend.tabId }, world: 'MAIN', func: uploadBlogImage, args: [image] }))[0]?.result;
    if (!up?.ok) { await say(false, `The blog image could NOT be uploaded (${up?.error || 'no answer from the page'}) — add it by hand.`); return; }
    const ins = (await chrome.scripting.executeScript({ target: { tabId: pend.tabId }, world: 'MAIN', func: insertBlogImageIntoEditor, args: [up, !!pend.autoSave] }))[0]?.result;
    await chrome.storage.local.remove([BLOG_IMAGE_KEY, 'diBlogImageAlt', 'diBlogHeld']);
    if (ins?.ok) await say(true, `Blog image (${image.width}x${image.height}) uploaded with alt text and added at the start of the post${ins.featured ? ', and set as the Featured image' : ' (set the Featured image by hand)'}.${ins.saved ? ' The draft was saved again.' : ' Save the draft in WordPress.'}`);
    else await say(false, `The image was uploaded but could not be placed in the editor (${ins?.error || 'unknown'}) — add it by hand from the media library.`);
  } catch (e) {
    await say(false, `The blog image could NOT be added (${e.message}) — add it by hand.`);
  }
}
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes[BLOG_IMAGE_KEY] || lateBlogBusy) return;
  const lib = changes[BLOG_IMAGE_KEY].newValue;
  if (!lib || lib.status !== 'done' || !lib.dataUrl) return;
  const pend = (await chrome.storage.session.get(LATE_BLOG_IMG_KEY))[LATE_BLOG_IMG_KEY];
  if (!pend || (lib.updatedAt || 0) <= pend.since) return;
  lateBlogBusy = true;
  try { await chrome.storage.session.remove(LATE_BLOG_IMG_KEY); await addBlogImageLater(pend, lib); }
  finally { lateBlogBusy = false; }
});

/* Runs INSIDE the WordPress tab (serialised by chrome.scripting): uploads the image + alt text, returns the <img> markup */
async function uploadBlogImage(image) {
  const dataUrlToBlob = u => { const [h, b] = String(u).split(','); const mime = (h.match(/data:([^;]+)/) || [])[1] || 'image/png'; const bin = atob(b || ''); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: mime }); };
  const out = { ok: false, tried: [] };
  try {
    const blob = dataUrlToBlob(image.dataUrl);
    const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
    const filename = `${image.filename || 'blog-image'}.${ext}`;
    const file = new File([blob], filename, { type: blob.type || 'image/png' });
    const adminBase = location.origin + location.pathname.replace(/\/wp-admin\/.*$/, '/wp-admin/');
    const siteBase = adminBase.replace(/wp-admin\/$/, '');
    const esc = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const markup = (id, url) => `<img class="alignnone size-full wp-image-${id}" src="${url}" alt="${esc(image.alt)}" width="${image.width}" height="${image.height}" />`;

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

async function fillGutenbergDraft(draft, autoSaveDraft = false) {
  // Everything logged here shows up in this tab's own DevTools console
  // (Inspect on the WordPress post-new.php page), not the extension's
  // service worker console, since this function runs in the page's MAIN world.
  const log = (...args) => console.info('[Auto Publishing]', ...args);

  const setYoastField = (selector, value) => {
    const field = document.querySelector(selector);
    return setFieldValue(field, value);
  };

  const setFieldValue = (field, value) => {
    if (!field || value === undefined || value === null) return false;
    if (field.isContentEditable) {
      field.textContent = value;
    } else if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      const prototype = field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(field, value);
    } else {
      return false;
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

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
    const yoastTitle = draft.metaTitle || draft.title || '';
    const yoastDescription = draft.metaDescription || '';
    const titleWritten = [
      '#yoast_wpseo_title',
      'input[name="yoast_wpseo_title"]',
      'input[name="_yoast_wpseo_title"]',
      'input[id*="yoast"][id*="title"]',
      'input[name*="yoast"][name*="title"]'
    ].map(selector => setYoastField(selector, yoastTitle)).some(Boolean);
    const descriptionWritten = [
      '#yoast_wpseo_metadesc',
      'textarea[name="yoast_wpseo_metadesc"]',
      'textarea[name="_yoast_wpseo_metadesc"]',
      'textarea[id*="yoast"][id*="desc"]',
      'textarea[name*="yoast"][name*="desc"]'
    ].map(selector => setYoastField(selector, yoastDescription)).some(Boolean);
    // Current Yoast screens often render React inputs without the older
    // Yoast IDs. Their visible labels are a direct, stable fallback.
    const labelledTitleWritten = fieldsForLabel('SEO title')
      .map(field => setFieldValue(field, yoastTitle)).some(Boolean);
    const labelledDescriptionWritten = fieldsForLabel('Meta description')
      .map(field => setFieldValue(field, yoastDescription)).some(Boolean);
    const wrote = titleWritten || descriptionWritten || labelledTitleWritten || labelledDescriptionWritten;
    log(wrote ? 'Wrote title/description directly to Yoast DOM fields.' : 'No Yoast title/description DOM fields found to write to.');
    return wrote;
  };

  // Recent Yoast versions treat this store—not Gutenberg's `meta` object—as
  // the source of truth for the snippet editor. If only `editPost({ meta })`
  // is used, Yoast can overwrite the two values with empty fields on save.
  const updateYoastStore = () => {
    const dispatcher = window.wp?.data?.dispatch?.('yoast-seo/editor');
    if (!dispatcher) {
      log('yoast-seo/editor store not found yet (Yoast may not be loaded/active on this page).');
      return false;
    }
    if (!dispatcher.updateData) {
      // This action is undocumented and can be renamed between Yoast
      // releases. Log the real method names so a mismatch is visible
      // in the console instead of silently doing nothing.
      log('yoast-seo/editor store found, but has no updateData action. Available actions:', Object.keys(dispatcher));
      return false;
    }
    dispatcher.updateData({
      title: draft.metaTitle || draft.title || '',
      description: draft.metaDescription || ''
    });
    log('Wrote title/description to the yoast-seo/editor store.');
    return true;
  };

  // The "Edit snippet" button (and the SEO title/Meta description fields
  // behind it) only exist in the DOM once the Yoast SEO panel itself is the
  // active sidebar/tab. On a fresh draft nobody has opened that panel yet,
  // so there's nothing on the page for openYoastSnippet/writeYoastFields to
  // find until we open it first.
  const openYoastSidebar = () => {
    const alreadyOpen = document.querySelector('.yoast-seo-panel, #yoast-seo-metabox-root, [id^="yoast-seo-panel"]');
    if (alreadyOpen) return false;
    const candidates = [...document.querySelectorAll('button, [role="button"]')].filter(button => {
      const label = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`
        .replace(/\s+/g, ' ').trim().toLowerCase();
      return label.includes('yoast seo') || label === 'seo';
    });
    const button = candidates.find(item => item.offsetParent !== null);
    if (!button) {
      log('Could not find a Yoast SEO sidebar toggle button to click.');
      return false;
    }
    button.click();
    log('Opened the Yoast SEO sidebar panel.');
    return true;
  };

  const openYoastSnippet = () => {
    // Do not click the toggle once the snippet editor exists; clicking it again
    // closes the fields before they can receive the values.
    if (document.querySelector('#yoast_wpseo_title, #yoast_wpseo_metadesc, input[name="yoast_wpseo_title"], textarea[name="yoast_wpseo_metadesc"]') ||
      fieldsForLabel('SEO title').length || fieldsForLabel('Meta description').length) {
      return false;
    }
    openYoastSidebar();
    const visibleButtons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(button => {
        const label = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`
          .replace(/\s+/g, ' ').trim().toLowerCase();
        return /edit (the )?(snippet|google preview)|snippet (editor|preview)/.test(label);
      });
    const button = visibleButtons.find(item => item.offsetParent !== null);
    if (!button) {
      log('No visible "Edit snippet" button found (Yoast panel may still be closed/loading).');
      return false;
    }
    button.click();
    log('Clicked "Edit snippet" to reveal the SEO title/description fields.');
    return true;
  };

  const syncYoast = async () => {
    let storeWritten = false;
    let fieldWritten = false;

    // Yoast mounts asynchronously and can replace its hidden fields after the
    // post is edited. Reapply the values while it finishes mounting so Yoast's
    // own state, visible snippet editor, and saved hidden fields agree.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      openYoastSnippet();
      storeWritten = updateYoastStore() || storeWritten;
      fieldWritten = writeYoastFields() || fieldWritten;
      if (attempt < 14) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    log(`Yoast sync finished. store written: ${storeWritten}, DOM fields written: ${fieldWritten}.`);
    return { storeWritten, fieldWritten };
  };

  const ensureAuthorBoxVisible = () => {
    // If "Author" is unchecked in Screen Options, WordPress never renders
    // the #authordiv meta box at all, so #post_author_override below won't
    // exist and author auto-selection silently no-ops. Check it ourselves
    // (via a real click, so WordPress's own screen-options.js toggles the
    // box and saves the preference, same as a user clicking it) before
    // looking for the author field.
    const toggle = document.querySelector('#authordiv-hide, input.hide-postbox-tog[value="authordiv"]');
    if (toggle && !toggle.checked) toggle.click();
  };

  const domainAuthor = async () => {
    const domainName = window.location.hostname.replace(/^www\./i, '').split('.')[0].toLowerCase();
    if (!domainName || !window.wp?.apiFetch) return null;
    try {
      // Don't pre-filter with a WP search query: for a compound domain name
      // like "mcdonaldchevymarlette" it's unlikely any single user's name
      // contains that whole string, so the search param can come back empty
      // even when a good partial match exists. Fetch the user list and do
      // the matching ourselves instead.
      const users = await window.wp.apiFetch({
        path: `/wp/v2/users?per_page=100&context=edit`
      });
      const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const domainNormalized = normalize(domainName);

      // Longest run of characters the two strings share, checked in both
      // directions (domain containing the name, or name containing the
      // domain) so "mcdonald" matches inside "mcdonaldchevymarlette" and
      // vice versa.
      const overlapLength = candidate => {
        if (!candidate) return 0;
        if (domainNormalized.includes(candidate) || candidate.includes(domainNormalized)) {
          return Math.min(candidate.length, domainNormalized.length);
        }
        let best = 0;
        for (let start = 0; start < candidate.length; start += 1) {
          for (let end = candidate.length; end > start; end -= 1) {
            const chunk = candidate.slice(start, end);
            if (chunk.length > best && domainNormalized.includes(chunk)) {
              best = chunk.length;
              break;
            }
          }
        }
        return best;
      };

      const scored = users
        .map(user => {
          const candidates = [user.slug, user.name, user.nickname, user.username].map(normalize);
          const bestOverlap = Math.max(0, ...candidates.map(overlapLength));
          return { user, bestOverlap };
        })
        // Require a real chunk of overlap (4+ characters) so short, generic
        // names like "admin" don't count as a match by accident.
        .filter(entry => entry.bestOverlap >= 4)
        .sort((a, b) => b.bestOverlap - a.bestOverlap);

      if (!scored.length) {
        log(`No WordPress user's name resembles the domain "${domainName}" closely enough to auto-select an author.`);
        return null;
      }
      log(`Matched author "${scored[0].user.name}" to domain "${domainName}" (overlap: ${scored[0].bestOverlap} chars).`);
      return scored[0].user;
    } catch (error) {
      log('Could not fetch/match WordPress users for author selection:', error.message);
      return null;
    }
  };

  // Featured image: the image was already uploaded to the media library, so it only has to be SET (no second upload).
  // Classic editor ("Featured image" box, #postimagediv) -> wp.media.featuredImage.set(id) does what the
  // "Set featured image -> choose image" clicks do; if that is not available, write the hidden #_thumbnail_id field.
  const setClassicFeatured = async (id, url) => {
    const want = String(id);
    try {
      if (window.wp?.media?.featuredImage?.set) {
        window.wp.media.featuredImage.set(id);
        for (let attempt = 0; attempt < 24; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 250));
          if (document.querySelector('#_thumbnail_id')?.value === want) { log('Featured image set through wp.media.featuredImage.'); return true; }
        }
      }
    } catch (error) { log('wp.media.featuredImage.set failed:', error.message); }
    const input = document.querySelector('#_thumbnail_id');
    if (!input) return false;
    input.value = want;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const box = document.querySelector('#postimagediv .inside');
    if (box && url && !box.querySelector('img')) box.insertAdjacentHTML('afterbegin', `<p><img src="${url}" style="max-width:100%;height:auto" alt=""></p>`);
    log('Featured image written to the hidden _thumbnail_id field (it is saved with the post).');
    return true;
  };

  const waitForEditor = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (window.wp?.data?.dispatch?.('core/editor') || document.querySelector('#title, #content')) return true;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  };

  if (!await waitForEditor()) {
    throw new Error('No supported WordPress editor finished loading. Make sure you are signed in, then try again.');
  }

  if (!window.wp?.data?.dispatch?.('core/editor')) {
    if (document.body.classList.contains('post-type-page')) {
      throw new Error('Safety check stopped this action: pages cannot be filled by this extension.');
    }
    setYoastField('#title', draft.title || '');
    setYoastField('#post_name', draft.slug || '');
    setYoastField('#excerpt', draft.metaDescription || '');
    // Yoast's Classic Editor metabox (v14+) renders the same React snippet
    // editor as Gutenberg does, and mounts just as asynchronously — a single
    // writeYoastFields() call right after page load was too early/fragile.
    // Reuse the same retrying store+DOM sync the Gutenberg path uses.
    const author = await domainAuthor();
    ensureAuthorBoxVisible();
    await new Promise(resolve => setTimeout(resolve, 200)); // let the now-visible #authordiv box mount
    const authorSelect = document.querySelector('#post_author_override');
    if (author && authorSelect) {
      authorSelect.value = String(author.id);
      authorSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (window.tinymce?.get('content')) {
      window.tinymce.get('content').setContent(draft.content || '');
      window.tinymce.get('content').fire('change');
    } else {
      setYoastField('#content', draft.content || '');
    }
    if (draft.categoryIds && draft.categoryIds.length) {
      const want = draft.categoryIds.map(String);
      document.querySelectorAll('#categorychecklist input[type="checkbox"]').forEach(box => {
        const on = want.includes(String(box.value));
        if (box.checked !== on) { box.checked = on; box.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    }
    const classicFeatured = draft.featuredMediaId ? await setClassicFeatured(draft.featuredMediaId, draft.featuredMediaUrl) : false;
    const classicYoastSync = await syncYoast();
    let classicSaved = false;
    if (autoSaveDraft) {
      const saveButton = document.querySelector('#save-post');
      if (saveButton) {
        log('Auto-saving via the Classic Editor "Save Draft" button.');
        saveButton.click();
        classicSaved = true;
      } else {
        log('Could not find the Classic Editor "Save Draft" button (#save-post) to auto-save.');
      }
    }
    const classicPostId = Number(document.querySelector('#post_ID')?.value || new URL(location.href).searchParams.get('post') || 0);
    return {
      filled: true,
      editor: 'Classic',
      featured: classicFeatured,
      yoast: classicYoastSync.storeWritten || classicYoastSync.fieldWritten,
      author: author?.slug || '',
      saved: classicSaved,
      postId: classicPostId,
      previewUrl: classicPostId ? `${location.origin}/?p=${classicPostId}&preview=true` : ''
    };
  }

  const waitForYoastEditor = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (window.wp?.data?.dispatch?.('yoast-seo/editor')) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    log('Gave up waiting for the yoast-seo/editor store after 25s — is Yoast SEO active on this site?');
    return false;
  };

  // This uses WordPress’s own editor store, so Gutenberg treats the values as
  // real edits and enables its normal “Save draft” button.
  const postType = window.wp.data.select('core/editor')?.getCurrentPostType?.();
  if (postType && postType !== 'post') {
    throw new Error('Safety check stopped this action: only blog posts can be filled.');
  }
  const editorStore = window.wp.data.select('core/editor');
  const existingMeta = editorStore?.getEditedPostAttribute?.('meta') || {};
  const yoastMeta = {
    ...(draft.metaTitle || draft.title
      ? { _yoast_wpseo_title: draft.metaTitle || draft.title }
      : {}),
    ...(draft.metaDescription
      ? { _yoast_wpseo_metadesc: draft.metaDescription }
      : {})
  };
  const author = await domainAuthor();
  // Set Yoast's own state before Gutenberg updates its post meta. This prevents
  // Yoast from subsequently syncing an empty snippet back over our values.
  const yoastReady = await waitForYoastEditor();
  const yoastStoreInitiallyWritten = yoastReady && updateYoastStore();
  window.wp.data.dispatch('core/editor').editPost({
    title: draft.title || '',
    content: draft.content || '',
    slug: draft.slug || '',
    excerpt: draft.metaDescription || '',
    meta: { ...existingMeta, ...yoastMeta },
    ...(draft.categoryIds && draft.categoryIds.length ? { categories: draft.categoryIds } : {}),
    ...(draft.featuredMediaId ? { featured_media: draft.featuredMediaId } : {}),
    ...(author?.id ? { author: author.id } : {})
  });

  // Recent Yoast versions keep the snippet editor in their own data store.
  // Updating only WordPress's `core/editor` meta can be overwritten by Yoast
  // when the draft is saved, so update Yoast's active editor state as well.
  const yoastSync = await syncYoast();

  let gutenbergSaved = false;
  if (autoSaveDraft) {
    const editorDispatch = window.wp.data.dispatch('core/editor');
    if (editorDispatch?.savePost) {
      log('Auto-saving via wp.data.dispatch("core/editor").savePost() — the same action the "Save Draft" button triggers.');
      editorDispatch.savePost();
      // savePost() only kicks the save off; poll isSavingPost so the status
      // message reflects a save that actually completed, not just started.
      const isSaving = () => window.wp.data.select('core/editor')?.isSavingPost?.();
      for (let attempt = 0; attempt < 20 && !isSaving(); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      for (let attempt = 0; attempt < 30 && isSaving(); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      gutenbergSaved = !window.wp.data.select('core/editor')?.isEditedPostDirty?.();
      log(gutenbergSaved ? 'Draft saved successfully.' : 'savePost() ran, but the post still shows unsaved changes — check the editor.');
    } else {
      log('core/editor savePost action not found — could not auto-save.');
    }
  }

  const currentEditor = window.wp.data.select('core/editor');
  const gutenbergPostId = Number(currentEditor?.getCurrentPostId?.() || currentEditor?.getEditedPostAttribute?.('id') || 0);
  const gutenbergLink = currentEditor?.getEditedPostAttribute?.('link') || '';
  const previewUrl = gutenbergLink ? `${gutenbergLink}${gutenbergLink.includes('?') ? '&' : '?'}preview=true` : (gutenbergPostId ? `${location.origin}/?p=${gutenbergPostId}&preview=true` : '');
  return {
    filled: true,
    editor: 'Gutenberg',
    featured: !draft.featuredMediaId ? false : Number(window.wp.data.select('core/editor')?.getEditedPostAttribute?.('featured_media')) === Number(draft.featuredMediaId),
    yoast: yoastStoreInitiallyWritten || yoastSync.storeWritten || yoastSync.fieldWritten,
    author: author?.slug || '',
    saved: gutenbergSaved,
    postId: gutenbergPostId,
    previewUrl
  };
}

/* ------------------------------------------------------------------ */
/*  Safety net: if the WordPress tab this extension itself opened gets */
/*  closed before the fill listener above reaches its own              */
/*  storage.local.remove(TARGET_TAB_KEY) call, clear the tab-tracking   */
/*  keys here so a *different*, unrelated tab that happens to get       */
/*  assigned the same numeric id later is never mistaken for the fill   */
/*  target. Ignores every tab close except the one this run is          */
/*  actually tracking.                                                  */
/* ------------------------------------------------------------------ */
chrome.tabs.onRemoved.addListener(async tabId => {
  const stored = await chrome.storage.local.get(TARGET_TAB_KEY);
  if (stored[TARGET_TAB_KEY] !== tabId) return;
  await chrome.storage.local.remove([TARGET_TAB_KEY, AUTO_SAVE_KEY]);
});
