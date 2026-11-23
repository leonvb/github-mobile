/** Render each screen and dump structure so layout/classes can be inspected. */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const ROOT = new URL('../docs', import.meta.url).pathname;

const scen = process.argv[2] || 'welcome';

const dom = new JSDOM(
  fs.readFileSync(ROOT + '/index.html', 'utf8').replace(/<script type="module"[^>]*><\/script>/, ''),
  { url: 'https://leonvb.github.io/github-mobile/', runScripts: 'outside-only', pretendToBeVisual: true },
);
const { window } = dom;
global.window = window; global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(global, 'location', { value: window.location, configurable: true });
global.HTMLElement = window.HTMLElement; global.Node = window.Node; global.NodeFilter = window.NodeFilter;
global.localStorage = window.localStorage;
window.matchMedia = () => ({ matches: true, addEventListener() {} });
window.scrollTo = () => {};
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.requestAnimationFrame = window.requestAnimationFrame;
Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'u' }, configurable: true });
Object.defineProperty(global, 'crypto', { value: window.crypto, configurable: true });

const repoTree = new Map([
  ['README.md', 'r'], ['LICENSE', 'l'],
  ['notes/2026-11-23-phnom-penh.md', 'n1'], ['notes/ideas.md', 'n2'],
  ['assets/logo.png', 'a1'], ['assets/hero.jpg', 'a2'], ['src/index.js', 's1'],
]);
const blobs = new Map([
  ['r', '# Pocket Commit\n\nA tiny app.\n'], ['l', 'MIT\n'],
  ['n1', '# Phnom Penh\n\n- breakfast: kuy teav\n- walk along the river\n'],
  ['n2', '# Ideas\n\n1. offline mode\n2. better diffs\n'], ['s1', 'console.log(1)\n'],
]);
const refs = { main: 'c0' };
const commits = { c0: { sha: 'c0', tree: 't0', parents: [] } };

const json = (d, s = 200, h = {}) => ({ ok: s < 400, status: s, headers: { get: (k) => h[k] ?? null }, text: async () => JSON.stringify(d) });
Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: async (url, opts = {}) => {
  const u = new URL(String(url)); const p = u.pathname; const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (p === '/user') return json({ login: 'leonvb', name: 'Leon', avatar_url: 'https://avatars.example/u.png' }, 200, { 'x-oauth-scopes': 'repo' });
  if (p === '/user/repos') return json([{ owner: { login: 'leonvb' }, name: 'github-mobile', full_name: 'leonvb/github-mobile', private: false, default_branch: 'main', pushed_at: '2026-11-20T10:00:00Z', description: 'phone commits', permissions: { push: true } }]);
  let m;
  if ((m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/))) return json({ owner: { login: m[1] }, name: m[2], full_name: `${m[1]}/${m[2]}`, private: false, default_branch: 'main', size: 40, html_url: '#', permissions: { push: true } });
  if (p.endsWith('/branches')) return json([{ name: 'main' }, { name: 'drafts' }]);
  if ((m = p.match(/contents\/(.*)$/))) {
    const fp = decodeURIComponent(m[1]);
    const children = new Map();
    for (const [path] of repoTree) {
      const rel = fp ? (path.startsWith(fp + '/') ? path.slice(fp.length + 1) : null) : path;
      if (rel === null) continue;
      const sl = rel.indexOf('/');
      if (sl === -1) children.set(rel, { name: rel, path: (fp ? fp + '/' : '') + rel, sha: repoTree.get(path), type: 'file' });
      else children.set(rel.slice(0, sl), { name: rel.slice(0, sl), path: (fp ? fp + '/' : '') + rel.slice(0, sl), sha: 'tree', type: 'dir' });
    }
    const list = [...children.values()].map((e) => ({ ...e, size: e.type === 'file' ? (blobs.get(e.sha) || '').length : 0, download_url: null, html_url: '#' }));
    if (list.length && !repoTree.has(fp)) return json(list);
    const sha = repoTree.get(fp);
    const text = blobs.get(sha) || '';
    return json({ name: fp.split('/').pop(), path: fp, sha, size: text.length, type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), download_url: null, html_url: '#' });
  }
  if ((m = p.match(/git\/ref\/heads\/(.+)$/))) { const b = decodeURIComponent(m[1]); return refs[b] ? json({ object: { sha: refs[b] } }) : json({ message: 'Not Found' }, 404); }
  if ((m = p.match(/git\/commits\/(.+)$/))) return commits[m[1]] ? json({ ...commits[m[1]], tree: { sha: 't0' } }) : json({ message: 'nf' }, 404);
  return json({ message: 'unmocked ' + method + ' ' + p }, 404);
}});

await import(ROOT + '/js/app.js');
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
await tick(120);
const P = window.__pocket;

if (scen === 'welcome') {
  console.log('=== WELCOME ===');
  console.log(dump(document.getElementById('list')));
}
if (scen === 'repo') {
  P.store.setToken('tok', { remember: false, login: 'leonvb' });
  P.gh.setAuthToken('tok');
  P.state.viewer = { login: 'leonvb', name: 'Leon', avatarUrl: 'https://avatars.example/u.png' };
  await P.openRepoByName('leonvb', 'github-mobile');
  await tick(80);
  console.log('=== REPO VIEW ===');
  console.log(dump(document.getElementById('list')));
  console.log('=== TOPBAR ===');
  console.log(dump(document.querySelector('.topbar')));
  console.log('=== SUBBAR ===');
  console.log(dump(document.getElementById('subbar')));
  console.log('=== BOTTOMBAR ===');
  console.log(dump(document.getElementById('bottombar')));
}
if (scen === 'staged') {
  P.store.setToken('tok', { remember: false, login: 'leonvb' });
  P.gh.setAuthToken('tok');
  P.state.viewer = { login: 'leonvb', name: 'Leon', avatarUrl: '' };
  await P.openRepoByName('leonvb', 'github-mobile');
  P.state.changes.push(
    { id: 'a', path: 'assets/beach.png', kind: 'put', bytes: new Uint8Array(2048), size: 2048, isNew: true },
    { id: 'b', path: 'notes/2026-11-23-phnom-penh.md', kind: 'put', bytes: new Uint8Array(120), size: 120, isNew: false, stats: { added: 4, removed: 1 } },
    { id: 'c', path: 'LICENSE', kind: 'delete', sha: 'l', size: 0 },
  );
  P.render();
  await tick(60);
  console.log('=== STAGED LIST ===');
  console.log(dump(document.getElementById('list')));
  console.log('=== BOTTOM ===');
  console.log(dump(document.getElementById('bottombar')));
}

function dump(node, depth = 0, out = []) {
  if (!node) return '';
  const pad = '  '.repeat(depth);
  const cls = node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\s+/).join('.') : '';
  const hidden = node.hidden ? ' [hidden]' : '';
  const txt = node.children.length === 0 && node.textContent.trim() ? ' «' + node.textContent.trim().slice(0, 60) + '»' : '';
  out.push(`${pad}${node.tagName.toLowerCase()}${cls}${hidden}${txt}`);
  [...node.children].forEach((c) => dump(c, depth + 1, out));
  return out.join('\n');
}
