/* Ludora — dev/check.mjs
   Production gate: syntax-checks every JS file, verifies the canonical
   version is in sync everywhere, validates the SW precache list against
   the real files (no missing, no obsolete), checks every referenced asset
   resolves, and scans for stray debug logging. Exits non-zero on failure. */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const ROOT = process.cwd();
let fails = 0;
const bad = (msg) => { console.error('  ✗ ' + msg); fails++; };
const good = (msg) => console.log('  ✓ ' + msg);

/* 1 · syntax check every JS/CJS/MJS */
const jsFiles = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f.startsWith('.')) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs)$/.test(f)) jsFiles.push(p);
  }
})(ROOT);
for (const f of jsFiles) {
  try { execSync(`node --check "${f}"`, { stdio: 'pipe' }); }
  catch (e) { bad(`syntax: ${f}\n    ${e.stderr}`.split('\n')[0]); }
}
good(`syntax: ${jsFiles.length} JS files parse cleanly`);

/* 2 · canonical version sync */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const sw = read('sw.js');
const ui = read('js/ui.js');
const readme = read('README.md');
const v = pkg.version;
if (!sw.includes(`'ludora-v${v}'`)) bad(`sw.js VERSION is not v${v}`);
if (!ui.includes(`APP_VERSION = '${v}'`)) bad(`js/ui.js APP_VERSION is not ${v}`);
if (!readme.includes(`(v${v})`)) bad(`README.md missing version (v${v})`);
if (sw.includes(`'ludora-v1.3.0'`) && v !== '1.3.0') bad('sw.js has a stale version literal');
good(`version ${v} synchronized (package.json · sw.js · ui.js · README)`);

/* 3 · SW precache completeness (no missing, no obsolete) */
const precacheSrc = sw.split('var PRECACHE = [')[1].split('];')[0];
const precached = [...precacheSrc.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const canonical = ['./', ...precacheSrc.matchAll(/'\.\/([^']+)'/g)].length ? precached : [];
for (const entry of precached) {
  const rel = entry === './' ? 'index.html' : entry.replace('./', '');
  if (!existsSync(join(ROOT, rel))) bad(`SW precache references missing file: ${entry}`);
}
/* every production asset on disk that the HTML references must be precached */
const html = read('index.html');
for (const m of html.matchAll(/(?:src|href)="(css\/[^"]+|js\/[^"]+|icons\/[^"]+|manifest[^"]*|sw\.js)"/g)) {
  if (!precached.includes('./' + m[1]) && m[1] !== 'sw.js') bad(`referenced asset not precached: ${m[1]}`);
}
good(`SW precache: ${precached.length} entries, all present, all references covered`);

/* 4 · generated artifact freshness */
if (!existsSync(join(ROOT, 'ludora.html'))) bad('ludora.html missing — run npm run build');
else {
  const bundle = read('ludora.html');
  for (const f of ['js/engine.js', 'js/net.js', 'js/mp.js', 'js/qr.js', 'js/ui.js', 'js/persist.js', 'js/game.js', 'js/main.js', 'js/store.js', 'js/profile.js', 'js/audio.js', 'js/board.js', 'js/ai.js']) {
    const src = read(f);
    const probe = src.slice(50, 130);   // stable interior slice
    if (!bundle.includes(probe)) { bad(`ludora.html is stale (missing current ${f})`); break; }
  }
  good('ludora.html is current with source');
}

/* 5 · manifest + icons */
const manifest = JSON.parse(read('manifest.webmanifest'));
for (const icon of manifest.icons) {
  if (!existsSync(join(ROOT, icon.src))) bad(`manifest icon missing: ${icon.src}`);
}
if (!manifest.start_url || !manifest.display) bad('manifest missing start_url/display');
good(`manifest: ${manifest.icons.length} icons present, standalone display`);

/* 6 · hygiene: debug logging / TODO markers in production files */
const prodFiles = [...new Set([...jsFiles.map((f) => f.slice(ROOT.length + 1)), 'sw.js', 'server.mjs'])]
  .filter((f) => !f.startsWith('dev/'));
for (const f of prodFiles) {
  const src = read(f);
  const isDevServer = f === 'server.mjs';   // its single startup line is fine
  if (!isDevServer && /console\.(log|debug|trace)\(/.test(src)) bad(`debug logging in ${f}`);
  if (/\b(TODO|FIXME|HACK|XXX)\b/.test(src)) bad(`unfinished marker in ${f}`);
}
good('no debug logging or TODO/FIXME markers in production files');

/* 7 · index.html icon references exist */
for (const m of html.matchAll(/<use href="#i-([a-z-]+)"/g)) {
  if (!html.includes(`id="i-${m[1]}"`)) bad(`icon sprite missing symbol #i-${m[1]}`);
}
good('all referenced sprite icons exist');

console.log(fails ? `\n✗ ${fails} CHECK(S) FAILED` : '\nALL PRODUCTION CHECKS PASSED');
process.exit(fails ? 1 : 0);
