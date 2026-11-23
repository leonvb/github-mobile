/*
 * Minimal GitHub REST client, sized for this app.
 *
 * All calls go straight from the browser to https://api.github.com, which sends
 * CORS headers permitting authenticated requests from any origin. That is what
 * makes a backend-free commit flow possible.
 *
 * Writes use the Git Data API (blob -> tree -> commit -> ref) rather than the
 * Contents API, because that commits several files — additions, edits and
 * deletions — together in one atomic commit and never silently clobbers a
 * concurrent edit: the new commit is built on the head SHA we read, and the ref
 * update is a fast-forward from exactly that SHA (GitHub rejects the push if the
 * branch moved in the meantime).
 */

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export class GitHubError extends Error {
  constructor(message, { status = 0, code = '', url = '', details = '' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
    this.url = url;
    this.details = details;
  }
}

export class RateLimitError extends GitHubError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'RateLimitError';
  }
}

export function describeError(err) {
  if (!err) return 'Something went wrong.';
  if (err instanceof GitHubError) return err.message;
  if (err instanceof TypeError) return 'No connection to GitHub. Check your network and try again.';
  return err.message || String(err);
}

/* ---------------- auth ---------------- */

let authToken = '';

export function setAuthToken(token) {
  authToken = token || '';
}

export function getAuthToken() {
  return authToken;
}

/* ---------------- transport ---------------- */

function rateLimitFrom(res) {
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return { remaining, reset, limited: remaining === 0 };
}

function rateLimitError(res, body) {
  const { reset } = rateLimitFrom(res);
  const when = reset
    ? new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const message = when
    ? `GitHub rate limit reached. Try again after ${when}.`
    : 'GitHub rate limit reached. Try again later.';
  return new RateLimitError(message, { status: res.status, url: res.url, details: body });
}

function errorFromResponse(res, body) {
  const msg = (body && typeof body === 'object' && (body.message || body.error_description || body.error)) || '';
  let message = msg || `GitHub returned ${res.status}`;
  // Friendliest phrasings for the errors people actually hit.
  if (res.status === 401) message = 'Your token is invalid or was revoked. Sign in again.';
  else if (res.status === 403) message = msg || 'This token does not have permission for that action.';
  else if (res.status === 404) message = 'Not found — or this token cannot see that private repository.';
  else if (res.status === 409) message = 'The branch changed while saving. Reload and try again.';
  else if (res.status === 422) message = msg || 'GitHub rejected that request (probably an invalid path or branch name).';
  return new GitHubError(message, { status: res.status, url: res.url, details: msg });
}

async function request(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  const url = path.startsWith('http') ? path : API + path;
  const finalHeaders = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    ...headers,
  };
  if (auth && authToken) finalHeaders.Authorization = `Bearer ${authToken}`;
  let payload;
  if (body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, { method, headers: finalHeaders, body: payload, cache: 'no-store' });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new TypeError('offline');
  }

  if (res.status === 304) return { data: null, res };
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      const limited = rateLimitFrom(res);
      if (limited.limited || /rate limit/i.test(String((data && data.message) || text))) {
        throw rateLimitError(res, data);
      }
    }
    throw errorFromResponse(res, data);
  }
  return { data, res };
}

export const api = {
  get: (path, opts) => request(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
};

/* ---------------- session ---------------- */

let viewerCache = null;

export async function getViewer({ fresh = false } = {}) {
  if (viewerCache && !fresh) return viewerCache;
  const { data } = await api.get('/user');
  viewerCache = {
    login: data.login,
    name: data.name || '',
    avatarUrl: data.avatar_url || '',
    htmlUrl: data.html_url || '',
    email: data.email || '',
  };
  return viewerCache;
}

export function clearViewerCache() {
  viewerCache = null;
}

/**
 * Validate a token without storing it.
 * @returns {Promise<{login: string, name: string, avatarUrl: string, email: string,
 *                    scopes: string[], canWrite: 'yes'|'unknown'|'no'}>}
 */
export async function checkToken(token) {
  const previous = authToken;
  authToken = token;
  try {
    const { data, res } = await api.get('/user');
    const scopes = (res.headers.get('x-oauth-scopes') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Fine-grained tokens report no scopes; absence means "unknown", not "read-only".
    let canWrite = 'unknown';
    if (scopes.length) canWrite = scopes.includes('repo') || scopes.includes('public_repo') ? 'yes' : 'no';
    return {
      login: data.login,
      name: data.name || '',
      avatarUrl: data.avatar_url || '',
      email: data.email || '',
      scopes,
      canWrite,
    };
  } finally {
    authToken = previous;
  }
}

/* ---------------- repositories ---------------- */

export async function listRepos({ page = 1, perPage = 100 } = {}) {
  const { data, res } = await api.get(
    `/user/repos?sort=pushed&direction=desc&per_page=${perPage}&page=${page}&affiliation=owner,collaborator,organization_member`,
  );
  const hasMore = /rel="next"/.test(res.headers.get('link') || '');
  return {
    repos: (Array.isArray(data) ? data : []).map(mapRepo),
    hasMore,
  };
}

function mapRepo(r) {
  return {
    owner: r.owner.login,
    repo: r.name,
    fullName: r.full_name,
    private: Boolean(r.private),
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
    description: r.description || '',
    canPush: r.permissions ? Boolean(r.permissions.push) : true,
  };
}

export async function getRepo(owner, repo) {
  const { data } = await api.get(`/repos/${owner}/${repo}`);
  return {
    ...mapRepo(data),
    size: data.size,
    htmlUrl: data.html_url,
    canPush: data.permissions ? Boolean(data.permissions.push) : true,
  };
}

export async function listBranches(owner, repo) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const { data, res } = await api.get(`/repos/${owner}/${repo}/branches?per_page=100&page=${page}`);
    if (!Array.isArray(data)) break;
    out.push(...data.map((b) => b.name));
    if (!/rel="next"/.test(res.headers.get('link') || '')) break;
  }
  return out;
}

/* ---------------- contents ---------------- */

export function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

export function encodeRef(branch) {
  return String(branch).split('/').map(encodeURIComponent).join('/');
}

/**
 * List a directory. Returns [] when the path is an empty/absent directory.
 */
export async function listContents(owner, repo, path, ref) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const { data } = await api.get(`/repos/${owner}/${repo}/contents/${encodePath(path)}${query}`);
  if (!Array.isArray(data)) return [mapEntry(data)];
  return data.map(mapEntry);
}

function mapEntry(item) {
  return {
    name: item.name,
    path: item.path,
    sha: item.sha,
    size: item.size,
    type: item.type === 'dir' ? 'dir' : item.type === 'symlink' ? 'symlink' : 'file',
    isFile: item.type !== 'dir',
    downloadUrl: item.download_url || '',
    htmlUrl: item.html_url || '',
  };
}

/**
 * Read one file as bytes.
 * The Contents API only inlines content up to 1 MB; larger files need a blob
 * read, and files over 100 MB cannot be read at all.
 */
export async function getFile(owner, repo, path, ref) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const { data } = await api.get(`/repos/${owner}/${repo}/contents/${encodePath(path)}${query}`);
  if (Array.isArray(data)) throw new GitHubError('That path is a directory.', { status: 422 });

  const entry = mapEntry(data);
  let bytes;
  if (data.encoding === 'base64' && data.content) {
    bytes = base64ToBytes(data.content);
  } else {
    if (data.size > 100 * 1024 * 1024) {
      throw new GitHubError('This file is over GitHub’s 100 MB limit and cannot be read in the browser.');
    }
    const blob = await api.get(`/repos/${owner}/${repo}/git/blobs/${data.sha}`);
    bytes = base64ToBytes(blob.data.content || '');
  }
  return { ...entry, bytes };
}

/* ---------------- writes ---------------- */

export async function getRefSha(owner, repo, branch) {
  try {
    const { data } = await api.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeRef(branch)}`);
    return data.object.sha;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

async function getCommit(owner, repo, sha) {
  const { data } = await api.get(`/repos/${owner}/${repo}/git/commits/${sha}`);
  return data;
}

async function createBlob(owner, repo, bytes, asText) {
  // Text goes up as UTF-8 so GitHub stores it verbatim; binaries go base64.
  const body = asText
    ? { content: new TextDecoder().decode(bytes), encoding: 'utf-8' }
    : { content: bytesToBase64(bytes), encoding: 'base64' };
  const { data } = await api.post(`/repos/${owner}/${repo}/git/blobs`, body);
  return data.sha;
}

async function createTree(owner, repo, entries, baseTree) {
  const body = {
    tree: entries.map((e) => ({
      path: e.path,
      mode: '100644',
      type: 'blob',
      sha: e.blobSha, // null removes the path when base_tree is set
    })),
  };
  if (baseTree) body.base_tree = baseTree;
  const { data } = await api.post(`/repos/${owner}/${repo}/git/trees`, body);
  return data.sha;
}

async function createCommit(owner, repo, { message, tree, parents, author }) {
  const body = { message, tree, parents };
  if (author && author.name && author.email) body.author = { name: author.name, email: author.email };
  const { data } = await api.post(`/repos/${owner}/${repo}/git/commits`, body);
  return data;
}

async function updateRef(owner, repo, branch, sha, force = false) {
  const { data } = await api.patch(`/repos/${owner}/${repo}/git/refs/heads/${encodeRef(branch)}`, { sha, force });
  return data;
}

async function createRef(owner, repo, branch, sha) {
  const { data } = await api.post(`/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  return data;
}

function isBinary(bytes) {
  if (!bytes) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0 || b < 7 || (b > 13 && b < 32)) return true;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

/**
 * Commit a set of changes to a branch in a single atomic commit.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.branch        target branch
 * @param {string} opts.message       commit message (subject + optional body)
 * @param {Array}  opts.changes       [{ path, bytes?, delete?: boolean }]
 * @param {{name: string, email: string}} [opts.author]
 * @param {boolean} [opts.createBranch] create `branch` when it does not exist
 * @param {string} [opts.baseBranch]  branch to start from (default: repo default)
 * @param {string} [opts.defaultBranch]
 * @returns {Promise<{sha: string, htmlUrl: string, branch: string, created: boolean}>}
 */
export async function commitChanges({
  owner,
  repo,
  branch,
  message,
  changes,
  author,
  createBranch = false,
  baseBranch = '',
  defaultBranch = 'main',
  onProgress = null,
}) {
  if (!changes || !changes.length) throw new GitHubError('Nothing to commit.');
  if (!message || !message.trim()) throw new GitHubError('A commit message is required.');

  // 1. Where does the new commit sit? Never guess: read the head every time.
  const currentHead = await getRefSha(owner, repo, branch);
  let baseSha = currentHead;
  let created = false;

  if (!baseSha) {
    if (!createBranch) {
      throw new GitHubError(`Branch “${branch}” does not exist yet.`, { status: 404 });
    }
    created = true;
    // Start a new branch from the requested base, falling back to the default.
    for (const candidate of [baseBranch, defaultBranch]) {
      if (!candidate || candidate === branch) continue;
      baseSha = await getRefSha(owner, repo, candidate);
      if (baseSha) break;
    }
  }

  const baseCommit = baseSha ? await getCommit(owner, repo, baseSha) : null;

  // 2. Upload blob contents.
  onProgress?.(changes.length > 1 ? `Uploading ${changes.length} files…` : 'Uploading…');
  const treeEntries = [];
  for (const change of changes) {
    if (change.delete) {
      treeEntries.push({ path: normalizePath(change.path), blobSha: null });
      continue;
    }
    const bytes = change.bytes || new TextEncoder().encode(change.text ?? '');
    const asText = typeof change.text === 'string' ? true : !isBinary(bytes);
    const blobSha = await createBlob(owner, repo, bytes, asText);
    treeEntries.push({ path: normalizePath(change.path), blobSha });
  }

  // 3. Build the new tree on top of the branch tip (null entries delete paths).
  onProgress?.('Building tree…');
  const treeSha = await createTree(owner, repo, treeEntries, baseCommit ? baseCommit.tree.sha : undefined);

  // 4. Create the commit.
  onProgress?.('Writing commit…');
  const commit = await createCommit(owner, repo, {
    message,
    tree: treeSha,
    parents: baseSha ? [baseSha] : [],
    author,
  });

  // 5. Move the branch, or create it.
  onProgress?.(created ? 'Creating branch…' : 'Updating branch…');
  if (created) {
    await createRef(owner, repo, branch, commit.sha);
  } else {
    await updateRef(owner, repo, branch, commit.sha, false);
  }

  return {
    sha: commit.sha,
    htmlUrl: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    branch,
    created,
  };
}

function normalizePath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
}

/** Default author identity, derived from the token owner. */

/* ---------------- encoding helpers ---------------- */

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
