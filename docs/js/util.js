/* small DOM / data helpers used across the app */

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an HTML element. */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

/** Create an SVG element (namespaced). */
export function s(tag, props) {
  const node = document.createElementNS(SVG_NS, tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  return node;
}

export function applyProps(node, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Icon element from the inline sprite. */
export function icon(name, cls = '') {
  const svg = s('svg', { class: `icon${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' });
  svg.appendChild(s('use', { href: `#i-${name}` }));
  return svg;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ---------------- text ---------------- */

export function truncate(str, max) {
  str = String(str ?? '');
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

export function plural(n, single, pluralWord) {
  return n === 1 ? single : pluralWord || single + 's';
}

/** "1 file" / "3 files" — the count plus its correctly pluralised noun. */
export function countLabel(n, single, pluralWord) {
  return `${fmtNumber(n)} ${plural(n, single, pluralWord)}`;
}

export function fmtBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function fmtNumber(n) {
  return new Intl.NumberFormat().format(n);
}

/* ---------------- paths ---------------- */

export function normalizePath(path) {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join('/'));
}

export function dirName(path) {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function baseName(path) {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function fileExt(path) {
  const base = baseName(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

/**
 * Validate a repository-relative path typed by the user.
 * @returns {{ok: boolean, path: string, error?: string}}
 */
export function validatePath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, path: '', error: 'Enter a file path.' };
  const path = normalizePath(raw);
  if (!path) return { ok: false, path: '', error: 'Enter a file path.' };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, path, error: 'Path contains control characters.' };
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) {
    return { ok: false, path, error: 'Path cannot contain . or .. segments.' };
  }
  if (path.length > 900) return { ok: false, path, error: 'Path is too long.' };
  return { ok: true, path };
}

/** Combine a directory and a filename, avoiding collisions with `taken`. */
export function uniquePath(dir, name, taken) {
  const base = baseName(name);
  const ext = fileExt(base);
  const stem = ext ? base.slice(0, -(ext.length + 1)) : base;
  let candidate = joinPath(dir, base);
  let n = 1;
  while (taken.has(candidate)) {
    const suffix = `-${n++}`;
    candidate = joinPath(dir, ext ? `${stem}${suffix}.${ext}` : `${stem}${suffix}`);
  }
  return candidate;
}

/* ---------------- encoding ---------------- */

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Heuristic: does this byte buffer look like text? */
export function looksLikeText(bytes) {
  if (!bytes || !bytes.length) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) return false;
    if (b < 7 || (b > 13 && b < 32)) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

export async function readFileAsBytes(file) {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

export const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  ico: 'image/x-icon', pdf: 'application/pdf', zip: 'application/zip',
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', log: 'text/plain',
  json: 'application/json', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  mjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  py: 'text/x-python', rb: 'text/plain', go: 'text/plain', rs: 'text/plain',
  java: 'text/plain', c: 'text/plain', h: 'text/plain', cpp: 'text/plain',
  sh: 'text/x-sh', sql: 'text/plain', xml: 'text/xml', csv: 'text/csv',
  mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav', mov: 'video/quicktime',
};

export function mimeFor(path) {
  return MIME[fileExt(path)] || '';
}

export function isImage(path) {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'].includes(fileExt(path));
}

export function isMarkdown(path) {
  return ['md', 'markdown', 'mdown'].includes(fileExt(path));
}

export function fileKind(path) {
  const ext = fileExt(path);
  if (isImage(path)) return 'image';
  if (isMarkdown(path)) return 'markdown';
  if (ext === 'zip' || ext === 'gz' || ext === 'tgz' || ext === 'tar' || ext === 'rar' || ext === '7z' || ext === 'pdf') return 'archive';
  if (['js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm', 'json', 'yml', 'yaml', 'toml', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'sql', 'xml', 'svg'].includes(ext)) return 'code';
  return 'file';
}

export function iconForPath(path) {
  switch (fileKind(path)) {
    case 'image': return 'image';
    case 'markdown': return 'markdown';
    case 'code': return 'code';
    case 'archive': return 'archive';
    default: return 'file';
  }
}

/* ---------------- misc ---------------- */

export function parseRepoInput(value) {
  let v = String(value ?? '').trim();
  v = v.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  v = v.replace(/^git@github\.com:/i, '');
  v = v.replace(/\.git$/i, '');
  v = v.replace(/^\/+|\/+$/g, '');
  const parts = v.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

export function safeUrl(value, schemes = ['http:', 'https:', 'mailto:']) {
  try {
    const url = new URL(value, location.href);
    if (!schemes.includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms); } catch { /* ignore */ }
}

/** Copy text, with a legacy fallback for older mobile browsers. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Very small line diff summary: added / removed counts. */
export function diffStats(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  const counts = new Map();
  for (const line of a) counts.set(line, (counts.get(line) || 0) + 1);
  let common = 0;
  for (const line of b) {
    const n = counts.get(line) || 0;
    if (n > 0) { common++; counts.set(line, n - 1); }
  }
  return { added: Math.max(0, b.length - common), removed: Math.max(0, a.length - common) };
}
