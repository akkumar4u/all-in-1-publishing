function allowCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Cache-Control', 'no-store');
}

module.exports = function handler(req, res) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Use GET.' });
  const expected = process.env.CONTENT_STUDIO_API_KEY;
  if (!expected) return res.status(503).json({ ok: false, error: 'The private server is not configured yet.' });
  const supplied = String(req.headers['x-api-key'] || '');
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  const crypto = require('node:crypto');
  if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'The private server key is missing or invalid.' });
  return res.status(200).json({ ok: true, service: 'content-studio-private-parser' });
};
