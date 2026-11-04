/* global generateHub */

/* ── DOM refs ── */
const hubType = document.querySelector('#hub-type');
const brandName = document.querySelector('#brand-name');
const adminUrl = document.querySelector('#admin-url');
const serviceSpecialsUrl = document.querySelector('#service-specials-url');
const partsSpecialsUrl = document.querySelector('#parts-specials-url');
const hubResearchUrl = document.querySelector('#hub-research-url');
const hubFinanceUrl = document.querySelector('#hub-finance-url');
const hubServiceUrl = document.querySelector('#hub-service-url');
const researchNewVehiclesUrl = document.querySelector('#research-new-vehicles-url');
const contactUsUrl = document.querySelector('#contact-us-url');
const financePageUrl = document.querySelector('#finance-page-url');
const generateBtn = document.querySelector('#generate');
const saveAdminBtn = document.querySelector('#save-admin');
const formStatus = document.querySelector('#form-status');

const comparisonDocUrl = document.querySelector('#comparison-doc-url');
const comparisonButtonCode = document.querySelector('#comparison-button-code');
const comparisonButtonStatus = document.querySelector('#comparison-button-status');
const comparisonButtonResults = document.querySelector('#comparison-button-results');
const importDocBtn = document.querySelector('#import-doc');
const importStatus = document.querySelector('#import-status');
const comparisonPageTitle = document.querySelector('#comparison-page-title');
const comparisonPageSlug = document.querySelector('#comparison-page-slug');
const comparisonMetaTitle = document.querySelector('#comparison-meta-title');
const comparisonMetaDescription = document.querySelector('#comparison-meta-description');
const comparisonLearnMoreUrl = document.querySelector('#comparison-learn-more-url') || { value: '' };   // field removed from the popup — stays empty
const comparisonInventoryUrl = document.querySelector('#comparison-inventory-url') || { value: '' };   // field removed from the popup — stays empty
const comparisonVehicleName = document.querySelector('#comparison-vehicle-name') || { value: '' };   // field removed from the popup — stays empty
const comparisonCtaBody = document.querySelector('#comparison-cta-body');
const landingParent = document.querySelector('#landing-parent');
const landingParentCustom = document.querySelector('#landing-parent-custom');
const landingBottom = document.querySelector('#landing-bottom');
const group1Ticket = document.querySelector('#sf-group1');
group1Ticket?.addEventListener('change', () => { if (group1Ticket.checked) landingBottom.value = 'form'; });
let vrpPageMode = window.__vrpPageMode || { active: false };
const getVrpMode = () => window.__vrpPageMode || vrpPageMode;
const vrpModePanel = document.querySelector('#vrp-mode-panel');
const vrpAction = document.querySelector('#vrp-page-action');
const vrpNewButton = document.querySelector('#vrp-new-btn');
const vrpExistingButton = document.querySelector('#vrp-existing-btn');
const vrpExistingPicker = document.querySelector('#vrp-existing-page-picker');
const vrpPageSearch = document.querySelector('#vrp-page-search');
const vrpSitemapUrl = document.querySelector('#vrp-sitemap-url');
const vrpManualPageUrl = document.querySelector('#vrp-manual-page-url');
const vrpManualPageButton = document.querySelector('#vrp-manual-page-btn');
const vrpPageSearchButton = document.querySelector('#vrp-page-search-btn');
const vrpPageSuggestions = document.querySelector('#vrp-page-suggestions');
const vrpSelectedPage = document.querySelector('#vrp-selected-page');
const vrpPageSearchStatus = document.querySelector('#vrp-page-search-status');
const vrpPageType = document.querySelector('#landing-page-type');
const vrpActive = () => publishingType.value === 'vrp';   // only the dropdown decides, so an old saved VRP mode can never turn a Landing / Comparison page into a Lightning page
const storeVrpMode = patch => {
  const next = { ...getVrpMode(), ...patch };
  window.__vrpPageMode = vrpPageMode = next;
  chrome.storage.session.set({ vrpPageMode: next });
  return next;
};
function paintVrpAction() {
  const existing = vrpAction.value === 'existing';
  vrpNewButton.classList.toggle('is-selected', !existing);
  vrpNewButton.setAttribute('aria-pressed', String(!existing));
  vrpExistingButton.classList.toggle('is-selected', existing);
  vrpExistingButton.setAttribute('aria-pressed', String(existing));
  vrpExistingPicker.hidden = !vrpActive() || !existing;
}
function applyVrpVisibility() {
  const active = vrpActive();
  const existing = active && vrpAction.value === 'existing';
  if (vrpModePanel) vrpModePanel.hidden = !active;
  const titleField = comparisonPageTitle.closest('.field-group');
  const slugField = comparisonPageSlug.closest('.field-group');
  const parentField = landingParent.closest('.field-group');
  const pageTypeField = vrpPageType.closest('.field-group');
  const landingOption = publishingType.querySelector('option[value="landing"]');
  const parentContext = document.querySelector('#landing-parent-context');
  const regularLanding = ['landing', 'comparison'].includes(publishingType.value);
  const contentHint = document.querySelector('#content-html-hint');
  if (titleField) titleField.hidden = existing || !(regularLanding || publishingType.value === 'vrp');
  if (slugField) slugField.hidden = existing || !(regularLanding || publishingType.value === 'vrp');
  if (parentField) parentField.hidden = existing || !(regularLanding || publishingType.value === 'vrp');
  if (pageTypeField) pageTypeField.hidden = active || publishingType.value !== 'landing';
  if (landingOption) landingOption.hidden = false;
  if (parentContext) parentContext.textContent = active ? '(auto-picked from the ticket subject)' : '(Page Attributes → Parent)';
  if (contentHint) contentHint.textContent = active
    ? 'VRP: title starts as H2; no custom buttons are added.'
    : 'cleaned from the Google Doc';
  const imageBox = document.querySelector('#landing-image-box');
  const bottomRow = landingBottom.closest('.field-group');
  const linkCard = document.querySelector('#hub-link-card');
  if (imageBox) imageBox.hidden = active || !regularLanding;
  if (bottomRow) bottomRow.hidden = active || !['landing', 'comparison', 'blog'].includes(publishingType.value);
  if (linkCard) linkCard.hidden = active || !regularLanding;
  paintVrpAction();
}
chrome.storage.session.get('vrpPageMode').then(stored => {
  vrpPageMode = window.__vrpPageMode || stored.vrpPageMode || { active: false };
  if (vrpAction && vrpPageMode.pageAction) vrpAction.value = vrpPageMode.pageAction;
  if (vrpPageSearch && vrpPageMode.pageQuery) vrpPageSearch.value = vrpPageMode.pageQuery;
  if (vrpSitemapUrl && vrpPageMode.sitemapUrl) vrpSitemapUrl.value = vrpPageMode.sitemapUrl;
  if (vrpManualPageUrl && vrpPageMode.manualPageUrl) vrpManualPageUrl.value = vrpPageMode.manualPageUrl;
  if (vrpSelectedPage && vrpPageMode.selectedPageUrl) vrpSelectedPage.textContent = `Selected: ${vrpPageMode.selectedPageTitle || vrpPageMode.selectedPageUrl}`;
  applyVrpVisibility();
});
function chooseVrpAction(action) {
  vrpAction.value = action;
  storeVrpMode({ pageAction: action });
  paintVrpAction();
  applyVrpVisibility();
}
vrpNewButton.addEventListener('click', () => chooseVrpAction('new'));
vrpExistingButton.addEventListener('click', () => chooseVrpAction('existing'));
vrpPageSearch.addEventListener('input', () => storeVrpMode({ pageQuery: vrpPageSearch.value }));
vrpSitemapUrl.addEventListener('input', () => storeVrpMode({ sitemapUrl: vrpSitemapUrl.value.trim() }));
vrpManualPageUrl.addEventListener('input', () => storeVrpMode({ manualPageUrl: vrpManualPageUrl.value.trim() }));
vrpManualPageButton.addEventListener('click', async () => {
  let pageUrl = vrpManualPageUrl.value.trim();
  if (!pageUrl) {
    vrpPageSearchStatus.textContent = 'Enter the exact page URL you want to edit.';
    vrpPageSearchStatus.className = 'error';
    return;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(pageUrl)) pageUrl = 'https://' + pageUrl;
  if (typeof window.__diResolveVrpEditPage !== 'function') {
    vrpPageSearchStatus.textContent = 'Page selection is still loading. Try again in a moment.';
    vrpPageSearchStatus.className = 'error';
    return;
  }
  vrpManualPageButton.disabled = true;
  vrpPageSearchStatus.textContent = 'Finding this page in WordPress…';
  vrpPageSearchStatus.className = '';
  try {
    const resolved = await window.__diResolveVrpEditPage(publishingAdminUrl.value.trim(), pageUrl);
    storeVrpMode({ existingPageUrl: resolved.editUrl, selectedPageUrl: pageUrl, selectedPageTitle: resolved.title, manualPageUrl: pageUrl });
    vrpSelectedPage.textContent = 'Selected: ' + resolved.title + ' (' + new URL(pageUrl).pathname + ')';
    vrpPageSearchStatus.textContent = 'Page selected. Generate Preview, then open WordPress to update it.';
    vrpPageSearchStatus.className = 'success';
    vrpPageSuggestions.replaceChildren();
  } catch (error) {
    storeVrpMode({ existingPageUrl: '', selectedPageUrl: '', selectedPageTitle: '' });
    vrpSelectedPage.textContent = '';
    vrpPageSearchStatus.textContent = error.message;
    vrpPageSearchStatus.className = 'error';
  } finally {
    vrpManualPageButton.disabled = false;
  }
});
vrpPageSearchButton.addEventListener('click', async () => {
  const query = vrpPageSearch.value.trim() || comparisonPageTitle.value.trim() || comparisonPageSlug.value.trim();
  if (!query) {
    vrpPageSearchStatus.textContent = 'Import the Google Doc first, or enter a page title to search.';
    vrpPageSearchStatus.className = 'error';
    return;
  }
  if (typeof window.__diFindVrpPages !== 'function') {
    vrpPageSearchStatus.textContent = 'Page search is still loading. Try again in a moment.';
    vrpPageSearchStatus.className = 'error';
    return;
  }
  vrpPageSearchButton.disabled = true;
  vrpPageSuggestions.replaceChildren();
  vrpPageSearchStatus.textContent = 'Reading the website sitemap and finding related pages…';
  vrpPageSearchStatus.className = '';
  try {
    const result = await window.__diFindVrpPages(publishingAdminUrl.value.trim(), query, vrpSitemapUrl.value.trim());
    if (!result.pages.length) {
      vrpPageSearchStatus.textContent = `Read ${result.count} sitemap pages, but no close match was found. Try fewer words.`;
      vrpPageSearchStatus.className = '';
      return;
    }
    vrpPageSuggestions.replaceChildren(...result.pages.map(page => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.textContent = `${page.title || page.path} — ${page.path}`;
      if (getVrpMode().selectedPageUrl === page.url) button.classList.add('is-selected');
      button.addEventListener('click', async () => {
        vrpPageSuggestions.querySelectorAll('button').forEach(item => item.classList.remove('is-selected'));
        button.classList.add('is-selected');
        vrpPageSearchStatus.textContent = 'Resolving the WordPress edit page…';
        vrpPageSearchStatus.className = '';
        try {
          const resolved = await window.__diResolveVrpEditPage(publishingAdminUrl.value.trim(), page.url);
          storeVrpMode({ existingPageUrl: resolved.editUrl, selectedPageUrl: page.url, selectedPageTitle: resolved.title, pageQuery: vrpPageSearch.value });
          vrpSelectedPage.textContent = `Selected: ${resolved.title} (${page.path})`;
          vrpPageSearchStatus.textContent = 'Page selected. Generate Preview, then open WordPress to update it.';
          vrpPageSearchStatus.className = 'success';
        } catch (error) {
          storeVrpMode({ existingPageUrl: '', selectedPageUrl: '', selectedPageTitle: '' });
          vrpSelectedPage.textContent = '';
          vrpPageSearchStatus.textContent = error.message;
          vrpPageSearchStatus.className = 'error';
        }
      });
      return button;
    }));
    vrpPageSearchStatus.textContent = `Read ${result.count} sitemap pages. Choose the page you want to update.`;
    vrpPageSearchStatus.className = 'success';
  } catch (error) {
    vrpPageSearchStatus.textContent = error.message;
    vrpPageSearchStatus.className = 'error';
  } finally {
    vrpPageSearchButton.disabled = false;
  }
});
// "Auto": a page about a specific model year (e.g. "2026 BMW i4 …") is Manufacturer Information; everything else is a Research Hub page.
const autoParentFor = title => (/\b20\d{2}\b/.test(title || '') ? 'Manufacturer Information' : 'Research Hub');
const resolveLandingParent = () => (landingParent.value === '__other' ? landingParentCustom.value.trim()
  : landingParent.value === '__auto' ? autoParentFor(comparisonPageTitle.value) : landingParent.value);
const showParentCustom = () => {
  landingParentCustom.hidden = landingParent.value !== '__other';
  const hint = document.querySelector('#landing-parent-hint');
  if (hint) hint.textContent = landingParent.value === '__auto' ? `Auto picks: ${autoParentFor(comparisonPageTitle.value)}` : '';
};
setInterval(showParentCustom, 1500);
landingParent.addEventListener('change', showParentCustom);
let importedCompareRows = [];
let importedCompareButtons = '';
const COMPARE_ROWS_KEY = 'hubImportedCompareRows';
const COMPARE_BUTTONS_KEY = 'hubImportedCompareButtons';
chrome.storage.session.get([COMPARE_ROWS_KEY, COMPARE_BUTTONS_KEY]).then(stored => {
  if (Array.isArray(stored[COMPARE_ROWS_KEY])) importedCompareRows = stored[COMPARE_ROWS_KEY];
  if (typeof stored[COMPARE_BUTTONS_KEY] === 'string') {
    importedCompareButtons = stored[COMPARE_BUTTONS_KEY];
    if (comparisonButtonCode) comparisonButtonCode.value = importedCompareButtons;
    setTimeout(checkComparisonButtonUrls, 900);
  }
});

const emptyCard = document.querySelector('#empty');
const previewCard = document.querySelector('#preview');
const openWpBtn = document.querySelector('#open-wp');
const clearBtn = document.querySelector('#clear');
const fillStatus = document.querySelector('#fill-status');
const sectionsContainer = document.querySelector('#sections');
const panelBlog = document.querySelector('#panel-blog');
const hubWorkflow = document.querySelector('#hub-workflow');
const publishingWorkflow = document.querySelector('#publishing-workflow');
const previewWorkflow = document.querySelector('#hub-preview-workflow');
const tabHubs = document.querySelector('#tab-hubs');
const tabPublishing = document.querySelector('#tab-publishing');
const publishingType = document.querySelector('#publishing-type');
const publishingAdminUrl = document.querySelector('#publishing-admin-url');
let ctaCheckRun = 0;
let ctaCheckTimer = 0;
async function checkComparisonButtonUrls() {
  const run = ++ctaCheckRun;
  const code = (comparisonButtonCode?.value || '').trim();
  comparisonButtonResults?.replaceChildren();
  if (!code) { comparisonButtonStatus.textContent = 'No button code in the Google Doc.'; comparisonButtonStatus.className = ''; return; }
  const site = publishingAdminUrl?.value.trim() || adminUrl?.value.trim() || '';
  if (!site) { comparisonButtonStatus.textContent = 'Enter the WordPress Admin URL to check button links.'; comparisonButtonStatus.className = 'warn'; return; }
  comparisonButtonStatus.textContent = 'Checking button URLs…';
  comparisonButtonStatus.className = '';
  try {
    const { verifyButtonUrls } = await import('./bulk/pipeline.js');
    const checks = await verifyButtonUrls(code, site);
    if (run !== ctaCheckRun) return;
    if (!checks.length) {
      comparisonButtonStatus.textContent = 'No button URLs to check.';
      return;
    }
    checks.forEach((check, i) => {
      const li = document.createElement('li');
      li.className = check.ok ? 'ok' : check.level === 'error' ? 'error' : 'warn';
      li.textContent = `${i + 1}. ${check.ok ? '✓' : check.level === 'error' ? '✕' : '!'} ${check.name.replace(/^Button URL — /, '')} — ${check.detail || (check.ok ? 'working' : 'needs attention')}`;
      comparisonButtonResults.append(li);
    });
    const broken = checks.filter(c => !c.ok && c.level === 'error').length;
    comparisonButtonStatus.textContent = broken ? `${broken} broken button URL${broken === 1 ? '' : 's'} found.` : 'Button URLs checked.';
    comparisonButtonStatus.className = broken ? 'error' : 'success';
  } catch (err) {
    if (run === ctaCheckRun) { comparisonButtonStatus.textContent = `Could not check button URLs: ${err.message}`; comparisonButtonStatus.className = 'warn'; }
  }
}
comparisonButtonCode?.addEventListener('input', () => {
  importedCompareButtons = comparisonButtonCode.value;
  chrome.storage.session.set({ [COMPARE_BUTTONS_KEY]: importedCompareButtons });
  clearTimeout(ctaCheckTimer);
  ctaCheckTimer = setTimeout(checkComparisonButtonUrls, 650);
});
publishingAdminUrl?.addEventListener('input', () => {
  clearTimeout(ctaCheckTimer);
  ctaCheckTimer = setTimeout(checkComparisonButtonUrls, 650);
});
const publishingGenerateBtn = document.querySelector('#publishing-generate');
const publishingSaveAdminBtn = document.querySelector('#publishing-save-admin');
const publishingFormStatus = document.querySelector('#publishing-form-status');
const contentSelection = document.querySelector('#content-selection');
const contentSelectionItems = document.querySelector('#content-selection-items');
let activeArea = 'hubs';
let importedContentBlocks = [];

/* ── Show/hide fields per hub type ──
   "Blog Publishing" is just a 5th Hub Type value — selecting it swaps in the
   Auto Publishing panel (#panel-blog) the same way other hub types swap in
   their own field-groups. */
function applyFieldVisibility() {
  const type = hubType.value;
  document.querySelectorAll('.field-group[data-hub-types]').forEach(group => {
    const types = group.dataset.hubTypes.split(',');
    group.hidden = !types.includes(type);
  });
}

function applyPublishingVisibility() {
  const type = publishingType.value === 'vrp' ? 'landing' : publishingType.value;
  document.querySelectorAll('.field-group[data-publishing-types]').forEach(group => {
    group.hidden = !group.dataset.publishingTypes.split(',').includes(type);
  });
  if (panelBlog) panelBlog.hidden = activeArea !== 'publishing' || type !== 'blog';
}

function setActiveArea(area) {
  activeArea = area;
  const isHub = area === 'hubs';
  hubWorkflow.hidden = !isHub;
  // Keep the Publishing Type selector visible even for Blog Publishing;
  // otherwise choosing Blog hides the only control that can switch back to
  // Comparison or Landing Page Publishing.
  publishingWorkflow.hidden = isHub;
  previewWorkflow.hidden = !isHub && publishingType.value === 'blog';
  tabHubs.classList.toggle('is-active', isHub);
  tabHubs.setAttribute('aria-selected', String(isHub));
  tabPublishing.classList.toggle('is-active', !isHub);
  tabPublishing.setAttribute('aria-selected', String(!isHub));
  applyPublishingVisibility();
  applyVrpVisibility();
}
hubType.addEventListener('change', applyFieldVisibility);
publishingType.addEventListener('change', () => setActiveArea('publishing'));
tabHubs.addEventListener('click', () => setActiveArea('hubs'));
tabPublishing.addEventListener('click', () => setActiveArea('publishing'));
applyFieldVisibility();
setActiveArea('hubs');

/* ── Restore saved admin URL ── */
chrome.storage.local.get(['hubAdminUrl', 'wordPressAdminUrl']).then(stored => {
  if (stored.hubAdminUrl || stored.wordPressAdminUrl) {
    const saved = stored.hubAdminUrl || stored.wordPressAdminUrl;
    adminUrl.value = saved;
    publishingAdminUrl.value = saved;
  }
  if (comparisonButtonCode?.value.trim()) setTimeout(checkComparisonButtonUrls, 100);
});

/* ── Persist in-progress form state (hub type, doc URL, all comparison
   fields) across popup close/reopen — the popup unloads every time it
   loses focus (e.g. switching tabs to copy the Google Doc URL), so
   without this the hub-type selection and anything typed/imported is
   lost and has to be redone. Keyed by field id, stored in session
   storage (cleared when the browser fully closes, same as the rest of
   the in-progress hub state). ── */
const PERSIST_FIELD_IDS = [
  'hub-type', 'comparison-doc-url', 'brand-name', 'comparison-page-title', 'comparison-page-slug',
  'service-specials-url', 'parts-specials-url', 'hub-research-url', 'hub-finance-url',
  'hub-service-url', 'research-new-vehicles-url', 'contact-us-url', 'finance-page-url',
  'comparison-meta-title', 'comparison-meta-description', 'comparison-learn-more-url',
  'comparison-inventory-url', 'comparison-vehicle-name', 'comparison-cta-body',
  'publishing-type', 'publishing-admin-url', 'landing-parent', 'landing-parent-custom', 'landing-bottom',
  'vrp-page-action', 'vrp-page-search', 'vrp-sitemap-url', 'vrp-manual-page-url',
];
const FORM_STATE_KEY = 'hubFormState';

function saveFormState() {
  const state = {};
  for (const id of PERSIST_FIELD_IDS) {
    const el = document.getElementById(id);
    if (el) state[id] = el.value;
  }
  chrome.storage.session.set({ [FORM_STATE_KEY]: state });
}

chrome.storage.session.get(FORM_STATE_KEY).then(stored => {
  const state = stored[FORM_STATE_KEY];
  if (!state) return;
  for (const id of PERSIST_FIELD_IDS) {
    const el = document.getElementById(id);
    if (el && state[id] !== undefined) el.value = state[id];
  }
  applyFieldVisibility();
  applyPublishingVisibility();
  showParentCustom();
});

for (const id of PERSIST_FIELD_IDS) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', saveFormState);
}

/* ── Restore pending hub page + status ── */
chrome.runtime.sendMessage({ type: 'GET_HUB_PAGE' }, response => {
  if (response?.ok && response.hub) {
    renderPreview(response.hub);
    if (response.status?.message) {
      fillStatus.textContent = response.status.message;
      fillStatus.className = response.status.ok ? 'success' : 'error';
      if (response.status.filled) openWpBtn.disabled = true;
    }
  }
});

/* ── Poll status every 2s while popup is open (to catch phase transitions) ── */
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'GET_HUB_PAGE' }, response => {
    if (response?.ok && response.status?.message) {
      fillStatus.textContent = response.status.message;
      fillStatus.className = response.status.ok ? 'success' : 'error';
      if (response.status.filled) openWpBtn.disabled = true;
    }
  });
}, 2000);


/* Links in the page body: Google's google.com/url?q=… wrappers are removed, external links get target=_blank +
   rel="nofollow noopener", the dealer's own links stay normal (link_rules.js). Applied when the preview is made. */
const withLinkRules = (html, adminValue) => {
  let host = '';
  try { host = new URL((adminValue || '').trim()).hostname; } catch { /* no admin URL yet */ }
  return window.diLinkRules ? window.diLinkRules.fixHtml(html, host) : html;
};

/* ── Generate preview ── */
generateBtn.addEventListener('click', () => {
  const type = hubType.value;
  const brand = brandName.value.trim();

  if (type === 'comparison') {
    if (!comparisonPageTitle.value.trim()) {
      setStatus(formStatus, 'Comparison page title is required.', false);
      comparisonPageTitle.focus();
      return;
    }
  } else if (!brand) {
    setStatus(formStatus, 'Brand name is required.', false);
    brandName.focus();
    return;
  }

  const admin = adminUrl.value.trim();
  if (!admin) {
    setStatus(formStatus, 'WordPress admin URL is required.', false);
    adminUrl.focus();
    return;
  }

  try {
    const hub = generateHub(type, {
      brandName: brand,
      serviceSpecialsUrl: serviceSpecialsUrl.value.trim() || '/service-specials/',
      partsSpecialsUrl: partsSpecialsUrl.value.trim() || '/parts-specials/',
      hubResearchUrl: hubResearchUrl.value.trim(),
      hubFinanceUrl: hubFinanceUrl.value.trim(),
      hubServiceUrl: hubServiceUrl.value.trim(),
      researchNewVehiclesUrl: researchNewVehiclesUrl.value.trim(),
      researchContactUsUrl: contactUsUrl.value.trim(),
      financePageUrl: financePageUrl.value.trim(),
      financeContactUsUrl: contactUsUrl.value.trim(),
      pageTitle: comparisonPageTitle.value.trim(),
      pageSlug: comparisonPageSlug.value.trim(),
      comparisonMetaTitle: comparisonMetaTitle.value.trim(),
      comparisonMetaDescription: comparisonMetaDescription.value.trim(),
      ctaLearnMoreUrl: comparisonLearnMoreUrl.value.trim(),
      ctaInventoryUrl: comparisonInventoryUrl.value.trim(),
      vehicleName: comparisonVehicleName.value.trim(),
      ctaBodyContent: withLinkRules(comparisonCtaBody.value.trim(), admin),
      compareRows: importedCompareRows,
      ctaButtonsHtml: comparisonButtonCode?.value ?? importedCompareButtons,
    });

    hub.adminUrl = admin;

    chrome.runtime.sendMessage({ type: 'STORE_HUB_PAGE', hub }, response => {
      if (!response?.ok) {
        setStatus(formStatus, response?.error || 'Could not store the hub page.', false);
        return;
      }
      setStatus(formStatus, 'Preview generated.', true);
      renderPreview(hub);
    });

    chrome.runtime.sendMessage({ type: 'SAVE_ADMIN_URL', adminUrl: admin });
  } catch (err) {
    setStatus(formStatus, err.message, false);
  }
});

/* ── Generate a Google-Doc-backed Comparison or Landing page ── */
publishingGenerateBtn.addEventListener('click', () => {
  const selectedType = publishingType.value;
  const isVrp = selectedType === 'vrp' || vrpActive();
  const type = selectedType === 'vrp' ? 'landing' : selectedType;
  if (!comparisonPageTitle.value.trim()) {
    setStatus(publishingFormStatus, 'Page title is required.', false);
    comparisonPageTitle.focus();
    return;
  }
  const admin = publishingAdminUrl.value.trim();
  if (!admin) {
    setStatus(publishingFormStatus, 'WordPress admin URL is required.', false);
    publishingAdminUrl.focus();
    return;
  }
  if (type === 'landing' && !comparisonCtaBody.value.trim()) {
    setStatus(publishingFormStatus, 'Content HTML is empty — the page would only get the buttons. Import the Google Doc again, or paste the text under "Page SEO & content".', false);
    return;
  }
  try {
    const hub = generateHub(type, {
      pageTitle: comparisonPageTitle.value.trim(),
      pageSlug: comparisonPageSlug.value.trim(),
      comparisonMetaTitle: comparisonMetaTitle.value.trim(),
      comparisonMetaDescription: comparisonMetaDescription.value.trim(),
      ctaLearnMoreUrl: comparisonLearnMoreUrl.value.trim(),
      ctaInventoryUrl: comparisonInventoryUrl.value.trim(),
      vehicleName: comparisonVehicleName.value.trim(),
      ctaBodyContent: withLinkRules(comparisonCtaBody.value.trim(), admin),
      compareRows: importedCompareRows,
      ctaButtonsHtml: comparisonButtonCode?.value ?? importedCompareButtons,
      landingParent: (type === 'landing' || type === 'comparison') ? resolveLandingParent() : '',
      templateName: isVrp ? 'Lightning' : undefined,
      vrpSeoContent: isVrp,
      landingBottom: landingBottom.value,
      landingImage: (type === 'landing' || type === 'comparison') && window.__diGetLandingImage ? window.__diGetLandingImage() : null,
    });
    const vrpMode = getVrpMode();
    if (isVrp && vrpMode.pageAction === 'existing') {
      if (!vrpMode.existingPageUrl || !vrpMode.selectedPageUrl) {
        setStatus(publishingFormStatus, 'Choose the existing page from the sitemap suggestions first.', false);
        vrpPageSearchButton.focus();
        return;
      }
      hub.vrpExistingPage = true;
      hub.existingPageUrl = vrpMode.existingPageUrl;
      hub.vrpSelectedPageUrl = vrpMode.selectedPageUrl;
    }
    hub.adminUrl = admin;
    chrome.runtime.sendMessage({ type: 'STORE_HUB_PAGE', hub }, response => {
      if (!response?.ok) return setStatus(publishingFormStatus, response?.error || 'Could not store the page.', false);
      setStatus(publishingFormStatus, 'Preview generated.', true);
      renderPreview(hub);
    });
    chrome.runtime.sendMessage({ type: 'SAVE_ADMIN_URL', adminUrl: admin });
  } catch (err) {
    setStatus(publishingFormStatus, err.message, false);
  }
});

/* ── Import from Google Doc (Comparison Page: title + Yoast meta) ── */
importDocBtn.addEventListener('click', () => {
  const docUrl = comparisonDocUrl.value.trim();
  if (!docUrl) {
    importStatus.textContent = 'Paste a Google Doc URL first.';
    importStatus.className = 'error';
    return;
  }
  importDocBtn.disabled = true;
  importStatus.textContent = 'Importing from Google Doc…';
  importStatus.className = '';

  chrome.runtime.sendMessage({ type: 'IMPORT_COMPARISON_DOC', documentUrl: docUrl }, response => {
    importDocBtn.disabled = false;
    if (!response?.ok) {
      importStatus.textContent = response?.error || 'Could not import the document.';
      importStatus.className = 'error';
      return;
    }
    if (response.title) comparisonPageTitle.value = response.title;
    if (response.pageSlug) comparisonPageSlug.value = response.pageSlug;
    if (response.metaTitle) comparisonMetaTitle.value = response.metaTitle;
    if (response.metaDescription) comparisonMetaDescription.value = response.metaDescription;
    // Body copy (paragraphs/headings/lists — table content and the table's
    // position in the doc are irrelevant here, they're already excluded)
    // goes into the content field; the regular Landing / Comparison page flow
    // handles its own CTA buttons when Generate Preview is clicked.
    if (response.bodyHtml) {
      let contentHtml = response.bodyHtml;
      // The parser extracts an H1 into the separate WordPress page title.
      // VRP copy starts with that same title as an H2 inside the content row.
      if (vrpActive()) {
        const root = new DOMParser().parseFromString(`<div id="vrp-content-root">${contentHtml}</div>`, 'text/html').querySelector('#vrp-content-root');
        // CTA/button markup belongs to publishing pages, not VRP Enhancement content.
        root.querySelectorAll('a.button, a.primary-button, a[class*="button"]').forEach(link => link.remove());
        [...root.querySelectorAll('div, p')].reverse().forEach(node => {
          if (!node.textContent.trim() && !node.children.length) node.remove();
        });
        root.querySelectorAll('h1').forEach(oldHeading => {
          const heading = document.createElement('h2');
          for (const attr of oldHeading.attributes) heading.setAttribute(attr.name, attr.value);
          heading.innerHTML = oldHeading.innerHTML;
          oldHeading.replaceWith(heading);
        });
        if (response.title) {
          const firstContent = [...root.children].find(node => node.textContent.trim());
          const sameTitle = firstContent?.tagName === 'H2'
            && firstContent.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === response.title.replace(/\s+/g, ' ').trim().toLowerCase();
          if (!sameTitle) {
            const heading = document.createElement('h2');
            heading.textContent = response.title;
            root.prepend(heading);
          }
        }
        contentHtml = root.innerHTML;
      }
      renderContentSelection(contentHtml);
    }
    const noBody = !response.bodyHtml;
    importedCompareRows = Array.isArray(response.compareRows) ? response.compareRows : [];
    importedCompareButtons = typeof response.buttons === 'string' ? response.buttons : '';
    if (comparisonButtonCode) comparisonButtonCode.value = importedCompareButtons;
    chrome.storage.session.set({
      [COMPARE_ROWS_KEY]: importedCompareRows,
      [COMPARE_BUTTONS_KEY]: importedCompareButtons,
    });
    checkComparisonButtonUrls();
    const rowsNote = importedCompareRows.length
      ? ` Found a comparison table — ${importedCompareRows.length} row${importedCompareRows.length === 1 ? '' : 's'} will be auto-filled into the Direct Compare Data Row.`
      : ' No comparison table found in the doc — you\'ll need to fill the Direct Compare Data Row by hand.';
    const slugNote = response.pageSlug ? ` Slug from the doc: "${response.pageSlug}".` : ' No Page Slug found in the doc — the slug will be made from the title (type it in Page Slug if that is wrong).';
    const discNote = response.disclaimerFound ? ' Disclaimer: found, added at the end.'
      : response.disclaimerSkipped ? ' Disclaimer: found in the doc but NOT added (switched off) — add it by hand.'
      : ' Disclaimer: none in the doc.';
    const skipNote = Array.isArray(response.skipped) && response.skipped.length
      ? ` ⚠ NOT copied into the body: ${response.skipped.map(s => `“${s.text}” (${s.why})`).join(' · ')} — add by hand if it is real content.` : '';
    const noTitle = !response.title ? ' The doc has no H1 — type the Page Title yourself.' : '';
    if (noBody) {
      importStatus.textContent = 'Imported, but NO body text was found in this doc (check the doc is the content doc, not a template).' + noTitle;
      importStatus.className = 'error';
    } else {
      importStatus.textContent = 'Imported — review the fields below, then Generate Preview.' + rowsNote + slugNote + discNote + noTitle + skipNote + (response.tabNote || '');
      importStatus.className = 'success';
    }
  });
});

/* ── Save admin URL ── */
saveAdminBtn.addEventListener('click', () => {
  const url = adminUrl.value.trim();
  if (!url) {
    setStatus(formStatus, 'Enter a WordPress admin URL to save.', false);
    return;
  }
  chrome.runtime.sendMessage({ type: 'SAVE_ADMIN_URL', adminUrl: url }, response => {
    setStatus(formStatus, response?.ok ? 'WordPress URL saved.' : (response?.error || 'Could not save.'), response?.ok);
  });
});

publishingSaveAdminBtn.addEventListener('click', () => {
  const url = publishingAdminUrl.value.trim();
  if (!url) return setStatus(publishingFormStatus, 'Enter a WordPress admin URL to save.', false);
  chrome.runtime.sendMessage({ type: 'SAVE_ADMIN_URL', adminUrl: url }, response => {
    setStatus(publishingFormStatus, response?.ok ? 'WordPress URL saved.' : (response?.error || 'Could not save.'), response?.ok);
  });
});

/* ── Open WordPress (triggers Phase 1 → Phase 2 automatically) ── */
openWpBtn.addEventListener('click', () => {
  openWpBtn.disabled = true;
  const vrpExisting = vrpActive() && getVrpMode().pageAction === 'existing';
  fillStatus.textContent = vrpExisting
    ? 'Opening the existing WordPress page — updating Lightning VRP SEO Content and meta…'
    : 'Opening WordPress — filling title, template, parent, then building all rows…';
  fillStatus.className = '';

  chrome.runtime.sendMessage({
    type: 'OPEN_HUB_PAGE',
    adminUrl: activeArea === 'publishing' ? publishingAdminUrl.value.trim() : adminUrl.value.trim(),
  }, response => {
    if (response?.ok) {
      fillStatus.textContent = vrpExisting
        ? 'Existing page opened. Updating VRP content and meta — nothing will be saved automatically.'
        : 'WordPress opened. Building the page — nothing will be saved automatically, review before publishing.';
      fillStatus.className = 'success';
    } else {
      fillStatus.textContent = response?.error || 'Could not open WordPress.';
      fillStatus.className = 'error';
      openWpBtn.disabled = false;
    }
  });
});

/* ── Clear ── */
clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_HUB_PAGE' }, response => {
    if (response?.ok) {
      previewCard.hidden = true;
      emptyCard.hidden = false;
      openWpBtn.disabled = false;
      fillStatus.textContent = '';
      fillStatus.className = '';
      setStatus(formStatus, '', true);
      importedCompareRows = [];
      importedCompareButtons = '';
      if (comparisonButtonCode) comparisonButtonCode.value = '';
      comparisonButtonResults?.replaceChildren();
      comparisonButtonStatus.textContent = 'No CTA URLs checked.';
      comparisonButtonStatus.className = '';
      chrome.storage.session.remove([COMPARE_ROWS_KEY, COMPARE_BUTTONS_KEY]);
    }
  });
});

/* ── Render preview ── */
function renderPreview(hub) {
  emptyCard.hidden = true;
  previewCard.hidden = false;

  setFieldText('#p-title', hub.title, true);
  setFieldText('#p-slug', hub.slug, true);
  document.querySelector('#p-parent').textContent = hub.parentSlug || '(none)';
  document.querySelector('#p-template').textContent = hub.templateName || 'DI Page Composer';
  setFieldText('#p-meta-title', hub.metaTitle, true);
  setFieldText('#p-meta-desc', hub.metaDescription, true);

  sectionsContainer.replaceChildren();

  for (const section of hub.sections) {
    const block = document.createElement('div');
    block.className = 'section-block';

    // Header row
    const header = document.createElement('div');
    header.className = 'section-header';

    const labelWrap = document.createElement('div');
    labelWrap.className = 'section-label';
    labelWrap.textContent = section.label;
    // Flag anything with nothing to fill in — except a section that's
    // intentionally left for manual work (autoBuild: false), which already
    // explains itself in its description.
    if (!section.html?.trim() && section.autoBuild !== false) {
      labelWrap.classList.add('is-empty');
    }
    if (section.description) {
      const desc = document.createElement('span');
      desc.className = 'section-desc';
      desc.textContent = section.description;
      labelWrap.appendChild(desc);
    }

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.type = 'button';
    copyBtn.title = 'Copy HTML to clipboard (fallback if auto-fill misses this section)';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(section.html).then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1800);
      }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = section.html;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1800);
      });
    });

    header.appendChild(labelWrap);
    header.appendChild(copyBtn);
    header.addEventListener('click', () => block.classList.toggle('open'));

    // Body
    const body = document.createElement('div');
    body.className = 'section-body';

    const code = document.createElement('pre');
    code.className = 'section-code';
    code.textContent = section.html;
    body.appendChild(code);

    if (section.config) {
      const notes = document.createElement('div');
      notes.className = 'config-notes';
      notes.innerHTML = buildConfigNotes(section.config);
      body.appendChild(notes);
    }

    block.appendChild(header);
    block.appendChild(body);
    sectionsContainer.appendChild(block);
  }
}

/* ── Config notes ── */
function buildConfigNotes(config) {
  const items = [];
  if (config.rowType) items.push('<strong>Row Type:</strong> ' + esc(config.rowType));
  if (config.maxWidthContainer) items.push('<strong>Max Width Container:</strong> ✓ Checked');
  if (config.backgroundImageUrl) items.push('<strong>BG Image URL:</strong> ' + esc(config.backgroundImageUrl));
  if (config.bgImgSizing) items.push('<strong>BG Img Sizing:</strong> ' + esc(config.bgImgSizing));
  if (config.backgroundAttachment) items.push('<strong>BG Attachment:</strong> ' + esc(config.backgroundAttachment));
  if (config.rowPadding) items.push('<strong>Row Padding:</strong> ' + esc(config.rowPadding));
  if (config.customClass) items.push('<strong>Custom Class:</strong> ' + esc(config.customClass));
  return '<strong>Row Settings (auto-filled by extension):</strong><ul>' + items.map(i => '<li>' + i + '</li>').join('') + '</ul>';
}

/* ── Helpers ── */
function setFieldText(selector, value, flagIfEmpty) {
  const el = document.querySelector(selector);
  el.textContent = value || (flagIfEmpty ? '' : value);
  el.classList.toggle('is-empty', flagIfEmpty && !value?.trim());
}

function setStatus(el, message, ok) {
  el.textContent = message;
  el.className = ok ? 'success' : message ? 'error' : '';
}

/* Split the already-cleaned HTML into selectable top-level sections. The
   Google Doc parser has removed metadata before this point; this review UI
   gives the writer the final say about which real content belongs on-page. */
function splitContentBlocks(html) {
  const root = new DOMParser().parseFromString(`<div id="content-root">${html || ''}</div>`, 'text/html')
    .querySelector('#content-root');
  return [...root.children]
    .map(node => node.outerHTML.trim())
    .filter(Boolean);
}

// The parser wraps red "internal link" text in <mark data-il>; a browser paints <mark> yellow, so it must
// never reach the page. (Internal linking will turn these into real links later; until then, unwrap them.)
const stripMarks = html => (html || '').replace(/<\/?mark\b[^>]*>/gi, '');

function syncSelectedContent() {
  const chosen = [...contentSelectionItems.querySelectorAll('input[type="checkbox"]')]
    .filter(input => input.checked)
    .map(input => importedContentBlocks[Number(input.dataset.index)])
    .filter(Boolean);
  let html = chosen.join('\n\n');
  if (typeof window.__diTransformContent === 'function') html = window.__diTransformContent(html);   // internal links (links/il_popup.js): ticked links become <a href="/page/">
  comparisonCtaBody.value = stripMarks(html);                                                       // any red marker left over is unwrapped
  saveFormState();
}

function renderContentSelection(bodyHtml) {
  importedContentBlocks = splitContentBlocks(bodyHtml);          // red <mark data-il> kept here: the internal-links panel needs them
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
    checkbox.addEventListener('change', syncSelectedContent);
    const preview = document.createElement('div');
    preview.className = 'content-selection-preview';
    // This is the same cleaned HTML that will go into the WYSIWYG field,
    // rendered visually so content can be selected by appearance—not only
    // by a one-line text snippet.
    preview.innerHTML = stripMarks(block);
    label.append(checkbox, preview);
    contentSelectionItems.appendChild(label);
  });
  contentSelection.hidden = false;
  contentSelection.closest('details').open = true;
  syncSelectedContent();
  document.dispatchEvent(new CustomEvent('di:imported', { detail: { bodyHtml } }));   // -> internal links panel scans the body
}

function esc(value) {
  return (value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}



