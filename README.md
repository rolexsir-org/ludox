# Ludora (v1.4.0)

Ludora is a fast, premium Ludo board game delivered as a **pure static PWA**.
It requires **no backend, no serverless functions, no Node.js at runtime**, and
**no environment variables**. Everything — game engine, AI, pass-and-play,
daily challenge, and peer-to-peer (WebRTC) multiplayer with QR invite codes —
runs in the browser. It is offline-first via a service worker.

## What gets deployed

The production site is a bundle of static files served from the repo root `/`:

```
index.html              ← canonical entry point
css/app.css             ← all styles
js/*.js                 ← all scripts (engine, ai, persist, store, profile,
                          audio, board, net, sha, mp, qr, game, ui, main)
icons/*                 ← PWA icons (svg, 192, 512, maskable, apple-touch)
manifest.webmanifest    ← PWA manifest
sw.js                   ← offline service worker
```

You deploy the repository root as-is. There is **no build step** required at
deploy time (the single-file `ludora.html` is only a generated convenience
artifact used for inline previews, **not** the production entry point).

## Deploy to Vercel

1. Push the repo to GitHub and import it into Vercel (or use the Vercel CLI).
2. Do **not** select a framework. Leave the build command empty.
3. Set the **Output Directory** to `.` (the repo root) if prompted.
4. Vercel serves `index.html` from `/` and all static assets resolve. The
   `vercel.json` in the root keeps this a plain static project (no runtime,
   no framework detection) and adds an SPA fallback.

No `npm install`, no `npm run build`, no environment variables, no functions.

## Deploy to Netlify

1. **Netlify Drop**: drag the repo folder onto https://app.netlify.com/drop.
2. **Git-connected**: import the GitHub repo. Set **Build command** to empty
   and **Publish directory** to `.` (repo root).
3. `_headers` (applied automatically) sets a CSP that allows Canvas, Web Audio,
   IndexedDB, localStorage and WebRTC data channels; `_redirects` provides an
   SPA fallback to `index.html`.
4. `/`, `manifest.webmanifest`, `sw.js` and every asset resolve with HTTP 200.

No Netlify Functions, no build command, no environment variables.

## Local development

The only Node.js usage is **local dev tooling** — it is not part of the
deployed site.

```bash
npm install        # dev-only: jsdom for the test harness
npm test           # engine, persistence, QR, audit, multiplayer, integration
npm run check      # production gates: version sync, SW precache, icons, hygiene
node server.mjs    # optional local static dev server (also: npm start)
```

## Reliability & correctness

- Never depends on the service worker to boot — if SW registration is
  unavailable or fails, the game works normally.
- Offline-first precache with tolerant install (a failed precache entry never
  breaks registration), stale-cache pruning, safe update flow (never reloads
  mid-match), and a valid `index.html` offline fallback.
- Failed network responses are never cached; only successful GETs are stored.
- Paths are root-relative and work served from `/`.

## License

Internal project.
