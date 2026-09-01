/* =========================================================================
   Ludora — sw.js
   Offline-first service worker. The app is a pure static PWA and never
   depends on this file to boot: every page load works without it, and if
   registration is unavailable or fails the game runs normally.
   ========================================================================= */
'use strict';

var VERSION = 'ludora-v1.4.0';
var PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/engine.js',
  './js/ai.js',
  './js/persist.js',
  './js/store.js',
  './js/profile.js',
  './js/audio.js',
  './js/board.js',
  './js/net.js',
  './js/sha.js',
  './js/mp.js',
  './js/qr.js',
  './js/game.js',
  './js/ui.js',
  './js/main.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];
var CACHE_NAME = VERSION;

/* resolve a cache lookup for the shell that works both from a real browser
   (relative URL resolution against the SW scope) and from strict test
   sandboxes that key caches by an absolute URL. */
function cachedShell() {
  var origin = (self.location && self.location.origin) || '';
  return caches.match('./index.html')
    .then(function (hit) { return hit || caches.match('./'); })
    .then(function (hit) { return hit || caches.match(origin + '/./index.html'); })
    .then(function (hit) { return hit || caches.match(origin + '/index.html'); });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(PRECACHE.map(function (url) {
        /* a failed precache entry must never break installation */
        return cache.add(url).catch(function () { return undefined; });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) { return caches.delete(key); }
        return undefined;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (!req || req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (!self.location || url.origin !== self.location.origin) return;

  /* ---- navigations: network-first, cached-shell fallback, never cache errors ---- */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
          return res;
        }
        return cachedShell().then(function (hit) { return hit || res; });
      }).catch(function () {
        return cachedShell();
      })
    );
    return;
  }

  /* ---- assets: stale-while-revalidate, cache only successful responses ---- */
  event.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return hit;
      });
      return hit || network;
    })
  );
});
