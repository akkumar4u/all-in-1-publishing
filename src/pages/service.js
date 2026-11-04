/**
 * PAGE TYPE: Service & Parts hub
 *
 * Everything this page type needs lives in THIS file — its template AND its own
 * private copies of every helper it uses (blog-feed row, URL cleaners, etc.).
 * Nothing here is shared with the other page types, so editing this file can
 * only ever change the Service & Parts hub output.
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

function generateServiceHub({
  brandName = '',
  serviceSpecialsUrl = '/service-specials/',
  partsSpecialsUrl = '/parts-specials/',
  hubResearchUrl = '',
  hubFinanceUrl = '',
}) {
  const brand = brandName.trim();
  const defaults = defaultHubUrls(brand);

  /* ---------- page basics ---------- */
  const title = 'Service & Parts Information';
  const slug = 'service-and-parts-tips';
  const parentSlug = 'service';
  const templateName = 'DI Page Composer';

  /* ---------- Yoast SEO (static %%di_makes%% shortcode, no brand substitution) ---------- */
  const metaTitle =
    'Service and Parts Tips | %%di_makes%% Service and Parts Information';
  const metaDescription =
    'Our team of experienced, factory-trained technicians can help you keep your car performing at its best. Learn about %%di_makes%% parts and service information, so you can take care of your model properly!';

  /* ---------- Banner row ---------- */
  const bannerHtml = [
    '<h1>Service and Parts Tips</h1>',
    '<h4>From %%di_name%%</h4>',
    `<div class="center"><a class="button primary-button" href="${sanitizeUrl(serviceSpecialsUrl)}">Service Specials</a> <a class="button primary-button" href="${sanitizeUrl(partsSpecialsUrl)}">Parts Specials</a></div>`,
  ].join('\n');

  /* ---------- Body content row ---------- */
  const bodyHtml = [
    '<p>After you drive off our lot in a different ride, you can rely on our knowledgeable %%di_makes%% service department at %%di_name%% to help you keep your car running in prime condition. Even if you didn\'t purchase your vehicle from us, we\'re happy to help you as well! From how often to rotate your tires or when you need brake repairs to what is the maintenance schedule for your model, we have all the %%di_makes%% service information ready for you. As your source for auto repair in %%di_city%%, %%state%%, we will inform you on %%di_makes%% parts and service!</p>',
    '<p>When your car needs parts replacement, you can count on us to use strictly genuine OEM %%di_makes%% parts every time. Our parts department has a well-stocked inventory on hand and we can also help you order the right parts for your needs and even install them at our %%di_makes%% service center. Doing a DIY project? We want to share our %%di_makes%% parts tips and tricks, so you can complete the project successfully! If you have any specific questions about %%di_makes%% parts and accessories, reach out to our parts department in %%di_city%% when you are free.</p>',
  ].join('\n');

  /* ---------- Closing CTAs row — links to Finance + Research hubs ---------- */
  const researchHref = hubResearchUrl || defaults.research;
  const financeHref = hubFinanceUrl || defaults.finance;

  const closingCtasHtml = [
    '<h2>More %%di_makes%% Information</h2>',
    `<a class="button primary-button" href="${sanitizeUrl(financeHref)}">Finance &amp; Insurance Info</a>`,
    `<a class="button primary-button" href="${sanitizeUrl(researchHref)}">%%di_makes%% Research</a>`,
  ].join('\n');

  /* ---------- assembled result ---------- */
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

HubRegistry.register({ key: 'service', label: 'Service & Parts Information', enabled: true }, generateServiceHub);
})();
