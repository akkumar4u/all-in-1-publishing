const SETTINGS_KEY = 'bulkSettings';

async function settings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  return {
    url: String(stored.serverUrl || '').trim().replace(/\/+$/, ''),
    key: String(stored.serverToken || '').trim(),
  };
}

export async function buildPublishingPayload(payload = {}) {
  const config = await settings();
  requireConfig(config);
  let response;
  try {
    response = await fetch(config.url + '/api/build-payload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': config.key },
      body: JSON.stringify(payload), cache: 'no-store',
    });
  } catch { throw new Error('Could not reach the private page builder. Check Bulk dashboard → Settings and try again.'); }
  let data = {};
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !data.ok || !data.result) throw new Error(data.error || ('Private page builder failed (HTTP ' + response.status + ').'));
  return data.result;
}

function requireConfig(config) {
  if (!config.url || !config.key) {
    throw new Error('Set the private Vercel server URL and access key in Bulk dashboard → Settings first.');
  }
  if (!/^https:\/\//i.test(config.url)) throw new Error('The private server URL must start with https://.');
}

export async function checkPrivateServer(saved = null) {
  const config = saved ? { url: String(saved.serverUrl || '').trim().replace(/\/+$/, ''), key: String(saved.serverToken || '').trim() } : await settings();
  requireConfig(config);
  let response;
  try {
    response = await fetch(`${config.url}/api/healthz`, { headers: { 'X-API-Key': config.key }, cache: 'no-store' });
  } catch {
    throw new Error('Could not reach the private Vercel server. Check the server URL and your internet connection.');
  }
  let data = {};
  try { data = await response.json(); } catch { /* show the status below */ }
  if (!response.ok || !data.ok) throw new Error(data.error || `Private server connection failed (HTTP ${response.status}).`);
  return data;
}

export async function parseOnPrivateServer(type, sourceHtml, ownHost = '') {
  const config = await settings();
  requireConfig(config);
  let response;
  try {
    response = await fetch(`${config.url}/api/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.key },
      body: JSON.stringify({ type, sourceHtml, ownHost }),
      cache: 'no-store',
    });
  } catch {
    throw new Error('Could not reach the private Vercel parser. Check the server URL and try again.');
  }
  let data = {};
  try { data = await response.json(); } catch { /* handled as a server response error */ }
  if (!response.ok || !data.ok || !data.result) throw new Error(data.error || `Private parser failed (HTTP ${response.status}).`);
  return data.result;
}

export async function verifyButtonUrlsOnPrivateServer(buttonsHtml, websiteUrl = '') {
  const config = await settings();
  requireConfig(config);
  let response;
  try {
    response = await fetch(`${config.url}/api/verify-buttons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.key },
      body: JSON.stringify({ buttonsHtml, websiteUrl }),
      cache: 'no-store',
    });
  } catch {
    throw new Error('Could not reach the private button checker.');
  }
  let data = {};
  try { data = await response.json(); } catch { /* handled as a server response error */ }
  if (!response.ok || !data.ok || !Array.isArray(data.checks)) throw new Error(data.error || `Private button check failed (HTTP ${response.status}).`);
  return data.checks;
}

export async function runPrivateQa(payload = {}) {
  const config = await settings();
  requireConfig(config);
  let response;
  try {
    response = await fetch(`${config.url}/api/qa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.key },
      body: JSON.stringify(payload), cache: 'no-store',
    });
  } catch { throw new Error('Could not reach the private QA service.'); }
  let data = {};
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !data.ok || !Array.isArray(data.checks)) throw new Error(data.error || `Private QA failed (HTTP ${response.status}).`);
  return data.checks;
}

export async function verifyPublishedPageOnPrivateServer(url, expectedTitle = '') {
  const config = await settings();
  requireConfig(config);
  let response;
  try {
    response = await fetch(`${config.url}/api/verify-published`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': config.key },
      body: JSON.stringify({ url, expectedTitle }), cache: 'no-store',
    });
  } catch { throw new Error('Could not reach the private published-page checker.'); }
  let data = {};
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !data.ok || !Array.isArray(data.checks)) throw new Error(data.error || `Published-page check failed (HTTP ${response.status}).`);
  return { finalUrl: String(data.finalUrl || ''), checks: data.checks };
}
