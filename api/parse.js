const { parseGoogleDoc } = require('../server/parser-service');

const MAX_HTML_BYTES = 4 * 1024 * 1024;

function allowCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Cache-Control', 'no-store');
}

function validKey(supplied, expected) {
  if (!supplied || !expected) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  return a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST.' });

  const expected = process.env.CONTENT_STUDIO_API_KEY;
  if (!expected) return res.status(503).json({ ok: false, error: 'The private server is not configured yet.' });
  if (!validKey(req.headers['x-api-key'], expected)) return res.status(401).json({ ok: false, error: 'The private server key is missing or invalid.' });

  const { type, sourceHtml, ownHost = '' } = req.body || {};
  if (!['hub', 'blog'].includes(type)) return res.status(400).json({ ok: false, error: 'Unknown parser type.' });
  if (typeof sourceHtml !== 'string' || !sourceHtml.trim()) return res.status(400).json({ ok: false, error: 'Google Docs returned an empty document.' });
  if (Buffer.byteLength(sourceHtml, 'utf8') > MAX_HTML_BYTES) return res.status(413).json({ ok: false, error: 'This Google Doc is too large to process.' });

  try {
    const result = parseGoogleDoc(type, sourceHtml, ownHost);
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    console.error('Private document parsing failed:', error?.name || 'parser error');
    return res.status(422).json({ ok: false, error: 'The Google Doc could not be parsed. Check the document and try again.' });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } } };
