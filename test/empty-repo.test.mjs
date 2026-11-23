/**
 * Regression suite for repositories with no commits.
 *
 * GitHub answers the Git Data endpoints with 409 "Git Repository is empty."
 * on a repo that has no commits — not 404. A new repository therefore looked
 * to the app like a branch conflict, and the first upload failed with
 * "The branch changed while saving."
 *
 * The fake backend here reproduces the documented GitHub behaviour:
 *
 *   GET git/ref/heads/<any>   -> 409 "Git Repository is empty."
 *   GET contents/?ref=<any>   -> 404 "This repository is empty."
 *   GET branches              -> []
 *   POST git/blobs|trees|commits -> normal
 *   POST git/refs             -> creates the first branch
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = new URL('../docs', import.meta.url).pathname;

/** Deterministic 40-char hex object ids, like GitHub's. */
const sha40 = (n) => n.toString(16).padStart(40, '0');
const fails = [];
const passes = [];
const ok = (name, cond, extra = '') => (cond ? passes.push(name) : fails.push(name + (extra ? ` — ${extra}` : '')));
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ---------------- fake backend: an empty repository ---------------- */
const calls = [];
let empty = true;
const refs = {};
const commits = {};
const trees = {};
const blobs = {};
let seq = 0;

const json = (data, status = 200, headers = {}) => ({
  ok: status < 400,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => JSON.stringify(data),
});

async function handle(url, opts = {}) {
  const u = new URL(String(url));
  const p = u.pathname;
  const ref = u.searchParams.get('ref') || 'main';
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path: p, body });

  if (p === '/user') {
    return json({ login: 'leonvb', name: 'Leon', avatar_url: '', html_url: '#' }, 200, { 'x-oauth-scopes': 'repo' });
  }
  if (p === '/user/repos') {
    return json([{
      owner: { login: 'leonvb' }, name: 'fresh', full_name: 'leonvb/fresh', private: true,
      default_branch: 'main', pushed_at: null, description: '', permissions: { push: true },
    }]);
  }

  let m;
  if ((m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
    return json({
      owner: { login: m[1] }, name: m[2], full_name: `${m[1]}/${m[2]}`, private: true,
      default_branch: 'main', size: 0, html_url: '#', permissions: { push: true },
    });
  }

  // A repository with no commits lists no branches at all.
  if (p.endsWith('/branches')) {
    return json(empty ? [] : Object.keys(refs).map((name) => ({ name })));
  }

  // PUT contents is the documented way to initialise a repo with no commits.
  if ((m = p.match(/contents\/(.*)$/)) && method === 'PUT') {
    const filePath = decodeURIComponent(m[1]);
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    const blobSha = sha40(++seq);
    blobs[blobSha] = text;
    const treeSha = sha40(++seq);
    trees[treeSha] = new Map([[filePath, blobSha]]);
    const commitSha = sha40(++seq);
    commits[commitSha] = {
      sha: commitSha, tree: { sha: treeSha }, parents: [], message: body.message, author: body.author,
    };
    refs[body.branch || 'main'] = commitSha;
    empty = false;
    return json({
      content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha },
      commit: { sha: commitSha, html_url: `https://github.com/leonvb/fresh/commit/${commitSha}` },
    }, 201);
  }

  // Contents: 404 "This repository is empty." while empty; a missing path on a
  // populated repo gives the usual 404.
  if ((m = p.match(/contents\/(.*)$/))) {
    if (empty) return json({ message: 'This repository is empty.' }, 404);
    const filePath = decodeURIComponent(m[1]);
    const flat = trees[commits[refs[ref]].tree.sha] || new Map();
    if (filePath && flat.has(filePath)) {
      const sha = flat.get(filePath);
      const text = blobs[sha];
      return json({
        name: filePath.split('/').pop(), path: filePath, sha, size: text.length,
        type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64'),
        download_url: null, html_url: '#',
      });
    }
    const kids = new Map();
    for (const [fp, sha] of flat) {
      const rel = filePath ? (fp.startsWith(filePath + '/') ? fp.slice(filePath.length + 1) : null) : fp;
      if (rel === null) continue;
      const sl = rel.indexOf('/');
      if (sl === -1) kids.set(rel, { name: rel, path: (filePath ? filePath + '/' : '') + rel, sha, type: 'file', size: blobs[sha].length });
      else kids.set(rel.slice(0, sl), { name: rel.slice(0, sl), path: (filePath ? filePath + '/' : '') + rel.slice(0, sl), sha: 'tree', type: 'dir', size: 0 });
    }
    if (kids.size) return json([...kids.values()]);
    return json({ message: 'Not Found' }, 404);
  }

  // Git refs: 409 "Git Repository is empty." — the crux of this bug.
  if ((m = p.match(/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
    if (empty) return json({ message: 'Git Repository is empty.' }, 409);
    const branch = decodeURIComponent(m[1]);
    const parents = (commits[body.sha].parents || []).map((x) => x.sha);
    if (refs[branch] && body.force !== true && !parents.includes(refs[branch])) {
      return json({ message: 'Update is not a fast forward' }, 422);
    }
    refs[branch] = body.sha;
    return json({ object: { sha: body.sha } });
  }

  if ((m = p.match(/git\/ref\/heads\/(.+)$/)) && method === 'GET') {
    // /git/ref/heads/<b> (singular) is the read endpoint; note that
    // /git/refs/heads/<b> also contains "git/ref", so the PATCH route below is
    // matched separately and before this one.

    if (empty) return json({ message: 'Git Repository is empty.' }, 409);
    const branch = decodeURIComponent(m[1]);
    return refs[branch] ? json({ ref: `refs/heads/${branch}`, object: { sha: refs[branch] } }) : json({ message: 'Not Found' }, 404);
  }

  if ((m = p.match(/git\/commits\/(.+)$/)) && method === 'GET') {
    if (empty) return json({ message: 'Git Repository is empty.' }, 409);
    return commits[m[1]] ? json(commits[m[1]]) : json({ message: 'Not Found' }, 404);
  }

  if (p.endsWith('/git/blobs') && method === 'POST') {
    if (empty) return json({ message: 'Git Repository is empty.' }, 409); // documented behaviour
    const sha = sha40(++seq);
    blobs[sha] = body.encoding === 'base64' ? Buffer.from(body.content, 'base64').toString('utf8') : body.content;
    return json({ sha }, 201);
  }

  if (p.endsWith('/git/trees') && method === 'POST') {
    if (empty) return json({ message: 'Git Repository is empty.' }, 409);
    const flat = new Map(body.base_tree ? trees[body.base_tree] : []);
    for (const e of body.tree) {
      if (e.sha === null) flat.delete(e.path);
      else flat.set(e.path, e.sha);
    }
    const sha = sha40(++seq);
    trees[sha] = flat;
    return json({ sha }, 201);
  }

  if (p.endsWith('/git/commits') && method === 'POST') {
    if (empty) return json({ message: 'Git Repository is empty.' }, 409);
    const sha = sha40(++seq);
    commits[sha] = {
      sha, tree: { sha: body.tree }, parents: (body.parents || []).map((s) => ({ sha: s })),
      message: body.message, author: body.author,
    };
    return json(commits[sha], 201);
  }

  if (p.endsWith('/git/refs') && method === 'POST') {
    const branch = body.ref.replace('refs/heads/', '');
    if (refs[branch]) return json({ message: 'Reference already exists' }, 422);
    refs[branch] = body.sha;
    empty = false; // the repository now has a commit
    return json({ ref: body.ref, object: { sha: body.sha } }, 201);
  }

  return json({ message: `unmocked ${method} ${p}` }, 404);
}

/* ---------------- boot the app ---------------- */
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
global.localStorage = window.localStorage;
global.TextEncoder = globalThis.TextEncoder;
global.TextDecoder = globalThis.TextDecoder;
window.matchMedia = () => ({ matches: false, addEventListener() {} });
window.scrollTo = () => {};
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.requestAnimationFrame = window.requestAnimationFrame;
Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'u' + (++seq) }, configurable: true });
Object.defineProperty(global, 'crypto', { value: window.crypto, configurable: true });
Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: (url, opts) => handle(url, opts) });

// jsdom's Blob/File predate arrayBuffer(); browsers have it.
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

await import(path.join(ROOT, 'js/app.js') + `?t=${Date.now()}`);
const tick = (ms = 6) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick(); };
await settle(20);

const P = window.__pocket;

/* ---------------- 1. getRefSha treats 409-empty as "no branch" ---------------- */
eq('getRefSha on empty repo returns null', await P.gh.getRefSha('leonvb', 'fresh', 'main'), null);
ok('isRepoEmpty detects an empty repo', await P.gh.isRepoEmpty('leonvb', 'fresh'));

/* ---------------- 2. the 409 message is not a conflict message ---------------- */
let emptyErr = null;
try {
  // a blobs call directly still reports the empty-repo 409, with honest wording
  await P.gh.api.post('/repos/leonvb/fresh/git/blobs', { content: 'x', encoding: 'utf-8' });
} catch (e) { emptyErr = e; }
ok('409 empty-repo error is not called a conflict', emptyErr && !/branch changed/i.test(emptyErr.message), emptyErr && emptyErr.message);

/* ---------------- 3. the app opens an empty repo without an error ---------------- */
P.store.setToken('tok', { remember: false, login: 'leonvb' });
P.gh.setAuthToken('tok');
P.state.viewer = { login: 'leonvb', name: 'Leon', avatarUrl: '' };
await P.openRepoByName('leonvb', 'fresh');
await settle();
ok('empty repo opens', P.state.repo && P.state.repo.repo === 'fresh');
ok('no conflict toast was shown', !/branch changed/i.test(document.body.textContent), document.body.textContent.slice(0, 160));
ok('marked as empty', P.state.emptyRepo === true, String(P.state.emptyRepo));
ok('branch flagged as new', P.state.branchIsNew === true);
ok('first-commit empty state rendered', /Brand-new repository/.test(document.body.textContent));

/* ---------------- 4. the first commit succeeds ---------------- */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const result = await P.gh.commitChanges({
  owner: 'leonvb',
  repo: 'fresh',
  branch: 'main',
  message: 'First commit',
  changes: [{ path: 'first.png', bytes: png }],
  author: { name: 'leonvb', email: 'leonvb@users.noreply.github.com' },
  createBranch: true,
  baseBranch: 'main',
  defaultBranch: 'main',
});
ok('first commit returned a sha', Boolean(result.sha), JSON.stringify(result));
ok('branch was created', result.created === true);
ok('ref now points at the commit', refs.main === result.sha, `${refs.main} vs ${result.sha}`);
eq('first commit has no parents', commits[result.sha].parents, []);
ok('file is in the commit tree', trees[commits[result.sha].tree.sha].has('first.png'));
ok('seed content sent as base64 via contents PUT',
  calls.some((c) => c.method === 'PUT' && /\/contents\//.test(c.path) && c.body && /^[A-Za-z0-9+/=]+$/.test(c.body.content)));
calls.length = 0;
/* ---------------- 5. a second commit fast-forwards normally ---------------- */
const second = await P.gh.commitChanges({
  owner: 'leonvb',
  repo: 'fresh',
  branch: 'main',
  message: 'Second commit',
  changes: [{ path: 'notes.md', text: 'hello\n' }],
});
eq('second commit parented on the first', commits[second.sha].parents[0].sha, result.sha);
ok('both files still present', trees[commits[second.sha].tree.sha].has('first.png') && trees[commits[second.sha].tree.sha].has('notes.md'),
  JSON.stringify([...trees[commits[second.sha].tree.sha].keys()]));

/* ---------------- 6. uploading through the UI stages and commits ---------------- */
P.state.repo = await P.gh.getRepo('leonvb', 'fresh');
P.state.branch = 'main';
P.state.changes = [];
P.state.entries = [];
P.state.emptyRepo = false;
P.render();
await settle();

const file = new window.File([new Uint8Array([9, 8, 7])], 'from-phone.png', { type: 'image/png' });
const staging = P.stageFiles([file]);
await settle(25);
// the folder sheet appears; accept the default
const sheets = [...document.querySelectorAll('.sheet')];
const top = sheets[sheets.length - 1];
ok('upload folder sheet opened on a fresh repo', Boolean(top));
const addBtn = top && [...top.querySelectorAll('.btn')].find((b) => /Add files/.test(b.textContent));
if (addBtn) addBtn.click();
await settle(30);
eq('upload staged', P.state.changes.length, 1);
eq('staged into the default upload folder', P.state.changes[0] && P.state.changes[0].path, 'uploads/from-phone.png');
/* ---------------- 7. branch semantics on a repo that already has history ---------------- */
// Asking for a branch that does not exist, while naming a real base, is the
// "commit to a new branch" flow: the branch is created on top of the base.
const fromBase = await P.gh.commitChanges({
  owner: 'leonvb',
  repo: 'fresh',
  branch: 'feature-from-phone',
  message: 'Branch off main',
  changes: [{ path: 'feature.md', text: 'hi\n' }],
  createBranch: true,
  baseBranch: 'main',
});
ok('new branch created', Boolean(refs['feature-from-phone']));
eq('new branch parented on main', commits[fromBase.sha].parents[0].sha, refs.main);
ok('feature file present', trees[commits[fromBase.sha].tree.sha].has('feature.md'));

// With no base to resolve, the app must refuse instead of inventing a root
// commit in the middle of an existing project.
let orphan = null;
try {
  await P.gh.commitChanges({
    owner: 'leonvb',
    repo: 'fresh',
    branch: 'brand-new-name',
    message: 'should not happen',
    changes: [{ path: 'nope.txt', text: 'x' }],
    createBranch: true,
    baseBranch: 'also-missing',
    defaultBranch: 'also-missing',
  });
} catch (e) { orphan = e; }
ok('refuses to invent a root commit in a populated repo', orphan && /does not exist/i.test(orphan.message),
  orphan ? orphan.message : 'no error thrown');
ok('no stray branch was created', !refs['brand-new-name']);

/* ---------------- 8. the exact path the bug report came from ---------------- */
// Fresh empty repo -> open it -> upload a file -> review -> commit, via the UI.
empty = true;
Object.keys(refs).forEach((k) => delete refs[k]);
Object.keys(commits).forEach((k) => delete commits[k]);
P.state.changes = [];
P.state.entries = [];
P.state.repo = null;

await P.openRepoByName('leonvb', 'fresh');
await settle(30);
ok('fresh repo opened as empty', P.state.emptyRepo === true);
ok('no conflict wording anywhere', !/branch changed/i.test(document.body.textContent));

const photo = new window.File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'beach.jpg', { type: 'image/jpeg' });
const stagingPhoto = P.stageFiles([photo]);
await settle(25);
const sheetStack = [...document.querySelectorAll('.sheet')];
const uploadSheet = sheetStack[sheetStack.length - 1];
const addFiles = uploadSheet && [...uploadSheet.querySelectorAll('.btn')].find((b) => /Add files/.test(b.textContent));
ok('upload sheet appeared', Boolean(addFiles));
if (addFiles) addFiles.click();
await settle(35);
eq('one file staged', P.state.changes.length, 1);

P.openCommitSheet();
await settle(30);
const reviews = [...document.querySelectorAll('.sheet')];
const reviewSheet = reviews[reviews.length - 1];
ok('review sheet shows first-commit wording',
  reviewSheet && /first commit/i.test(reviewSheet.textContent), reviewSheet && reviewSheet.textContent.slice(0, 200));
const msgBox = reviewSheet && reviewSheet.querySelector('textarea');
if (msgBox) {
  msgBox.value = 'Add the first photo';
  msgBox.dispatchEvent(new window.Event('input', { bubbles: true }));
}
const commitButton = reviewSheet && [...reviewSheet.querySelectorAll('.sheet-foot .btn')].find((b) => /Commit/.test(b.textContent));
ok('commit button present', Boolean(commitButton));
if (commitButton) commitButton.click();
await settle(60);

ok('first commit landed', Boolean(refs.main), JSON.stringify(refs));
ok('changes cleared', P.state.changes.length === 0);
const treeKeys = refs.main ? [...trees[commits[refs.main].tree.sha].keys()] : [];
ok('photo is in the repository', treeKeys.includes('uploads/beach.jpg'), JSON.stringify(treeKeys));
ok('no conflict error surfaced', !/branch changed/i.test(document.body.textContent), document.body.textContent.slice(0, 200));
ok('success sheet shown', /Committed|first commit/i.test(document.body.textContent));

/* ---------------- report ---------------- */
console.log(`\n${passes.length} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFAILURES:');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
