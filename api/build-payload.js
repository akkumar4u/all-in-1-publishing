const { buildPublishingPayload } = require('../server/content-service');
const MAX_BYTES = 5 * 1024 * 1024;
function allowCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key'); res.setHeader('Cache-Control', 'no-store');
}
function validKey(supplied, expected) {
  if (!supplied || !expected) return false;
  const a = Buffer.from(String(supplied)), b = Buffer.from(String(expected));
  return a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
}
module.exports = async function handler(req, res) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST.' });
  const expected = process.env.CONTENT_STUDIO_API_KEY;
  if (!expected) return res.status(503).json({ ok: false, error: 'The private server is not configured yet.' });
  if (!validKey(req.headers['x-api-key'], expected)) return res.status(401).json({ ok: false, error: 'The private server key is missing or invalid.' });
  const payload = req.body || {};
  if (!['hub', 'page', 'blog'].includes(payload.kind)) return res.status(400).json({ ok: false, error: 'Unknown publishing payload type.' });
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_BYTES) return res.status(413).json({ ok: false, error: 'The publishing payload is too large.' });
  try {
    const result = buildPublishingPayload(payload);
    if (!result) return res.status(400).json({ ok: false, error: 'The publishing payload could not be built.' });
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    const reason = String(error?.code || error?.name || 'BUILD_FAILED').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    console.error('Private payload build failed:', reason);
    return res.status(422).json({ ok: false, error: `Private page template build failed (${reason}).` });
  }
};
module.exports.config = { api: { bodyParser: { sizeLimit: '6mb' } } };
