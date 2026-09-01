/* =========================================================================
   Ludora — main.js
   Bootstrap: init UI, register service worker, handle install prompt
   and safe update flow.
   ========================================================================= */
(function () {
  'use strict';

  /* OS appearance changes (Auto mode) */
  function watchSystemTheme() {
    try {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var handler = function () {
        if (window.LudoraUI && LudoraUI.profile && LudoraUI.profile().settings.theme === 'auto') {
          LudoraUI.applyAppearance();
        }
      };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else if (mq.addListener) mq.addListener(handler);
    } catch (e) {}
  }
  /* appearance changed in another tab → follow it live */
  function watchCrossTab() {
    window.addEventListener('storage', function (e) {
      if (!e || e.key !== 'ludora:profile.v1' || !window.LudoraUI) return;
      LudoraUI.reloadProfile();
      LudoraUI.applyAppearance();
      if (LudoraUI.applyView) LudoraUI.applyView();
    });
  }

  function boot() {
    try {
      if (window.LudoraEngine && (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.hash === '#debug')) {
        LudoraEngine.setStrict(true);   // dev/test builds assert invariants every transition
      }
      LudoraUI.init();
      watchSystemTheme();
      watchCrossTab();
      /* reconcile the async IndexedDB copy with the localStorage mirror;
         if IDB turned out fresher, reload the profile behind the scenes */
      if (window.LudoraPersist) {
        LudoraPersist.hydrate().then(function (h) {
          if (h && h.fromIdb && h.replaced.length && window.LudoraUI.reloadProfile) {
            LudoraUI.reloadProfile();
          }
        }).catch(function () {});
      }
    } catch (e) {
      /* never leave the user with a blank screen */
      document.body.insertAdjacentHTML('beforeend',
        '<div style="position:fixed;inset:0;display:grid;place-items:center;background:#0B0C10;color:#F4F5F7;font:600 15px -apple-system,Roboto,sans-serif;text-align:center;padding:30px">Something went wrong starting the game.<br/>Reload to try again.</div>');
      return;
    }
    registerSW();
    hookInstall();
  }

  /* ---- update safety ----------------------------------------------------
     A new service worker may install any time, but the page only reloads
     at a SAFE moment: never during an active match — online matches are
     deliberately not persisted, so a reload would destroy them. The user
     is offered the update; if they decline/delay, the app keeps running
     on the current version and applies it next (safe) launch. */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    var pendingWorker = null;
    function safeNow() {
      try { return window.LudoraUI && LudoraUI.safeToReload && LudoraUI.safeToReload().safe; }
      catch (e) { return true; }
    }
    function applyUpdate() {
      if (!pendingWorker) return;
      if (!safeNow()) {
        LudoraUI.toast('Update ready — it will apply when your match ends', 'info', 'refresh');
        return;
      }
      try { pendingWorker.postMessage({ type: 'SKIP_WAITING' }); } catch (e) {}
    }
    function offerUpdate() {
      if (!pendingWorker) return;
      LudoraUI.toast('Update ready — tap to restart', 'good', 'refresh');
      var t = document.getElementById('toasts').lastChild;
      if (t) {
        t.style.pointerEvents = 'auto';
        t.addEventListener('click', applyUpdate, { once: true });
      }
    }
    try {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              pendingWorker = reg.waiting || nw;
              offerUpdate();
            }
          });
        });
        if (reg.waiting && navigator.serviceWorker.controller) {
          pendingWorker = reg.waiting;
          offerUpdate();
        }
        /* auto-apply once the app reaches a safe state (e.g. match ended,
           user returned home) — never before */
        var applyWhenSafe = setInterval(function () {
          if (!pendingWorker) { clearInterval(applyWhenSafe); return; }
          if (safeNow()) {
            clearInterval(applyWhenSafe);
            try { pendingWorker.postMessage({ type: 'SKIP_WAITING' }); } catch (e) {}
          }
        }, 5000);
        var reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          if (reloading) return;
          if (!safeNow()) return;      // paranoia: controller changed without our ask
          reloading = true;
          location.reload();
        });
      }).catch(function () { /* SW is an enhancement; the game works regardless */ });
    } catch (e) { /* ignore */ }
  }

  function hookInstall() {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      LudoraUI.setInstallEvent(e);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
