import { showSurface, hideSurface } from '/motion.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function actionIcon(name) {
  const span = document.createElement('span');
  span.className = 'action-icon';
  span.setAttribute('aria-hidden', 'true');
  span.style.backgroundImage = `url("/icons/${name}.svg")`;
  return span;
}

export function decorate(root = document) {
  $$('[data-icon]', root).forEach((node) => {
    if (!node.querySelector('.action-icon')) node.prepend(actionIcon(node.dataset.icon));
  });
}

export function report(error) {
  window.dispatchEvent(new CustomEvent('system:message', { detail: error?.message || String(error) }));
}

let activeMenu;
export function closeMenu() {
  if (!activeMenu) return;
  const { node, anchor } = activeMenu;
  anchor?.setAttribute('aria-expanded', 'false');
  activeMenu = null;
  hideSurface(node, { effect: 'menu', origin: 'top' });
  const animations = node.getAnimations();
  if (animations.length) Promise.allSettled(animations.map(animation => animation.finished)).then(() => node.remove());
  else node.remove();
}

export function menu(items, anchor, point) {
  const same = activeMenu?.anchor === anchor && anchor;
  closeMenu();
  if (same) return;
  const node = document.createElement('div');
  node.className = 'native-menu';
  node.setAttribute('role', 'menu');
  for (const item of items) {
    if (!item) {
      const divider = document.createElement('div');
      divider.className = 'menu-separator';
      divider.setAttribute('role', 'separator');
      node.append(divider);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = typeof item.disabled === 'function' ? item.disabled() : Boolean(item.disabled);
    button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
    const check = document.createElement('span');
    check.className = 'menu-check';
    if (item.checked) check.textContent = '✓';
    else if (item.icon) check.append(actionIcon(item.icon));
    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = item.label;
    const shortcut = document.createElement('kbd');
    shortcut.textContent = item.shortcut || '';
    button.append(check, label, shortcut);
    button.addEventListener('click', () => {
      closeMenu();
      anchor?.focus({ preventScroll: true });
      Promise.resolve().then(item.action).catch(report);
    });
    node.append(button);
  }
  document.body.append(node);
  const rect = anchor?.getBoundingClientRect();
  const x = point?.x ?? rect?.left ?? 8;
  const y = point?.y ?? rect?.bottom ?? 8;
  node.style.left = Math.max(4, Math.min(x, innerWidth - node.offsetWidth - 4)) + 'px';
  node.style.top = Math.max(4, Math.min(y, innerHeight - node.offsetHeight - 4)) + 'px';
  activeMenu = { node, anchor };
  anchor?.setAttribute('aria-expanded', 'true');
  showSurface(node, { effect: 'menu', origin: 'top' });
  node.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  node.addEventListener('keydown', (event) => {
    const buttons = $$('button:not(:disabled)', node);
    const current = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') { closeMenu(); anchor?.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Home') buttons[0]?.focus();
    else if (event.key === 'End') buttons.at(-1)?.focus();
  });
}

document.addEventListener('pointerdown', (event) => {
  if (activeMenu && !activeMenu.node.contains(event.target) && !activeMenu.anchor?.contains(event.target)) closeMenu();
});
window.addEventListener('resize', closeMenu);

export function menubar(node, definitions) {
  node.replaceChildren();
  node.setAttribute('role', 'menubar');
  for (const [label, entries] of Object.entries(definitions)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const open = () => menu(typeof entries === 'function' ? entries() : entries, button);
    button.addEventListener('click', open);
    button.addEventListener('pointerenter', () => { if (activeMenu && activeMenu.anchor?.parentElement === node && activeMenu.anchor !== button) open(); });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); open(); }
    });
    node.append(button);
  }
}

export function askText(title, value = '', label = '名称：') {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'native-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    const heading = document.createElement('h2'); heading.textContent = title;
    const field = document.createElement('label'); field.textContent = label;
    const input = document.createElement('input'); input.value = value; input.required = true; input.maxLength = 300;
    input.autocomplete = 'off'; input.spellcheck = false; field.append(input);
    const row = document.createElement('div'); row.className = 'button-row';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
    const accept = document.createElement('button'); accept.type = 'submit'; accept.className = 'button primary'; accept.textContent = '确定';
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (event) => { event.preventDefault(); dialog.close(input.value.trim()); });
    row.append(cancel, accept); form.append(heading, field, row); dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => { const result = dialog.returnValue || null; dialog.remove(); resolve(result); }, { once: true });
    dialog.showModal(); showSurface(dialog, { effect: 'window', origin: 'center' }); input.focus(); input.select();
  });
}

export function askSave(name) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog'); dialog.className = 'native-dialog';
    const title = document.createElement('h2'); title.textContent = '保存更改';
    const text = document.createElement('p'); text.textContent = name;
    const row = document.createElement('div'); row.className = 'button-row';
    for (const [value, label] of [['cancel', '取消'], ['discard', '不保存'], ['save', '保存']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      if (value === 'save') button.className = 'button primary';
      button.addEventListener('click', () => dialog.close(value)); row.append(button);
    }
    dialog.append(title, text, row); document.body.append(dialog);
    dialog.addEventListener('close', () => { const result = dialog.returnValue || 'cancel'; dialog.remove(); resolve(result); }, { once: true });
    dialog.showModal(); showSurface(dialog, { effect: 'window', origin: 'center' }); row.lastElementChild.focus();
  });
}

export function shortcut(event, key, shift = false) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.shiftKey === shift && event.key.toLowerCase() === key.toLowerCase();
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MiB';
}
