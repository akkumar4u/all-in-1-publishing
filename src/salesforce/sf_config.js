/**
 * Salesforce lookup — settings. If Salesforce changes a label or your sites use a
 * different WordPress admin path, change it HERE (nothing else needs editing).
 */
export const SF_CONFIG = {
  origin: 'https://cars-commerce.lightning.force.com',
  homePath: '/lightning/page/home',

  // API name of the ticket object (from the record URL: /lightning/r/Service_Task__c/<id>/view)
  ticketObject: 'Service_Task__c',

  // Field labels as they appear on the record
  subjectLabels: ['Subject', 'Service Task Subject', 'Task Subject'],   // first one found is used
  accountLabel: 'Account',
  websiteLabel: 'Website',

  // A ticket is "Group 1" if this text shows up in the ticket's details or the account name.
  // (The popup shows what it matched and lets you correct it.)
  group1Pattern: '\\bgroup\\s*1\\b',

  // Website -> WordPress admin URL:  https://dealer.com  ->  https://dealer.com/wp/wp-admin
  wpAdminPath: '/wp/wp-admin',

  // Links to these hosts are never treated as the dealer's website
  ignoredWebsiteHosts: ['force.com', 'salesforce.com', 'salesforce-setup.com', 'visualforce.com'],

  // The Account hover card never showed a website in timing tests (it just burned its 6s timeout), so it is
  // off by default. Set to true to try it again before opening the Account.
  tryHover: true,

  timeouts: {
    pageLoadMs: 45000,   // each page navigation
    homeSettleMs: 30000, // Salesforce may redirect a few times before the home page is ready
    loginConfirmMs: 12000, // staying on a login-looking page this long = really logged out
    searchSettleMs: 15000, // MAX wait for the page to be really ready (spinner gone + search button stopped moving); usually ends in 2-3s
    searchMs: 20000,     // finding the search box / the ticket in results
    detailsMs: 25000,    // waiting for the Details tab content to appear
    hoverMs: 3500,       // waiting for the Account hover card
    accountPageMs: 20000 // fallback: Website field on the Account page
  },
};
