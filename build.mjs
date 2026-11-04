/**
 * Builds the extension from src/ into dist/ (or --out <folder>, e.g. the synced shared folder).
 *   node build.mjs                 minified build -> dist/
 *   node build.mjs --no-minify     plain copy (for finding a problem)
 *   node build.mjs --out "D:/Drive/All-in-1"   write straight into a folder
 * Every .js file is minified on its own (no bundling), so global names used between the popup's plain <script> files
 * and the module imports keep working. Docs (*.md) are left out. The LAST file written is build.json: the version label
 * plus a SHA-256 of every file; the extension uses it to update itself only when the whole folder has arrived.
 */
import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(root, 'src');
const args = process.argv.slice(2);
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : process.env.OUT_DIR;
const OUT = path.resolve(outArg || path.join(root, 'dist'));
const MINIFY = !args.includes('--no-minify') && process.env.MINIFY !== '0';

async function walk(dir, base = '') {
  const found = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) found.push(...await walk(path.join(dir, e.name), rel));
    else if (!/\.md$/i.test(e.name)) found.push(rel);
  }
  return found.sort();
}

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function buildLabel() {
  let sha = (process.env.GITHUB_SHA || '').slice(0, 7);
  if (!sha) { try { sha = execSync('git rev-parse --short=7 HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no git */ } }
  if (!sha) sha = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return sha;
}

let esbuild = null;
if (MINIFY) {
  try { esbuild = await import('esbuild'); }
  catch { console.error('esbuild is not installed — run "npm install" first (or use --no-minify).'); process.exit(1); }
}

const files = await walk(SRC);
const outFiles = {};
let before = 0, after = 0;

for (const rel of files) {
  let data = await readFile(path.join(SRC, rel));
  if (rel === 'manifest.json') {
    const m = JSON.parse(data.toString('utf8'));
    m.version_name = `${m.version} (${buildLabel()})`;
    data = Buffer.from(JSON.stringify(m, null, 2) + '\n');
  } else if (MINIFY && rel.endsWith('.js')) {
    before += data.length;
    try {
      const r = await esbuild.transform(data.toString('utf8'), { loader: 'js', minify: true, target: 'chrome114', legalComments: 'none' });
      data = Buffer.from(r.code);
    } catch (e) { console.error(`Could not minify ${rel}:\n${e.message}`); process.exit(1); }
    after += data.length;
  }
  const dest = path.join(OUT, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, data);
  outFiles[rel] = sha256(data);
}

// files of the previous build that no longer exist
try {
  const prev = JSON.parse(await readFile(path.join(OUT, 'build.json'), 'utf8'));
  for (const old of Object.keys(prev.files || {})) if (!(old in outFiles)) await unlink(path.join(OUT, old)).catch(() => {});
} catch { /* first build into this folder */ }

const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
await writeFile(path.join(OUT, 'build.json'), JSON.stringify({ versionName: manifest.version_name, builtAt: new Date().toISOString(), files: outFiles }, null, 2) + '\n');   // LAST

console.log(`Built ${Object.keys(outFiles).length} files -> ${OUT}`);
console.log(`Version: ${manifest.version_name}${MINIFY ? `  (JS ${Math.round(before / 1024)} KB -> ${Math.round(after / 1024)} KB)` : '  (not minified)'}`);
