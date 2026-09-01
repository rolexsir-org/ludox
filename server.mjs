/* =========================================================================
   Ludora — server.mjs
   OPTIONAL local development server. The deployed site is a pure static PWA;
   this is NOT used in production on Vercel or Netlify, it only lets you
   preview the repo locally without any external tooling.

   run: node server.mjs   (or: npm start)
   ========================================================================= */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    filePath = filePath.replace(/^[/\\]+/, '');
    let full = resolve(join(ROOT, filePath || 'index.html'));
    if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (filePath === '' || filePath === '.') full = join(ROOT, 'index.html');
    let info = await stat(full).catch(() => null);
    if (info && info.isDirectory()) full = join(full, 'index.html');
    let body = await readFile(full).catch(() => null);
    if (!body) {
      /* SPA fallback for the PWA (hash routing means this is only for
         deep links; the app itself never navigates to real paths) */
      full = join(ROOT, 'index.html');
      body = await readFile(full).catch(() => null);
    }
    if (!body) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500);
    res.end('Internal server error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[ludora] dev server at http://0.0.0.0:' + PORT);
});
