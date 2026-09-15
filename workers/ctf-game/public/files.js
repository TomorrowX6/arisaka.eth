import { $, $$, menu, menubar, askText, showMessage, shortcut, report, decorate, formatSize } from '/ui.js';
import { HOME, DOCUMENTS, TRASH, MAX_FILE_SIZE, MAX_WORKSPACE_SIZE, normalize, parent, basename, fileType } from '/filesystem.js';
import { profileKey } from '/preferences.js';
import { icon } from '/desktop.js';

const accessDenied = (path) => showMessage('禁止访问', '你没有权限访问此文件夹：' + path);

export function pickFile(fs, open, initial = HOME) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog'); dialog.className = 'native-dialog file-dialog';
    dialog.innerHTML = '<h2>打开文件</h2><form><div class="native-toolbar"><button type="button" data-up aria-label="上一级" data-icon="go-up"></button><input aria-label="位置" data-path></div><div class="picker-files"></div><label>文件名：<input data-name autocomplete="off" spellcheck="false"></label><div class="button-row"><button type="button" data-cancel>取消</button><button type="submit" class="button primary">打开</button></div></form>';
    let cwd = initial, generation = 0;
    async function navigate(path) {
      const token = ++generation;
      try {
        const entries = await fs.entries(path); if (token !== generation) return;
        cwd = normalize(path); $('[data-path]', dialog).value = cwd;
        const list = $('.picker-files', dialog); list.replaceChildren();
        for (const file of entries) {
          if (file.name.startsWith('.')) continue;
          const button = document.createElement('button'); button.type = 'button'; button.className = 'picker-file' + (file.locked ? ' locked' : ''); button.innerHTML = icon(file.icon);
          const name = document.createElement('span'); name.textContent = file.name; button.append(name);
          button.addEventListener('click', () => { $$('button', list).forEach((item) => item.classList.toggle('selected', item === button)); $('[data-name]', dialog).value = file.name; });
          button.addEventListener('dblclick', () => { if (file.kind === 'directory') void navigate(file.path); else void choose(file.path); }); list.append(button);
        }
      } catch (error) { if (error.message.startsWith('EACCES')) await accessDenied(path); else report(error); }
    }
    async function choose(path) {
      try {
        const entries = await fs.entries(path);
        if (entries) { await navigate(path); return; }
      } catch (error) { if (!error.message.startsWith('ENOTDIR')) { report(error); return; } }
      try { await open(path); dialog.close(path); } catch (error) { report(error); }
    }
    $('form', dialog).addEventListener('submit', (event) => { event.preventDefault(); void choose(normalize($('[data-name]', dialog).value, cwd)); });
    $('[data-path]', dialog).addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void navigate(normalize(event.target.value)); } });
    $('[data-up]', dialog).addEventListener('click', () => void navigate(parent(cwd)));
    $('[data-cancel]', dialog).addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { const path = dialog.returnValue; dialog.remove(); resolve(path || null); }, { once: true });
    document.body.append(dialog); decorate(dialog); dialog.showModal(); void navigate(initial);
  });
}

export function createFileManager(controls) {
  const { fs, windows } = controls;
  const panes = [$('#files-primary'), $('#files-secondary')].map((node) => ({ node, grid: $('.file-grid', node), path: HOME, history: [], position: -1, selected: new Set(), entries: [], generation: 0 }));
  let active = panes[0], split = false, mode = 'icons', hidden = false, filter = '', clipboard;
  let iconSize = 56;
  let sortBy = 'name', reversed = false;
  let previewUrl;
  let previewGeneration = 0;

  function saveSettings() {
    try { localStorage.setItem('arisaka/dolphin/settings/' + profileKey(), JSON.stringify({ mode, hidden, iconSize, sortBy, reversed })); } catch {}
  }
  try {
    const saved = JSON.parse(localStorage.getItem('arisaka/dolphin/settings/' + profileKey()) || '{}');
    if (['icons', 'compact', 'details'].includes(saved.mode)) mode = saved.mode;
    hidden = Boolean(saved.hidden); if (saved.iconSize >= 32 && saved.iconSize <= 96) iconSize = saved.iconSize;
  } catch {}
  function select(pane, entry, append = false) {
    active = pane;
    if (!append) pane.selected.clear();
    if (append && pane.selected.has(entry.path)) pane.selected.delete(entry.path); else pane.selected.add(entry.path);
    for (const item of $$('[data-file-path]', pane.node)) { const value = pane.selected.has(item.dataset.filePath); item.classList.toggle('selected', value); item.setAttribute('aria-selected', String(value)); }
    sync(); void information(entry);
  }
  function sorted(pane) {
    const files = pane.entries.filter((entry) => (hidden || !entry.name.startsWith('.')) && (!filter || entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())));
    return files.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || (sortBy === 'size' ? (a.size || 0) - (b.size || 0) : a.name.localeCompare(b.name, 'zh-CN', { numeric: true })) * (reversed ? -1 : 1));
  }
  async function information(entry) {
    const token = ++previewGeneration;
    const box = $('#file-information');
    $('#file-info-icon').innerHTML = icon(entry.icon);
    $('#file-info-name').textContent = entry.name;
    $('#file-info-type').textContent = entry.label;
    $('#file-info-size').textContent = formatSize(entry.size);
    $('#file-info-location').textContent = parent(entry.path);
    $('#file-info-preview').replaceChildren();
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (box.hidden || entry.kind === 'directory') return;
    try {
      const bytes = await fs.read(entry.path); if (token !== previewGeneration) return;
      $('#file-info-size').textContent = formatSize(bytes.length);
      if (/\.(png|jpe?g)$/i.test(entry.name)) {
        previewUrl = URL.createObjectURL(new Blob([bytes], { type: /\.png$/i.test(entry.name) ? 'image/png' : 'image/jpeg' }));
        const image = document.createElement('img'); image.src = previewUrl; image.alt = entry.name; $('#file-info-preview').append(image);
      }
    } catch {}
  }
  function sync() {
    $('#file-location').value = active.path;
    const crumbs = $('#file-breadcrumbs'); crumbs.replaceChildren();
    const parts = active.path === TRASH ? [{ name: '回收站', path: TRASH }] : active.path.startsWith(HOME) ? [{ name: '主目录', path: HOME }, ...active.path.slice(HOME.length).split('/').filter(Boolean).map((name, index, all) => ({ name, path: HOME + '/' + all.slice(0, index + 1).join('/') }))] : [{ name: '根目录', path: '/' }, ...active.path.split('/').filter(Boolean).map((name, index, all) => ({ name, path: '/' + all.slice(0, index + 1).join('/') }))];
    for (const part of parts) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = part.name;
      button.addEventListener('click', () => void navigate(part.path)); crumbs.append(button);
    }
    $('#files-back').disabled = active.position <= 0;
    $('#files-forward').disabled = active.position >= active.history.length - 1;
    $('#files-up').disabled = active.path === '/';
    const entries = sorted(active); const directories = entries.filter((entry) => entry.kind === 'directory').length;
    $('#file-count').textContent = active.selected.size ? '已选择 ' + active.selected.size + ' 项' : [directories ? directories + ' 个文件夹' : '', entries.length - directories ? entries.length - directories + ' 个文件' : ''].filter(Boolean).join('，') || '0 个文件';
    $('#files-storage').textContent = formatSize(Math.max(0, MAX_WORKSPACE_SIZE - fs.used())) + ' 可用';
    windows.setTitle('files', (active.path === HOME ? '主目录' : active.path === TRASH ? '回收站' : basename(active.path)) + ' — Dolphin', 'files');
    $$('[data-place]').forEach((button) => button.classList.toggle('active', button.dataset.place === active.path));
    for (const pane of panes) pane.node.classList.toggle('active-pane', pane === active);
  }
  function render(pane) {
    pane.grid.replaceChildren();
    pane.node.dataset.view = mode; pane.grid.style.setProperty('--file-icon-size', iconSize + 'px');
    for (const entry of sorted(pane)) {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'file-item' + (pane.selected.has(entry.path) ? ' selected' : '') + (entry.solved ? ' solved' : '');
      item.classList.toggle('locked', Boolean(entry.locked)); item.dataset.filePath = entry.path;
      item.title = entry.name + (entry.locked ? ' · 未解锁' : entry.solved ? ' · 已恢复' : '');
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(pane.selected.has(entry.path)));
      item.innerHTML = icon(entry.icon);
      const name = document.createElement('span'); name.className = 'file-name'; name.textContent = entry.name;
      const size = document.createElement('span'); size.className = 'file-size'; size.textContent = entry.kind === 'directory' ? '' : formatSize(entry.size);
      const type = document.createElement('span'); type.className = 'file-type'; type.textContent = entry.label;
      const modified = document.createElement('span'); modified.className = 'file-modified'; modified.textContent = entry.modified ? new Date(entry.modified).toLocaleDateString('zh-CN') : '—';
      item.append(name, size, type, modified);
      item.addEventListener('click', (event) => select(pane, entry, event.ctrlKey || event.metaKey));
      item.addEventListener('dblclick', () => void open(entry));
      item.addEventListener('contextmenu', (event) => { event.preventDefault(); if (!pane.selected.has(entry.path)) select(pane, entry); menu(contextItems(), null, { x: event.clientX, y: event.clientY }); });
      pane.grid.append(item);
    }
    sync();
  }
  async function navigate(path, pane = active, history = true) {
    path = normalize(path); const generation = ++pane.generation;
    try {
      const entries = await fs.entries(path); if (generation !== pane.generation) return;
      pane.path = path; pane.entries = entries; pane.selected.clear();
      if (history && pane.history[pane.position] !== path) { pane.history.splice(++pane.position); pane.history.push(path); }
      active = pane; render(pane);
      if (!$('#files-terminal-panel').hidden) void controls.terminal(path).catch(report);
      return true;
    } catch (error) { if (error.message.startsWith('EACCES')) await accessDenied(path); else report(error); return false; }
  }
  async function open(entry) {
    try {
      if (entry.locked) { await accessDenied(entry.path); return; }
      if (entry.kind === 'directory') await navigate(entry.path);
      else await controls.openFile(entry.path);
    } catch (error) { report(error); }
  }
  const selected = () => active.entries.filter((entry) => active.selected.has(entry.path));
  const openSelected = () => Promise.all(selected().map(open));
  const refresh = () => Promise.all(panes.filter((pane) => !pane.node.hidden).map((pane) => navigate(pane.path, pane, false)));
  async function back(delta) {
    const index = active.position + delta;
    if (index < 0 || index >= active.history.length) return;
    const pane = active;
    if (await navigate(pane.history[index], pane, false)) { pane.position = index; sync(); }
  }
  function view(value) { mode = value; panes.forEach(render); $$('[data-file-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.fileView === value))); saveSettings(); }
  async function newFolder() { const name = await askText('新建文件夹', '新建文件夹'); if (name) await fs.mkdir(normalize(name, active.path)); }
  async function newFile() { const name = await askText('新建文本文件', 'untitled.txt'); if (name) { const path = await fs.writeFile(normalize(name, active.path), '', false); controls.openFile(path, 'edit'); } }
  function importFiles() {
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
    input.addEventListener('change', async () => {
      try {
        const incoming = [...input.files];
        if (incoming.some((file) => file.size > MAX_FILE_SIZE) || fs.used() + incoming.reduce((sum, file) => sum + file.size, 0) > MAX_WORKSPACE_SIZE) throw new Error('ENOSPC');
        for (const file of incoming) await fs.writeFile(normalize(file.name, active.path === DOCUMENTS || active.path.startsWith(DOCUMENTS + '/') ? active.path : DOCUMENTS), new Uint8Array(await file.arrayBuffer()), false);
        await navigate(active.path === DOCUMENTS || active.path.startsWith(DOCUMENTS + '/') ? active.path : DOCUMENTS);
      } catch (error) { report(error); }
    }); input.click();
  }
  async function rename() { const entry = selected()[0]; if (!entry) return; const name = await askText('重命名', entry.name); if (name && name !== entry.name) await fs.rename(entry.path, normalize(name, parent(entry.path))); }
  async function remove() { for (const entry of selected()) await fs.remove(entry.path); }
  function copy(cut = false) { clipboard = { paths: [...active.selected], cut }; }
  async function paste() {
    if (!clipboard?.paths.length) return;
    for (const path of clipboard.paths) {
      const destination = active.path + '/' + basename(path);
      if (clipboard.cut) await fs.rename(path, destination); else await fs.writeFile(destination, await fs.read(path), false);
    }
    if (clipboard.cut) clipboard = null;
  }
  function toggleSplit() {
    split = !split; panes[1].node.hidden = !split;
    if (split) void navigate(active.path, panes[1]); else { active = panes[0]; sync(); }
    $('#files-split').setAttribute('aria-pressed', String(split));
  }
  function location() { $('#file-breadcrumbs').hidden = true; $('#file-location').hidden = false; $('#file-location').focus(); $('#file-location').select(); }
  function hideLocation() { $('#file-breadcrumbs').hidden = false; $('#file-location').hidden = true; }
  function toggleHidden() { hidden = !hidden; panes.forEach(render); saveSettings(); }
  function toggleInfo() { $('#file-information').hidden = !$('#file-information').hidden; if (selected()[0]) void information(selected()[0]); }
  function terminal() { $('#files-terminal-panel').hidden = !$('#files-terminal-panel').hidden; if (!$('#files-terminal-panel').hidden) return controls.terminal(active.path); }
  function contextItems() {
    const items = selected(), has = Boolean(items.length), writable = items.length && items.every((entry) => entry.writable);
    if (active.path === TRASH) return [{ label: '还原', icon: 'edit-undo', disabled: !has, action: async () => { for (const entry of items) await fs.restore(entry.path); } }];
    return [
      { label: '打开', icon: 'document-open', disabled: !has, action: openSelected },
      { label: '用 Kate 打开', icon: 'document-open', disabled: items.length !== 1 || items[0]?.kind === 'directory', action: () => controls.openFile(items[0].path, 'edit') }, null,
      { label: '剪切', icon: 'edit-cut', shortcut: 'Ctrl+X', disabled: !writable, action: () => copy(true) },
      { label: '复制', icon: 'edit-copy', shortcut: 'Ctrl+C', disabled: !has || items.some((entry) => entry.kind === 'directory'), action: () => copy() },
      { label: '粘贴', icon: 'edit-paste', shortcut: 'Ctrl+V', disabled: !clipboard?.paths.length || !(active.path === DOCUMENTS || fs.writable(active.path)), action: paste }, null,
      { label: '重命名…', shortcut: 'F2', disabled: items.length !== 1 || !writable, action: rename },
      { label: '移到回收站', icon: 'edit-delete', shortcut: 'Delete', disabled: !writable, action: remove }, null,
      { label: '新建文件夹…', icon: 'folder-new', shortcut: 'F10', disabled: !(active.path === DOCUMENTS || fs.writable(active.path)), action: newFolder },
      { label: '新建文本文件…', icon: 'document-new', disabled: !(active.path === DOCUMENTS || fs.writable(active.path)), action: newFile }, null,
      { label: '复制位置', disabled: items.length !== 1, action: () => navigator.clipboard.writeText(items[0].path) },
      { label: '属性', icon: 'document-properties', disabled: items.length !== 1, action: () => { $('#file-information').hidden = false; return information(items[0]); } },
    ];
  }
  const definitions = {
    '文件': () => [contextItems()[0], null, ...contextItems().filter((entry) => entry?.label.startsWith('新建')), { label: '导入文件…', icon: 'document-open', action: importFiles }, null, { label: '关闭', shortcut: 'Alt+F4', action: () => windows.close('files') }],
    '编辑': () => contextItems().filter((entry) => ['剪切', '复制', '粘贴', '重命名…', '移到回收站'].includes(entry?.label)),
    '视图': () => [
      ...[['icons', '图标', 'Ctrl+1'], ['compact', '紧凑', 'Ctrl+2'], ['details', '详细信息', 'Ctrl+3']].map(([key, label, shortcut]) => ({ label, shortcut, checked: mode === key, action: () => view(key) })), null,
      { label: '拆分视图', checked: split, shortcut: 'F3', action: toggleSplit }, { label: '信息面板', checked: !$('#file-information').hidden, shortcut: 'F11', action: toggleInfo },
      { label: '显示隐藏文件', checked: hidden, shortcut: 'Ctrl+H', action: toggleHidden }, { label: '刷新', icon: 'view-refresh', shortcut: 'F5', action: refresh },
    ],
    '转到': [{ label: '后退', icon: 'go-previous', shortcut: 'Alt+←', action: () => back(-1) }, { label: '前进', icon: 'go-next', shortcut: 'Alt+→', action: () => back(1) }, { label: '上一级', icon: 'go-up', shortcut: 'Alt+↑', action: () => navigate(parent(active.path)) }, { label: '主目录', icon: 'go-home', shortcut: 'Alt+Home', action: () => navigate(HOME) }],
    '工具': [{ label: '打开终端', shortcut: 'Shift+F4', action: () => controls.openConsole(active.path) }, { label: '显示终端面板', shortcut: 'F4', action: terminal }],
    '设置': () => [{ label: '显示菜单栏', checked: !$('#files-menubar').hidden, shortcut: 'Ctrl+M', action: () => { $('#files-menubar').hidden = !$('#files-menubar').hidden; } }],
  };
  menubar($('#files-menubar'), definitions);
  $('#files-menu').addEventListener('click', () => menu([...definitions['视图'](), null, ...definitions['工具'], null, ...definitions['设置']()], $('#files-menu')));
  const actions = { '#files-back': () => back(-1), '#files-forward': () => back(1), '#files-up': () => navigate(parent(active.path)), '#files-home': () => navigate(HOME), '#files-split': toggleSplit, '#files-terminal-toggle': terminal, '#files-info': toggleInfo, '#files-search-toggle': () => { $('#files-filterbar').hidden = !$('#files-filterbar').hidden; if (!$('#files-filterbar').hidden) $('#files-filter').focus(); else { filter = ''; $('#files-filter').value = ''; panes.forEach(render); } }, '#files-filter-close': () => $('#files-search-toggle').click(), '#files-terminal-close': () => { $('#files-terminal-panel').hidden = true; }, '#files-location-edit': location };
  for (const [selector, action] of Object.entries(actions)) $(selector).addEventListener('click', () => Promise.resolve().then(action).catch(report));
  $$('[data-place]').forEach((button) => button.addEventListener('click', () => void navigate(button.dataset.place)));
  $$('[data-file-view]').forEach((button) => button.addEventListener('click', () => view(button.dataset.fileView)));
  $('#file-location').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void navigate(event.target.value).then((success) => { if (success) hideLocation(); }); } else if (event.key === 'Escape') hideLocation(); });
  $('#file-location').addEventListener('blur', hideLocation);
  $('#file-breadcrumbs').addEventListener('dblclick', location);
  $('#files-filter').addEventListener('input', (event) => { filter = event.target.value; panes.forEach(render); });
  $('#files-zoom').value = iconSize;
  $('#files-zoom').addEventListener('input', (event) => { iconSize = Number(event.target.value); panes.forEach(render); saveSettings(); });
  for (const pane of panes) {
    pane.node.addEventListener('pointerdown', () => { active = pane; sync(); });
    pane.node.addEventListener('contextmenu', (event) => { if (!event.target.closest('[data-file-path]')) { event.preventDefault(); active = pane; pane.selected.clear(); menu(contextItems(), null, { x: event.clientX, y: event.clientY }); } });
    $$('[data-sort]', pane.node).forEach((button) => button.addEventListener('click', () => { if (sortBy === button.dataset.sort) reversed = !reversed; else { sortBy = button.dataset.sort; reversed = false; } panes.forEach(render); }));
  }
  $('#files-window').addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea') || event.target.closest('#files-terminal-panel')) return;
    let action;
    if (shortcut(event, 'l')) action = location;
    else if (shortcut(event, 'h')) action = toggleHidden;
    else if (shortcut(event, 'c')) action = () => copy();
    else if (shortcut(event, 'x')) action = () => copy(true);
    else if (shortcut(event, 'v')) action = paste;
    else if (shortcut(event, 'm')) action = () => { $('#files-menubar').hidden = !$('#files-menubar').hidden; };
    else if (shortcut(event, 'a')) action = () => { active.selected = new Set(sorted(active).filter((item) => !item.locked).map((item) => item.path)); render(active); };
    else if (event.ctrlKey && ['1', '2', '3'].includes(event.key)) action = () => view(['icons', 'compact', 'details'][Number(event.key) - 1]);
    else if (event.altKey && event.key === 'ArrowLeft') action = () => back(-1);
    else if (event.altKey && event.key === 'ArrowRight') action = () => back(1);
    else if (event.altKey && event.key === 'ArrowUp') action = () => navigate(parent(active.path));
    else if (event.key === 'Enter') action = openSelected;
    else if (event.key === 'Delete') action = remove;
    else if (event.key === 'F2') action = rename;
    else if (event.key === 'F3') action = toggleSplit;
    else if (event.key === 'F4') action = event.shiftKey ? () => controls.openConsole(active.path) : terminal;
    else if (event.key === 'F5') action = refresh;
    else if (event.key === 'F10') action = newFolder;
    else if (event.key === 'F11') action = toggleInfo;
    if (action) { event.preventDefault(); Promise.resolve().then(action).catch(report); }
  });
  // The address shortcut must also work while a toolbar button holds focus.
  $('#files-window').addEventListener('keydown', (event) => { if (shortcut(event, 'l')) { event.preventDefault(); location(); } }, true);
  fs.events.addEventListener('change', () => { if (controls.state().started) void refresh(); });
  view(mode); decorate($('#files-window'));
  return { navigate, refresh, reset: () => { active = panes[0]; panes.forEach((pane) => { pane.path = HOME; pane.history = []; pane.position = -1; pane.selected.clear(); }); void navigate(HOME); }, currentPath: () => active.path };
}
