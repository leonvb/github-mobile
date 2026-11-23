/*
 * Service worker registration + update plumbing.
 *
 * Loaded as a classic (non-module) script so it runs even if a module fails to
 * parse, and deliberately small and stable so it is not the thing that goes
 * stale.
 *
 * Two jobs:
 *   1. register the worker, and when a new version is installed, swap it in
 *      immediately and reload once so the user is actually running new code.
 *   2. expose window.pocketCommitUpdate(), used by the app's "check for
 *      updates" action, which also clears the shell cache.
 */

(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  var reloading = false;
  function reloadOnce() {
    if (reloading) return;
    reloading = true;
    location.reload();
  }

  window.addEventListener('load', function () {
    // `updateViaCache: 'none'` keeps the browser from answering the worker
    // script request out of the HTTP cache — otherwise a deploy can sit
    // invisible behind a stale sw.js, which is exactly the trap this replaces.
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(function (reg) {
      // A worker that is already waiting means a deploy landed while this page
      // was open: take it over now.
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      reg.addEventListener('updatefound', function () {
        var installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', function () {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            // New version installed and an old one was in control: activate it.
            installing.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });

      // Check for a new deploy whenever the page is brought back to the front —
      // this is the common case on a phone, where the tab is resumed rather
      // than reloaded.
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') reg.update().catch(function () {});
      });
    }).catch(function () { /* offline support is optional */ });

    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
  });

  /**
   * Hard refresh: drop the shell cache, unregister the worker, reload.
   * Resolves to false if anything failed, so the caller can fall back to a
   * plain reload.
   */
  window.pocketCommitUpdate = function () {
    var tasks = [];
    if ('caches' in window) {
      tasks.push(caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }));
    }
    if (navigator.serviceWorker.getRegistrations) {
      tasks.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      }));
    }
    return Promise.all(tasks).then(function () {
      location.reload();
      return true;
    }).catch(function () {
      location.reload();
      return false;
    });
  };
})();
