import { verifyButtonUrls } from './bulk/pipeline.js';

const empty = document.querySelector('#blog-empty');
const draftCard = document.querySelector('#draft');
const status = document.querySelector('#status');
const fillButton = document.querySelector('#fill');
const fields = document.querySelector('#fields');
const blogButtonReview = document.querySelector('#blog-button-review');
const blogButtonCode = document.querySelector('#blog-button-code');
const blogButtonSummary = document.querySelector('#blog-button-summary');
const blogButtonResults = document.querySelector('#blog-button-results');
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
  blogButtonCode.value = buttonCode;
  blogButtonReview.hidden = !buttonCode.trim();
  blogButtonSummary.textContent = buttonCode.trim() ? 'Checking URLs…' : 'No CTA buttons in this Doc.';
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
  if (buttonCode.trim()) {
    try {
      const checks = await verifyButtonUrls(buttonCode, draft.adminUrl || adminUrl.value || '');
      blogButtonResults.replaceChildren(...checks.map((check, i) => {
        const li = document.createElement('li');
        li.className = check.ok ? 'ok' : check.level === 'error' ? 'error' : 'warn';
        li.textContent = `${i + 1}. ${check.ok ? '✓' : check.level === 'error' ? '✕' : '!'} ${check.name.replace(/^Button URL — /, '')} — ${check.detail || (check.ok ? 'working' : 'needs attention')}`;
        return li;
      }));
      const broken = checks.filter(check => !check.ok && check.level === 'error').length;
      blogButtonSummary.textContent = broken ? `${broken} broken URL${broken === 1 ? '' : 's'} — expand to review` : checks.length ? 'URLs checked — expand to review' : 'No CTA URLs to check.';
      blogButtonSummary.className = broken ? 'error' : checks.length ? 'success' : '';
    } catch (err) {
      blogButtonSummary.textContent = `Could not check CTA URLs: ${err.message}`;
      blogButtonSummary.className = 'warn';
    }
  }
  if (fillStatus?.message) {
    status.textContent = fillStatus.message;
    status.className = fillStatus.ok ? 'success' : 'error';
  }
  fillButton.disabled = Boolean(fillStatus?.filled);
}

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

fillButton.addEventListener('click', () => {
  fillButton.disabled = true;
  status.textContent = 'Opening WordPress…';
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
