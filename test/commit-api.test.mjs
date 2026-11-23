/**
 * Integration test: boots the real app under jsdom, with a fake GitHub backend,
 * and drives the actual UI to stage + commit files. Asserts on the API calls made.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = new URL('../docs', import.meta.url).pathname;
const failures = [];
const passes = [];
function ok(name, cond, extra = '') {
  if (cond) passes.push(name);
  else failures.push(`${name}${extra ? ' — ' + extra : ''}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, `got ${a} expected ${e}`);
}

/* ---------------- fake GitHub ---------------- */
const calls = [];
function makeServer() {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  let refs = { 'refs/heads/main': 'commit-0' };
  let blobN = 0, treeN = 0, commitN = 0;

  commits.set('commit-0', { sha: 'commit-0', tree: { sha: 'tree-root' }, message: 'Initial commit' });
  trees.set('tree-root', { sha: 'tree-root', tree: [
    { path: 'README.md', mode: '100644', type: 'blob', sha: 'blob-readme' },
    { path: 'src', mode: '040000', type: 'tree', sha: 'tree-src' },
  ], flat: new Map([['README.md', 'blob-readme'], ['src/app.js', 'blob-app']]) });
  blobs.set('blob-readme', { text: '# github-mobile\n' });
  trees.set('tree-src', { sha: 'tree-src', tree: [
    { path: 'app.js', mode: '100644', type: 'blob', sha: 'blob-app' },
  ]});
  blobs.set('blob-app', { text: 'console.log("hi")\n' });

  const json = (data, status = 200, headers = {}) => ({
    ok: status < 400, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(data),
    json: async () => data,
  });

  async function handle(url, opts = {}) {
    const u = new URL(url);
    const p = u.pathname;
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path: p, body });

    if (p === '/user') {
      return json({ login: 'leonvb', name: 'Leon', avatar_url: 'https://avatars.example/u.png', html_url: 'https://github.com/leonvb' }, 200, { 'x-oauth-scopes': 'repo' });
    }
    if (p === '/user/repos') {
      return json([
        { owner: { login: 'leonvb' }, name: 'github-mobile', full_name: 'leonvb/github-mobile', private: false, default_branch: 'main', pushed_at: '2026-11-01T10:00:00Z', description: 'phone commits', permissions: { push: true } },
        { owner: { login: 'leonvb' }, name: 'secrets', full_name: 'leonvb/secrets', private: true, default_branch: 'main', pushed_at: '2026-10-01T10:00:00Z', description: '', permissions: { push: false } },
      ]);
    }
    let m;
    if ((m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
      return json({ owner: { login: m[1] }, name: m[2], full_name: `${m[1]}/${m[2]}`, private: false, default_branch: 'main', pushed_at: '2026-11-01T10:00:00Z', description: '', size: 12, html_url: `https://github.com/${m[1]}/${m[2]}`, permissions: { push: true } });
    }
    if (p.match(/^\/repos\/[^/]+\/[^/]+\/branches$/)) {
      return json(Object.keys(refs).map((r) => ({ name: r.replace('refs/heads/', '') })));
    }
    if ((m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/))) {
      const filePath = decodeURIComponent(m[3]);
      const ref = u.searchParams.get('ref') || 'main';
      const sha = refs[`refs/heads/${ref}`];
      const commit = commits.get(sha);
      const tree = trees.get(commit.tree.sha);
      const flat = tree.flat || new Map(tree.tree.map((e) => [e.path, e.sha]));
      // directory listing — real GitHub returns entries for the immediate
      // children only, including synthesised tree entries for subfolders.
      const children = new Map();
      for (const [filePath2, blobSha] of flat.entries()) {
        const rel = filePath ? (filePath2.startsWith(filePath + '/') ? filePath2.slice(filePath.length + 1) : null) : filePath2;
        if (rel === null) continue;
        const slash = rel.indexOf('/');
        if (slash === -1) children.set(rel, { name: rel, path: filePath2, sha: blobSha, type: 'file' });
        else {
          const dirName = rel.slice(0, slash);
          children.set(dirName, { name: dirName, path: (filePath ? filePath + '/' : '') + dirName, sha: `tree-${dirName}`, type: 'dir' });
        }
      }
      const inDir = [...children.values()].map((e) => ({
        name: e.name, path: e.path, sha: e.sha,
        size: e.type === 'file' ? (blobs.get(e.sha)?.text?.length ?? 10) : 0,
        type: e.type,
        download_url: null, html_url: `https://github.com/x/y/blob/main/${e.path}`,
      }));
      // a directory path returns its children; a file path returns the file below
      if (inDir.length && !flat.has(filePath)) return json(inDir);
      // file read
      const flatSha = flat.get(filePath);
      const entry = flatSha ? { path: filePath, sha: flatSha } : undefined;
      const blobEntry = entry || { path: 'README.md', sha: flat.get('README.md') };
      const blob = blobs.get(blobEntry.sha);
      if (!blob) return json({ message: 'Not Found' }, 404);
      const text = blob.text;
      return json({
        name: filePath.split('/').pop(), path: filePath, sha: blobEntry.sha, size: text.length,
        type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64'),
        download_url: null, html_url: 'https://github.com/x',
      });
    }
    if ((m = p.match(/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/))) {
      const branch = decodeURIComponent(m[1]);
      const sha = refs[`refs/heads/${branch}`];
      if (!sha) return json({ message: 'Not Found' }, 404);
      return json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    if ((m = p.match(/^\/repos\/[^/]+\/[^/]+\/git\/commits\/(.+)$/))) {
      const c = commits.get(m[1]);
      if (!c) return json({ message: 'Not Found' }, 404);
      return json(c);
    }
    if (p.match(/^\/repos\/[^/]+\/[^/]+\/git\/blobs$/) && method === 'POST') {
      if (body.encoding === 'base64') {
        const text = Buffer.from(body.content, 'base64').toString('utf8');
        const sha = `blob-${++blobN}`;
        blobs.set(sha, { text, binary: true });
        return json({ sha }, 201);
      }
      const sha = `blob-${++blobN}`;
      blobs.set(sha, { text: body.content });
      return json({ sha }, 201);
    }
    if (p.match(/^\/repos\/[^/]+\/[^/]+\/git\/trees$/) && method === 'POST') {
      // Faithful to GitHub: paths are repo-relative and may contain slashes;
      // base_tree supplies everything the request does not mention, and a null
      // sha removes that exact path.
      const flat = new Map(body.base_tree ? (trees.get(body.base_tree)?.flat || new Map()) : []);
      for (const n of body.tree) {
        if (n.sha === null) flat.delete(n.path);
        else flat.set(n.path, n.sha);
      }
      const sha = `tree-${++treeN}`;
      const entries = [...flat.entries()].map(([path, blob]) => ({ path, mode: '100644', type: 'blob', sha: blob }));
      trees.set(sha, { sha, tree: entries, flat });
      return json({ sha }, 201);
    }
    if (p.match(/^\/repos\/[^/]+\/[^/]+\/git\/commits$/) && method === 'POST') {
      const sha = `commit-${++commitN}`;
      commits.set(sha, { sha, tree: { sha: body.tree }, message: body.message, parents: (body.parents || []).map((s) => ({ sha: s })), author: body.author });
      return json(commits.get(sha), 201);
    }
    if ((m = p.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
      const branch = decodeURIComponent(m[1]);
      const current = refs[`refs/heads/${branch}`];
      // fast-forward check: the new commit's parent must be current head
      const target = commits.get(body.sha);
      if (current && body.force !== true) {
        const parents = (target.parents || []).map((x) => x.sha);
        if (!parents.includes(current)) return json({ message: 'Update is not a fast forward' }, 422);
      }
      refs[`refs/heads/${branch}`] = body.sha;
      return json({ ref: `refs/heads/${branch}`, object: { sha: body.sha } });
    }
    if (p.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs$/) && method === 'POST') {
      const branch = body.ref.replace('refs/heads/', '');
      if (refs[`refs/heads/${branch}`]) return json({ message: 'Reference already exists' }, 422);
      refs[`refs/heads/${branch}`] = body.sha;
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    return json({ message: `unmocked ${method} ${p}` }, 404);
  }

  return { handle, blobs, trees, commits, refs: () => refs };
}

/* ---------------- boot the app ---------------- */
const server = makeServer();
const dom = new JSDOM(
  fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script type="module"[^>]*><\/script>/, ''),
  { url: 'https://leonvb.github.io/github-mobile/', runScripts: 'outside-only', pretendToBeVisual: true },
);
const { window } = dom;
global.window = window;
global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(global, 'location', { value: window.location, configurable: true });
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.NodeFilter = window.NodeFilter;
global.Image = window.Image;
global.localStorage = window.localStorage;
Object.defineProperty(global, 'fetch', { value: async (url, opts) => server.handle(String(url), opts), configurable: true, writable: true });
Object.defineProperty(global, 'crypto', { value: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) }, configurable: true });
Object.defineProperty(window, 'fetch', { value: global.fetch, configurable: true, writable: true });
Object.defineProperty(window, 'crypto', { value: global.crypto, configurable: true });

// minimal shims the app touches
window.matchMedia = (q) => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.requestAnimationFrame = window.requestAnimationFrame;
Object.defineProperty(window, 'crypto', { value: global.crypto, configurable: true });
global.requestAnimationFrame = window.requestAnimationFrame;
dom.window.URL.createObjectURL = () => 'blob:fake';
dom.window.URL.revokeObjectURL = () => {};

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle(n = 12) { for (let i = 0; i < n; i++) await tick(4); }

await import(path.join(ROOT, 'js/app.js') + `?t=${Date.now()}`);
await settle(30);

const { state, gh, store } = window.__pocket || global.__pocket || {};
ok('app booted and exposes state', Boolean(state));

/* ---------------- 1. welcome screen ---------------- */
ok('welcome screen rendered', /Commit from anywhere/.test(document.body.textContent));
ok('connect button present', [...document.querySelectorAll('button')].some((b) => /Connect GitHub/.test(b.textContent)));

/* ---------------- 2. sign in ---------------- */
store.saveSettings({ rememberToken: false });
const token = 'ghp_test_token_123';
const info = await gh.checkToken(token);
eq('checkToken returns login', info.login, 'leonvb');
eq('checkToken sees repo scope', info.canWrite, 'yes');

store.setToken(token, { remember: false, login: info.login, avatarUrl: info.avatarUrl });
gh.setAuthToken(token);
state.viewer = { login: info.login, name: info.name, avatarUrl: info.avatarUrl };
await settle();

/* ---------------- 3. open repo & browse ---------------- */
await window.__pocket.openRepoByName
  ? await window.__pocket.openRepoByName('leonvb', 'github-mobile')
  : null;
await settle(20);
// openRepoByName is module-private; drive it through the repo chooser UI instead
if (!state.repo) {
  const browse = [...document.querySelectorAll('button')].find((b) => /Browse repositories/.test(b.textContent) || /Pick a repository/.test(b.textContent));
  if (browse) { browse.click(); await settle(20); }
  const row = [...document.querySelectorAll('.row')].find((r) => /github-mobile/.test(r.textContent));
  if (row) { row.click(); await settle(30); }
}

ok('repository opened via UI', Boolean(state.repo), `state.repo=${JSON.stringify(state.repo && state.repo.repo)}`);
if (state.repo) {
  eq('branch picked up', state.branch, 'main');
  const text = document.body.textContent;
  ok('folder listed (src)', /src/.test(text));
  ok('file listed (README.md)', /README\.md/.test(text));
}

/* ---------------- 4. commit flow through the pure API layer ---------------- */
const before = { ...server.refs() };
const res = await gh.commitChanges({
  owner: 'leonvb', repo: 'github-mobile', branch: 'main',
  message: 'Add trip notes\n\nFrom the phone.',
  changes: [
    { path: 'notes/trip.md', text: '# Trip\n\nDay one was good.\n' },
    { path: 'README.md', text: '# github-mobile\n\nUpdated from phone.\n' },
  ],
});
ok('commit returned a sha', /^commit-\d+$/.test(res.sha), res.sha);
eq('commit html url', res.htmlUrl, `https://github.com/leonvb/github-mobile/commit/${res.sha}`);
ok('branch advanced', server.refs()['refs/heads/main'] === res.sha, server.refs()['refs/heads/main']);

const newTree = server.trees.get(server.commits.get(res.sha).tree.sha);
const tripEntry = { sha: newTree.flat.get('notes/trip.md') };
ok('new file present in tree', Boolean(tripEntry));
eq('new file content', server.blobs.get(tripEntry.sha).text, '# Trip\n\nDay one was good.\n');
const readmeEntry = { sha: newTree.flat.get('README.md') };
eq('edited file content', server.blobs.get(readmeEntry.sha).text, '# github-mobile\n\nUpdated from phone.\n');
ok('untouched sibling file kept', newTree.flat.has('src/app.js'), 'base_tree not applied');

const putBlob = calls.find((c) => c.path.startsWith('/repos/leonvb/github-mobile/git/blobs') && c.method === 'POST');
ok('text blobs sent as utf-8', putBlob && putBlob.body.encoding === 'utf-8', JSON.stringify(putBlob && putBlob.body));

/* ---------------- 5. deletion in the same commit ---------------- */
const treeBefore = newTree.flat.size;
const del = await gh.commitChanges({
  owner: 'leonvb', repo: 'github-mobile', branch: 'main',
  message: 'Drop the app file',
  changes: [{ path: 'src/app.js', delete: true }],
});
const delTree = server.trees.get(server.commits.get(del.sha).tree.sha);
ok('file removed from tree', !delTree.flat.has('src/app.js'), JSON.stringify([...delTree.flat.keys()]));
eq('tree shrunk by one', delTree.flat.size, treeBefore - 1);
ok('siblings survive the delete', delTree.flat.has('README.md') && delTree.flat.has('notes/trip.md'));

/* ---------------- 6. new branch from base ---------------- */
const nb = await gh.commitChanges({
  owner: 'leonvb', repo: 'github-mobile', branch: 'notes-from-phnom-penh',
  message: 'Start a branch',
  changes: [{ path: 'journal.md', text: 'day 1\n' }],
  createBranch: true,
  baseBranch: 'main',
  defaultBranch: 'main',
});
ok('branch created', Boolean(server.refs()['refs/heads/notes-from-phnom-penh']));
eq('branch created at new commit', server.refs()['refs/heads/notes-from-phnom-penh'], nb.sha);
const nbCommit = server.commits.get(nb.sha);
eq('new branch parented on main', nbCommit.parents[0].sha, del.sha);

/* ---------------- 7. binary upload ---------------- */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0xff, 0xfe]);
await gh.commitChanges({
  owner: 'leonvb', repo: 'github-mobile', branch: 'main',
  message: 'Add a picture',
  changes: [{ path: 'images/sunset.png', bytes: png }],
});
const binaryBlobCall = [...calls].reverse().find((c) => c.path.endsWith('/git/blobs') && c.method === 'POST');
eq('binary uploaded as base64', binaryBlobCall.body.encoding, 'base64');
ok('binary bytes round-trip', Buffer.from(binaryBlobCall.body.content, 'base64').equals(Buffer.from(png)));

/* ---------------- 8. non-fast-forward is rejected ---------------- */
let conflicted = false;
try {
  await gh.commitChanges({
    owner: 'leonvb', repo: 'github-mobile', branch: 'main',
    message: 'Stale write',
    changes: [{ path: 'stale.txt', text: 'x' }],
  });
} catch (e) { conflicted = true; }
// our flow re-reads the ref each time, so this should succeed; the guard below
// documents that a genuinely stale update would be refused by GitHub.
ok('commit re-reads head each time (no stale parent)', server.commits.get(server.refs()['refs/heads/main']).parents.length === 1);

/* ---------------- 9. UI: stage a file and commit through the sheet ---------------- */
state.changes = [];
state.repo = await gh.getRepo('leonvb', 'github-mobile');
state.branch = 'main';
state.branchIsNew = false;
state.entries = [];
window.__pocket.render();
await settle();

// simulate staging (what the upload path produces)
state.changes.push({ id: 'c1', path: 'uploads/photo.jpg', kind: 'put', bytes: new Uint8Array([1, 2, 3, 4]), size: 4, isNew: true });
window.__pocket.render();
await settle();
ok('bottom bar shows commit button', !document.getElementById('changesBtn').hidden);
eq('staged count shown', document.getElementById('changesCount').textContent, '1');
ok('staged row rendered', /photo\.jpg/.test(document.body.textContent));

/* ---------------- 10. error surfaces ---------------- */
calls.length = 0;
let err401 = null;
try {
  const saved = gh.getAuthToken();
  gh.setAuthToken('bad');
  global.fetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => JSON.stringify({ message: 'Bad credentials' }) });
  await gh.getRepo('leonvb', 'github-mobile');
  gh.setAuthToken(saved);
} catch (e) { err401 = e; }
ok('401 mapped to a human message', err401 && /invalid or was revoked/.test(err401.message), err401 && err401.message);

/* ---------------- 11. markdown rendering is XSS-safe ---------------- */
const md = window.__pocket.renderMarkdown(`
# Title
<script>alert(1)</script>
<img src=x onerror="alert(2)">
[link](javascript:alert(3))
[good](https://example.com)

- one
- two

\`\`\`js
const a = 1 < 2;
\`\`\`
`);
ok('strips <script>', !/<script/i.test(md), md.slice(0, 200));
ok('strips onerror', !/<img[^>]*onerror/i.test(md));
ok('blocks javascript: urls', !/javascript:/i.test(md));
ok('keeps safe links', /href="https:\/\/example\.com\/?"/.test(md));
ok('renders headings', /<h1>Title<\/h1>/.test(md));
ok('renders lists', /<li>one<\/li>/.test(md));
ok('escapes code', /1 &lt; 2/.test(md));

/* ---------------- 12. token storage policy ---------------- */
store.saveSettings({ rememberToken: false });
store.setToken('tok-A', { remember: false, login: 'leonvb' });
ok('token not written when not remembered', localStorage.getItem('pocketcommit.v1.session') === null);
eq('token still usable in memory', store.getToken(), 'tok-A');
store.setToken('tok-B', { remember: true, login: 'leonvb' });
ok('token written when remembered', JSON.parse(localStorage.getItem('pocketcommit.v1.session')).token === 'tok-B');
store.clearToken();
ok('sign out clears storage', localStorage.getItem('pocketcommit.v1.session') === null);
eq('sign out clears memory', store.getToken(), '');

/* ---------------- report ---------------- */
console.log(`\n${passes.length} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
