import { normalizeButtonMarkup, verifyButtonUrls, fetchWebsitePages, chooseBlogHubPage, addBlogHubButton } from './bulk/pipeline.js';

const empty = document.querySelector('#blog-empty');
const draftCard = document.querySelector('#draft');
const status = document.querySelector('#status');
const fillButton = document.querySelector('#fill');
const fields = document.querySelector('#fields');
const blogButtonReview = document.querySelector('#blog-button-review');
const blogButtonCode = document.querySelector('#blog-button-code');
const blogButtonSummary = document.querySelector('#blog-button-summary');
const blogButtonResults = document.querySelector('#blog-button-results');
const blogButtonPreview = document.querySelector('#blog-button-preview');
const blogButtonCheck = document.querySelector('#blog-button-check');
const blogHubPage = document.querySelector('#blog-hub-page');
const blogHubAdd = document.querySelector('#blog-hub-add');
const blogHubStatus = document.querySelector('#blog-hub-status');
const documentUrl = document.querySelector('#document-url');
const adminUrl = document.querySelector('#blog-admin-url');
const importButton = document.querySelector('#import');
const importStatus = document.querySelector('#blog-import-status');
const saveAdminButton = document.querySelector('#blog-save-admin');
const clearButton = document.querySelector('#blog-clear');
const autoSaveDraft = document.querySelector('#auto-save-draft');
const contentSelection = document.querySelector('#blog-content-selection');
const contentSelectionItems = document.querySelector('#blog-content-selection-items');
let importedContentBlocks = [];
let activeBlogCtaDraft = null;
let blogCtaCheckId = 0;
let blogCtaSaveTimer = 0;
let blogCtaCheckTimer = 0;
let pendingBlogCtaSave = Promise.resolve(true);
let resolvePendingBlogCtaSave = null;
let blogHubPages = [];
let blogHubLoadPromise = Promise.resolve();
const importedFields = [
  ['Meta title', 'metaTitle'],
  ['Meta description', 'metaDescription'],
  ['Keywords', 'keyword'],
  ['Category', 'category'],
  ['Tags', 'tags'],
  ['Author', 'author'],
  ['Alt text', 'altText'],
  ['Image shortcode', 'imageShortcode'],
  ['CTA buttons', 'buttons']
];

async function showDraft(draft, fillStatus) {
  if (!draft) return;
  empty.hidden = true;
  draftCard.hidden = false;
  document.querySelector('#title').textContent = draft.title || 'Untitled post';
  document.querySelector('#slug').textContent = draft.slug || 'WordPress will generate a slug';
  document.querySelector('#target').textContent = draft.adminUrl || 'No target set';
  const buttonCode = draft.buttons || '';
  activeBlogCtaDraft = draft;
  blogButtonCode.value = buttonCode;
  blogButtonReview.hidden = false;
  renderBlogButtonPreview(buttonCode, draft.adminUrl || adminUrl.value || '');
  blogButtonSummary.textContent = buttonCode.trim() ? 'Ready to check URLs' : 'No CTA buttons found in this Doc.';
  blogButtonSummary.className = buttonCode.trim() ? '' : 'warn';
  blogButtonResults.replaceChildren();
  fields.replaceChildren(...importedFields.map(([label, key]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const value = document.createElement('dd');
    term.textContent = label;
    value.textContent = draft[key] || 'Not included in this document';
    row.append(term, value);
    return row;
  }));
  document.querySelector('#content').textContent = draft.content || 'Not included in this document';
  renderContentSelection(draft.content || '');
  window.__diBlogSave = saveSelectedContent;
  document.dispatchEvent(new CustomEvent('di:blog-imported', { detail: { bodyHtml: draft.content || '', adminUrl: draft.adminUrl || '' } }));
  if (buttonCode.trim()) checkBlogButtonUrls();
  blogHubLoadPromise = loadBlogHubPages(draft.adminUrl || adminUrl.value || '', true);
  if (fillStatus?.message) {
    status.textContent = fillStatus.message;
    status.className = fillStatus.ok ? 'success' : 'error';
  }
  fillButton.disabled = Boolean(fillStatus?.filled);
}

async function loadBlogHubPages(siteAdminUrl, autoAdd = false) {
  if (!siteAdminUrl) {
    blogHubStatus.textContent = 'Enter the WordPress Admin URL to load this site’s Hub page.';
    blogHubAdd.disabled = true;
    return;
  }
  blogHubPage.replaceChildren();
  const loading = document.createElement('option'); loading.value = ''; loading.textContent = 'Loading Hub pages…'; blogHubPage.append(loading);
  blogHubAdd.disabled = true;
  blogHubStatus.textContent = 'Reading published pages from WordPress…';
  try { blogHubPages = await fetchWebsitePages(siteAdminUrl); }
  catch (error) { blogHubPages = []; blogHubStatus.textContent = `Could not load WordPress pages: ${error.message}`; }
  const hubs = blogHubPages.filter(page => /research|hub|manufacturer information/i.test(`${page.title} ${page.slug}`));
  const choices = hubs.length ? hubs : blogHubPages;
  blogHubPage.replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = choices.length ? 'Choose a Hub page…' : 'No WordPress pages found'; blogHubPage.append(placeholder);
  choices.forEach(page => {
    const option = document.createElement('option'); option.value = String(page.id); option.textContent = page.title; blogHubPage.append(option);
  });
  const preferred = chooseBlogHubPage(choices);
  if (choices.length) {
    if (preferred) { blogHubPage.value = String(preferred.id); blogHubAdd.disabled = false; }
    blogHubStatus.textContent = preferred ? `${preferred.title} found. It is added to the Blog as a Landing-style button.` : 'Choose the correct Hub page from the site page list.';
    if (autoAdd && preferred) {
      const updated = addBlogHubButton(blogButtonCode.value, preferred);
      if (updated !== blogButtonCode.value) {
        blogButtonCode.value = updated;
        blogButtonCode.dispatchEvent(new Event('input', { bubbles: true }));
        blogHubStatus.textContent = `Added ${preferred.title} automatically as a primary button.`;
      } else blogHubStatus.textContent = `${preferred.title} Hub button is already included.`;
    }
  } else {
    blogHubStatus.textContent = 'No WordPress pages came back. Check the admin URL/login, then use Reload Hub pages.';
  }
}

blogHubPage.addEventListener('change', () => { blogHubAdd.disabled = !blogHubPage.value; });
blogHubAdd.addEventListener('click', () => {
  const page = blogHubPages.find(item => String(item.id) === blogHubPage.value);
  if (!page?.link) { blogHubStatus.textContent = 'This page has no published URL yet.'; return; }
  const updated = addBlogHubButton(blogButtonCode.value, page);
  if (updated === blogButtonCode.value) { blogHubStatus.textContent = `${page.title} Hub button is already included.`; return; }
  blogButtonCode.value = updated;
  blogButtonCode.dispatchEvent(new Event('input', { bubbles: true }));
  blogHubStatus.textContent = `Added “${page.title}” using the Landing page button format.`;
});
document.querySelector('#blog-hub-reload')?.addEventListener('click', () => loadBlogHubPages(activeBlogCtaDraft?.adminUrl || adminUrl.value || '', false));

function renderBlogButtonPreview(markup, baseUrl) {
  const decoded = normalizeButtonMarkup(markup || '');
  const parsed = new DOMParser().parseFromString(decoded, 'text/html');
  let links = [...parsed.querySelectorAll('a.button, a.primary-button, a[class*="button"]')];
  if (!links.length) links = [...parsed.querySelectorAll('a[href]')];
  blogButtonPreview.replaceChildren();
  if (!links.length) {
    const note = document.createElement('span');
    note.className = 'blog-cta-empty';
    note.textContent = markup?.trim() ? 'Could not find a button link to preview.' : 'No buttons in the imported Google Doc.';
    blogButtonPreview.append(note);
    return;
  }
  let origin = '';
  try { origin = new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`).origin; } catch { /* preview labels still render without a site URL */ }
  links.forEach((link, index) => {
    const label = (link.textContent || '').replace(/\s+/g, ' ').trim() || `Button ${index + 1}`;
    const href = (link.getAttribute('href') || '').trim();
    const chip = document.createElement('span');
    chip.className = 'blog-cta-preview-button';
    chip.textContent = label;
    let destination = href;
    try { if (href && origin) destination = new URL(href, origin).href; } catch { /* keep the raw href visible */ }
    chip.title = href ? `Destination: ${destination}` : 'No destination URL';
    blogButtonPreview.append(chip);
  });
}

async function checkBlogButtonUrls() {
  const checkId = ++blogCtaCheckId;
  const code = blogButtonCode.value.trim();
  const baseUrl = activeBlogCtaDraft?.adminUrl || adminUrl.value || '';
  renderBlogButtonPreview(code, baseUrl);
  blogButtonResults.replaceChildren();
  if (!code) {
    blogButtonSummary.textContent = 'No CTA buttons found in this Doc.';
    blogButtonSummary.className = 'warn';
    return;
  }
  blogButtonCheck.disabled = true;
  blogButtonSummary.textContent = 'Checking button URLs…';
  blogButtonSummary.className = '';
  const pending = document.createElement('li');
  pending.className = 'warn';
  pending.textContent = 'Checking each destination against the website…';
  blogButtonResults.append(pending);
  try {
    const checks = await verifyButtonUrls(code, baseUrl);
    if (checkId !== blogCtaCheckId) return;
    blogButtonResults.replaceChildren(...checks.map((check, i) => {
      const li = document.createElement('li');
      li.className = check.ok ? 'ok' : check.level === 'error' ? 'error' : 'warn';
      li.textContent = `${i + 1}. ${check.ok ? '✓' : check.level === 'error' ? '✕' : '!'} ${check.name.replace(/^Button URL — /, '')} — ${check.detail || (check.ok ? 'working' : 'needs attention')}`;
      return li;
    }));
    const broken = checks.filter(check => !check.ok && check.level === 'error').length;
    const warning = checks.filter(check => !check.ok && check.level !== 'error').length;
    blogButtonSummary.textContent = broken ? `${broken} URL${broken === 1 ? '' : 's'} need attention` : warning ? `${warning} URL${warning === 1 ? '' : 's'} could not be confirmed` : checks.length ? `${checks.length} URL${checks.length === 1 ? '' : 's'} checked · working` : 'No CTA URLs to check.';
    blogButtonSummary.className = broken ? 'error' : warning ? 'warn' : checks.length ? 'success' : '';
    if (!checks.length) {
      const li = document.createElement('li'); li.className = 'warn'; li.textContent = 'No href URLs were found to check.'; blogButtonResults.append(li);
    }
  } catch (err) {
    if (checkId !== blogCtaCheckId) return;
    blogButtonSummary.textContent = `Could not check CTA URLs: ${err.message}`;
    blogButtonSummary.className = 'warn';
    const li = document.createElement('li'); li.className = 'warn'; li.textContent = err.message || 'The check failed.'; blogButtonResults.replaceChildren(li);
  } finally {
    if (checkId === blogCtaCheckId) blogButtonCheck.disabled = false;
  }
}

blogButtonCheck.addEventListener('click', checkBlogButtonUrls);
blogButtonCode.addEventListener('input', () => {
  const code = blogButtonCode.value;
  renderBlogButtonPreview(code, activeBlogCtaDraft?.adminUrl || adminUrl.value || '');
  blogButtonSummary.textContent = 'Saving CTA changes…';
  blogButtonSummary.className = '';
  clearTimeout(blogCtaSaveTimer);
  clearTimeout(blogCtaCheckTimer);
  if (resolvePendingBlogCtaSave) resolvePendingBlogCtaSave(false);
  pendingBlogCtaSave = new Promise(resolve => { resolvePendingBlogCtaSave = resolve; });
  blogCtaSaveTimer = setTimeout(() => {
    const resolveSave = resolvePendingBlogCtaSave;
    resolvePendingBlogCtaSave = null;
    chrome.runtime.sendMessage({ type: 'UPDATE_PENDING_DRAFT_BUTTONS', buttons: code }, response => {
      if (!response?.ok) {
        blogButtonSummary.textContent = response?.error || 'Could not save CTA changes.';
        blogButtonSummary.className = 'error';
        resolveSave?.(false);
        return;
      }
      if (activeBlogCtaDraft) {
        activeBlogCtaDraft.buttons = code;
        activeBlogCtaDraft.content = response.content || activeBlogCtaDraft.content;
      }
      blogButtonSummary.textContent = code.trim() ? 'CTA changes saved · checking URLs…' : 'CTA changes saved · no buttons';
      blogButtonSummary.className = code.trim() ? '' : 'warn';
      resolveSave?.(true);
    });
  }, 300);
  blogCtaCheckTimer = setTimeout(checkBlogButtonUrls, 500);
});

function splitContentBlocks(html) {
  const root = new DOMParser().parseFromString(`<div id="content-root">${html || ''}</div>`, 'text/html')
    .querySelector('#content-root');
  return [...root.children].map(node => node.outerHTML.trim()).filter(Boolean);
}

function saveSelectedContent() {
  const content = [...contentSelectionItems.querySelectorAll('input[type="checkbox"]')]
    .filter(input => input.checked)
    .map(input => importedContentBlocks[Number(input.dataset.index)])
    .filter(Boolean)
    .join('\n\n');
  const withLinks = typeof window.__diBlogTransform === 'function' ? window.__diBlogTransform(content) : content;   // internal links (links/il_popup.js)
  document.querySelector('#content').textContent = withLinks || 'No content sections selected.';
  chrome.runtime.sendMessage({ type: 'UPDATE_PENDING_DRAFT_CONTENT', content: withLinks }, response => {
    if (!response?.ok) {
      status.textContent = response?.error || 'Could not update the selected content.';
      status.className = 'error';
    }
  });
}

function renderContentSelection(content) {
  importedContentBlocks = splitContentBlocks(content);
  contentSelectionItems.replaceChildren();
  if (!importedContentBlocks.length) {
    contentSelection.hidden = true;
    return;
  }
  importedContentBlocks.forEach((block, index) => {
    const label = document.createElement('label');
    label.className = 'content-selection-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.index = String(index);
    checkbox.addEventListener('change', saveSelectedContent);
    const preview = document.createElement('div');
    preview.className = 'content-selection-preview';
    // Render the cleaned imported HTML as a visual document preview; the
    // selected blocks are exactly the blocks that go to WordPress.
    preview.innerHTML = block;
    label.append(checkbox, preview);
    contentSelectionItems.appendChild(label);
  });
  contentSelection.hidden = false;
}

chrome.runtime.sendMessage({ type: 'GET_PENDING_DRAFT' }, response => {
  if (response?.ok) showDraft(response.draft, response.status);
});

chrome.storage.local.get(['wordPressAdminUrl', 'hubAdminUrl']).then(stored => {
  adminUrl.value = stored.wordPressAdminUrl || stored.hubAdminUrl || '';
});

importButton.addEventListener('click', () => {
  importButton.disabled = true;
  importStatus.textContent = 'Importing Google Doc…';
  importStatus.className = '';
  chrome.runtime.sendMessage({
    type: 'IMPORT_GOOGLE_DOC',
    documentUrl: documentUrl.value.trim(),
    adminUrl: adminUrl.value.trim(),
    landingBottom: document.querySelector('#landing-bottom')?.value || 'blog'
  }, response => {
    importButton.disabled = false;
    if (!response?.ok) {
      importStatus.textContent = response?.error || 'Could not import the document.';
      importStatus.className = 'error';
      return;
    }
    const skippedLines = Array.isArray(response.draft?.skipped) ? response.draft.skipped : [];
    importStatus.textContent = 'Draft queued. Click Open & fill WordPress below.' + (skippedLines.length
      ? ` ⚠ NOT copied into the post: ${skippedLines.map(s => `“${s.text}” (${s.why})`).join(' · ')} — add by hand if it is real content.` : '');
    importStatus.className = 'success';
    showDraft(response.draft);
  });
});

saveAdminButton.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SAVE_WORDPRESS_ADMIN_URL', adminUrl: adminUrl.value.trim() }, response => {
    importStatus.textContent = response?.ok ? 'WordPress URL saved.' : response?.error || 'Could not save the WordPress URL.';
    importStatus.className = response?.ok ? 'success' : 'error';
  });
});

clearButton.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_DRAFT' }, response => {
    if (!response?.ok) {
      status.textContent = response?.error || 'Could not clear the draft.';
      status.className = 'error';
      return;
    }
    draftCard.hidden = true;
    empty.hidden = false;
    fillButton.disabled = false;
    status.textContent = '';
  });
});

fillButton.addEventListener('click', async () => {
  fillButton.disabled = true;
  status.textContent = 'Saving the latest Blog and Hub button, then opening WordPress…';
  await blogHubLoadPromise;
  clearTimeout(blogCtaSaveTimer);
  const ctaSaved = await pendingBlogCtaSave;
  if (!ctaSaved) {
    status.textContent = 'The latest CTA could not be saved. Check the button status, then try again.';
    fillButton.disabled = false;
    return;
  }
  chrome.runtime.sendMessage({ type: 'OPEN_PENDING_DRAFT', autoSaveDraft: autoSaveDraft.checked }, response => {
    if (response?.ok) {
      status.textContent = autoSaveDraft.checked
        ? 'WordPress opened. The editor will be filled and saved as a draft after it loads.'
        : 'WordPress opened. The editor will be filled after it loads.';
      return;
    }
    status.textContent = response?.error || 'Could not open WordPress.';
    fillButton.disabled = false;
  });
});
