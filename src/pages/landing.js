/**
 * PAGE TYPE: Landing Page
 *
 * Everything this page type needs lives in THIS file — its template AND its own
 * private copies of every helper it uses (blog-feed row, URL cleaners, etc.).
 * Nothing here is shared with the other page types, so editing this file can
 * only ever change the Landing Page output.
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

// Buttons from the Google Doc sit right before the first H2 in the doc, so they go there on the page too.
// No H2 in the body -> after the first paragraph (old behaviour).
function insertBeforeFirstH2(bodyHtml, insertHtml) {
  const body = (bodyHtml || '').trim();
  const insert = (insertHtml || '').trim();
  if (!insert) return body;
  if (!body) return insert;
  const container = new DOMParser().parseFromString(`<div id="root">${body}</div>`, 'text/html').querySelector('#root');
  const h2 = container.querySelector('h2');
  if (!h2) return insertAfterFirstParagraph(body, insert);
  // Insert before the H2's top-level block, not inside some wrapper.
  let anchor = h2;
  while (anchor.parentElement && anchor.parentElement !== container) anchor = anchor.parentElement;
  anchor.insertAdjacentHTML('beforebegin', insert);
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

/* ------------------------------------------------------------------ */
/*  Landing Page                                                        */
/*                                                                      */
/*  A deliberately lean DI Page Composer page: Page Title, a blank    */
/*  image row, one Full Width WYSIWYG content row, then the standard More From feed.        */
/* ------------------------------------------------------------------ */
function generateLandingPage({
  pageTitle = '',
  pageSlug = '',
  ctaLearnMoreUrl = '',
  ctaInventoryUrl = '',
  vehicleName = '',
  ctaBodyContent = '',
  ctaButtonsHtml: docButtonsHtml = '',   // button markup read from the Google Doc
  suppressCtaButtons = false,
  comparisonMetaTitle = '',
  comparisonMetaDescription = '',
  landingBottom = 'blog',      // 'blog' = More-from blog feed, 'form' = Group 1 Gravity Form
  landingImage = null,         // { dataUrl, width, height, alt, filename } from the Image Library
  landingParent = '',          // exact (or partial) title of the parent page in Page Attributes
  templateName = 'DI Page Composer',
  vrpSeoContent = false,
}) {
  const title = pageTitle.trim();
  const isVrp = !!vrpSeoContent || /^lightning$/i.test((templateName || '').trim());
  // The slug written in the Google Doc wins. "/research/cx-5/" or a full URL -> last part "cx-5"
  // (WordPress slugs cannot contain "/"; the parent page comes from the Parent Page setting).
  const docSlugPart = (pageSlug || '').trim().replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  const suppliedSlug = slugify(docSlugPart);
  const slug = suppliedSlug || slugify(title);
  const inventoryLabel = vehicleName.trim()
    ? `View ${escapeHtml(vehicleName.trim())} Inventory`
    : 'View Vehicle Inventory';
  // Keep exactly one literal space between the two anchors; DI's button
  // styling relies on this whitespace to avoid the buttons touching.
  const fallbackButtonsHtml = isVrp ? '' :
    `<div class="text-center"><a class="button primary-button" href="${sanitizeUrl(ctaLearnMoreUrl || '/URL/')}">Learn More</a> ` +
    `<a class="button primary-button" href="${sanitizeUrl(ctaInventoryUrl || '/new-vehicles/URL/')}">${inventoryLabel}</a></div>`;

  // The Google Doc's own buttons are the source of truth; the generated pair is only a fallback
  // for docs that have no buttons at all. Doc buttons are wrapped the same way as comparison pages.
  const docButtons = isVrp ? '' : (docButtonsHtml || '').trim();
  const buttonsToUse = isVrp || suppressCtaButtons ? '' : docButtons
    ? (/<div[^>]*text-center/i.test(docButtons) ? docButtons : `<div class="text-center">${docButtons.replace(/<\/a>\s*<a/g, '</a> <a')}</div>`)
    : fallbackButtonsHtml;

  // VRP copy always sits inside this centred, 1175px-wide wrapper — in the preview and in the WordPress editor.
  const vrpWrapped = (() => {
    const inner = isVrp ? stripMarkTags(ctaBodyContent).trim() : '';
    if (!inner || /^\s*<div[^>]*max-width:\s*1175px/i.test(inner)) return inner;
    return `<div style="margin-right: auto; margin-left: auto; max-width:1175px;">\n${inner}\n</div>`;
  })();

  return {
    title,
    slug,
    parentSlug: (landingParent || '').trim() || null,
    templateName: (templateName || 'DI Page Composer').trim(),
    metaTitle: comparisonMetaTitle.trim(),
    metaDescription: comparisonMetaDescription.trim(),
    vrpSeoContent: isVrp,
    vrpContentHtml: vrpWrapped,
    sections: isVrp ? [{
      id: 'vrp-seo-content',
      label: 'Lightning VRP SEO Content',
      description: 'HTML is filled into the Lightning VRP SEO Content editor.',
      html: vrpWrapped,
      autoBuild: false,
    }] : [
      {
        id: 'pagetitle',
        label: 'Page Title Row',
        description: '"Page Title" layout — sets the on-page title via its own Title field',
        html: title,
        fillMethod: 'label',
        fieldLabel: 'Title',
        config: { rowType: 'Page Title', customClass: 'text-center' },
      },
      {
        // Blank row above the content, reserved for the page image (same as the comparison page's image row).
        id: 'landingimage',
        label: 'Image Row (blank)',
        description: 'Blank Full Width WYSIWYG — Max Width Container ticked, 2% padding, text-center — for the image',
        html: '',
        // With an image: the build uploads it to the site's media library (with the alt text) and puts the <img> here.
        // The file is named after the page slug (the Doc's Page Slug wins), e.g. 2026-cadillac-xt5-review.png
        image: landingImage && landingImage.dataUrl ? { ...landingImage, filename: slug || landingImage.filename } : null,
        autoBuild: true,
        config: {
          rowType: 'Full Width WYSIWYG',
          customClass: 'text-center',
          rowPadding: '2%',
          maxWidthContainer: true,
          bgImgSizing: 'Auto',
          backgroundAttachment: 'Scroll',
        },
      },
      {
        id: 'landingcontent',
        label: 'Landing Page Content',
        description: 'Full Width WYSIWYG — Google Doc content, with the Doc\'s own buttons placed before the first H2',
        html: insertBeforeFirstH2(stripMarkTags(ctaBodyContent).trim(), buttonsToUse),
        config: { rowType: 'Full Width WYSIWYG', maxWidthContainer: true, rowPadding: '2%' },
      },
      landingBottom === 'form' ? buildGravityFormSection() : buildBlogFeedSection(),
    ],
    backgroundImageUrl: null,
  };
}

HubRegistry.register({ key: 'landing', label: 'Landing Page Publishing', enabled: true }, generateLandingPage);
})();
