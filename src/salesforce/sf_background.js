/**
 * Salesforce ticket lookup — orchestration (runs in the extension's service worker).
 *
 *  1. Opens Salesforce in a helper window (your normal logged-in browser session)
 *  2. Searches the ticket number, opens the ticket
 *  3. Reads the Google Doc link(s) from the Details tab
 *  4. Reads the Account's website (hover card first, Account page as fallback)
 *  5. Derives the WordPress admin URL from the website, closes the helper window
 *
 * The result is saved to chrome.storage.session so it survives the popup closing.
 * Nothing here touches the page templates, the blog code, or the WordPress fill code.
 */
import { SF_CONFIG as C } from './sf_config.js';
import { sfPageRun } from './sf_page.js';
import { trustedSearch } from './sf_search.js';
import { startTimeLog } from '../timelog.js';
import { classifyTask, cleanAccountName } from './sf_classify.js';
import { closeHelperWindow } from '../win_util.js';

const STATE_KEY = 'sfLookupState';
const BATCH_HELPER_KEY = 'sfBulkSalesforceHelper';
const STALE_MS = 3 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getState() {
  return (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] || null;
}
async function setState(patch) {
  const next = { ...((await getState()) || {}), ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ [STATE_KEY]: next });
  return next;
}
async function addLog(lines) {
  const cur = (await getState()) || {};
  const log = [...(cur.log || []), ...[].concat(lines)].slice(-60);
  await setState({ log });
}

/* ---------- helpers ---------- */

function navigate(tabId, url, timeoutMs = C.timeouts.pageLoadMs) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    const cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Salesforce page took too long to load.')); }, timeoutMs);
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) { cleanup(); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch(err => { cleanup(); reject(err); });
  });
}

// Is this URL a Lightning page on your Salesforce (not a login / redirect hop)?
function isLightningUrl(u) {
  try {
    const x = new URL(u);
    return x.origin === C.origin && !/\/(login|secur|saml|sso|identity)/i.test(x.pathname);
  } catch { return false; }
}
function looksLikeLoginUrl(u) {
  return !isLightningUrl(u) && /login|saml|sso|okta|onelogin|microsoftonline|secur\/|identity|auth/i.test(u || '');
}

// Salesforce often redirects a few times after the first load. Wait for it to settle on
// Lightning; only call it a login problem if it stays on a login-looking page.
async function waitForLightning(tabId) {
  const start = Date.now();
  let loginSince = null;
  let lastUrl = '';
  while (Date.now() - start < C.timeouts.homeSettleMs) {
    const tab = await chrome.tabs.get(tabId);
    lastUrl = tab.url || tab.pendingUrl || '';
    if (isLightningUrl(lastUrl) && tab.status === 'complete') {
      await sleep(800); // let a late redirect, if any, happen before we trust it
      const again = await chrome.tabs.get(tabId);
      if (isLightningUrl(again.url || '')) return { ok: true, url: again.url };
      lastUrl = again.url || lastUrl;
    }
    if (looksLikeLoginUrl(lastUrl)) {
      loginSince = loginSince || Date.now();
      if (Date.now() - loginSince >= C.timeouts.loginConfirmMs) return { ok: false, needsLogin: true, url: lastUrl };
    } else {
      loginSince = null;
    }
    await sleep(150);
  }
  return { ok: false, needsLogin: looksLikeLoginUrl(lastUrl), url: lastUrl };
}

async function runInPage(tabId, action, params = {}) {
  // Salesforce can remount its Lightning top frame while opening a record or
  // switching to Details. A single executeScript then rejects with
  // "Frame with ID 0 was removed" even though the tab and ticket are valid.
  // Target only the top frame, and retry this read-only action after the page settles.
  const retryableRead = action === 'readTicket';
  for (let attempt = 0; ; attempt++) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: sfPageRun,
        args: [action, C, params],
      });
      const result = res?.result;
      if (!result) throw new Error('Nothing came back from the Salesforce page.');
      if (result.log?.length) await addLog(result.log);
      return result;
    } catch (error) {
      const message = error?.message || String(error);
      const frameWasRemoved = /frame\s+with\s+id\s+0\s+was\s+removed|frame.{0,40}(removed|not found|does not exist)/i.test(message);
      if (!retryableRead || !frameWasRemoved || attempt >= 2) throw error;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error('Salesforce tab closed while reading ticket details.');
      await addLog(`Salesforce refreshed its record frame during Details read; retrying (${attempt + 1}/2).`);
      await sleep(500 * (attempt + 1));
    }
  }
}
// Accepts "dealer.com", "https://www.dealer.com/about", etc. -> "https://www.dealer.com"
function normalizeWebsite(raw) {
  let value = (raw || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value.replace(/^\/+/, '');
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!host.includes('.')) return null;
    if (C.ignoredWebsiteHosts.some(d => host === d || host.endsWith('.' + d))) return null;
    // Dealer websites copied from Salesforce sometimes use http; force the secure site origin for all follow-up work.
    url.protocol = 'https:';
    if (url.port === '80') url.port = '';
    return url.origin;
  } catch {
    return null;
  }
}

function websiteFrom(found) {
  if (!found) return null;
  return normalizeWebsite(found.href && /^https?:/i.test(found.href) ? found.href : found.text);
}

function deriveAdminUrl(website) {
  return website ? website.replace(/\/$/, '') + C.wpAdminPath : null;
}

// Real (trusted) mouse + keyboard input through chrome.debugger. Returns null if the
// debugger can't attach (e.g. DevTools is open on that tab).
async function searchWithDebugger(tabId, ticket) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    await addLog(`Could not attach the debugger (${err.message}).`);
    return null;
  }
  try {
    return await trustedSearch({
      send: (method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
      runPage: (action, params) => runInPage(tabId, action, params),
      getUrl: async () => (await chrome.tabs.get(tabId)).url || '',
      ticket, cfg: C, log: addLog,
    });
  } catch (err) {
    await addLog(`Trusted search failed: ${err.message}`);
    return null;
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

// Backup reader (DevTools protocol sees the whole page tree). Returns null if it can't attach.

// Salesforce's global-search results page, addressed directly.
function searchUrl(ticket) {
  const target = {
    componentDef: 'forceSearch:searchPageDesktop',
    attributes: {
      term: ticket,
      scopeMap: { type: 'TOP_RESULTS' },
      context: {
        FILTERS: {},
        searchSource: 'ASSISTANT_DIALOG',
        disableIntentQuery: false,
        disableSpellCorrection: false,
        searchDialogSessionId: crypto.randomUUID(),
        debugInfo: { appName: 'LightningSales', appType: 'Standard', appNamespace: 'standard', location: 'home:landing' },
      },
      groupId: 'DEFAULT',
    },
    state: {},
  };
  return `${C.origin}/one/one.app#${btoa(JSON.stringify(target))}`;
}

// Best guess first: "Publish this document" / "Content Bank" / anything unlabeled, then "Template".
function rankDocs(docs) {
  const score = d => /publish|content|copy|doc/i.test(d.label || '') ? 0 : /template/i.test(d.label || '') ? 2 : 1;
  return docs.map((d, i) => ({ ...d, i })).sort((a, b) => score(a) - score(b) || a.i - b.i).map(({ url, label }) => ({ url, label }));
}

/* ---------- the lookup ---------- */

async function runLookup(ticketRaw, { bulkBatch = false } = {}) {
  const ticket = ticketRaw.trim().toUpperCase();
  const TL = startTimeLog('timeLogSalesforce', 'Salesforce lookup ' + ticket);
  let win = null;
  let tabId = null;
  let helperTabId = null;
  let helperCreatedWindow = false;
  let keepWindow = false;
  try {
    await chrome.storage.session.set({ [STATE_KEY]: {
      status: 'running', ticket, step: 'Opening Salesforce in the background…', log: [], applied: false, updatedAt: Date.now(),
    } });

    if (bulkBatch) {
      const saved = (await chrome.storage.session.get(BATCH_HELPER_KEY))[BATCH_HELPER_KEY];
      if (saved?.tabId) {
        try {
          const existing = await chrome.tabs.get(saved.tabId);
          if (isLightningUrl(existing.url || '') || looksLikeLoginUrl(existing.url || '')) {
            tabId = existing.id;
            helperTabId = existing.id;
            helperCreatedWindow = !!saved.createdWindow;
            win = await chrome.windows.get(existing.windowId);
            await addLog('Continuing Salesforce lookup in the same tab for this ticket batch.');
          }
        } catch { await chrome.storage.session.remove(BATCH_HELPER_KEY); }
      }
      if (!tabId) {
        const tabs = await chrome.tabs.query({ url: C.origin + '/*' });
        const open = tabs.find(tab => tab.status === 'complete' && isLightningUrl(tab.url || ''));
        if (open) {
          try {
            const duplicate = await chrome.tabs.duplicate(open.id);
            tabId = duplicate.id;
            helperTabId = duplicate.id;
            win = await chrome.windows.get(duplicate.windowId);
            await addLog('Reusing the open Salesforce session for this ticket batch.');
          } catch (err) { await addLog('Could not duplicate the open Salesforce tab (' + err.message + '); opening a batch helper.'); }
        }
      }
    }
    if (!tabId) {
      win = await chrome.windows.create({
        url: 'about:blank', focused: false, type: 'normal', width: 1280, height: 900,
      });
      helperCreatedWindow = true;
      tabId = win.tabs[0].id;
      helperTabId = tabId;
      TL.lap('Open helper window');
      await navigate(tabId, C.origin + C.homePath);
    }
    if (bulkBatch && helperTabId) {
      await chrome.storage.session.set({ [BATCH_HELPER_KEY]: { tabId: helperTabId, windowId: win.id, createdWindow: helperCreatedWindow } });
    }

    const home = await waitForLightning(tabId);
    await addLog(`Salesforce page: ${home.url || '(unknown)'}`);
    TL.lap('Load Salesforce + wait until it is ready');
    if (!home.ok) {
      if (home.needsLogin) {
        keepWindow = true;
        // Leave the Salesforce helper window in the background if manual login is needed.
        await setState({ status: 'error', needsLogin: true,
          error: 'Salesforce needs a login. The helper window is in the background; bring it forward, log in, then click "Find" again.' });
      } else {
        keepWindow = true; // leave it open so you can see where it got stuck
        // Leave the Salesforce helper window in the background if manual login is needed.
        await setState({ status: 'error', needsLogin: false,
          error: `Salesforce did not reach the home page (stopped at: ${home.url || 'unknown'}). The helper window was left open in the background.` });
      }
      return;
    }

    // Lightning only builds hover/dropdown rows in a visible, focused window
    // Do not activate the helper window; keep the user's current work in front.
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await setState({ step: `Searching for ${ticket}…` });
    let ticketUrl = null;
    let subjectHint = null;                  // subject as shown in the search suggestion (backup source)
    const trusted = await searchWithDebugger(tabId, ticket);
    if (trusted?.ok && trusted.href) {
      ticketUrl = trusted.href;               // suggestion click already opened the ticket
      subjectHint = trusted.hint || null;
    } else if (trusted?.usedEnter) {
      // Enter from the suggestion list opens Salesforce results asynchronously. Do not run a second
      // synthetic search against that transitional page; navigate to the canonical results route.
      await addLog('Suggestion list did not open the ticket; opening Salesforce search results directly.');
      await navigate(tabId, searchUrl(ticket));
    } else {
      // Backup 1: in-page typing. Backup 2: open the search-results page by URL.
      if (trusted) await addLog(`${trusted.error} Trying in-page typing instead.`);
      const r0 = await runInPage(tabId, 'search', { ticket });
      if (!r0.ok) {
        await addLog(`${r0.error} Trying the search URL instead.`);
        await navigate(tabId, searchUrl(ticket));
      } else if (r0.data?.href) {
        ticketUrl = r0.data.href;
      }
    }

    if (!ticketUrl) {
      const r = await runInPage(tabId, 'findTicketLink', { ticket });
      if (!r.ok) {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        await addLog(`Page when it gave up: ${t?.url || 'unknown'}`);
        throw new Error(r.error);
      }
      ticketUrl = r.data.href;
    }

    TL.lap('Search for the ticket (type, suggestion, click)');
    await setState({ step: 'Opening the ticket…', ticketUrl });
    // The suggestion click already opened the ticket inside the running app — reloading the same page
    // re-boots all of Lightning (seconds). Only navigate if the tab is NOT already on the ticket.
    const nowUrl = ((await chrome.tabs.get(tabId).catch(() => null))?.url || '').split('#')[0];
    const alreadyOpen = nowUrl === ticketUrl.split('#')[0];
    if (!alreadyOpen) await navigate(tabId, ticketUrl);
    // Lightning only renders the record while its window is visible.
    // Do not focus or activate the Salesforce helper window.
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    if (!alreadyOpen) await sleep(500);

    await setState({ step: 'Reading the Details tab…' });
    let r = await runInPage(tabId, 'readTicket');
    if (r.ok && alreadyOpen && !r.data.account && !(r.data.docs || []).length && !r.data.subject) {
      await addLog('Ticket looked empty without a reload — reloading the page once and reading again.');
      await navigate(tabId, ticketUrl);
      await sleep(300);
      r = await runInPage(tabId, 'readTicket');
    }
    if (!r.ok) throw new Error(r.error);
    let { account } = r.data;
    let docsFound = r.data.docs || [];
    let subjectRead = r.data.subject;
    let accountNameRead = account?.name;
    if (!docsFound.length || !subjectRead || !account) {
      await addLog('Some ticket fields were not visible in the active record. Skipped whole-page backup extraction to prevent hidden prior records from supplying this ticket data.');
    }
    const docs = rankDocs(docsFound);
    const docUrls = docs.map(d => d.url);
    const accountName = cleanAccountName(accountNameRead);

    // What kind of task is this? (from the subject) and is it a Group 1 ticket?
    const subject = subjectRead || subjectHint || '';
    const g1Re = new RegExp(C.group1Pattern, 'i');
    const group1 = r.data.group1?.is
      ? { is: true, evidence: r.data.group1.evidence }
      : g1Re.test(accountName) ? { is: true, evidence: `Account name: ${accountName}` }
      : g1Re.test(subject) ? { is: true, evidence: `Subject: ${subject}` }
      : { is: false, evidence: '' };
    const task = classifyTask({ subject, group1: group1.is });
    await addLog(`Subject: ${subject || 'not found'} → ${task.label} (${task.confidence}); Group 1: ${group1.is ? 'yes' : 'no'}`);

    // The doc, subject and task type are known now — publish them while the website is still being looked up,
    // so the popup's auto-run can start importing the Google Doc straight away.
    await setState({
      step: 'Ticket read — finding the website…', accountName,
      early: { docs, docUrls, subject, group1, task: { key: task.key, label: task.label, category: task.category, confidence: task.confidence, reason: task.reason } },
    });

    let website = null;
    let websiteFromCache = false;
    // A dealer whose website was already read once does not need its Account page opened again.
    const cacheKey = (accountName || '').trim().toLowerCase();
    if (cacheKey) {
      const cache = (await chrome.storage.local.get('sfWebsiteCache')).sfWebsiteCache || {};
      const hit = cache[cacheKey];
      if (hit?.website && Date.now() - (hit.at || 0) < 60 * 24 * 3600 * 1000) {
        website = hit.website;
        websiteFromCache = true;
        await addLog(`Website for "${accountName}" taken from the saved list: ${website} (the Account page was not opened)`);
      }
    }
    if (account?.href && !website) {
      TL.lap('Open ticket + read Details');
      await setState({ step: 'Finding the website from the Account…', accountName });
      if (C.tryHover) {
        const hover = await runInPage(tabId, 'hoverAccount', { accountHref: account.href });
        website = websiteFrom(hover.data?.website);
      }

      if (!website) {
        // Preferred: click the Account link inside the running app. Fallback: load the Account page by URL.
        let inApp = false;
        try {
          const spa = await runInPage(tabId, 'openAccountInApp', { accountHref: account.href });
          inApp = !!spa.data?.navigated;
        } catch (err) { await addLog(`In-app Account open failed (${err.message}).`); }
        if (!inApp) {
          await navigate(tabId, account.href);
        }
        const acc = await runInPage(tabId, 'readAccountWebsite');
        website = websiteFrom(acc.data?.website);
      }
      if (website && cacheKey) {
        const cache = (await chrome.storage.local.get('sfWebsiteCache')).sfWebsiteCache || {};
        cache[cacheKey] = { website, at: Date.now() };
        await chrome.storage.local.set({ sfWebsiteCache: cache });
      }
    }

    TL.lap(websiteFromCache ? 'Account → website (from the saved list)' : 'Account → website');
    const warnings = [];
    if (task.category === 'unknown') warnings.push('Could not tell what kind of task this is — pick the task type below.');
    if (task.category !== 'hub' && !docUrls.length) warnings.push('No Google Doc link was found on this ticket.');
    if (!account) warnings.push('No Account was found on this ticket.');
    else if (!website) warnings.push('Could not read a website from the Account.');

    await setState({
      status: 'done', step: '', ticket, ticketUrl, docUrls, docs,
      accountName, website, adminUrl: deriveAdminUrl(website),
      subject, group1, task: { key: task.key, label: task.label, category: task.category, confidence: task.confidence, reason: task.reason },
      warnings, error: null, needsLogin: false, applied: false, websiteFromCache, early: null,
    });
  } catch (err) {
    await setState({ status: 'error', error: err.message || String(err) });
  } finally {
    TL.save();
    if (bulkBatch) {
      if (helperTabId) {
        const live = await chrome.tabs.get(helperTabId).catch(() => null);
        if (live) await chrome.storage.session.set({ [BATCH_HELPER_KEY]: { tabId: helperTabId, windowId: win?.id, createdWindow: helperCreatedWindow } });
        else await chrome.storage.session.remove(BATCH_HELPER_KEY);
      }
    } else if (win?.id && !keepWindow) {
      closeHelperWindow(win.id, win.tabs?.[0]?.id);
    }
  }
}

/* ---------- messages from the popup ---------- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case 'SF_START': {
      (async () => {
        const ticket = (message.ticket || '').trim();
        if (!ticket) return sendResponse({ ok: false, error: 'Enter a ticket number.' });
        const cur = await getState();
        if (cur?.status === 'running' && Date.now() - (cur.updatedAt || 0) < STALE_MS) {
          return sendResponse({ ok: false, error: 'A lookup is already running.' });
        }
        runLookup(ticket, { bulkBatch: !!message.bulkBatch }); // intentionally not awaited — progress goes to storage
        sendResponse({ ok: true });
      })();
      return true;
    }
    case 'SF_BATCH_DONE': {
      (async () => {
        const saved = (await chrome.storage.session.get(BATCH_HELPER_KEY))[BATCH_HELPER_KEY];
        if (saved?.createdWindow) await closeHelperWindow(saved.windowId, saved.tabId);
        else if (saved?.tabId) await chrome.tabs.remove(saved.tabId).catch(() => {});
        await chrome.storage.session.remove(BATCH_HELPER_KEY);
        sendResponse({ ok: true });
      })().catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    case 'SF_GET_STATE':
      getState().then(state => sendResponse({ ok: true, state }));
      return true;
    case 'SF_MARK_APPLIED':
      setState({ applied: true }).then(() => sendResponse({ ok: true }));
      return true;
    case 'SF_RESET':
      chrome.storage.session.remove(STATE_KEY).then(() => sendResponse({ ok: true }));
      return true;
    default:
      return false;
  }
});
