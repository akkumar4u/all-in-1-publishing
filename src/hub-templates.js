/**
 * Hub / page template entry point.
 *
 * This file no longer contains any page templates. Each page type has its own
 * self-contained file in /pages (service.js, research.js, finance.js,
 * comparison.js, landing.js) and registers itself with HubRegistry.
 * To change one page type, edit only its file in /pages.
 */
function generateHub(typeKey, inputs) {
  return HubRegistry.generate(typeKey, inputs);
}
