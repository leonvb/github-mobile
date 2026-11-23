/*
 * Persistence.
 *
 * Everything here stays inside this browser: localStorage only. There is no
 * backend, no analytics, no third-party request. The personal access token is
 * the sensitive part, so it follows one rule: it is stored *only* when the user
 * explicitly opts in ("Remember on this device"). Otherwise it lives in memory
 * for the current tab and is dropped on reload.
 *
 * Trade-off, deliberately chosen: "remember" mode also survives reloads, which
 * means any script able to read this origin could read it. Since this page
 * ships its own code and has a strict CSP (no inline/eval, no third parties),
 * the remaining risk is someone with unlocked physical access to the browser.
 * The UI says so plainly.
 */

const NS = 'pocketcommit.v1';
const KEY = {
  settings: `${NS}.settings`,
  session: `${NS}.session`,   // token in localStorage (only when remembered)
  repos: `${NS}.repos`,
  lastRepo: `${NS}.lastRepo`,
};

export const DEFAULT_SETTINGS = {
  theme: 'auto',            // auto | light | dark
  rememberToken: false,     // persist token in localStorage
  commitName: '',           // optional author override
  commitEmail: '',
  uploadFolder: 'uploads',  // default destination for uploaded files
  confirmLargeUploads: true,
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/* ---------------- settings ---------------- */

export function getSettings() {
  const stored = readJSON(KEY.settings, {});
  return { ...DEFAULT_SETTINGS, ...(typeof stored === 'object' ? stored : {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJSON(KEY.settings, next);
  return next;
}

/* ---------------- token ---------------- */

let memoryToken = '';
let memoryLogin = '';

export function getToken() {
  if (memoryToken) return memoryToken;
  const remembered = readJSON(KEY.session, null);
  if (remembered && typeof remembered.token === 'string' && remembered.token) {
    memoryToken = remembered.token;
    memoryLogin = remembered.login || '';
    return memoryToken;
  }
  return '';
}

export function setToken(token, { remember, login, avatarUrl } = {}) {
  memoryToken = String(token || '');
  if (login) memoryLogin = login;
  if (remember && memoryToken) {
    writeJSON(KEY.session, {
      token: memoryToken,
      login: memoryLogin,
      avatarUrl: avatarUrl || '',
      savedAt: new Date().toISOString(),
    });
  } else {
    remove(KEY.session);
  }
}

export function setTokenMeta({ login, avatarUrl }) {
  if (login) memoryLogin = login;
  const remembered = readJSON(KEY.session, null);
  if (remembered && remembered.token) {
    writeJSON(KEY.session, { ...remembered, login: login || remembered.login, avatarUrl: avatarUrl || remembered.avatarUrl });
  }
}

export function clearToken() {
  memoryToken = '';
  memoryLogin = '';
  remove(KEY.session);
}

export function hasToken() {
  return Boolean(getToken());
}

/* ---------------- repos ---------------- */

/**
 * Recently used repos: [{ owner, repo, branch, defaultBranch, private, updatedAt }]
 */
export function getRepos() {
  const list = readJSON(KEY.repos, []);
  return Array.isArray(list) ? list.filter((r) => r && r.owner && r.repo) : [];
}

export function rememberRepo(entry) {
  if (!entry || !entry.owner || !entry.repo) return;
  const list = getRepos().filter((r) => !(r.owner === entry.owner && r.repo === entry.repo));
  list.unshift({
    owner: entry.owner,
    repo: entry.repo,
    branch: entry.branch || entry.defaultBranch || '',
    defaultBranch: entry.defaultBranch || entry.branch || '',
    private: Boolean(entry.private),
    updatedAt: new Date().toISOString(),
  });
  const trimmed = list.slice(0, 24);
  if (!writeJSON(KEY.repos, trimmed)) {
    // storage full or blocked — drop the least recently used and retry once
    if (!writeJSON(KEY.repos, trimmed.slice(0, 6))) {
      remove(KEY.repos);
      writeJSON(KEY.repos, trimmed.slice(0, 6));
    }
  }
}

export function forgetRepo(owner, repo) {
  writeJSON(KEY.repos, getRepos().filter((r) => !(r.owner === owner && r.repo === repo)));
}

export function getLastRepo() {
  const last = readJSON(KEY.lastRepo, null);
  if (last && last.owner && last.repo) return last;
  const repos = getRepos();
  return repos.length ? { owner: repos[0].owner, repo: repos[0].repo, branch: repos[0].branch } : null;
}

export function setLastRepo(entry) {
  if (!entry) { remove(KEY.lastRepo); return; }
  writeJSON(KEY.lastRepo, {
    owner: entry.owner,
    repo: entry.repo,
    branch: entry.branch || '',
  });
}
