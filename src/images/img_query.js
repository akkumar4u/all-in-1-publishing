/**
 * Turns a blog / page title into the image-library search text:
 *   "2026 BMW i4 Review: Specs, Price & Features"  ->  "2026 BMW i4"
 * Keeps the model year + make + model and drops everything after it.
 */
const STOP = /^(review|reviews|specs?|specifications?|price|prices|pricing|cost|features?|trims?|interior|exterior|performance|overview|comparison|compare|vs\.?|versus|mpg|horsepower|engine|safety|reliability|pros|cons|guide|redesign|release|changes|what|everything|to|in|at|for|and|the|a|an|is|are|how|why|new|lease|deals?|near|inventory)$/i;

export function vehicleQuery(title) {
  const t = (title || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/\b(20\d{2})\b\s+(.+)/);
  if (!m) return t.split(/\s*[:|–—]\s*|\s+-\s+/)[0].split(' ').slice(0, 5).join(' ');
  // cut at the first separator, then take words until a "topic" word starts
  const rest = m[2].split(/\s*[:|–—,(]\s*|\s+-\s+/)[0];
  const out = [];
  for (const w of rest.split(' ')) {
    if (STOP.test(w.replace(/[^\w.]/g, '')) && out.length >= 1) break;
    out.push(w);
    if (out.length >= 5) break;
  }
  return `${m[1]} ${out.join(' ')}`.trim();
}
