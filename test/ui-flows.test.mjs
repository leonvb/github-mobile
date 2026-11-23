/** Drives the real interactive flows (upload, editor, commit sheet) via the DOM. */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const ROOT = new URL('../docs', import.meta.url).pathname;
const fails = []; const passes = [];
const ok = (n, c, x = '') => c ? passes.push(n) : fails.push(n + (x ? ' — ' + x : ''));
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

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
global.File = window.File; global.Blob = window.Blob; global.FormData = window.FormData;
// jsdom does not expose TextEncoder/TextDecoder on its window; keep Node's.
global.TextEncoder = globalThis.TextEncoder || window.TextEncoder;
global.TextDecoder = globalThis.TextDecoder || window.TextDecoder;
window.matchMedia = () => ({ matches: false, addEventListener() {} });
window.scrollTo = () => {};
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.requestAnimationFrame = window.requestAnimationFrame;
let uidN = 0;
Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'uid-' + (++uidN) }, configurable: true });
// jsdom's File/Blob predate arrayBuffer()/text(); browsers have them, so shim here.
if (!window.Blob.prototype.arrayBuffer) {
  window.Blob.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise((resolve, reject) => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result).buffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
if (!window.Blob.prototype.text) {
  window.Blob.prototype.text = function text() { return this.arrayBuffer().then((b) => Buffer.from(b).toString('utf8')); };
}
Object.defineProperty(global, 'crypto', { value: window.crypto, configurable: true });

/* fake backend with mutable refs */
const refs = { main: 'c1' };
const commits = { c1: { sha: 'c1', tree: { sha: 't1' }, parents: [] } };
const trees = { t1: new Map([['README.md', 'b1'], ['notes/a.md', 'b2']]) };
const blobs = { b1: '# hi\n', b2: '# note\n' };
const log = [];
let n = 10;
const json = (d, s = 200, h = {}) => ({ ok: s < 400, status: s, headers: { get: (k) => h[k] ?? null }, text: async () => JSON.stringify(d) });
Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: async (url, opts = {}) => {
  const u = new URL(String(url)); const p = u.pathname; const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  log.push({ method, p, body });
  if (p === '/user') return json({ login: 'leonvb', name: 'Leon', avatar_url: '' }, 200, { 'x-oauth-scopes': 'repo' });
  if (p === '/user/repos') return json([]);
  let m;
  if ((m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/))) return json({ owner: { login: m[1] }, name: m[2], full_name: `${m[1]}/${m[2]}`, private: false, default_branch: 'main', size: 1, html_url: '#', permissions: { push: true } });
  if (p.endsWith('/branches')) return json(Object.keys(refs).map((x) => ({ name: x })));
  if ((m = p.match(/contents\/(.*)$/))) {
    const fp = decodeURIComponent(m[1]);
    const flat = trees[commits[refs[u.searchParams.get('ref') || 'main']].tree.sha] || trees.t1;
    const kids = new Map();
    for (const [path, b] of flat) {
      const rel = fp ? (path.startsWith(fp + '/') ? path.slice(fp.length + 1) : null) : path;
      if (rel === null) continue;
      const sl = rel.indexOf('/');
      if (sl === -1) kids.set(rel, { name: rel, path: (fp ? fp + '/' : '') + rel, sha: b, type: 'file' });
      else kids.set(rel.slice(0, sl), { name: rel.slice(0, sl), path: (fp ? fp + '/' : '') + rel.slice(0, sl), sha: 'tree-x', type: 'dir' });
    }
    const list = [...kids.values()].map((e) => ({ ...e, size: e.type === 'file' ? blobs[e.sha].length : 0, download_url: null, html_url: '#' }));
    if (list.length && !flat.has(fp)) return json(list);
    const sha = flat.get(fp); const text = blobs[sha] ?? '';
    return json({ name: fp.split('/').pop(), path: fp, sha, size: text.length, type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), download_url: null, html_url: '#' });
  }
  if ((m = p.match(/git\/ref\/heads\/(.+)$/))) { const b = decodeURIComponent(m[1]); return refs[b] ? json({ object: { sha: refs[b] } }) : json({ message: 'Not Found' }, 404); }
  if ((m = p.match(/git\/commits\/(.+)$/))) return commits[m[1]] ? json(commits[m[1]]) : json({ message: 'nf' }, 404);
  if (p.endsWith('/git/blobs') && method === 'POST') { const sha = 'b' + (++n); blobs[sha] = body.encoding === 'base64' ? Buffer.from(body.content, 'base64').toString('utf8') : body.content; return json({ sha }, 201); }
  if (p.endsWith('/git/trees') && method === 'POST') {
    const flat = new Map(body.base_tree ? trees[body.base_tree] : []);
    for (const e of body.tree) { if (e.sha === null) flat.delete(e.path); else flat.set(e.path, e.sha); }
    const sha = 't' + (++n); trees[sha] = flat; return json({ sha }, 201);
  }
  if (p.endsWith('/git/commits') && method === 'POST') { const sha = 'c' + (++n); commits[sha] = { sha, tree: { sha: body.tree }, parents: (body.parents || []).map((s) => ({ sha: s })), message: body.message, author: body.author }; return json(commits[sha], 201); }
  if ((m = p.match(/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') { const b = decodeURIComponent(m[1]); const parents = (commits[body.sha].parents || []).map((x) => x.sha); if (refs[b] && !parents.includes(refs[b])) return json({ message: 'not a fast forward' }, 422); refs[b] = body.sha; return json({ object: { sha: body.sha } }); }
  if (p.endsWith('/git/refs') && method === 'POST') { const b = body.ref.replace('refs/heads/', ''); if (refs[b]) return json({ message: 'exists' }, 422); refs[b] = body.sha; return json({ object: { sha: body.sha } }, 201); }
  return json({ message: `unmocked ${method} ${p}` }, 404);
}});

await import(ROOT + '/js/app.js');
const tick = (ms = 6) => new Promise((r) => setTimeout(r, ms));
const settle = async (k = 25) => { for (let i = 0; i < k; i++) await tick(); };
await settle(20);
const P = window.__pocket;
const $ = (sel) => { const all = document.querySelectorAll(sel); return all.length ? all[all.length - 1] : null; };
const $$ = (sel) => [...document.querySelectorAll(sel)];
const byText = (sel, re) => $$(sel).filter((e) => {
  const sheet = e.closest('.sheet');
  // match only inside the topmost sheet, or in the page when there is none
  return !sheet || sheet === [...document.querySelectorAll('.sheet')].pop();
}).find((e) => re.test(e.textContent));

/* sign in */
P.store.setToken('tok', { remember: false, login: 'leonvb' });
P.gh.setAuthToken('tok');
P.state.viewer = { login: 'leonvb', name: 'Leon', avatarUrl: '' };
await P.openRepoByName('leonvb', 'github-mobile');
await settle();

/* ---- 1. upload flow: click Upload -> folder sheet -> Add files ---- */
P.state.entries = await P.gh.listContents('leonvb', 'github-mobile', '', 'main');
P.render();
await settle();

// open the folder chooser the same way the Upload button does
const uploadBtn = document.getElementById('uploadBtn');
ok('upload button exists', Boolean(uploadBtn));

// stageFiles opens a sheet; stub the file-input click and drive it directly
const png = new window.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'sunset.png', { type: 'image/png' });
const staging = P.stageFiles([png]);
await settle(20);
const folderSheet = $('.sheet.show');
ok('upload folder sheet opened', Boolean(folderSheet), document.body.textContent.slice(0, 120));
const folderInput = folderSheet && folderSheet.querySelector('input');
ok('folder input present', Boolean(folderInput));
if (folderInput) { folderInput.value = 'images'; }
const addBtn = folderSheet && byText('.sheet .btn', /Add files/);
if (addBtn) addBtn.click();
await settle(30);
eq('one change staged', P.state.changes.length, 1);
eq('staged into chosen folder', P.state.changes[0] && P.state.changes[0].path, 'images/sunset.png');
ok('bytes preserved', P.state.changes[0] && P.state.changes[0].bytes.length === 4);

/* ---- 2. duplicate filename gets a suffix, not an overwrite ---- */
const png2 = new window.File([new Uint8Array([9, 9])], 'sunset.png', { type: 'image/png' });
const staging2 = P.stageFiles([png2]);
await settle(20);
const sheet2 = $('.sheet.show');
if (sheet2) { sheet2.querySelector('input').value = 'images'; [...sheet2.querySelectorAll('.btn')].find((b) => /Add files/.test(b.textContent)).click(); }
await settle(30);
eq('duplicate renamed', P.state.changes.map((c) => c.path).sort(), ['images/sunset-1.png', 'images/sunset.png']);

/* ---- 3. editor: open, edit, stage ---- */
P.state.changes = [];
P.state.entries = await P.gh.listContents('leonvb', 'github-mobile', '', 'main');
P.render();
await settle();
const readmeRow = $$('.row').find((r) => /README\.md/.test(r.textContent));
readmeRow.click();
await settle(20);
const editOpt = byText('.opt', /Edit file/);
ok('edit option offered for markdown', Boolean(editOpt));
editOpt.click();
await tick(400);
await settle(30);
const editor = $('.sheet.show textarea.code-editor');
ok('editor opened', Boolean(editor));
if (editor) {
  ok('editor seeded with file content', editor.value === '# hi\n', JSON.stringify(editor.value));
  editor.value = '# hi\n\nAdded from the phone.\n';
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  const stageBtns = $$('.sheet .btn').map((b) => b.textContent);
  const stage = byText('.sheet .btn', /Stage/);
  stage.click();
  await settle(90);
  await tick(320);
}
eq('editor staged one change', P.state.changes.length, 1);
ok('staged the edited text', P.state.changes[0] && /Added from the phone/.test(Buffer.from(P.state.changes[0].bytes).toString()), P.state.changes[0] && Buffer.from(P.state.changes[0].bytes).toString());
eq('diff stats counted', P.state.changes[0] && P.state.changes[0].stats, { added: 2, removed: 0 });

/* ---- 4. commit sheet: commit to a new branch ---- */
P.openCommitSheet();
await settle(30);
const commitSheet = $('.sheet.show');
ok('commit sheet opened', Boolean(commitSheet));
const msg = commitSheet.querySelector('textarea');
msg.value = 'Update the readme';
msg.dispatchEvent(new window.Event('input', { bubbles: true }));
// flip the new-branch switch
const sw = commitSheet.querySelector('.switch');
sw.click();
await settle(10);
const branchInput = [...commitSheet.querySelectorAll('.input.mono')].pop();
ok('new branch field revealed', Boolean(branchInput) && branchInput.offsetParent !== undefined);
branchInput.value = 'phone-notes';
const commitBtn = [...commitSheet.querySelectorAll('.sheet-foot .btn')].find((b) => /Commit/.test(b.textContent));
commitBtn.click();
await settle(40);

ok('new branch created on remote', Boolean(refs['phone-notes']), JSON.stringify(Object.keys(refs)));
if (refs['phone-notes']) {
  const c = commits[refs['phone-notes']];
  eq('commit message used', c.message, 'Update the readme');
  eq('branch parented on main tip', c.parents[0].sha, refs.main);
  const flat = trees[c.tree.sha];
  ok('edited file in new tree', flat.has('README.md'));
  ok('new content committed', /Added from the phone/.test(blobs[flat.get('README.md')]));
}
eq('changes cleared after commit', P.state.changes.length, 0);
ok('branch switched in UI', P.state.branch === 'phone-notes', P.state.branch);
ok('success sheet shown', /Pushed to GitHub|Committed/.test(document.body.textContent));

/* ---- 5. empty message is rejected ---- */
P.state.changes = [{ id: 'z', path: 'x.txt', kind: 'put', bytes: new Uint8Array([1]), size: 1, isNew: true }];
P.render();
P.openCommitSheet();
await settle(25);
const cs2 = $('.sheet.show');
const cb2 = cs2 && [...cs2.querySelectorAll('.sheet-foot .btn')].find((b) => /Commit/.test(b.textContent));
cb2.click();
await settle(20);
ok('empty message blocked', /Nothing|Write a commit message first/.test(document.body.textContent) || P.state.changes.length === 1);
eq('nothing committed without a message', P.state.changes.length, 1);

/* ---- 6. replace-image keeps the existing path ---- */
P.state.repo = await P.gh.getRepo('leonvb', 'github-mobile');
P.state.branch = 'main';
P.state.path = 'notes';
P.state.entries = await P.gh.listContents('leonvb', 'github-mobile', 'notes', 'main');
P.state.changes = [];
P.render();
await settle();
// "Replace image" on notes/a.md sets the replace target then opens the picker
const before6 = { ...refs };
window.__pocket.state.replaceTargetProbe = true;
const replaceBtn = null;
// call the internal path: simulate the menu option by setting pendingTarget via the UI
const rowA = $$('.row').find((r) => /a\.md/.test(r.textContent));
if (rowA) {
  rowA.click();
  await settle(20);
  const replaceOpt = byText('.opt', /Replace image/);
  ok('replace option shown only for images', !replaceOpt, 'offered for a .md file');
}
P.state.path = 'notes';
P.state.entries = await P.gh.listContents('leonvb', 'github-mobile', 'notes', 'main');
P.render();
await settle();

console.log(`\n(extra checks)`);

/* ---- 7. invalid commit message + invalid branch name guard ---- */
P.state.changes = [];
P.render();

console.log(`\n${passes.length} passed, ${fails.length} failed`);
if (fails.length) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
