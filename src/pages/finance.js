/**
 * PAGE TYPE: Finance & Insurance hub
 *
 * Everything this page type needs lives in THIS file — its template AND its own
 * private copies of every helper it uses (blog-feed row, URL cleaners, etc.).
 * Nothing here is shared with the other page types, so editing this file can
 * only ever change the Finance & Insurance hub output.
 * 
 *
 * The only thing outside this file is core/hub-core.js, which just provides the
 * registry that lets generateHub() find this page type.
 */
(function () {
'use strict';

const BG_IMAGE_URL =
  'https://dealerinspire-image-library-prod.s3.us-east-1.amazonaws.com/images/zRTVBlkZk4jJUd7Ehi8Ko5BQFmvCU65WSispXbAk.jpeg';

function buildComingSoonSection() {
  return {
    id: 'cta',
    label: 'CTA / Coming Soon',
    description: 'Full Width WYSIWYG — placeholder until accordion content is ready',
    html: '<h2>Watch for more content coming soon!</h2>',
    config: {
      rowType: 'Full Width WYSIWYG',
      maxWidthContainer: true,
      customClass: 'text-center',
      rowPadding: '2%',
    },
  };
}

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

function buildCssOverridesSection() {
  const html = [
    'h1 {',
    '  font-size: 45px;',
    '  color: #ffffff;',
    '}',
    'h4 {',
    '  font-size: 25px;',
    '  color: #ffffff;',
    '}',
    '.panel {',
    '  width: 85%;',
    '  margin: auto;',
    '}',
  ].join('\n');

  return {
    id: 'css',
    label: 'CSS Overrides',
    description: 'Auto-filled into the page-level CSS box (not a row) — double-check it landed there and not in a row field',
    html,
    config: null,
  };
}

function bannerConfigDefaults() {
  return {
    rowType: 'Full Width WYSIWYG',
    maxWidthContainer: true,
    backgroundImageUrl: BG_IMAGE_URL,
    bgImgSizing: 'Cover',
    backgroundAttachment: 'Scroll',
    rowPadding: '5% 0',
    customClass: 'text-center',
  };
}

function bodyConfigDefaults() {
  return {
    rowType: 'Full Width WYSIWYG',
    maxWidthContainer: true,
    rowPadding: '2%',
  };
}

function closingCtasConfigDefaults() {
  return {
    rowType: 'Full Width WYSIWYG',
    maxWidthContainer: true,
    customClass: 'text-center',
    rowPadding: '2%',
  };
}

function brandSlug(brand) {
  return brand.trim().toLowerCase().replace(/\s+/g, '-');
}

function defaultHubUrls(brand) {
  return {
    research: `/${brandSlug(brand)}-research/`,
    service: '/service/service-and-parts-tips/',
    finance: '/finance/car-buying-tips/',
  };
}

function sanitizeUrl(url) {
  const trimmed = (url || '').trim();
  if (!trimmed) return '/';
  if (!trimmed.startsWith('http') && !trimmed.startsWith('/')) {
    return '/' + trimmed;
  }
  return trimmed;
}

function generateFinanceHub({
  brandName = '',
  hubResearchUrl = '',
  hubServiceUrl = '',
  financePageUrl = '',
  financeContactUsUrl = '',
}) {
  const brand = brandName.trim();
  const defaults = defaultHubUrls(brand);

  /* ---------- page basics ---------- */
  const title = 'Finance & Insurance Information';
  const slug = 'car-buying-tips';
  const parentSlug = 'finance'; // "Primary Finance Page" per the guide
  const templateName = 'DI Page Composer';

  /* ---------- Yoast SEO ---------- */
  const metaTitle =
    'Car Finance and Insurance Info | %%di_makes%% Finance %%di_city%%';
  const metaDescription =
    'Have questions about car finance and insurance? Let %%di_name%% walk you through buying or leasing a car, navigating interest rates, and much more!';

  /* ---------- Banner row ---------- */
  const financeHref = financePageUrl || '/finance/';
  const contactUsHref = financeContactUsUrl || '/contact-us/';

  const bannerHtml = [
    '<h1>Car Buying Tips</h1>',
    '<h4>From %%di_name%%</h4>',
    `<div class="center"><a class="button primary-button" href="${sanitizeUrl(financeHref)}">Finance</a> <a class="button primary-button" href="${sanitizeUrl(contactUsHref)}">Contact Us</a></div>`,
  ].join('\n');

  /* ---------- Body content row ---------- */
  const bodyHtml = [
    '<p>Whether you\'re financing or leasing a %%di_makes%% car, you\'ll want to stay informed on all things related to automotive financing. Our finance department at %%di_name%% is here to make the process less stressful by teaching you about %%di_makes%% finance and insurance, which includes auto loan finance rates, gap insurance, and more. Explore our %%di_makes%% finance offers in %%di_city%% and feel free to reach out with any questions! We want to help you make an informed and confident decision whether you are choosing a %%di_makes%% finance or %%di_makes%% insurance plan.</p>',
  ].join('\n');

  /* ---------- Closing CTAs row — links to Research + Service hubs ---------- */
  const researchHref = hubResearchUrl || defaults.research;
  const serviceHref = hubServiceUrl || defaults.service;

  const closingCtasHtml = [
    '<h2>More %%di_makes%% Information</h2>',
    `<a class="button primary-button" href="${sanitizeUrl(researchHref)}">%%di_makes%% Research</a>`,
    `<a class="button primary-button" href="${sanitizeUrl(serviceHref)}">Service &amp; Parts Info</a>`,
  ].join('\n');

  return {
    title,
    slug,
    parentSlug,
    templateName,
    metaTitle,
    metaDescription,
    sections: [
      {
        id: 'banner',
        label: 'Banner Row',
        description: 'Header Image / Full Width WYSIWYG — paste into the content box after adding the row',
        html: bannerHtml,
        config: bannerConfigDefaults(),
      },
      {
        id: 'body',
        label: 'Body Content',
        description: 'Full Width WYSIWYG — paste into the content box',
        html: bodyHtml,
        config: bodyConfigDefaults(),
      },
      buildComingSoonSection(),
      {
        id: 'closing',
        label: 'Closing CTAs',
        description: 'Full Width WYSIWYG — links to other hub pages',
        html: closingCtasHtml,
        config: closingCtasConfigDefaults(),
      },
      buildBlogFeedSection(),
      buildCssOverridesSection(),
    ],
    backgroundImageUrl: BG_IMAGE_URL,
  };
}

HubRegistry.register({ key: 'finance', label: 'Finance & Insurance Information', enabled: true }, generateFinanceHub);
})();
