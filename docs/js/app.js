import * as gh from './github.js';
import * as store from './store.js';
import {
  h, icon, clear, validatePath, joinPath, dirName, baseName, fileKind, iconForPath,
  fmtBytes, isImage, isMarkdown, readFileAsBytes, looksLikeText, mimeFor, uniquePath,
  parseRepoInput, plural, countLabel, copyText, haptic, truncate, diffStats, normalizePath,
} from './util.js';
import {
  openSheet, toast, toastError, toastOk, confirmSheet, promptSheet, field, segmented,
  switchRow, banner, emptyState, skeletonList,
} from './ui.js';

const BUILD = '2026-11-23.3';
const LARGE_UPLOAD = 12 * 1024 * 1024;
const HARD_FILE_LIMIT = 90 * 1024 * 1024; // GitHub rejects blobs over 100 MB
const EDITABLE_MAX = 4 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  viewer: null,
  repo: null,
  branch: '',
  branchIsNew: false,
  emptyRepo: false,   // repository has no commits at all
  path: '',
  entries: [],
  loading: false,
  changes: [],   // { id, path, kind: 'put'|'delete', bytes?, sha?, size, stats?, isNew? }
  dirty: false,
};

const el = (id) => document.getElementById(id);

/** Set when the user picks a file to *replace* rather than upload. */
let pendingTarget = '';

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  applyTheme();
  bindEvents();
  render();

  const token = store.getToken();
  if (token) {
    gh.setAuthToken(token);
    await refreshViewer({ restore: true });
  }

}

function bindEvents() {
  el('repoBtn').addEventListener('click', () => (state.repo ? openRepoSwitchSheet() : openRepoSheet()));
  el('accountBtn').addEventListener('click', () => openAccountSheet());
  el('branchBtn').addEventListener('click', () => openBranchSheet());
  el('newFileBtn').addEventListener('click', () => createNewFile());
  el('uploadBtn').addEventListener('click', () => el('fileInput').click());
  el('changesBtn').addEventListener('click', () => openCommitSheet());
  el('fileInput').addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) await stageFiles(files);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty || state.changes.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (store.getSettings().theme === 'auto') applyTheme();
  });
}

async function refreshViewer({ restore = false } = {}) {
  try {
    const viewer = await gh.getViewer({ fresh: true });
    state.viewer = viewer;
    store.setTokenMeta({ login: viewer.login, avatarUrl: viewer.avatarUrl });
    render();
    if (restore) await restoreLastRepo();
  } catch (err) {
    if (err instanceof gh.GitHubError && err.status === 401) {
      store.clearToken();
      gh.setAuthToken('');
      state.viewer = null;
      render();
      toastError('Your saved token is no longer valid. Sign in again.');
    } else {
      render();
      toastError(gh.describeError(err));
    }
  }
}

async function restoreLastRepo() {
  const last = store.getLastRepo();
  if (!last) return;
  try {
    await openRepoByName(last.owner, last.repo, { silent: true, branch: last.branch });
  } catch {
    state.repo = null;
    render();
  }
}

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

function applyTheme() {
  const theme = store.getSettings().theme || 'auto';
  document.documentElement.dataset.theme = theme;
  syncThemeColor(theme);
}

/**
 * Keep the browser chrome colour in step with the app.
 *
 * In "auto" mode the two media-scoped <meta> tags in the document handle this
 * natively, so we only drop any override we added. When a theme is chosen
 * explicitly, those media queries would be wrong, so we pin one plain tag and
 * remove the scoped ones.
 */
function syncThemeColor(theme) {
  const dark = theme === 'dark'
    || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const color = dark ? '#0b0f14' : '#f7f8fa';

  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    const media = meta.getAttribute('media');
    if (media === '(prefers-color-scheme: dark)') meta.setAttribute('content', '#0b0f14');
    else if (media === '(prefers-color-scheme: light)') meta.setAttribute('content', '#f7f8fa');
  });

  let plain = document.querySelector('meta[name="theme-color"]:not([media])');
  if (theme === 'auto') {
    if (plain && plain.dataset.dynamic) plain.remove();
    return;
  }
  if (!plain) {
    plain = document.createElement('meta');
    plain.name = 'theme-color';
    plain.dataset.dynamic = '1';
    document.head.appendChild(plain);
  }
  plain.setAttribute('content', color);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render() {
  renderTopbar();
  renderBottomBar();

  if (!store.hasToken() && !state.viewer) {
    el('subbar').hidden = true;
    renderWelcome();
    return;
  }
  if (!state.repo) {
    el('subbar').hidden = true;
    renderRepoChooser();
    return;
  }
  renderSubbar();
  renderList();
}

function renderTopbar() {
  const name = el('repoName');
  const sub = el('repoSub');
  if (state.repo) {
    name.textContent = state.repo.repo;
    sub.textContent = state.repo.owner;
  } else {
    name.textContent = 'Pocket Commit';
    sub.textContent = state.viewer ? `Signed in as ${state.viewer.login}` : 'Commit to GitHub from your phone';
  }

  const img = el('avatarImg');
  const fallback = el('avatarFallback');
  if (state.viewer && state.viewer.avatarUrl) {
    img.src = state.viewer.avatarUrl;
    img.alt = state.viewer.login;
    img.hidden = false;
    fallback.hidden = true;
  } else {
    img.hidden = true;
    fallback.hidden = false;
  }
}

function renderSubbar() {
  el('subbar').hidden = false;
  el('branchName').textContent = state.branch;
  renderCrumbs();
}

function renderCrumbs() {
  const nav = el('crumbs');
  clear(nav);
  nav.appendChild(h('button', {
    class: 'crumb',
    type: 'button',
    text: state.repo.repo,
    onClick: () => navigateTo(''),
  }));
  let acc = '';
  (state.path ? state.path.split('/') : []).forEach((seg) => {
    acc = joinPath(acc, seg);
    const target = acc;
    nav.appendChild(h('span', { class: 'crumb-sep', text: '/' }));
    nav.appendChild(h('button', { class: 'crumb', type: 'button', text: seg, onClick: () => navigateTo(target) }));
  });
  requestAnimationFrame(() => { nav.scrollLeft = nav.scrollWidth; });
}

function renderBottomBar() {
  el('bottombar').hidden = !state.repo;
  const count = state.changes.length;
  el('changesBtn').hidden = count === 0;
  el('changesCount').textContent = String(count);
}

function renderWelcome() {
  const list = el('list');
  clear(list);
  list.append(
    h('div', { class: 'state' },
      h('div', { class: 'state-ill' }, icon('commit')),
      h('h2', { text: 'Commit from anywhere' }),
      h('p', { text: 'Browse a repository, edit files and push them straight to GitHub from your phone. Your token stays in this browser — there is no server in between.' }),
      h('button', { class: 'btn btn-primary', type: 'button', onClick: openAuthSheet },
        icon('key'), h('span', { text: 'Connect GitHub' })),
    ),
    h('div', { class: 'row-group', style: { marginTop: '22px' } },
      ...[
        ['upload', 'Upload photos & files', 'Snap a picture or pick from your library, then commit it in one tap.'],
        ['edit', 'Edit text and Markdown', 'Fix a typo, write a note, preview Markdown before committing.'],
        ['branch', 'Commit to any branch', 'Switch branches, or start a new one without touching the current branch.'],
      ].map(([ic, title, sub]) => h('div', { class: 'row' },
        h('div', { class: 'row-icon' }, icon(ic)),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-name', text: title }),
          h('div', { class: 'row-sub', text: sub }),
        ),
      )),
    ),
    h('p', { class: 'help', style: { textAlign: 'center', margin: '20px 10px 0' } },
      'Add this page to your home screen — it runs full-screen, like an app.'),
    h('p', {
      class: 'help mono',
      style: { textAlign: 'center', margin: '16px 10px 0', opacity: '.6', fontSize: '11px' },
      text: `build ${BUILD}`,
    }),
  );
}

function renderRepoChooser() {
  const list = el('list');
  clear(list);
  const repos = store.getRepos();

  list.appendChild(h('div', { class: 'section-label' },
    h('span', { text: 'Recent repositories' }),
    h('span', { class: 'count', text: String(repos.length) }),
  ));

  if (!repos.length) {
    list.appendChild(h('div', { class: 'row-group' },
      h('button', { class: 'row', type: 'button', onClick: openRepoSheet },
        h('div', { class: 'row-icon folder' }, icon('search')),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-name', text: 'Pick a repository' }),
          h('div', { class: 'row-sub', text: 'Search every repo you can push to' }),
        ),
        h('div', { class: 'row-end' }, icon('chevron-right')),
      ),
    ));
    return;
  }

  const group = h('div', { class: 'row-group' });
  repos.forEach((r) => {
    group.appendChild(h('div', { class: 'row' },
      h('button', {
        class: 'row-btn',
        type: 'button',
        onClick: () => openRepoByName(r.owner, r.repo).catch((err) => toastError(gh.describeError(err))),
      },
        h('div', { class: 'repo-badge' }, r.private ? icon('lock') : icon('github')),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-name', text: r.repo }),
          h('div', { class: 'row-sub', text: `${r.owner}${r.private ? ' · private' : ''}` }),
        ),
      ),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': `Remove ${r.owner}/${r.repo} from recents`,
        onClick: () => { store.forgetRepo(r.owner, r.repo); render(); },
      }, icon('x')),
    ));
  });
  list.appendChild(group);

  list.appendChild(h('button', {
    class: 'btn btn-soft btn-block',
    type: 'button',
    style: { marginTop: '14px' },
    onClick: openRepoSheet,
  }, icon('search'), h('span', { text: 'Browse repositories' })));
}

function renderList() {
  const list = el('list');
  clear(list);

  if (state.loading) {
    list.appendChild(skeletonList(6));
    return;
  }

  // staged work is always visible, wherever you are in the tree
  if (state.changes.length) {
    list.appendChild(h('div', { class: 'section-label' },
      h('span', { text: 'Ready to commit' }),
      h('span', { class: 'count', text: countLabel(state.changes.length, 'file') }),
    ));
    const staged = h('div', { class: 'row-group' });
    state.changes.forEach((change) => {
      const removing = change.kind === 'delete';
      staged.appendChild(h('div', { class: 'row' },
        h('div', { class: `row-icon ${removing ? 'removed' : 'added'}` }, icon(removing ? 'trash' : iconForPath(change.path))),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-name', text: baseName(change.path) }),
          h('div', { class: 'row-sub', text: `${removing ? 'Delete' : change.isNew ? 'New file' : 'Edited'} · ${change.path}${change.size ? ` · ${fmtBytes(change.size)}` : ''}` }),
        ),
        h('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': `Unstage ${baseName(change.path)}`,
          onClick: () => unstage(change),
        }, icon('x')),
      ));
    });
    list.appendChild(staged);
  }

  if (state.branchIsNew) {
    list.appendChild(banner('info', h('div', {},
      h('b', { text: `New branch “${state.branch}”. ` }),
      'Your first commit starts it from ',
      h('span', { class: 'mono', text: state.repo.defaultBranch }),
      '.',
    )));
  }

  if (!state.repo.canPush) {
    list.appendChild(banner('warn', h('div', {},
      h('b', { text: 'Read-only access. ' }),
      'This token can read the repository but not push to it.',
    )));
  }

  if (state.loading === false && !state.entries.length) {
    if (!state.changes.length) {
      if (state.emptyRepo && !state.path) {
        // First commit on a brand-new repository. Nothing is broken: there is
        // simply no commit to read files from yet.
        list.appendChild(h('div', { class: 'state' },
          h('div', { class: 'state-ill' }, icon('commit')),
          h('h2', { text: 'Brand-new repository' }),
          h('p', { text: 'There are no commits yet. Anything you upload or create here becomes the first commit, and the default branch starts with it.' }),
          h('button', {
            class: 'btn btn-primary',
            type: 'button',
            onClick: () => el('fileInput').click(),
          }, icon('upload'), h('span', { text: 'Upload the first file' })),
          h('button', {
            class: 'btn btn-soft',
            type: 'button',
            style: { marginTop: '8px' },
            onClick: () => createNewFile(),
          }, icon('plus'), h('span', { text: 'Create a file instead' })),
        ));
      } else {
        list.appendChild(emptyState({
          iconName: state.path ? 'folder' : 'commit',
          title: state.path ? 'This folder is empty' : 'No files on this branch',
          text: state.path ? 'Nothing has been committed at this path yet.' : 'Upload a file or create one to make the first commit.',
          actionLabel: 'Upload files',
          onAction: () => el('fileInput').click(),
        }));
      }
    }
    return;
  }

  const dirs = state.entries.filter((e) => e.type === 'dir').sort(byName);
  const files = state.entries.filter((e) => e.type !== 'dir').sort(byName);

  if (dirs.length) {
    list.appendChild(h('div', { class: 'section-label' },
      h('span', { text: 'Folders' }),
      h('span', { class: 'count', text: String(dirs.length) }),
    ));
    const group = h('div', { class: 'row-group' });
    dirs.forEach((entry) => {
      group.appendChild(h('button', { class: 'row', type: 'button', onClick: () => navigateTo(entry.path) },
        h('div', { class: 'row-icon folder' }, icon('folder')),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-name', text: entry.name }),
          h('div', { class: 'row-sub', text: 'Folder' }),
        ),
        h('div', { class: 'row-end' }, icon('chevron-right')),
      ));
    });
    list.appendChild(group);
  }

  if (files.length) {
    list.appendChild(h('div', { class: 'section-label' },
      h('span', { text: 'Files' }),
      h('span', { class: 'count', text: String(files.length) }),
    ));
    const group = h('div', { class: 'row-group' });
    files.forEach((entry) => {
      group.appendChild(h('button', {
        class: 'row',
        type: 'button',
        onClick: () => openFileActions(entry),
      },
        h('div', { class: `row-icon ${fileKind(entry.path)}` }, icon(iconForPath(entry.path))),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-name', text: entry.name }),
          h('div', { class: 'row-sub', text: entry.size != null ? fmtBytes(entry.size) : 'File' }),
        ),
        h('div', { class: 'row-end' }, icon('chevron-right')),
      ));
    });
    list.appendChild(group);
  }
}

function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

async function navigateTo(path) {
  if (state.dirty) {
    const ok = await confirmSheet({
      title: 'Discard unsaved edits?',
      message: 'The editor has changes that are not staged yet.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
  }
  state.path = normalizePath(path);
  await loadContents();
  window.scrollTo({ top: 0 });
}

async function loadContents() {
  state.loading = true;
  renderList();
  try {
    state.entries = await gh.listContents(state.repo.owner, state.repo.repo, state.path, state.branch);
    state.emptyRepo = false;
  } catch (err) {
    state.entries = [];
    // A repository with no commits answers 409 "empty" for contents reads; a
    // missing path answers 404. Neither is worth an error toast — the empty
    // state explains what to do next.
    const benign = err instanceof gh.GitHubError
      && (err.status === 404 || (err.status === 409 && /empty/i.test(err.details || err.message)));
    if (benign) {
      if (err.status === 409) state.emptyRepo = true;
    } else {
      toastError(gh.describeError(err));
    }
  } finally {
    state.loading = false;
    render();
  }
}

/* ------------------------------------------------------------------ *
 * Repository
 * ------------------------------------------------------------------ */

async function openRepoByName(owner, repo, { silent = false, branch = '' } = {}) {
  const info = await gh.getRepo(owner, repo);
  state.repo = info;
  state.branch = branch || info.defaultBranch;
  state.path = '';
  state.changes = [];
  state.dirty = false;
  state.entries = [];
  await refreshBranchFlag();
  store.rememberRepo({ ...info, branch: state.branch });
  store.setLastRepo({ ...info, branch: state.branch });
  await loadContents();
  if (!silent) {
    toastOk(`Opened ${owner}/${repo}`);
    haptic(10);
  }
}

async function refreshBranchFlag() {
  try {
    const sha = await gh.getRefSha(state.repo.owner, state.repo.repo, state.branch);
    state.branchIsNew = !sha;
    state.emptyRepo = !sha ? await gh.isRepoEmpty(state.repo.owner, state.repo.repo) : false;
  } catch {
    state.branchIsNew = false;
  }
}

function openRepoSheet() {
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search your repositories',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    'aria-label': 'Search repositories',
  });
  const results = h('div', { style: { marginTop: '12px' } });
  const body = h('div', {},
    h('p', { class: 'help', style: { marginBottom: '10px' } },
      'Only repositories where you have push access can be committed to.'),
    search,
    results,
  );

  const sheet = openSheet({
    title: 'Choose a repository',
    body,
    footer: [
      h('button', {
        class: 'btn btn-soft btn-block',
        type: 'button',
        onClick: () => { sheet.close(); promptForRepo(); },
      }, icon('link'), h('span', { text: 'Enter a URL instead' })),
    ],
  });

  const renderResults = (repos, { loading = false, error = '' } = {}) => {
    clear(results);
    if (loading) { results.appendChild(skeletonList(6)); return; }
    if (error) { results.appendChild(banner('danger', h('div', {}, h('b', { text: 'Could not load repositories. ' }), error))); return; }
    if (!repos.length) {
      results.appendChild(emptyState({
        iconName: 'search',
        title: 'No matches',
        text: 'Try a different search, or open a repository by URL.',
      }));
      return;
    }
    const group = h('div', { class: 'row-group' });
    repos.forEach((r) => {
      group.appendChild(h('button', {
        class: 'row',
        type: 'button',
        onClick: async () => {
          sheet.close();
          try { await openRepoByName(r.owner, r.repo); }
          catch (err) { toastError(gh.describeError(err)); }
        },
      },
        h('div', { class: 'repo-badge' }, r.private ? icon('lock') : icon('github')),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-name', text: r.repo }),
          h('div', { class: 'row-sub', text: r.canPush ? r.owner : `${r.owner} · read-only` }),
        ),
        r.canPush ? null : h('span', { class: 'badge', text: 'Read' }),
        h('div', { class: 'row-end' }, icon('chevron-right')),
      ));
    });
    results.appendChild(group);
  };

  let all = [];
  renderResults([], { loading: true });
  gh.listRepos()
    .then(({ repos }) => { all = repos; renderResults(repos); })
    .catch((err) => renderResults([], { error: gh.describeError(err) }));

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    renderResults(q ? all.filter((r) => `${r.owner}/${r.repo}`.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) : all);
  });
}

function openRepoSwitchSheet() {
  const body = h('div', {});
  const group = h('div', { class: 'opt-list' });
  group.appendChild(h('button', {
    class: 'opt',
    type: 'button',
    onClick: () => { sheet.close(); openRepoSheet(); },
  }, icon('search'), h('div', { class: 'opt-main' },
    h('div', { class: 'opt-title', text: 'Switch repository' }),
    h('div', { class: 'opt-sub', text: 'Search or paste a URL' }),
  )));

  group.appendChild(h('button', {
    class: 'opt',
    type: 'button',
    onClick: () => { sheet.close(); openBranchSheet(); },
  }, icon('branch'), h('div', { class: 'opt-main' },
    h('div', { class: 'opt-title', text: 'Switch branch' }),
    h('div', { class: 'opt-sub mono', text: state.branch }),
  )));

  group.appendChild(h('button', {
    class: 'opt',
    type: 'button',
    onClick: () => {
      copyText(`https://github.com/${state.repo.owner}/${state.repo.repo}`)
        .then((ok) => ok ? toastOk('Repository link copied') : toastError('Could not copy'));
    },
  }, icon('link'), h('div', { class: 'opt-main' },
    h('div', { class: 'opt-title', text: 'Copy repository link' }),
    h('div', { class: 'opt-sub mono', text: `${state.repo.owner}/${state.repo.repo}` }),
  )));

  group.appendChild(h('button', {
    class: 'opt',
    type: 'button',
    onClick: () => { sheet.close(); window.open(`https://github.com/${state.repo.owner}/${state.repo.repo}`, '_blank', 'noopener'); },
  }, icon('github'), h('div', { class: 'opt-main' },
    h('div', { class: 'opt-title', text: 'Open on GitHub' }),
    h('div', { class: 'opt-sub', text: 'View the repository in a browser' }),
  )));

  body.appendChild(group);
  const sheet = openSheet({ title: state.repo.repo, subtitle: state.repo.owner, body });
}

async function promptForRepo() {
  const parsed = await promptSheet({
    title: 'Open repository',
    label: 'GitHub URL or owner/repo',
    placeholder: 'https://github.com/owner/repo',
    confirmLabel: 'Open',
    help: 'You can paste a full link.',
    validate: (raw) => {
      const value = parseRepoInput(raw);
      return value ? { ok: true, value } : { ok: false, error: 'Use the form github.com/owner/repo' };
    },
  });
  if (!parsed) return;
  try { await openRepoByName(parsed.owner, parsed.repo); }
  catch (err) { toastError(gh.describeError(err)); }
}

function openBranchSheet() {
  const results = h('div', {}, skeletonList(6));
  const sheet = openSheet({
    title: 'Switch branch',
    subtitle: `${state.repo.owner}/${state.repo.repo}`,
    body: results,
    footer: [
      h('button', {
        class: 'btn btn-soft btn-block',
        type: 'button',
        onClick: () => { sheet.close(); createBranch(); },
      }, icon('plus'), h('span', { text: 'New branch' })),
    ],
  });

  gh.listBranches(state.repo.owner, state.repo.repo).then((branches) => {
    clear(results);
    if (!branches.length) {
      results.appendChild(emptyState({ iconName: 'branch', title: 'No branches yet', text: 'This repository has no commits.' }));
      return;
    }
    const group = h('div', { class: 'opt-list' });
    branches.forEach((name) => {
      group.appendChild(h('button', {
        class: 'opt',
        type: 'button',
        'aria-pressed': String(name === state.branch),
        onClick: async () => {
          sheet.close();
          state.branch = name;
          state.path = '';
          state.changes = [];
          await refreshBranchFlag();
          store.setLastRepo({ ...state.repo, branch: name });
          await loadContents();
          toast(`On branch ${name}`, { duration: 1800 });
        },
      },
        icon('branch'),
        h('div', { class: 'opt-main' },
          h('div', { class: 'opt-title mono', text: name }),
          name === state.repo.defaultBranch ? h('div', { class: 'opt-sub', text: 'Default branch' }) : null,
        ),
        icon('check', 'check'),
      ));
    });
    results.appendChild(group);
  }).catch((err) => {
    clear(results);
    results.appendChild(banner('danger', h('div', {}, gh.describeError(err))));
  });
}

async function createBranch() {
  const name = await promptSheet({
    title: 'New branch',
    label: 'Branch name',
    placeholder: 'notes-from-the-road',
    confirmLabel: 'Use branch',
    help: `Starts from ${state.branch} when you commit.`,
    validate: (raw) => {
      const value = String(raw || '').trim();
      if (!value) return { ok: false, error: 'Enter a branch name' };
      if (/\s/.test(value)) return { ok: false, error: 'Branch names cannot contain spaces' };
      if (/[:?*[\\~^]/.test(value)) return { ok: false, error: 'Remove characters like : ? * [ \\ ~ ^' };
      if (value.startsWith('-') || value.endsWith('/') || value.endsWith('.')) {
        return { ok: false, error: 'That name is not allowed by git' };
      }
      return { ok: true, value };
    },
  });
  if (!name) return;
  state.branch = name;
  state.branchIsNew = true;
  state.path = '';
  state.changes = [];
  await loadContents();
  render();
  toast(`Switched to new branch ${name}`, { duration: 2600 });
}

/* ------------------------------------------------------------------ *
 * File actions
 * ------------------------------------------------------------------ */

function openFileActions(entry) {
  const kind = fileKind(entry.path);
  const editable = ['code', 'markdown'].includes(kind)
    || ['txt', 'csv', 'log', 'tsv', 'env', 'gitignore', 'lock'].includes(entry.name.split('.').pop().toLowerCase())
    || !entry.name.includes('.');

  const group = h('div', { class: 'opt-list' });
  if (editable) {
    group.appendChild(h('button', {
      class: 'opt',
      type: 'button',
      onClick: () => { sheet.close(); openEditor(entry.path); },
    }, icon('edit'), h('div', { class: 'opt-main' },
      h('div', { class: 'opt-title', text: 'Edit file' }),
      h('div', { class: 'opt-sub', text: 'Change the contents, then commit' }),
    )));
  }

  if (isImage(entry.path)) {
    group.appendChild(h('button', {
      class: 'opt',
      type: 'button',
      onClick: () => { sheet.close(); replaceFile(entry.path); },
    }, icon('upload'), h('div', { class: 'opt-main' },
      h('div', { class: 'opt-title', text: 'Replace image' }),
      h('div', { class: 'opt-sub', text: 'Keep the path, swap the picture' }),
    )));
  }

  group.appendChild(h('button', {
    class: 'opt',
    type: 'button',
    onClick: () => { sheet.close(); downloadFile(entry); },
  }, icon('download'), h('div', { class: 'opt-main' },
    h('div', { class: 'opt-title', text: 'Download' }),
    h('div', { class: 'opt-sub', text: 'Save a copy to this device' }),
  )));

  group.appendChild(h('button', {
    class: 'opt',
    type: 'button',
    onClick: () => {
      copyText(`https://github.com/${state.repo.owner}/${state.repo.repo}/blob/${gh.encodeRef(state.branch)}/${gh.encodePath(entry.path)}`)
        .then((ok) => ok ? toastOk('Link copied') : toastError('Could not copy'));
      sheet.close();
    },
  }, icon('link'), h('div', { class: 'opt-main' },
    h('div', { class: 'opt-title', text: 'Copy link' }),
    h('div', { class: 'opt-sub', text: 'GitHub URL for this file' }),
  )));

  group.appendChild(h('button', {
    class: 'opt',
    type: 'button',
    onClick: () => { sheet.close(); stageDelete(entry); },
  }, icon('trash'), h('div', { class: 'opt-main' },
    h('div', { class: 'opt-title', style: { color: 'var(--red)' }, text: 'Delete file' }),
    h('div', { class: 'opt-sub', text: 'Stage the removal, commit it next' }),
  )));

  const sheet = openSheet({ title: entry.name, subtitle: entry.path, body: group });
}

async function downloadFile(entry) {
  try {
    const file = await gh.getFile(state.repo.owner, state.repo.repo, entry.path, state.branch);
    const blob = new Blob([file.bytes], { type: mimeFor(entry.path) || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: baseName(entry.path) });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toastOk('Download started');
  } catch (err) {
    toastError(gh.describeError(err));
  }
}

async function stageDelete(entry) {
  const ok = await confirmSheet({
    title: `Delete ${entry.name}?`,
    message: `It stays in the repository until you commit the staged deletion on ${state.branch}.`,
    confirmLabel: 'Stage deletion',
    danger: true,
  });
  if (!ok) return;
  state.changes = state.changes.filter((c) => c.path !== entry.path);
  state.changes.push({ id: uid(), path: entry.path, kind: 'delete', sha: entry.sha, size: 0 });
  haptic(12);
  render();
  toast(`Staged deletion of ${entry.name}`);
}

function unstage(change) {
  state.changes = state.changes.filter((c) => c.id !== change.id);
  render();
  toast(`Unstaged ${baseName(change.path)}`, { duration: 1800 });
}

function replaceFile(path) {
  pendingTarget = path;
  el('fileInput').click();
}

/* ------------------------------------------------------------------ *
 * Editor
 * ------------------------------------------------------------------ */

async function openEditor(path, { isNew = false } = {}) {
  let original = '';
  let existingSha = '';
  let originalBytes = null;

  if (!isNew) {
    try {
      const file = await gh.getFile(state.repo.owner, state.repo.repo, path, state.branch);
      if (file.size > EDITABLE_MAX) {
        toastError(`That file is ${fmtBytes(file.size)} — too large to edit on a phone.`);
        return;
      }
      if (!looksLikeText(file.bytes)) {
        toastError('That file looks binary, so it cannot be edited as text.');
        return;
      }
      originalBytes = file.bytes;
      existingSha = file.sha;
      original = new TextDecoder().decode(file.bytes);
    } catch (err) {
      toastError(gh.describeError(err));
      return;
    }
  }

  const isMd = isMarkdown(path);
  let previewing = false;

  const pathInput = h('input', {
    class: 'input mono',
    type: 'text',
    value: isNew ? (state.path ? `${state.path}/` : '') : path,
    placeholder: 'notes/today.md',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    'aria-label': 'File path',
  });
  const pathField = field('File path', pathInput, { help: 'Folders are created automatically.' });
  pathField.hidden = !isNew;

  const textarea = h('textarea', {
    class: 'code-editor',
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off',
    'aria-label': 'File contents',
    placeholder: 'Start typing…',
  });
  textarea.value = original;

  const preview = h('div', { class: 'preview', hidden: true });
  const status = h('div', { class: 'editor-bar' },
    h('span', { class: 'grow mono', text: countLines(original) }),
    isMd ? h('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      text: 'Preview',
      onClick: (e) => {
        previewing = !previewing;
        e.currentTarget.textContent = previewing ? 'Edit' : 'Preview';
        textarea.hidden = previewing;
        preview.hidden = !previewing;
        if (previewing) preview.innerHTML = renderMarkdown(textarea.value);
      },
    }) : null,
  );

  const body = h('div', {},
    pathField,
    h('div', { class: 'field', style: { marginTop: isNew ? '0' : '6px' } },
      h('div', { class: 'field-label' },
        h('span', { text: 'Contents' }),
        h('span', { class: 'hint mono', text: isNew ? '' : baseName(path) }),
      ),
      textarea,
      preview,
    ),
    status,
  );

  textarea.addEventListener('input', () => {
    state.dirty = textarea.value !== original;
    status.firstElementChild.textContent = countLines(textarea.value);
  });

  const stageBtn = h('button', { class: 'btn btn-primary', type: 'button', text: isNew ? 'Stage file' : 'Stage changes' });

  const sheet = openSheet({
    title: isNew ? 'New file' : 'Edit file',
    subtitle: `${state.repo.owner}/${state.repo.repo} · ${state.branch}`,
    body,
    footer: [
      h('button', { class: 'btn btn-soft', type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
      stageBtn,
    ],
    onClose: () => { state.dirty = false; },
    autofocus: false,
  });

  if (!isNew) setTimeout(() => textarea.focus({ preventScroll: true }), 380);

  stageBtn.addEventListener('click', () => {
    let target = path;
    if (isNew) {
      const verdict = validatePath(pathInput.value);
      if (!verdict.ok) {
        pathInput.classList.add('input-invalid');
        pathInput.focus();
        toastError(verdict.error);
        return;
      }
      if (verdict.path.endsWith('/')) {
        toastError('Add a file name after the folder.');
        return;
      }
      target = verdict.path;
    }

    const text = textarea.value;
    const bytes = new TextEncoder().encode(text);
    if (!isNew && text === original) {
      toast('Nothing changed yet');
      return;
    }
    if (bytes.length > HARD_FILE_LIMIT) {
      toastError('That file is too large to commit.');
      return;
    }

    state.changes = state.changes.filter((c) => c.path !== target);
    state.changes.push({
      id: uid(),
      path: target,
      kind: 'put',
      bytes,
      size: bytes.length,
      isNew: !existingSha,
      stats: existingSha || originalBytes ? diffStats(original, text) : null,
    });

    state.dirty = false;
    haptic(12);
    sheet.close();
    render();
    toast(`Staged ${baseName(target)} — ${countLabel(state.changes.length, 'file')} to commit`);
  });
}

function countLines(text) {
  const n = String(text || '').split('\n').length;
  return `${n} ${plural(n, 'line')}`;
}

/* ------------------------------------------------------------------ *
 * New file & uploads
 * ------------------------------------------------------------------ */

function createNewFile() {
  if (!state.repo.canPush) { toastError('This repository is read-only for this token.'); return; }
  openEditor('', { isNew: true });
}

async function stageFiles(files) {
  if (!state.repo) { toastError('Open a repository first.'); return; }
  if (!state.repo.canPush) { toastError('This repository is read-only for this token.'); return; }

  // "Replace image" keeps the exact path; a plain upload asks where to put things.
  const replacing = pendingTarget;
  pendingTarget = '';

  let dir;
  if (replacing) {
    dir = dirName(replacing);
  } else {
    dir = await chooseUploadFolder();
    if (dir === null) return;
  }

  const taken = new Set([...state.entries.map((e) => e.path), ...state.changes.map((c) => c.path)]);
  const staged = [];
  const skipped = [];

  for (const [i, file] of files.entries()) {
    if (file.size > HARD_FILE_LIMIT) { skipped.push(`${file.name} is too large`); continue; }
    // A replacement targets one path; extra files picked alongside it are added.
    const path = replacing && i === 0
      ? replacing
      : uniquePath(dir, file.name.replace(/[/\\]/g, '-'), taken);
    taken.add(path);
    const bytes = await readFileAsBytes(file);
    staged.push({
      id: uid(),
      path,
      kind: 'put',
      bytes,
      size: bytes.length,
      isNew: !replacing || i > 0,
      mime: file.type || mimeFor(path),
    });
  }

  if (skipped.length) toastError(skipped.join(' · '));
  if (!staged.length) return;

  const total = staged.reduce((sum, c) => sum + c.size, 0);
  if (total > LARGE_UPLOAD && store.getSettings().confirmLargeUploads) {
    const ok = await confirmSheet({
      title: 'Large upload',
      message: `${countLabel(staged.length, 'file')} totalling ${fmtBytes(total)}. GitHub accepts files up to 100 MB, but big commits can be slow on mobile data.`,
      confirmLabel: 'Stage anyway',
    });
    if (!ok) return;
  }

  if (replacing) state.changes = state.changes.filter((c) => c.path !== replacing);
  state.changes.push(...staged);
  haptic(14);
  render();
  if (state.path !== dir) {
    state.path = dir;
    await loadContents();
  }
  if (replacing) {
    toastOk(`Staged new contents for ${baseName(replacing)}`);
  } else {
    toastOk(`Staged ${countLabel(staged.length, 'file')} in ${dir || 'the repository root'}`);
  }
}

/** Ask where uploads should land. Returns a directory ('' = root) or null when cancelled. */
function chooseUploadFolder() {
  const suggestion = state.path || store.getSettings().uploadFolder || '';

  return new Promise((resolve) => {
    let settled = false;
    const input = h('input', {
      class: 'input mono',
      type: 'text',
      value: suggestion,
      placeholder: 'uploads',
      autocomplete: 'off',
      autocapitalize: 'none',
      spellcheck: 'false',
      'aria-label': 'Upload folder',
    });

    const chips = h('div', { class: 'chips' });
    [...new Set(['', 'uploads', 'images', 'assets', state.path])].filter((d) => d !== null).forEach((dir) => {
      chips.appendChild(h('button', {
        class: 'file-chip',
        type: 'button',
        style: dir === suggestion ? { borderColor: 'var(--accent-line)', background: 'var(--accent-soft)', color: 'var(--accent)' } : {},
        onClick: () => { input.value = dir; },
      }, h('span', { class: 'name', text: dir || 'repository root' })));
    });

    const submit = () => {
      const raw = input.value.trim();
      if (raw) {
        const verdict = validatePath(raw);
        if (!verdict.ok) {
          input.classList.add('input-invalid');
          toastError(verdict.error);
          return;
        }
        settled = true;
        sheet.close();
        resolve(verdict.path);
      } else {
        settled = true;
        sheet.close();
        resolve('');
      }
    };

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    const body = h('div', {},
      h('p', { class: 'help', style: { marginBottom: '4px' } },
        'Files keep their names and land in this folder on ',
        h('span', { class: 'mono', text: state.branch }),
        '.'),
      field('Folder', input, { help: 'Leave empty for the repository root.' }),
      chips,
    );

    const sheet = openSheet({
      title: 'Where should these go?',
      body,
      footer: [
        h('button', { class: 'btn btn-soft', type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Add files', onClick: submit }),
      ],
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}

/* ------------------------------------------------------------------ *
 * Commit
 * ------------------------------------------------------------------ */

function openCommitSheet() {
  if (!state.changes.length) { toast('Nothing staged yet'); return; }

  const settings = store.getSettings();
  const messageInput = h('textarea', {
    class: 'textarea',
    placeholder: 'Add photos from the trip',
    'aria-label': 'Commit message',
    style: { fontFamily: 'var(--font)', fontSize: '15px', minHeight: '84px' },
  });
  messageInput.value = settings.lastMessage || '';

  const summary = h('div', { class: 'commit-summary' });
  state.changes.forEach((change) => {
    const stat = change.stats
      ? h('span', { class: 'diffstat' },
          h('span', { class: 'add', text: `+${change.stats.added}` }),
          h('span', { class: 'del', text: `−${change.stats.removed}` }))
      : h('span', { text: change.kind === 'delete' ? 'removed' : fmtBytes(change.size) });
    summary.appendChild(h('div', {},
      h('span', { text: `${change.kind === 'delete' ? '−' : '+'} ${change.path}` }),
      stat,
    ));
  });

  const authorName = h('input', {
    class: 'input', type: 'text', autocomplete: 'name', 'aria-label': 'Author name',
    placeholder: 'Your name',
    value: settings.commitName || (state.viewer ? state.viewer.name || state.viewer.login : ''),
  });
  const authorEmail = h('input', {
    class: 'input', type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'none',
    spellcheck: 'false', 'aria-label': 'Author email',
    placeholder: state.viewer ? `${state.viewer.login}@users.noreply.github.com` : 'you@example.com',
    value: settings.commitEmail || (state.viewer && state.viewer.email) || '',
  });
  const authorDetails = h('div', { hidden: true },
    field('Name', authorName),
    field('Email', authorEmail, { help: 'Used for the commit author line only. Nothing is sent anywhere else.' }),
  );

  let toNewBranch = false;
  const newBranchInput = h('input', {
    class: 'input mono', type: 'text', autocomplete: 'off', autocapitalize: 'none',
    spellcheck: 'false', 'aria-label': 'New branch name', placeholder: 'my-branch',
  });
  const newBranchField = field('New branch name', newBranchInput);
  newBranchField.hidden = true;

  const newBranchSwitch = switchRow({
    title: 'Commit to a new branch',
    sub: `Leaves ${state.branch} untouched`,
    checked: false,
    onChange: (on) => {
      toNewBranch = on;
      newBranchField.hidden = !on;
      if (on) {
        newBranchInput.value = suggestBranchName();
        setTimeout(() => newBranchInput.focus({ preventScroll: true }), 60);
      }
    },
  });

  const body = h('div', {},
    state.branchIsNew ? banner('info', h('div', {},
      state.emptyRepo
        ? [
            h('b', { text: 'This will be the first commit. ' }),
            `It creates ${state.branch} and becomes the root of the repository.`,
          ]
        : [
            h('b', { text: `Creates branch “${state.branch}”. ` }),
            `It starts from ${state.repo.defaultBranch}.`,
          ],
    )) : null,
    h('div', { class: 'field', style: { marginTop: '6px' } },
      h('div', { class: 'field-label' },
        h('span', { text: 'Commit message' }),
        h('span', { class: 'hint', text: 'First line is the summary' }),
      ),
      messageInput,
    ),
    h('div', { class: 'section-label', style: { paddingLeft: '0' } },
      h('span', { text: `${countLabel(state.changes.length, 'file')} staged` }),
      h('button', {
        class: 'linklike',
        type: 'button',
        style: { fontSize: '12.5px' },
        onClick: () => { sheet.close(); openStageManager(); },
      }, 'Manage'),
    ),
    summary,
    h('div', { style: { marginTop: '14px' } }, newBranchSwitch, newBranchField),
    h('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      style: { padding: '0', marginTop: '6px', color: 'var(--blue)' },
      onClick: (e) => {
        authorDetails.hidden = !authorDetails.hidden;
        e.currentTarget.textContent = authorDetails.hidden ? 'Set author identity' : 'Hide author identity';
      },
    }, 'Set author identity'),
    authorDetails,
  );

  const commitBtn = h('button', { class: 'btn btn-primary', type: 'button' },
    icon('commit'), h('span', { text: 'Commit' }));

  const sheet = openSheet({
    title: 'Review & commit',
    subtitle: `${state.repo.owner}/${state.repo.repo}`,
    body,
    footer: [
      h('button', { class: 'btn btn-soft', type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
      commitBtn,
    ],
  });

  setTimeout(() => messageInput.focus({ preventScroll: true }), 380);

  function suggestBranchName() {
    const digest = new Date().toISOString().slice(5, 10).replace('-', '');
    return `update-${digest}`;
  }

  commitBtn.addEventListener('click', async () => {
    const message = messageInput.value.trim();
    if (!message) {
      messageInput.classList.add('input-invalid');
      messageInput.focus();
      toastError('Write a commit message first');
      return;
    }
    messageInput.classList.remove('input-invalid');

    const branch = toNewBranch ? newBranchInput.value.trim() : state.branch;
    if (!branch) { toastError('Name the new branch'); return; }
    if (toNewBranch && (/\s/.test(branch) || /[:?*[\\~^]/.test(branch))) {
      toastError('That branch name is not valid');
      return;
    }

    // GitHub needs a name and email for the commit author. If the fields are
    // blank we still send the token owner's identity with the noreply address,
    // which GitHub accepts and which keeps the commit attributed correctly.
    const fallbackName = (state.viewer && (state.viewer.name || state.viewer.login)) || 'Pocket Commit';
    const fallbackEmail = state.viewer
      ? `${state.viewer.login}@users.noreply.github.com`
      : 'pocket-commit@users.noreply.github.com';
    const author = {
      name: authorName.value.trim() || fallbackName,
      email: authorEmail.value.trim() || fallbackEmail,
    };

    commitBtn.disabled = true;
    clear(commitBtn);
    commitBtn.append(h('span', { class: 'spinner' }), h('span', { text: 'Committing…' }));

    try {
      const result = await gh.commitChanges({
        owner: state.repo.owner,
        repo: state.repo.repo,
        branch,
        message,
        changes: state.changes.map((c) => ({
          path: c.path,
          bytes: c.kind === 'delete' ? undefined : c.bytes,
          delete: c.kind === 'delete',
        })),
        author,
        createBranch: state.branchIsNew || toNewBranch,
        baseBranch: state.branch,
        defaultBranch: state.repo.defaultBranch,
        onProgress: (stage) => {
          const label = commitBtn.querySelector('span:last-child');
          if (label) label.textContent = stage;
        },
      });

      store.saveSettings({ commitName: author.name, commitEmail: author.email });

      state.changes = [];
      if (branch !== state.branch) {
        state.branch = branch;
        store.setLastRepo({ ...state.repo, branch });
      }
      state.branchIsNew = false;
      sheet.close();
      haptic(20);
      render();
      showCommitSuccess(result, message);
      await loadContents();
    } catch (err) {
      commitBtn.disabled = false;
      clear(commitBtn);
      commitBtn.append(icon('commit'), h('span', { text: 'Commit' }));
      toastError(gh.describeError(err));
      if (err instanceof gh.GitHubError && err.status === 409) await refreshBranchFlag();
    }
  });
}

function openStageManager() {
  const listWrap = h('div', {});
  const sheet = openSheet({
    title: 'Staged files',
    subtitle: countLabel(state.changes.length, 'file'),
    body: listWrap,
    footer: [
      h('button', {
        class: 'btn btn-danger-soft',
        type: 'button',
        onClick: async () => {
          const ok = await confirmSheet({
            title: 'Discard all staged files?',
            message: 'Nothing has been committed yet, so this only clears the staging list.',
            confirmLabel: 'Discard all',
            danger: true,
          });
          if (!ok) return;
          state.changes = [];
          sheet.close();
          render();
        },
      }, icon('trash'), h('span', { text: 'Clear all' })),
      h('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Review & commit',
        onClick: () => { sheet.close(); openCommitSheet(); },
      }),
    ],
  });

  const draw = () => {
    clear(listWrap);
    if (!state.changes.length) {
      listWrap.appendChild(emptyState({ iconName: 'commit', title: 'Nothing staged', text: 'Upload or edit a file to get started.' }));
      return;
    }
    state.changes.forEach((change) => {
      const removing = change.kind === 'delete';
      listWrap.appendChild(h('div', { class: 'change' },
        h('div', { class: 'change-main' },
          h('div', { class: 'change-path', text: change.path }),
          h('div', { class: 'change-meta', text: removing ? 'Delete' : `Add · ${fmtBytes(change.size)}` }),
        ),
        h('span', { class: `badge ${removing ? 'removed' : 'added'}`, text: removing ? 'Delete' : 'Add' }),
        h('button', {
          class: 'icon-btn danger', type: 'button', 'aria-label': 'Unstage',
          onClick: () => { unstage(change); draw(); if (!state.changes.length) sheet.close(); },
        }, icon('x')),
      ));
    });
  };
  draw();
}

function showCommitSuccess(result, message) {
  const body = h('div', { style: { padding: '2px 0 4px' } },
    h('div', {
      style: {
        width: '62px', height: '62px', borderRadius: '50%', margin: '0 auto 14px',
        display: 'grid', placeItems: 'center',
        background: 'var(--accent-soft)', color: 'var(--accent)',
      },
    }, (() => { const i = icon('check'); i.style.width = '30px'; i.style.height = '30px'; i.style.strokeWidth = '2.4'; return i; })()),
    h('h2', { style: { fontSize: '17px', textAlign: 'center', marginBottom: '6px' }, text: 'Committed' }),
    h('p', { class: 'help', style: { textAlign: 'center', fontSize: '13.5px' },
      text: `“${truncate(message.split('\n')[0], 64)}” is now on ${result.branch}.` }),
    h('div', { class: 'commit-summary', style: { marginTop: '14px' } },
      h('div', {}, h('span', { text: 'commit' }), h('span', { text: result.sha.slice(0, 10) })),
      h('div', {}, h('span', { text: 'branch' }), h('span', { text: result.branch })),
    ),
  );
  const sheet = openSheet({
    title: 'Pushed to GitHub',
    body,
    footer: [
      h('button', { class: 'btn btn-soft', type: 'button', text: 'Keep working', onClick: () => sheet.close() }),
      h('a', {
        class: 'btn btn-primary', href: result.htmlUrl, target: '_blank', rel: 'noopener',
      }, icon('link'), h('span', { text: 'View commit' })),
    ],
  });
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

function openAuthSheet() {
  const tokenInput = h('input', {
    class: 'input mono',
    type: 'password',
    placeholder: 'ghp_… or github_pat_…',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    'aria-label': 'Personal access token',
    style: { fontSize: '15px' },
  });

  const remember = switchRow({
    title: 'Remember this device',
    sub: 'Otherwise the token is forgotten when you close this tab',
    checked: store.getSettings().rememberToken,
    onChange: (on) => store.saveSettings({ rememberToken: on }),
  });

  const errorBox = h('div', { hidden: true });

  const body = h('div', {},
    h('div', { class: 'banner info' },
      icon('lock'),
      h('div', {},
        h('b', { text: 'No server involved. ' }),
        'This page talks to GitHub straight from your browser. The token is never sent anywhere else.',
      ),
    ),
    h('div', { class: 'field', style: { marginTop: '14px' } },
      h('div', { class: 'field-label' },
        h('span', { text: 'Personal access token' }),
        h('a', {
          class: 'hint linklike',
          href: 'https://github.com/settings/personal-access-tokens/new',
          target: '_blank',
          rel: 'noopener',
          text: 'Create one ↗',
        }),
      ),
      tokenInput,
      h('div', { class: 'help', style: { marginTop: '8px' } },
        'Use a ',
        h('b', { text: 'fine-grained token' }),
        ' limited to the repositories you want, with ',
        h('code', { text: 'Contents: Read and write' }),
        ' permission. A classic token with the ',
        h('code', { text: 'repo' }),
        ' scope works too.',
      ),
    ),
    errorBox,
    remember,
  );

  const signInBtn = h('button', { class: 'btn btn-primary', type: 'button', text: 'Sign in' });
  const sheet = openSheet({
    title: 'Connect GitHub',
    subtitle: 'One token, stored on this device only',
    body,
    footer: [
      h('button', { class: 'btn btn-soft', type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
      signInBtn,
    ],
  });

  const submit = async () => {
    const token = tokenInput.value.trim();
    if (!token) {
      tokenInput.classList.add('input-invalid');
      tokenInput.focus();
      return;
    }
    signInBtn.disabled = true;
    clear(signInBtn);
    signInBtn.append(h('span', { class: 'spinner' }), h('span', { text: 'Checking…' }));
    errorBox.hidden = true;
    try {
      const info = await gh.checkToken(token);
      await completeSignIn(token, info);
      sheet.close();
    } catch (err) {
      signInBtn.disabled = false;
      clear(signInBtn);
      signInBtn.textContent = 'Sign in';
      tokenInput.classList.add('input-invalid');
      errorBox.hidden = false;
      clear(errorBox);
      errorBox.appendChild(banner('danger', h('div', {},
        h('b', { text: 'That token did not work. ' }),
        gh.describeError(err),
      )));
    }
  };

  signInBtn.addEventListener('click', submit);
  tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  tokenInput.addEventListener('input', () => {
    tokenInput.classList.remove('input-invalid');
    errorBox.hidden = true;
  });
}

async function completeSignIn(token, info) {
  store.setToken(token, {
    remember: store.getSettings().rememberToken,
    login: info.login,
    avatarUrl: info.avatarUrl,
  });
  gh.setAuthToken(token);
  gh.clearViewerCache();
  state.viewer = {
    login: info.login,
    name: info.name || '',
    avatarUrl: info.avatarUrl || '',
    email: info.email || '',
  };
  if (info.email) store.saveSettings({ commitEmail: info.email });
  haptic(14);
  render();
  toastOk(`Signed in as ${info.login}`);

  if (info.canWrite === 'no') {
    toast('This token looks read-only — commits will fail.', { type: 'err', duration: 5000 });
  }

  const last = store.getLastRepo();
  if (last) {
    try { await openRepoByName(last.owner, last.repo, { silent: true, branch: last.branch }); }
    catch { render(); }
  }
}

function openAccountSheet() {
  const viewer = state.viewer;
  const settings = store.getSettings();
  const body = h('div', {});

  if (viewer) {
    body.appendChild(h('div', { class: 'card', style: { display: 'flex', gap: '12px', alignItems: 'center' } },
      h('img', { src: viewer.avatarUrl, alt: '', style: { width: '44px', height: '44px', borderRadius: '50%', background: 'var(--surface-2)' } }),
      h('div', { style: { minWidth: '0' } },
        h('div', { style: { fontWeight: '640' }, text: viewer.name || viewer.login }),
        h('div', { class: 'help mono', text: `@${viewer.login}` }),
      ),
    ));
  } else {
    body.appendChild(h('button', {
      class: 'btn btn-primary btn-block',
      type: 'button',
      onClick: () => { sheet.close(); openAuthSheet(); },
    }, icon('key'), h('span', { text: 'Connect GitHub' })));
  }

  body.appendChild(h('div', { class: 'field' },
    h('div', { class: 'field-label' }, h('span', { text: 'Appearance' })),
    segmented([
      { label: 'System', value: 'auto' },
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' },
    ], settings.theme, (value) => { store.saveSettings({ theme: value }); applyTheme(); }),
  ));

  const folderInput = h('input', {
    class: 'input mono', type: 'text', autocomplete: 'off', autocapitalize: 'none',
    spellcheck: 'false', 'aria-label': 'Default upload folder', value: settings.uploadFolder,
    placeholder: 'uploads',
  });
  folderInput.addEventListener('change', () => {
    const raw = folderInput.value.trim();
    const verdict = raw ? validatePath(raw) : { ok: true, path: '' };
    if (!verdict.ok) { toastError(verdict.error); folderInput.value = store.getSettings().uploadFolder; return; }
    store.saveSettings({ uploadFolder: verdict.path });
    toastOk('Default folder saved');
  });
  body.appendChild(field('Default upload folder', folderInput, { help: 'You can still change it for each upload.' }));

  body.appendChild(switchRow({
    title: 'Remember token',
    sub: 'Stay signed in after closing the tab',
    checked: settings.rememberToken,
    onChange: (on) => {
      store.saveSettings({ rememberToken: on });
      const token = gh.getAuthToken();
      if (!token) return;
      store.setToken(token, { remember: on, login: state.viewer?.login, avatarUrl: state.viewer?.avatarUrl });
      toast(on ? 'Token saved on this device' : 'Token will be cleared when this tab closes');
    },
  }));

  body.appendChild(switchRow({
    title: 'Warn before large uploads',
    sub: 'Ask when a batch is over 12 MB',
    checked: settings.confirmLargeUploads,
    onChange: (on) => store.saveSettings({ confirmLargeUploads: on }),
  }));

  body.appendChild(h('div', { class: 'banner warn', style: { marginTop: '12px' } },
    icon('lock'),
    h('div', {},
      h('b', { text: 'Where your token lives. ' }),
      'This is a static page, so there is no server holding your token — and nothing else protecting it either. With “Remember token” on, it is stored in this browser and readable by anything running on this site. Keep it to a fine-grained token for the repos you need, and sign out on shared devices.',
    ),
  ));

  body.appendChild(h('div', { class: 'card tight' },
    h('div', { class: 'kv' }, h('dt', { text: 'Version' }), h('dd', { class: 'mono', text: BUILD })),
    h('div', { class: 'kv' }, h('dt', { text: 'Talks to' }), h('dd', { text: 'api.github.com' })),
    h('div', { class: 'kv' }, h('dt', { text: 'Third parties' }), h('dd', { text: 'None' })),
  ));

  const updateBtn = h('button', {
    class: 'btn btn-soft btn-block',
    type: 'button',
    style: { marginTop: '4px' },
  }, icon('refresh'), h('span', { text: 'Check for updates' }));
  updateBtn.addEventListener('click', async () => {
    const label = updateBtn.querySelector('span');
    updateBtn.disabled = true;
    if (label) label.textContent = 'Checking…';
    try {
      // Ask the browser whether a newer worker is available; if the cache is
      // stale, the hard reload below is what actually gets the new code.
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg) await reg.update();
      if (typeof window.pocketCommitUpdate === 'function') {
        await window.pocketCommitUpdate();
      } else {
        location.reload();
      }
    } catch {
      location.reload();
    }
  });
  body.appendChild(updateBtn);
  body.appendChild(h('p', {
    class: 'help',
    style: { marginTop: '8px' },
    text: 'Clears the offline cache, unregisters the service worker and reloads. Use it if a change you just deployed is not showing up.',
  }));

  const sheet = openSheet({
    title: 'Account',
    body,
    footer: viewer ? [
      h('button', {
        class: 'btn btn-danger-soft btn-block',
        type: 'button',
        onClick: async () => {
          const ok = await confirmSheet({
            title: 'Sign out?',
            message: 'The token is erased from this browser. Staged, uncommitted files are discarded too.',
            confirmLabel: 'Sign out',
            danger: true,
          });
          if (!ok) return;
          store.clearToken();
          gh.setAuthToken('');
          gh.clearViewerCache();
          state.viewer = null;
          state.repo = null;
          state.changes = [];
          state.entries = [];
          sheet.close();
          render();
          toast('Signed out');
        },
      }, icon('logout'), h('span', { text: 'Sign out' })),
    ] : [],
  });
}

/* ------------------------------------------------------------------ *
 * Markdown preview (small, sanitised subset)
 * ------------------------------------------------------------------ */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li',
  'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'img', 'span', 'div', 'sup', 'sub', 'kbd', 'details', 'summary',
]);
const ALLOWED_ATTR = new Set(['href', 'src', 'alt', 'title', 'class', 'align', 'colspan', 'rowspan', 'open']);

function safeUrl(value) {
  try {
    const url = new URL(value, location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitize(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
  const removals = [];
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.COMMENT_NODE) {
      removals.push(node);
    } else if (!ALLOWED_TAGS.has(node.tagName.toLowerCase())) {
      removals.push([node, document.createTextNode(node.textContent || '')]);
    } else {
      [...node.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (!ALLOWED_ATTR.has(name) || name.startsWith('on')) { node.removeAttribute(attr.name); return; }
        if (name === 'href' || name === 'src') {
          const url = safeUrl(attr.value);
          if (!url) node.removeAttribute(attr.name);
          else {
            node.setAttribute(attr.name, url);
            if (name === 'href') {
              node.setAttribute('target', '_blank');
              node.setAttribute('rel', 'noopener noreferrer');
            }
          }
        }
      });
    }
    node = walker.nextNode();
  }
  removals.forEach((item) => {
    if (Array.isArray(item)) {
      const [node2, repl] = item;
      node2.parentNode?.replaceChild(repl, node2);
    } else {
      item.parentNode?.removeChild(item);
    }
  });
  return root;
}

function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let lang = '';
  let buf = [];
  const listStack = [];
  const closeLists = () => { while (listStack.length) out.push(`</${listStack.pop()}>`); };

  const inline = (text) => {
    let s = esc(text);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000`; });
    // images first, so the link rule cannot eat them
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
      const safe = safeUrl(url);
      return safe ? `<img src="${safe}" alt="${alt}" loading="lazy">` : esc(alt);
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      const safe = safeUrl(url);
      return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
    return s;
  };

  for (const line of lines) {
    if (inCode) {
      if (/^```/.test(line)) {
        out.push(`<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
        inCode = false; lang = ''; buf = [];
      } else {
        buf.push(line);
      }
      continue;
    }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) { closeLists(); inCode = true; lang = fence[1]; continue; }
    if (/^\s*$/.test(line)) { closeLists(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeLists();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeLists(); out.push('<hr>'); continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { closeLists(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listStack[listStack.length - 1] !== want) {
        closeLists();
        out.push(`<${want}>`);
        listStack.push(want);
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeLists();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
  closeLists();

  const container = document.createElement('div');
  container.innerHTML = out.join('\n');
  return sanitize(container).innerHTML;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

boot();

// Exposed for the smoke test and for debugging from the console.
window.__pocket = { state, gh, store, renderMarkdown, render, openRepoByName, loadContents, stageFiles, openCommitSheet };
