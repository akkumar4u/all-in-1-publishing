// Loads both tools' original background scripts, unmodified, into the one
// service worker MV3 allows per extension. Static import (not importScripts)
// is used so each file keeps its own module scope — both originals declare
// same-named top-level consts (STATUS_KEY, GOOGLE_DOC_ID, PARSER_DOCUMENT,
// parserDocumentPromise, etc.), which would collide as classic scripts but
// don't as separate ES modules. Each file's chrome.runtime.onMessage and
// chrome.tabs.onUpdated listeners register independently and only act on
// their own storage keys/message types, so both tools keep working side by side.
import './hub_background.js';
import './blog_background.js';
// Salesforce ticket lookup lives in its own folder and only talks to the popup
// through its own SF_* messages, so it can't affect the hub or blog code.
import './salesforce/sf_background.js';
// Landing-page banner image from the Dealer Inspire Image Library.
import './images/img_background.js';
// Auto-update: when the build in the shared folder changes, this extension reloads itself (see updater.js).
import './updater.js';

// The tool lives in Chrome's side panel (not a toolbar popup), so it stays open while WordPress, the Image Library
// and the Salesforce helper take focus. Clicking the extension icon opens / closes the panel.
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch { /* older Chrome */ }
