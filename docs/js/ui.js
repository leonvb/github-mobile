/* Sheets, toasts, dialogs, and small form controls. */

import { h, icon, clear, haptic } from './util.js';

const sheetRoot = () => document.getElementById('sheetRoot');
const toastRoot = () => document.getElementById('toastRoot');

let openCount = 0;
let scrollLockY = 0;

function lockScroll() {
  if (openCount++ === 0) {
    scrollLockY = window.scrollY;
    document.body.style.top = `-${scrollLockY}px`;
    document.body.classList.add('no-scroll');
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
  }
}

function unlockScroll() {
  if (openCount > 0 && --openCount === 0) {
    document.body.classList.remove('no-scroll');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, scrollLockY);
  }
}

/**
 * Open a bottom sheet.
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.subtitle]
 * @param {Node|Node[]} [opts.body]
 * @param {Node|Node[]} [opts.footer]
 * @param {boolean} [opts.dismissible=true]
 * @param {() => void} [opts.onClose]
 * @param {boolean} [opts.closeButton=true]
 */
export function openSheet(opts = {}) {
  const {
    title = '',
    subtitle = '',
    body = null,
    footer = null,
    dismissible = true,
    onClose = null,
    closeButton = true,
  } = opts;

  const backdrop = h('div', { class: 'sheet-backdrop' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' });
  const bodyEl = h('div', { class: 'sheet-body' });

  const grip = h('div', { class: 'sheet-grip' });
  sheet.appendChild(grip);

  if (title || subtitle || closeButton) {
    const head = h('div', { class: 'sheet-head' },
      h('div', { style: { flex: '1', minWidth: '0' } },
        title ? h('h2', { text: title }) : null,
        subtitle ? h('div', { class: 'sub', text: subtitle }) : null,
      ),
      closeButton
        ? h('button', { class: 'sheet-x', type: 'button', 'aria-label': 'Close', onClick: () => close() }, icon('x'))
        : null,
    );
    sheet.appendChild(head);
  }

  if (body) {
    if (Array.isArray(body)) body.forEach((n) => n && bodyEl.appendChild(n));
    else bodyEl.appendChild(body);
  }
  sheet.appendChild(bodyEl);

  let footEl = null;
  if (footer) {
    footEl = h('div', { class: 'sheet-foot' });
    if (Array.isArray(footer)) footer.forEach((n) => n && footEl.appendChild(n));
    else footEl.appendChild(footer);
    sheet.appendChild(footEl);
  }

  backdrop.appendChild(sheet);
  sheetRoot().appendChild(backdrop);
  lockScroll();

  // animate in
  requestAnimationFrame(() => {
    backdrop.classList.add('show');
    sheet.classList.add('show');
  });

  const previousFocus = document.activeElement;
  setTimeout(() => {
    const focusable = sheet.querySelector('input, textarea, select, button.btn-primary, .sheet-x');
    if (focusable && opts.autofocus !== false) {
      try { focusable.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }, 340);

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.remove('show');
    sheet.classList.remove('show');
    unlockScroll();
    setTimeout(() => {
      backdrop.remove();
      if (previousFocus && previousFocus.focus) {
        try { previousFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
      onClose?.(result);
    }, 280);
  }

  function onKey(e) {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && dismissible) close();
  });

  // swipe-down-to-dismiss on the grip / header area
  let startY = null;
  let dy = 0;
  const swipeArea = sheet.querySelector('.sheet-grip');
  const headEl = sheet.querySelector('.sheet-head');
  const onStart = (e) => {
    if (!dismissible) return;
    const t = e.touches[0];
    startY = t.clientY;
    dy = 0;
    sheet.style.transition = 'none';
  };
  const onMove = (e) => {
    if (startY == null) return;
    const t = e.touches[0];
    dy = Math.max(0, t.clientY - startY);
    if (dy > 0) {
      sheet.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    }
  };
  const onEnd = () => {
    if (startY == null) return;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 90) close();
    startY = null;
  };
  for (const area of [swipeArea, headEl]) {
    if (!area) continue;
    area.addEventListener('touchstart', onStart, { passive: true });
    area.addEventListener('touchmove', onMove, { passive: false });
    area.addEventListener('touchend', onEnd);
    area.addEventListener('touchcancel', onEnd);
  }

  return {
    close,
    el: sheet,
    body: bodyEl,
    setFooter(node) {
      if (!footEl) return;
      clear(footEl);
      if (Array.isArray(node)) node.forEach((n) => n && footEl.appendChild(n));
      else if (node) footEl.appendChild(node);
    },
  };
}

/* ---------------- toasts ---------------- */

export function toast(message, { type = '', duration = 3200 } = {}) {
  const el = h('div', { class: `toast ${type}` },
    type === 'ok' ? icon('check') : type === 'err' ? icon('warning') : icon('info'),
    h('span', { text: message }),
  );
  toastRoot().appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
  }, duration);
  return el;
}

export const toastError = (message) => toast(message, { type: 'err', duration: 4600 });
export const toastOk = (message) => toast(message, { type: 'ok' });

/* ---------------- dialogs ---------------- */

/**
 * @returns {Promise<boolean>}
 */
export function confirmSheet({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  extra = null,
} = {}) {
  return new Promise((resolve) => {
    let result = false;
    const confirmBtn = h('button', {
      class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
      type: 'button',
      text: confirmLabel,
      onClick: () => { result = true; sheet.close(); },
    });
    const bodyNodes = [];
    if (message) bodyNodes.push(h('p', { class: 'help', style: { fontSize: '14px', color: 'var(--text-dim)' }, text: message }));
    if (extra) bodyNodes.push(extra);
    const sheet = openSheet({
      title,
      body: bodyNodes,
      footer: [
        h('button', { class: 'btn btn-soft', type: 'button', text: cancelLabel, onClick: () => sheet.close() }),
        confirmBtn,
      ],
      onClose: () => resolve(result),
    });
  });
}

/**
 * @returns {Promise<string|null>}
 */
export function promptSheet({
  title,
  label = '',
  value = '',
  placeholder = '',
  confirmLabel = 'Save',
  help = '',
  validate = null,
  inputMode = '',
  autocomplete = 'off',
  autocapitalize = 'none',
} = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', {
      class: 'input',
      type: 'text',
      value,
      placeholder,
      autocomplete,
      autocapitalize,
      spellcheck: 'false',
      inputmode: inputMode || undefined,
    });
    const errorEl = h('div', { class: 'field-error', hidden: true });
    const field = h('div', { class: 'field' },
      label ? h('div', { class: 'field-label' }, h('span', { text: label })) : null,
      input,
      errorEl,
      help ? h('div', { class: 'help', text: help }) : null,
    );

    const submit = () => {
      const raw = input.value;
      const verdict = validate ? validate(raw) : { ok: true, value: raw };
      if (!verdict.ok) {
        errorEl.hidden = false;
        clear(errorEl);
        errorEl.append(icon('warning'), h('span', { text: verdict.error || 'Invalid value' }));
        input.classList.add('input-invalid');
        input.focus();
        return;
      }
      result = verdict.value ?? raw;
      sheet.close();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    input.addEventListener('input', () => {
      input.classList.remove('input-invalid');
      errorEl.hidden = true;
    });

    const sheet = openSheet({
      title,
      body: field,
      footer: [
        h('button', { class: 'btn btn-soft', type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
        h('button', { class: 'btn btn-primary', type: 'button', text: confirmLabel, onClick: submit }),
      ],
      onClose: () => resolve(result),
    });
  });
}

/* ---------------- form bits ---------------- */

export function field(labelText, control, { help = '', hint = '' } = {}) {
  return h('div', { class: 'field' },
    h('div', { class: 'field-label' },
      h('span', { text: labelText }),
      hint ? h('span', { class: 'hint', text: hint }) : null,
    ),
    control,
    help ? h('div', { class: 'help' }, typeof help === 'string' ? [help] : help) : null,
  );
}

export function segmented(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'group' });
  options.forEach((opt) => {
    const btn = h('button', {
      type: 'button',
      text: opt.label,
      'aria-pressed': String(opt.value === value),
      onClick: () => {
        [...el.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
        onChange(opt.value);
      },
    });
    el.appendChild(btn);
  });
  return el;
}

export function switchRow({ title, sub, checked, onChange }) {
  const sw = h('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': String(Boolean(checked)),
    'aria-label': title,
  });
  sw.addEventListener('click', () => {
    const next = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(next));
    haptic(6);
    onChange?.(next);
  });
  const row = h('div', { class: 'switch-row' },
    h('div', { class: 'opt-main' },
      h('div', { class: 'opt-title', text: title }),
      sub ? h('div', { class: 'opt-sub', text: sub }) : null,
    ),
    sw,
  );
  row.setSwitch = (val) => sw.setAttribute('aria-checked', String(Boolean(val)));
  return row;
}

export function banner(kind, ...content) {
  const iconName = kind === 'warn' ? 'warning' : kind === 'danger' ? 'warning' : kind === 'ok' ? 'check' : 'info';
  return h('div', { class: `banner ${kind}` }, icon(iconName), h('div', {}, ...content));
}

export function emptyState({ iconName = 'file', title, text, actionLabel, onAction }) {
  return h('div', { class: 'state' },
    h('div', { class: 'state-ill' }, icon(iconName)),
    h('h2', { text: title }),
    text ? h('p', { text }) : null,
    actionLabel ? h('button', { class: 'btn btn-primary', type: 'button', text: actionLabel, onClick: onAction }) : null,
  );
}

export function skeletonList(rows = 5) {
  const group = h('div', { class: 'row-group' });
  for (let i = 0; i < rows; i++) {
    group.appendChild(h('div', { class: 'skel-row' },
      h('div', { class: 'skel sq' }),
      h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', gap: '7px' } },
        h('div', { class: 'skel line', style: { width: `${45 + ((i * 13) % 35)}%` } }),
        h('div', { class: 'skel line', style: { width: '22%', height: '9px', opacity: '.65' } }),
      ),
    ));
  }
  return group;
}
