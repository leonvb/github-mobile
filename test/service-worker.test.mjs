/**
 * Service worker behaviour.
 *
 * The bug this guards against: the worker used a **cache-first** strategy for
 * scripts, and its own bytes never changed between deploys. The browser saw an
 * identical sw.js, so nothing re-installed, nothing refetched — and every
 * subsequent fix was invisible to anyone who had opened the app once. The app
 * appeared frozen at its first version.
 *
 * The rules now:
 *   - same-origin GETs are network-first, cache is the offline fallback
 *   - a cached copy is never served while the network is available
 *   - the cache is refreshed on every successful load
 *   - cross-origin (api.github.com) is never intercepted
 *   - activating a new version wipes the old cache and tells open pages
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = new URL('../docs', import.meta.url).pathname;
const fails = [];
const passes = [];
const ok = (name, cond, extra = '') => (cond ? passes.push(name) : fails.push(name + (extra ? ` — ${extra}` : '')));

/* ---------------- a minimal service worker environment ---------------- */
function makeWorker() {
  const listeners = {};
  const cacheStore = new Map(); // url -> { body, status }
  let networkUp = true;
  const network = new Map(); // url -> { body, status }
  const fetched = [];
  const deletedCaches = [];
  const messages = [];

  const cacheApi = (name) => ({
    async addAll(requests) {
      for (const req of requests) {
        const url = typeof req === 'string' ? req : req.url;
        if (networkUp && network.has(url)) cacheStore.set(url, { ...network.get(url), url });
        else if (!networkUp) throw new Error('offline');
      }
    },
    async put(req, res) { cacheStore.set(typeof req === 'string' ? req : req.url, { body: res.body, status: res.status, url: req.url }); },
    async match(req) {
      const url = typeof req === 'string' ? req : req.url;
      const hit = cacheStore.get(url);
      return hit ? makeResponse(hit.body, hit.status, url) : undefined;
    },
  });

  function makeResponse(body, status = 200, url = 'https://leonvb.github.io/github-mobile/x', type = 'basic') {
    return {
      ok: status < 400,
      status,
      type,
      body,
      url,
      clone() { return makeResponse(body, status, url, type); },
    };
  }

  const self = {
    location: { origin: 'https://leonvb.github.io' },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [{ postMessage: (m) => messages.push(m) }],
    },
  };

  const sandbox = {
    self,
    caches: {
      async open() { return cacheApi('v'); },
      async keys() { return ['pocket-commit-v1', 'pocket-commit-v3']; },
      async delete(key) { deletedCaches.push(key); return true; },
      async match(req) { return cacheApi('v').match(req); },
    },
    fetch: async (req, opts) => {
      const url = typeof req === 'string' ? req : req.url;
      fetched.push({ url, opts });
      if (!networkUp) throw new TypeError('Failed to fetch');
      const hit = network.get(url);
      if (!hit) return makeResponse('', 404, url);
      return makeResponse(hit.body, hit.status ?? 200, url);
    },
    Response: { error: () => makeResponse('', 0) },
    Request: class { constructor(url) { this.url = new URL(url, 'https://leonvb.github.io/github-mobile/').href; } },
    URL,
    Promise,
    console,
  };

  const source = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'sw.js' });

  async function dispatchFetch(url, { method = 'GET', mode = 'no-cors' } = {}) {
    let responded = null;
    const event = {
      request: { url, method, mode },
      respondWith(p) { responded = p; },
    };
    for (const fn of listeners.fetch || []) fn(event);
    if (!responded) return null;
    return await responded;
  }

  async function dispatchLifecycle(type) {
    const jobs = [];
    for (const fn of listeners[type] || []) fn({ waitUntil: (p) => jobs.push(p) });
    await Promise.all(jobs);
  }

  return {
    setNetwork: (up) => { networkUp = up; },
    setFile: (url, body, status = 200) => network.set(url, { body, status }),
    cacheStore,
    fetched,
    deletedCaches,
    messages,
    dispatchFetch,
    dispatchLifecycle,
  };
}

const BASE = 'https://leonvb.github.io/github-mobile/';

/* ---------------- 1. the worker's own bytes change per release ---------------- */
const swSource = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const versionMatch = swSource.match(/const VERSION = '([^']+)'/);
ok('sw.js declares a cache version', Boolean(versionMatch), versionMatch ? versionMatch[1] : 'missing');
ok('cache version is not the original v1', versionMatch && versionMatch[1] !== 'pocket-commit-v1', versionMatch && versionMatch[1]);
ok('sw.js declares a build id', /const BUILD = '[^']+'/.test(swSource));

/* ---------------- 2. network-first wins over a stale cache ---------------- */
{
  const w = makeWorker();
  w.setFile(BASE + 'js/app.js', 'OLD VERSION');
  await w.dispatchFetch(BASE + 'js/app.js');           // populate the cache
  w.setFile(BASE + 'js/app.js', 'NEW VERSION');        // deploy happens
  const res = await w.dispatchFetch(BASE + 'js/app.js');
  ok('fresh script is served, not the cached one', res && res.body === 'NEW VERSION', res && res.body);
  const cached = w.cacheStore.get(BASE + 'js/app.js');
  ok('cache is refreshed with the new bytes', cached && cached.body === 'NEW VERSION', cached && cached.body);
}

/* ---------------- 3. the fetch is revalidated, not taken from the HTTP cache ---------------- */
{
  const w = makeWorker();
  w.setFile(BASE + 'js/github.js', 'x');
  await w.dispatchFetch(BASE + 'js/github.js');
  const call = w.fetched.find((f) => f.url === BASE + 'js/github.js');
  ok('requests bypass the HTTP cache (cache: no-cache)', call && call.opts && call.opts.cache === 'no-cache',
    call && JSON.stringify(call.opts));
}

/* ---------------- 4. offline still works from the cache ---------------- */
{
  const w = makeWorker();
  await w.dispatchLifecycle('install');  // precache while online
  w.setFile(BASE + 'js/app.js', 'SAVED');
  await w.dispatchFetch(BASE + 'js/app.js');
  w.setNetwork(false);
  const res = await w.dispatchFetch(BASE + 'js/app.js');
  ok('cached asset still served offline', res && res.body === 'SAVED', res && String(res.body).slice(0, 40));
}

/* ---------------- 5. navigations fall back to the shell offline ---------------- */
{
  const w = makeWorker();
  w.cacheStore.set('./index.html', { body: '<html>shell</html>', status: 200, url: BASE + 'index.html' });
  w.cacheStore.set(BASE + 'index.html', { body: '<html>shell</html>', status: 200, url: BASE + 'index.html' });
  w.setNetwork(false);
  const res = await w.dispatchFetch(BASE + 'some/deep/link', { mode: 'navigate' });
  ok('offline navigation falls back to the shell', res && /shell/.test(res.body), res && String(res.body).slice(0, 40));
}

/* ---------------- 6. API traffic is never intercepted ---------------- */
{
  const w = makeWorker();
  const res = await w.dispatchFetch('https://api.github.com/user');
  ok('api.github.com is not intercepted', res === null, res && res.body);
  const avatar = await w.dispatchFetch('https://avatars.githubusercontent.com/u/1');
  ok('avatar host is not intercepted', avatar === null);
}

/* ---------------- 7. activation clears old caches and notifies pages ---------------- */
{
  const w = makeWorker();
  await w.dispatchLifecycle('activate');
  ok('old cache versions are deleted', w.deletedCaches.includes('pocket-commit-v1'), JSON.stringify(w.deletedCaches));
  ok('the current version is kept', !w.deletedCaches.includes('pocket-commit-v3'), JSON.stringify(w.deletedCaches));
  ok('open pages are told to refresh', w.messages.some((m) => m && m.type === 'PC_ACTIVATED'), JSON.stringify(w.messages));
}

/* ---------------- 8. boot.js provides a hard-refresh escape hatch ---------------- */
{
  const bootSource = fs.readFileSync(path.join(ROOT, 'js/boot.js'), 'utf8');
  ok('boot.js exposes pocketCommitUpdate', /window\.pocketCommitUpdate\s*=/.test(bootSource));
  ok('boot.js clears caches', /caches\.keys\(\)/.test(bootSource) && /caches\.delete/.test(bootSource));
  ok('boot.js unregisters the worker', /unregister\(\)/.test(bootSource));
  ok('boot.js reloads the page', /location\.reload\(\)/.test(bootSource));
  ok('boot.js checks for updates when the tab is resumed', /visibilitychange/.test(bootSource));
  ok('boot.js activates a waiting worker', /SKIP_WAITING/.test(bootSource));
  ok('boot.js bypasses the HTTP cache for sw.js itself', /updateViaCache:\s*'none'/.test(bootSource));

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('index.html loads boot.js', /<script src="\.\/js\/boot\.js"><\/script>/.test(html));
  ok('boot.js is a classic script (runs even if a module fails)', !/type="module"[^>]*boot\.js/.test(html));
  ok('boot.js is precached in the shell', /'\.\/js\/boot\.js'/.test(swSource));
}

/* ---------------- 9. the app surfaces the running build ---------------- */
{
  const appSource = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  ok('app.js has a BUILD constant', /const BUILD = '[^']+'/.test(appSource));
  ok('the account sheet offers "Check for updates"', /Check for updates/.test(appSource));
  ok('the update button calls the hard-refresh helper', /pocketCommitUpdate/.test(appSource));
  ok('the app no longer registers the worker itself', !/serviceWorker\.register/.test(appSource));
}

/* ---------------- 10. strategy is network-first, not cache-first ---------------- */
// Behavioural, not textual: with the network up, a changed file must win.
{
  const w = makeWorker();
  w.setFile(BASE + 'app.css', 'CACHED');
  await w.dispatchFetch(BASE + 'app.css');
  w.setFile(BASE + 'app.css', 'DEPLOYED');
  const res = await w.dispatchFetch(BASE + 'app.css');
  ok('strategy is network-first (fresh bytes win over cache)', res && res.body === 'DEPLOYED', res && res.body);
}
// A cache read before the network attempt would be the bug returning.
{
  const body = swSource.slice(swSource.indexOf('async function networkFirst'));
  const fetchAt = body.indexOf('await fetch(request');
  const cacheAt = body.indexOf('cache.match(request');
  ok('network is attempted before the cache is consulted', fetchAt !== -1 && cacheAt !== -1 && fetchAt < cacheAt,
    `fetchAt=${fetchAt} cacheAt=${cacheAt}`);
}

console.log(`\n${passes.length} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFAILURES:');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
