/**
 * PAGE TYPE: Comparison Page
 *
 * Everything this page type needs lives in THIS file — its template AND its own
 * private copies of every helper it uses (blog-feed row, URL cleaners, etc.).
 * Nothing here is shared with the other page types, so editing this file can
 * only ever change the Comparison Page output.
 * 
 *
 * The only thing outside this file is core/hub-core.js, which just provides the
 * registry that lets generateHub() find this page type.
 */
(function () {
'use strict';

function buildBlogFeedSection() {
  const html = [
    '<div class="well">',
    '  <div class="center">',
    '    <h2>More from %%di_name%%</h2>',
    '  </div>',
    '  [di_posts posts_per_page="3" excerpt="true" posts_per_page="3" date="false" thumbs="false"]',
    '</div>',
  ].join('\n');

  return {
    id: 'blogfeed',
    label: 'Blog Feed',
    description: 'Full Width WYSIWYG — blog posts shortcode',
    html,
    config: {
      rowType: 'Full Width WYSIWYG',
      maxWidthContainer: true,
      customClass: 'text-center',
      rowPadding: '2%',
    },
  };
}

// Group 1 tickets: the contact form goes where the blog feed would. Same row type, but NOT text-center.
function buildGravityFormSection() {
  return {
    id: 'contactform',
    label: 'Contact Form',
    description: 'Full Width WYSIWYG — Gravity Form shortcode (Group 1)',
    html: '[gravityform id="3" title="true" description="true"]',
    config: {
      rowType: 'Full Width WYSIWYG',
      maxWidthContainer: true,
      rowPadding: '2%',
    },
  };
}

const stripMarkTags = html => (html || '').replace(/<\/?mark\b[^>]*>/gi, '');   // never let <mark> (yellow) reach the page

function escapeHtml(value) {
  return (value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(value) {
  return (value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Inserts `insertHtml` right after the first <p> found in `bodyHtml`, so
// the CTA buttons land after the opening paragraph of the doc-imported
// body copy instead of stacked above the whole thing. Only used by the
// Comparison Page template below — the three static hub templates never
// call this, so their output is completely unaffected.
function insertAfterFirstParagraph(bodyHtml, insertHtml) {
  const body = (bodyHtml || '').trim();
  const insert = (insertHtml || '').trim();
  if (!insert) return body;
  if (!body) return insert;

  const container = new DOMParser().parseFromString(`<div id="root">${body}</div>`, 'text/html').querySelector('#root');
  const firstParagraph = container.querySelector('p');
  if (!firstParagraph) {
    // No paragraph to anchor to (e.g. old-style content pasted without <p>
    // tags) — keep the previous behavior of leading with the buttons.
    return [insert, body].filter(Boolean).join('\n\n');
  }

  const fragment = new DOMParser().parseFromString(`<div id="frag">${insert}</div>`, 'text/html').querySelector('#frag');
  firstParagraph.insertAdjacentHTML('afterend', fragment.innerHTML);
  return container.innerHTML.trim();
}

function sanitizeUrl(url) {
  const trimmed = (url || '').trim();
  if (!trimmed) return '/';
  if (!trimmed.startsWith('http') && !trimmed.startsWith('/')) {
    return '/' + trimmed;
  }
  return trimmed;
}

function generateComparisonHub({
  pageTitle = '',
  pageSlug = '',
  ctaLearnMoreUrl = '',
  ctaInventoryUrl = '',
  vehicleName = '',
  ctaBodyContent = '',
  comparisonMetaTitle = '',
  comparisonMetaDescription = '',
  compareRows = [],
  ctaButtonsHtml = '',
  suppressCtaButtons = false,
  landingImage = null,   // { dataUrl, width, height, alt, filename } from the Image Library (same picker as landing pages)
  landingBottom = 'blog',   // 'blog' = More-from blog feed, 'form' = Group 1 Gravity Form (contact form)
  landingParent = '',       // exact (or partial) title of the parent page in Page Attributes (chosen in the popup)
}) {
  const title = pageTitle.trim();
  // Prefer the slug the writer actually specified in the Google Doc (or
  // typed in by hand) over auto-deriving one from the title — the two
  // don't always match (e.g. a shortened or reworded URL).
  const suppliedSlug = slugify(pageSlug.replace(/^https?:\/\/[^/]+/i, ''));
  const slug = suppliedSlug || slugify(title);
  const parentSlug = (landingParent || '').trim() || null;   // Parent Page chosen in the popup (empty = no parent)
  const templateName = 'DI Page Composer';

  const metaTitle = comparisonMetaTitle.trim();
  const metaDescription = comparisonMetaDescription.trim();

  /* ---------- 1. Page Title row ---------- */
  const pageTitleSection = {
    id: 'pagetitle',
    label: 'Page Title Row',
    description: '"Page Title" layout — sets the on-page title via its own Title field (not a WYSIWYG box)',
    html: title,
    fillMethod: 'label',
    fieldLabel: 'Title',
    config: {
      rowType: 'Page Title',
      customClass: 'text-center',
    },
  };

  /* ---------- 2. Comparison imagery row ---------- */
  // Content box is left blank on purpose — the comparison image shortcode is
  // generated externally (Brandfolder tool → DI Image Library) and only
  // exists once you've built this row, so paste it in manually. Because
  // there's nothing to fill in yet, this row is not auto-built like the
  // others (autoBuild: false) — it stays in the preview list purely as a
  // reminder of what to add by hand once you have the shortcode.
  const imagerySection = {
    id: 'imagery',
    label: 'Comparison Imagery Row',
    description: 'Full Width WYSIWYG row for the comparison image — with an image picked in the popup it is uploaded (with alt text) and inserted here, otherwise the row stays blank',
    // With an image: the build uploads it to the site's media library (with the alt text) and puts the <img> here.
    // The file is named after the page slug, same as landing pages.
    image: landingImage && landingImage.dataUrl ? { ...landingImage, filename: slug || landingImage.filename } : null,
    // Keep the WYSIWYG content genuinely blank. The 2% spacing belongs
    // to the ACF Row Padding field, not inside the WYSIWYG HTML.
    html: '',
    autoBuild: true,
    config: {
      rowType: 'Full Width WYSIWYG',
      customClass: 'text-center',
      rowPadding: '2%',
      maxWidthContainer: true,       // the image row's width tick box, same as the landing page's image row
      bgImgSizing: 'Auto',
      backgroundAttachment: 'Scroll',
    },
  };

  /* ---------- 3. Direct Compare Data Row (table) ---------- */
  // Each entry in compareRows came straight from a row of the Google Doc's
  // comparison table (Left | Middle | Right), so — unlike before — these
  // aren't left blank: hub_background.js fills each Data entry's Left
  // Data / Middle Label / Right Data fields with the matching row.
  const hasImportedRows = Array.isArray(compareRows) && compareRows.length > 0;
  const compareDataSection = {
    id: 'comparedata',
    label: 'Direct Compare Data Row',
    description: `Direct Compare Data Row — ${compareRows.length} "Data" entries are auto-added and auto-filled from your Google Doc's comparison table`,
    html: '',
    config: {
      rowType: 'Direct Compare Data Row',
      customClass: 'text-center',
    },
    // This row is included only when the imported Google Doc has a table;
    // no empty comparison-table placeholders are generated.
    nestedRows: compareRows,
    manualNote: 'The row and its Data entries are created and filled from your Google Doc comparison table — double-check the values once WordPress opens.',
  };

  /* ---------- 4. CTA buttons + body content row ---------- */
  const learnMoreHref = ctaLearnMoreUrl || '/URL/';
  const inventoryHref = ctaInventoryUrl || '/new-vehicles/URL/';
  const inventoryLabel = vehicleName.trim()
    ? `View ${escapeHtml(vehicleName.trim())} Inventory`
    : 'View Vehicle Inventory';

  const generatedCtaButtonsHtml =
    `<div class="text-center"><a class="button primary-button" href="${sanitizeUrl(learnMoreHref)}">Learn More</a> ` +
    `<a class="button primary-button" href="${sanitizeUrl(inventoryHref)}">${inventoryLabel}</a></div>`;

  // Google Doc buttons are the source of truth. Fall back to the existing
  // Learn More / Inventory buttons only when the Doc did not provide any.
  const resolvedCtaButtonsHtml = suppressCtaButtons ? '' : (ctaButtonsHtml.trim() || generatedCtaButtonsHtml);


  // The doc-imported body copy always leads with an opening paragraph, and
  // the CTA buttons belong right after it (not stacked above everything).
  // If there's no <p> to anchor to — e.g. old-style manually pasted content
  // that wasn't wrapped in paragraph tags — fall back to leading with the
  // buttons, same as before.
  const ctaSectionHtml = insertAfterFirstParagraph(stripMarkTags(ctaBodyContent).trim(), resolvedCtaButtonsHtml);

  const ctaContentSection = {
    id: 'ctacontent',
    label: 'CTA Buttons + Content',
    description: 'Full Width WYSIWYG — your Google Doc body copy with the CTA buttons inserted after the first paragraph, all links relative',
    html: ctaSectionHtml,
    config: {
      rowType: 'Full Width WYSIWYG',
      maxWidthContainer: true,
      rowPadding: '2%',
    },
  };

  /* ---------- assembled result ---------- */
  return {
    title,
    slug,
    parentSlug,
    templateName,
    metaTitle,
    metaDescription,
    sections: [
      pageTitleSection,
      imagerySection,
      ...(hasImportedRows ? [compareDataSection] : []),
      ctaContentSection,
      landingBottom === 'form' ? buildGravityFormSection() : buildBlogFeedSection(),
    ],
    backgroundImageUrl: null,
  };
}

HubRegistry.register({ key: 'comparison', label: 'Comparison Page', enabled: true }, generateComparisonHub);
})();
