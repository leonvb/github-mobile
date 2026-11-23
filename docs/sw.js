/*
 * Offline shell cache.
 *
 * Strategy: **network-first for everything same-origin**, cache as the
 * offline fallback. That is deliberately the opposite of "cache-first", which
 * is what this worker used to do and why a deploy could go unseen: a cached
 * script is served forever and the browser has no reason to fetch the new one.
 *
 * API traffic (api.github.com) is never touched here — it must always be live.
 */

const VERSION = 'pocket-commit-v3';
const BUILD = '2026-11-23.3';

const SHELL = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './js/boot.js',
  './js/app.js',
  './js/github.js',
  './js/store.js',
  './js/ui.js',
  './js/util.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

/* ---------------- lifecycle ---------------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Precache the shell so the app opens offline. A failure here (a single
    // 404, a flaky network) must not block activation.
    try {
      const cache = await caches.open(VERSION);
      await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    } catch {
      /* offline-first launch still works via the fetch fallback */
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
    await self.clients.claim();
    // Tell open pages a new worker is in charge, so they can refresh once.
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach((client) => client.postMessage({ type: 'PC_ACTIVATED', build: BUILD }));
  })());
});

// Pages (and the "Force update" button) can ask a waiting worker to take over.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ---------------- fetch ---------------- */

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Cross-origin (api.github.com, avatar images) is never intercepted.
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);

  try {
    // `cache: 'no-cache'` revalidates with the server, so a deploy is picked up
    // on the next load instead of being masked by the HTTP cache.
    const fresh = await fetch(request, { cache: 'no-cache' });
    if (fresh && fresh.ok && fresh.type === 'basic') {
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    // Offline: serve whatever we have.
    const hit = await cache.match(request);
    if (hit) return hit;

    const shared = await caches.match(request);
    if (shared) return shared;

    if (request.mode === 'navigate') {
      const shell = (await cache.match('./index.html')) || (await caches.match('./index.html'));
      if (shell) return shell;
    }
    return Response.error();
  }
}
