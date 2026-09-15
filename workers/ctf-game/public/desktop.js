import { menu } from '/ui.js';
import { getSettings, preferenceEvents, profileKey } from '/preferences.js';
import { matchesShortcut } from '/desktop-config.js';
import { showSurface, hideSurface, isSurfaceOpen, animateGeometry, cancelMotion } from '/motion.js';
import { createWindowPreview } from '/previews.js';

const shapes = {
  files: '<path fill="#3daee9" d="M3 8h10l3 3h13v17H3z"/><path fill="#7dc8f0" d="M3 8V5h10l3 3h12v3H3z"/>',
  console: '<rect x="2" y="5" width="28" height="23" rx="2" fill="#1b2025" stroke="#7f8c8d"/><path d="m7 11 5 5-5 5m8 1h9" fill="none" stroke="#eff0f1" stroke-width="2"/>',
  editor: '<path fill="#eff0f1" d="M7 2h14l5 5v23H7z"/><path fill="#b5c2c8" d="M21 2v7h5"/><path d="M11 12h10m-10 5h8m-8 5h7" stroke="#7f8c8d" stroke-width="2"/><path d="m17 25 9-15 4 3-10 14-4 2z" fill="#f6ad34"/>',
  http: '<circle cx="16" cy="16" r="13" fill="#1d99f3"/><ellipse cx="16" cy="16" rx="6" ry="13" fill="none" stroke="#d3f3ff"/><path d="M3 16h26M6 8h20M6 24h20" stroke="#d3f3ff"/>',
  notes: '<path fill="#f6d365" d="M5 3h22v23l-5 4H5z"/><path fill="#c69d26" d="M22 30v-5h5"/><path d="M10 10h12m-12 5h12m-12 5h8" stroke="#866b21" stroke-width="1.5"/>',
  viewer: '<rect x="3" y="4" width="26" height="25" rx="2" fill="#eff0f1"/><path fill="#1abc9c" d="M6 25V13l7 7 6-10 7 15z"/><circle cx="10" cy="10" r="3" fill="#fdbc4b"/>',
  workbench: '<rect x="5" y="3" width="22" height="26" rx="2" fill="#3daee9"/><path d="m11 10-4 6 4 6m10-12 4 6-4 6m-3-14-4 16" fill="none" stroke="white" stroke-width="1.6"/>',
  proof: '<path fill="#eff0f1" d="M6 2h20v24H6z"/><path d="M10 8h12m-12 5h12" stroke="#7f8c8d" stroke-width="2"/><circle cx="16" cy="23" r="6" fill="#27ae60"/><path d="m13 23 2 2 4-5" fill="none" stroke="white" stroke-width="2"/>',
  launch: '<path d="m5 8 6 8-6 8m11-16 6 8-6 8" fill="none" stroke="#3daee9" stroke-width="3"/><circle cx="27" cy="6" r="3" fill="#eff0f1"/><circle cx="27" cy="26" r="3" fill="#eff0f1"/>',
};
export function icon(name) {
  if (name === 'minecraft' || name === 'firefox' || name === 'yesplaymusic') return '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><image href="/icons/' + name + (name === 'minecraft' ? '.svg' : '.webp') + '" width="64" height="64"/></svg>';
  const assets = { files: 'dolphin', console: 'konsole', editor: 'kate', http: 'browser', notes: 'kwrite', viewer: 'okular', workbench: 'binary', proof: 'text', settings: 'systemsettings', calculator: 'kcalc', archive: 'ark', hex: 'okteta', media: 'elisa', monitor: 'utilities-system-monitor', characters: 'accessories-character-map', search: 'kfind', screenshot: 'spectacle', discover: 'plasmadiscover', keys: 'kleopatra', clock: 'clock', imageviewer: 'gwenview', packets: 'network-wired', help: 'help-contents', database: 'binary', diff: 'view-split-left-right', disk: 'folder-documents', logs: 'text', paint: 'gwenview', profiler: 'utilities-system-monitor', colors: 'preferences-desktop-theme', pipeline: 'binary', logic: 'utilities-system-monitor', structure: 'view-split-left-right', algebra: 'kcalc' };
  const asset = assets[name] || name;
  if (assets[name] || /^(?:dolphin|konsole|kate|kwrite|okular|gwenview|browser|folder|folder-documents|user-home|user-trash|text|script|image|audio|binary|pdf)$/.test(asset)) {
    return '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><image href="/icons/' + asset + '.svg" width="64" height="64"/></svg>';
  }
  return '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">' + (shapes[name] || shapes.workbench) + '</svg>';
}

export function createDesktop() {
  const windows = new Map(), tasks = document.querySelector('#tasks');
  const key = 'arisaka/window-layout/v2/' + profileKey();
  let saved = {}, settings = getSettings(), top = 20, active = '', restoreDesktop = [];
  let focusSerial = 0, switchOrder = [], switchIndex = 0;
  let currentDesktop = Math.min(settings.desktopCount - 1, Math.max(0, Number(sessionStorage.getItem(key + '/desktop')) || 0));
  try { saved = JSON.parse(localStorage.getItem(key) || localStorage.getItem('arisaka/window-layout/v1') || '{}'); } catch {}
  const notify = () => window.dispatchEvent(new Event('plasma:windows'));
  function workArea() {
    const gap = settings.panelFloating ? 8 : 0;
    const panel = settings.panelAutoHide ? 10 : settings.panelSize + gap * 2;
    const bounds = { x: 8, y: 8, width: innerWidth - 16, height: innerHeight - 16 };
    if (settings.panelPosition === 'top') { bounds.y += panel; bounds.height -= panel; }
    else if (settings.panelPosition === 'left') { bounds.x += panel; bounds.width -= panel; }
    else if (settings.panelPosition === 'right') bounds.width -= panel;
    else bounds.height -= panel;
    return bounds;
  }
  function applyWorkArea() {
    const bounds = workArea();
    for (const [name, value] of Object.entries(bounds)) document.documentElement.style.setProperty('--work-' + name, value + 'px');
  }
  function persist() {
    const layout = {};
    for (const [id, item] of windows) layout[id] = {
      x: parseFloat(item.node.style.left), y: parseFloat(item.node.style.top), width: parseFloat(item.node.style.width), height: parseFloat(item.node.style.height),
      opened: item.opened, minimized: item.minimized, maximized: item.node.classList.contains('maximized'), desktop: item.desktop, pinned: item.pinned,
    };
    try { localStorage.setItem(key, JSON.stringify(layout)); sessionStorage.setItem(key + '/desktop', String(currentDesktop)); } catch {}
  }
  function clamp(item) {
    if (item.node.classList.contains('maximized')) return;
    const bounds = workArea();
    const width = Math.min(Math.max(280, parseFloat(item.node.style.width) || 760), bounds.width);
    const height = Math.min(Math.max(220, parseFloat(item.node.style.height) || 540), bounds.height);
    Object.assign(item.node.style, {
      width: width + 'px', height: height + 'px',
      left: Math.max(bounds.x, Math.min(parseFloat(item.node.style.left) || bounds.x, bounds.x + bounds.width - width)) + 'px',
      top: Math.max(bounds.y, Math.min(parseFloat(item.node.style.top) || bounds.y, bounds.y + bounds.height - height)) + 'px',
    });
  }
  function visible(item) { return item.opened && !item.minimized && item.desktop === currentDesktop; }
  function taskAnchor(id) {
    const button = [...tasks.children].find((node) => node.dataset.task === id);
    const rect = (button?.querySelector('svg') || button)?.getBoundingClientRect();
    // focus/renderTasks replaces every task button. Keep the geometry, not a
    // detached element, for the whole minimize or restore transition.
    return rect?.width && rect.height ? rect : null;
  }
  function renderTasks() {
    tasks.replaceChildren();
    const ids = [...new Set([...settings.pinnedApps, ...windows.keys()])];
    for (const id of ids) {
      const item = windows.get(id);
      if (!item || !item.opened && !settings.pinnedApps.includes(id) || settings.taskCurrentDesktop && item.opened && item.desktop !== currentDesktop && !settings.pinnedApps.includes(id)) continue;
      const button = document.createElement('button');
      button.className = 'task-button' + (item.opened ? ' running' : '') + (active === id && visible(item) ? ' active' : '');
      button.type = 'button'; button.title = item.title; button.dataset.task = id;
      button.setAttribute('aria-label', item.title); button.setAttribute('aria-pressed', String(active === id && visible(item)));
      button.innerHTML = icon(item.icon);
      button.addEventListener('click', () => active === id && visible(item) ? minimize(id) : open(id));
      button.addEventListener('contextmenu', (event) => { event.preventDefault(); menu([
        { label: '打开', action: () => open(id) },
        { label: '固定到任务管理器', checked: settings.pinnedApps.includes(id), action: () => window.dispatchEvent(new CustomEvent('plasma:pin', { detail: id })) },
        ...(item.opened ? [null, { label: '最小化', action: () => minimize(id) }, { label: '关闭', action: () => close(id) }] : []),
      ], button, { x: event.clientX, y: event.clientY }); });
      tasks.append(button);
    }
  }
  function focus(id) {
    const item = windows.get(id);
    if (!item || !visible(item)) return;
    active = id; item.lastFocus = ++focusSerial; item.node.style.zIndex = String(++top + (item.pinned ? 10000 : 0));
    for (const [key, entry] of windows) entry.node.classList.toggle('focused', key === id);
    renderTasks(); notify();
  }
  function focusRemaining() {
    const visibleWindows = [...windows].filter(([, item]) => visible(item)).sort((a, b) => Number(b[1].node.style.zIndex) - Number(a[1].node.style.zIndex));
    active = ''; windows.forEach((item) => item.node.classList.remove('focused'));
    if (visibleWindows.length) focus(visibleWindows[0][0]); else { renderTasks(); notify(); }
  }
  function switchDesktop(index) {
    const previous = currentDesktop;
    currentDesktop = ((index % settings.desktopCount) + settings.desktopCount) % settings.desktopCount;
    const distance = (currentDesktop - previous + settings.desktopCount) % settings.desktopCount;
    const forward = distance <= settings.desktopCount / 2;
    windows.forEach((item) => {
      if (visible(item)) showSurface(item.node, { effect: 'desktop', origin: forward ? 'right' : 'left' });
      else hideSurface(item.node, { effect: 'desktop', origin: forward ? 'left' : 'right' });
    });
    focusRemaining(); persist();
    window.dispatchEvent(new CustomEvent('plasma:desktop', { detail: currentDesktop }));
  }
  function open(id) {
    const item = windows.get(id);
    if (!item || document.querySelector('#desktop').inert) return;
    const minimized = item.minimized;
    const anchor = taskAnchor(id) || item.minimizeAnchor;
    if (item.opened && item.desktop !== currentDesktop) switchDesktop(item.desktop);
    else if (!item.opened) item.desktop = currentDesktop;
    item.opened = true; item.minimized = false;
    clamp(item);
    showSurface(item.node, { effect: minimized ? 'minimize' : 'window', origin: settings.panelPosition, anchor });
    focus(id);
    hideSurface(document.querySelector('#launcher'), { origin: settings.panelPosition });
    document.querySelector('#launcher-button').setAttribute('aria-expanded', 'false');
    item.node.dispatchEvent(new Event('window:open')); persist();
    window.dispatchEvent(new CustomEvent('plasma:launch', { detail: id }));
  }
  function minimize(id) {
    const item = windows.get(id); if (!item) return;
    item.minimizeAnchor = taskAnchor(id) || item.minimizeAnchor;
    item.minimized = true;
    hideSurface(item.node, { effect: 'minimize', origin: settings.panelPosition, anchor: item.minimizeAnchor });
    focusRemaining(); persist();
  }
  function close(id) {
    const item = windows.get(id); if (!item) return;
    if (!item.node.dispatchEvent(new Event('window:beforeclose', { cancelable: true }))) return;
    item.opened = false; item.minimized = false;
    hideSurface(item.node, { effect: 'window', origin: 'center' });
    item.node.dispatchEvent(new Event('window:close')); focusRemaining(); persist();
  }
  function tile(id, side) {
    const item = windows.get(id); if (!item) return;
    const before = item.node.getBoundingClientRect(), bounds = workArea();
    item.node.classList.remove('maximized', 'shaded');
    if (side === 'top') item.node.classList.add('maximized');
    else Object.assign(item.node.style, { left: (bounds.x + (side === 'right' ? bounds.width / 2 + 2 : 0)) + 'px', top: bounds.y + 'px', width: (bounds.width / 2 - 2) + 'px', height: bounds.height + 'px' });
    item.node.querySelector('[data-window-action="maximize"]').setAttribute('aria-label', side === 'top' ? '还原' : '最大化');
    clamp(item); animateGeometry(item.node, before); focus(id); persist();
  }
  function maximize(id) {
    const item = windows.get(id); if (!item) return;
    const before = item.node.getBoundingClientRect();
    item.node.classList.remove('shaded'); item.node.classList.toggle('maximized');
    item.node.querySelector('[data-window-action="maximize"]').setAttribute('aria-label', item.node.classList.contains('maximized') ? '还原' : '最大化');
    clamp(item); animateGeometry(item.node, before); focus(id); persist();
  }
  function shade(id) {
    const item = windows.get(id); if (!item) return;
    const before = item.node.getBoundingClientRect();
    item.node.classList.toggle('shaded'); animateGeometry(item.node, before);
  }
  function moveTo(id, index) {
    const item = windows.get(id); if (!item) return;
    const previous = item.desktop;
    item.desktop = ((index % settings.desktopCount) + settings.desktopCount) % settings.desktopCount;
    if (visible(item)) showSurface(item.node, { effect: 'desktop', origin: previous > currentDesktop ? 'right' : 'left' });
    else hideSurface(item.node, { effect: 'desktop', origin: item.desktop > currentDesktop ? 'right' : 'left' });
    focusRemaining(); persist();
  }
  function setTitle(id, title, kind) {
    const item = windows.get(id); if (!item) return;
    item.title = title; if (kind) item.icon = kind;
    item.node.querySelector('.window-title').textContent = title;
    item.node.querySelector('.window-icon').innerHTML = icon(item.icon);
    item.node.setAttribute('aria-label', title); renderTasks(); notify();
  }
  const preview = document.createElement('div'); preview.id = 'tile-preview'; preview.hidden = true; preview.setAttribute('aria-hidden', 'true'); document.querySelector('#desktop').append(preview);
  const switcher = document.createElement('section');
  switcher.id = 'window-switcher'; switcher.hidden = true; switcher.setAttribute('role', 'listbox'); switcher.setAttribute('aria-label', '切换窗口');
  document.querySelector('#desktop').append(switcher);
  function finishSwitch(commit = true) {
    const selected = switchOrder[switchIndex]; switchOrder = [];
    hideSurface(switcher, { origin: 'center' });
    if (commit && selected) open(selected);
  }
  function switchWindow(direction) {
    const starting = !switchOrder.length;
    if (starting) {
      switchOrder = [...windows].filter(([, item]) => item.opened && item.desktop === currentDesktop).sort((a, b) => (b[1].lastFocus || 0) - (a[1].lastFocus || 0)).map(([id]) => id);
      switchIndex = Math.max(0, switchOrder.indexOf(active));
    }
    if (!switchOrder.length) return;
    switchIndex = (switchIndex + direction + switchOrder.length) % switchOrder.length;
    if (starting) {
      switcher.replaceChildren();
      for (const [index, id] of switchOrder.entries()) {
        const item = windows.get(id), button = document.createElement('button');
        button.type = 'button'; button.className = 'switcher-item'; button.id = 'switcher-' + id;
        button.setAttribute('role', 'option'); button.setAttribute('aria-label', item.title);
        const thumbnail = createWindowPreview(item.node, { width: Math.min(224, innerWidth - 72), height: 144 });
        thumbnail.classList.add('switcher-preview'); button.append(thumbnail);
        const caption = document.createElement('span'); caption.className = 'switcher-caption'; caption.innerHTML = '<span class="app-icon">' + icon(item.icon) + '</span>';
        const title = document.createElement('span'); title.className = 'switcher-title'; title.textContent = item.title; caption.append(title); button.append(caption);
        button.onclick = () => { switchIndex = index; finishSwitch(); }; switcher.append(button);
      }
    }
    [...switcher.children].forEach((button, index) => button.setAttribute('aria-selected', String(index === switchIndex)));
    showSurface(switcher, { origin: 'center' });
    switcher.setAttribute('aria-activedescendant', 'switcher-' + switchOrder[switchIndex]);
    switcher.children[switchIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function register(node) {
    const id = node.dataset.window; if (windows.has(id)) return;
    const geometry = settings.rememberWindows ? saved[id] || {} : {};
    const item = { node, title: node.dataset.title, icon: node.dataset.icon || id, opened: false, minimized: false, pinned: Boolean(geometry.pinned), desktop: Math.max(0, Math.min(settings.desktopCount - 1, Number(geometry.desktop) || 0)) };
    windows.set(id, item); node.hidden = true; node.inert = true; node.setAttribute('role', 'dialog'); node.setAttribute('aria-label', item.title);
    Object.assign(node.style, {
      left: (Number.isFinite(geometry.x) ? geometry.x : 95 + windows.size % 6 * 30) + 'px',
      top: (Number.isFinite(geometry.y) ? geometry.y : 55 + windows.size % 6 * 25) + 'px',
      width: (geometry.width >= 280 ? geometry.width : Number(node.dataset.width) || 740) + 'px',
      height: (geometry.height >= 220 ? geometry.height : Number(node.dataset.height) || 560) + 'px',
    });
    if (geometry.maximized) node.classList.add('maximized');
    const bar = document.createElement('header'); bar.className = 'window-titlebar';
    bar.innerHTML = '<button type="button" class="window-icon-button" aria-label="窗口菜单"><span class="window-icon">' + icon(item.icon) + '</span></button><button type="button" class="window-pin" aria-label="保持在最上方" title="保持在最上方" aria-pressed="' + item.pinned + '">⌖</button><span class="window-title"></span><div class="window-controls"><button type="button" data-window-action="minimize" aria-label="最小化">—</button><button type="button" data-window-action="maximize" aria-label="最大化">□</button><button type="button" data-window-action="close" aria-label="关闭">×</button></div>';
    bar.querySelector('.window-title').textContent = item.title; node.prepend(bar);
    const togglePin = () => {
      item.pinned = !item.pinned;
      bar.querySelector('.window-pin').setAttribute('aria-pressed', String(item.pinned));
      focus(id); persist();
    };
    const windowMenu = (event) => menu([
      { label: '最小化', action: () => minimize(id) }, { label: '最大化 / 还原', action: () => maximize(id) },
      { label: '卷起 / 展开', action: () => shade(id) },
      { label: '保持在最前', checked: item.pinned, action: togglePin }, null,
      { label: '平铺到左侧', action: () => tile(id, 'left') }, { label: '平铺到右侧', action: () => tile(id, 'right') }, null,
      ...Array.from({ length: settings.desktopCount }, (_, i) => ({ label: '移到 ' + (settings.desktopNames[i] || '桌面 ' + (i + 1)), checked: item.desktop === i, action: () => moveTo(id, i) })), null,
      { label: '关闭', shortcut: 'Alt+F4', action: () => close(id) },
    ], event.currentTarget, event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : undefined);
    bar.querySelector('.window-icon-button').addEventListener('click', windowMenu);
    bar.addEventListener('contextmenu', (event) => { event.preventDefault(); windowMenu(event); });
    bar.querySelector('.window-pin').addEventListener('click', togglePin);
    for (const [action, handler] of Object.entries({ minimize, maximize, close })) bar.querySelector('[data-window-action="' + action + '"]').addEventListener('click', () => handler(id));
    bar.addEventListener('dblclick', (event) => { if (!event.target.closest('button')) { if (settings.titlebarDoubleClick === 'maximize') maximize(id); if (settings.titlebarDoubleClick === 'shade') shade(id); } });
    node.addEventListener('pointerdown', () => focus(id));
    node.addEventListener('pointerenter', () => { if (settings.focusFollowsMouse) focus(id); });
    bindDrag(item, bar);
    bindResize(item);
    clamp(item);
  }
  function bindDrag(item, bar) {
    const node = item.node;
    bar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button') || innerWidth < 640) return;
      event.preventDefault();
      cancelMotion(node);
      if (node.classList.contains('maximized')) {
        const ratio = Math.min(1, Math.max(0, (event.clientX - node.offsetLeft) / node.offsetWidth));
        node.classList.remove('maximized'); node.style.left = event.clientX - node.offsetWidth * ratio + 'px'; node.style.top = event.clientY - 14 + 'px';
        node.querySelector('[data-window-action="maximize"]').setAttribute('aria-label', '最大化');
      }
      const start = { x: event.clientX, y: event.clientY, left: node.offsetLeft, top: node.offsetTop };
      let snap = '';
      bar.setPointerCapture(event.pointerId); node.classList.add('dragging');
      const move = (next) => {
        const bounds = workArea();
        node.style.left = Math.max(bounds.x - node.offsetWidth + 140, Math.min(bounds.x + bounds.width - 140, start.left + next.clientX - start.x)) + 'px';
        node.style.top = Math.max(bounds.y, Math.min(bounds.y + bounds.height - 32, start.top + next.clientY - start.y)) + 'px';
        const nextSnap = settings.snapWindows ? next.clientX <= bounds.x + 12 ? 'left' : next.clientX >= bounds.x + bounds.width - 12 ? 'right' : next.clientY <= bounds.y + 6 ? 'top' : '' : '';
        if (nextSnap !== snap) {
          snap = nextSnap;
          if (snap) {
            const before = isSurfaceOpen(preview) ? preview.getBoundingClientRect() : null;
            Object.assign(preview.style, { left: (bounds.x + (snap === 'right' ? bounds.width / 2 : 0)) + 'px', top: bounds.y + 'px', width: (snap === 'top' ? bounds.width : bounds.width / 2) + 'px', height: bounds.height + 'px' });
            if (before) animateGeometry(preview, before); else showSurface(preview, { origin: 'center' });
          } else hideSurface(preview, { origin: 'center' });
        }
      };
      const finish = (event) => {
        bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', finish); bar.removeEventListener('pointercancel', finish);
        node.classList.remove('dragging'); hideSurface(preview, { origin: 'center' });
        if (snap && event.type !== 'pointercancel') tile(node.dataset.window, snap); else { clamp(item); persist(); }
      };
      bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', finish); bar.addEventListener('pointercancel', finish);
    });
  }
  function bindResize(item) {
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = document.createElement('div'); handle.className = 'window-resize resize-' + edge; handle.setAttribute('aria-hidden', 'true'); item.node.append(handle);
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || item.node.classList.contains('maximized') || innerWidth < 640) return;
        event.preventDefault(); handle.setPointerCapture(event.pointerId); focus(item.node.dataset.window);
        const node = item.node, bounds = workArea();
        cancelMotion(node); node.classList.add('resizing');
        const initial = { x: event.clientX, y: event.clientY, left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight };
        const move = (next) => {
          const dx = next.clientX - initial.x, dy = next.clientY - initial.y;
          let left = initial.left, top = initial.top, right = initial.left + initial.width, bottom = initial.top + initial.height;
          if (edge.includes('e')) right = Math.min(bounds.x + bounds.width, Math.max(left + 280, right + dx));
          if (edge.includes('s')) bottom = Math.min(bounds.y + bounds.height, Math.max(top + 220, bottom + dy));
          if (edge.includes('w')) left = Math.max(bounds.x, Math.min(right - 280, left + dx));
          if (edge.includes('n')) top = Math.max(bounds.y, Math.min(bottom - 220, top + dy));
          Object.assign(node.style, { left: left + 'px', top: top + 'px', width: right - left + 'px', height: bottom - top + 'px' });
        };
        const finish = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish); node.classList.remove('resizing'); persist(); };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
      });
    }
  }
  for (const node of document.querySelectorAll('[data-window]')) register(node);
  document.querySelectorAll('[data-launch] .app-icon').forEach((node) => { node.innerHTML = icon(node.closest('[data-launch]').dataset.launch); });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-launch]'); if (!button) return;
    if (button.closest('.desktop-icons')) {
      document.querySelectorAll('.desktop-icons button').forEach((item) => item.classList.toggle('selected', item === button));
      if (settings.singleClick || innerWidth < 640 || event.detail === 0) open(button.dataset.launch);
    } else open(button.dataset.launch);
  });
  document.addEventListener('dblclick', (event) => { const button = event.target.closest('.desktop-icons [data-launch]'); if (button && !settings.singleClick && innerWidth >= 640) open(button.dataset.launch); });
  document.querySelector('#launcher-button').innerHTML = icon('launch');
  function showDesktop() {
    const visibleWindows = [...windows].filter(([, item]) => visible(item)).sort((a, b) => (a[1].lastFocus || 0) - (b[1].lastFocus || 0)).map(([id]) => id);
    if (visibleWindows.length) { restoreDesktop = visibleWindows; visibleWindows.forEach(minimize); }
    else { restoreDesktop.forEach(open); restoreDesktop = []; }
  }
  document.querySelector('#show-desktop').addEventListener('click', showDesktop);
  document.addEventListener('keydown', (event) => {
    if (document.querySelector('#desktop').inert || document.querySelector('dialog[open]')) return;
    if (switchOrder.length && event.key === 'Escape') { event.preventDefault(); finishSwitch(false); return; }
    const is = id => matchesShortcut(event, settings, id);
    if (is('window-next') || is('window-previous')) { event.preventDefault(); switchWindow(is('window-previous') ? -1 : 1); return; }
    for (const [id, action] of [
      ['window-close', () => close(active)], ['window-maximize', () => maximize(active)],
      ['window-minimize', () => minimize(active)], ['window-left', () => tile(active, 'left')], ['window-right', () => tile(active, 'right')],
    ]) if (active && is(id)) { event.preventDefault(); action(); return; }
    if (is('desktop-next') || is('desktop-previous') || is('move-next') || is('move-previous')) {
      event.preventDefault(); const index = currentDesktop + (is('desktop-next') || is('move-next') ? 1 : -1);
      if (active && (is('move-next') || is('move-previous'))) moveTo(active, index);
      switchDesktop(index); return;
    }
    if (is('show-desktop')) { event.preventDefault(); showDesktop(); }
  });
  document.addEventListener('keyup', event => { if (switchOrder.length && !event.altKey && !event.ctrlKey && !event.metaKey) finishSwitch(); });
  document.addEventListener('pointerdown', event => { if (switchOrder.length && !event.target.closest('#window-switcher')) finishSwitch(false); });
  window.addEventListener('blur', () => finishSwitch(false));

  preferenceEvents.addEventListener('appearance', (event) => {
    settings = event.detail; currentDesktop = Math.min(currentDesktop, settings.desktopCount - 1); applyWorkArea();
    windows.forEach((item) => {
      item.desktop = Math.min(item.desktop, settings.desktopCount - 1);
      if (visible(item)) showSurface(item.node, { effect: 'window' }); else hideSurface(item.node, { effect: 'window' });
      cancelMotion(item.node); clamp(item);
    });
    renderTasks(); notify(); window.dispatchEvent(new CustomEvent('plasma:desktop', { detail: currentDesktop }));
  });
  window.addEventListener('resize', () => { applyWorkArea(); windows.forEach((item) => { cancelMotion(item.node); clamp(item); }); });
  window.addEventListener('pagehide', persist);
  applyWorkArea(); renderTasks();
  return {
    open, close, focus, minimize, maximize, tile, setTitle, switchDesktop, moveTo, register, showDesktop, persist,
    active: () => active, currentDesktop: () => currentDesktop,
    isOpen: (id) => Boolean(windows.get(id)?.opened),
    list: () => [...windows].map(([id, item]) => ({ id, ...item })),
    restoreSession() {
      if (!settings.rememberWindows) return;
      for (const [id, geometry] of Object.entries(saved)) if (geometry.opened && !['workbench', 'proof'].includes(id) && windows.has(id)) {
        const item = windows.get(id);
        if (item.node.dataset.restoreSession === 'false') continue;
        item.opened = true; item.minimized = Boolean(geometry.minimized);
        if (visible(item)) showSurface(item.node, { effect: 'window' }); else hideSurface(item.node, { effect: 'window' });
        if (visible(item)) item.node.dispatchEvent(new Event('window:open'));
      }
      focusRemaining();
    },
  };
}
