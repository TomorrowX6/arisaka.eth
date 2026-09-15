import * as engine from '/vendor/editor-engine.js';
import { $, $$, menubar, askText, askSave, shortcut, report, decorate, actionIcon } from '/ui.js';
import { HOME, DOCUMENTS, basename, parent } from '/filesystem.js';

export function createEditor(controls) {
  const { fs, windows } = controls;
  const documents = [];
  let active;
  let view;
  let second;
  let player = '';
  let serial = 0;
  let wrapped = false;
  let size = 13;
  let savingTimer;

  function persist(immediate = false) {
    clearTimeout(savingTimer);
    const write = () => {
      try {
        localStorage.setItem('arisaka/kate/' + player, JSON.stringify({ active: active?.id, documents: documents.map((item) => ({ id: item.id, name: item.name, path: item.path, text: item.state.doc.toString(), saved: item.saved })) }));
      } catch { $('#editor-status').textContent = '保存失败'; }
    };
    if (immediate) write(); else savingTimer = setTimeout(write, 150);
  }
  window.addEventListener('pagehide', () => persist(true));
  function updateStatus() {
    if (!active || !view) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    $('#editor-position').textContent = line.number + ':' + (head - line.from + 1);
    $('#editor-language').textContent = /\.json$/i.test(active.name) ? 'JSON' : /\.(js|mjs|cjs|ts)$/i.test(active.name) ? 'JavaScript' : '纯文本';
    $('#editor-name').value = active.name;
    $('#editor-text').value = view.state.doc.toString();
    $('#editor-status').textContent = active.dirty ? '已修改' : '';
    $('#editor-path').textContent = (active.path || DOCUMENTS + '/' + active.name).replaceAll('/', ' › ').replace(/^ › /, '');
    windows.setTitle('editor', active.name + (active.dirty ? ' *' : '') + ' — Kate', 'editor');
  }
  function renderTabs() {
    for (const selector of ['#editor-tabs', '#editor-documents']) {
      const container = $(selector); container.replaceChildren();
      for (const item of documents) {
        const tab = document.createElement('div'); tab.className = 'document-tab' + (item === active ? ' selected' : '');
        const button = document.createElement('button'); button.type = 'button'; button.textContent = item.name;
        button.title = item.path || item.name; button.prepend(actionIcon('document-new'));
        button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(item === active));
        button.addEventListener('click', () => activate(item));
        const close = document.createElement('button'); close.type = 'button'; close.className = 'tab-close';
        close.textContent = item.dirty ? '●' : '×'; close.setAttribute('aria-label', '关闭 ' + item.name);
        close.addEventListener('click', () => void closeDocument(item));
        tab.append(button, close); container.append(tab);
      }
    }
  }
  function activate(item) {
    active = item;
    if (!view) view = engine.createView($('#editor-code'), item.state);
    else view.setState(item.state);
    if (second) second.setState(item.state);
    renderTabs(); updateStatus(); persist(); view.focus();
  }
  function add(name, text, path = '', saved = text, id) {
    const item = { id: id || 'document-' + ++serial, name, path, saved, dirty: saved !== text };
    item.state = engine.createState(text, name, (update) => {
      item.state = update.state;
      if (update.docChanged) {
        item.dirty = update.state.doc.toString() !== item.saved;
        if (second && second !== update.view) second.setState(update.state);
        if (view !== update.view) view.setState(update.state);
        renderTabs(); persist();
      }
      if (item === active) updateStatus();
    }, { save: () => void save(), saveAs: () => void save(true) });
    documents.push(item); activate(item); return item;
  }
  function open(name, text, path = '') {
    const existing = path && documents.find((item) => item.path === path);
    if (existing) activate(existing); else add(basename(name), text, path);
    windows.open('editor'); view.focus();
  }
  function newDocument() {
    let number = 1, name = 'untitled.js';
    while (documents.some((item) => item.name === name)) name = 'untitled-' + ++number + '.js';
    add(name, '', '', '');
  }
  async function save(as = false, item = active) {
    if (!item) return false;
    let path = item.path;
    if (as || !path || !fs.writable(path)) {
      const value = await askText('另存为', item.name, '文件名：');
      if (!value) return false;
      path = value.startsWith('/') ? value : DOCUMENTS + '/' + value;
    }
    try {
      const text = item.state.doc.toString();
      await fs.writeFile(path, text);
      if (!documents.includes(item)) return false;
      item.path = path; item.name = basename(path); item.saved = text; item.dirty = item.state.doc.toString() !== text;
      if (item === active) { engine.setLanguage(view, item.name); updateStatus(); }
      renderTabs(); persist(true); return true;
    } catch (error) { report(error); return false; }
  }
  async function closeDocument(item = active) {
    if (!item) return;
    if (item.dirty) {
      const choice = await askSave(item.name);
      if (choice === 'cancel' || choice === 'save' && !await save(false, item)) return;
    }
    const index = documents.indexOf(item);
    documents.splice(index, 1);
    if (!documents.length) newDocument();
    else if (active === item) activate(documents[Math.min(index, documents.length - 1)]);
    renderTabs(); persist();
  }
  function split() {
    const pane = $('#editor-code-split');
    if (second) { second.destroy(); second = null; pane.hidden = true; }
    else { pane.hidden = false; second = engine.createView(pane, view.state); }
    $('#editor-split').setAttribute('aria-pressed', String(Boolean(second)));
  }
  function toggleOutput(show) {
    const panel = $('#editor-output-panel');
    panel.hidden = typeof show === 'boolean' ? !show : !panel.hidden;
    $('#editor-output-toggle').setAttribute('aria-pressed', String(!panel.hidden));
  }
  function output(text, clear = false) {
    toggleOutput(true);
    const node = $('#editor-output');
    node.textContent = ((clear ? '' : node.textContent) + text).slice(-65536); node.scrollTop = node.scrollHeight;
  }
  function run() {
    output('', true);
    return controls.run(view.state.doc.toString(), (text) => output(text + '\n'), { language: active?.name?.endsWith('.py') ? 'python' : 'javascript', filename: active?.path || active?.name });
  }
  function setPlayer(value) {
    clearTimeout(savingTimer); player = value; serial = 0;
    documents.splice(0); view?.destroy(); second?.destroy(); view = null; second = null;
    $('#editor-code-split').hidden = true; $('#editor-output').textContent = ''; toggleOutput(false);
    try {
      const saved = JSON.parse(localStorage.getItem('arisaka/kate/' + player) || 'null');
      for (const item of (saved?.documents || []).slice(0, 20)) {
        if (typeof item.text === 'string' && item.text.length <= 100000 && typeof item.name === 'string') add(item.name, item.text, item.path || '', item.saved ?? item.text);
      }
      if (documents.length) activate(documents[Math.max(0, Number(saved.active?.split('-').at(-1)) - 1)] || documents.at(-1));
    } catch {}
    if (!documents.length) newDocument();
  }
  const find = () => { engine.openSearchPanel(view); };
  const wrap = () => { wrapped = !wrapped; engine.setWrap(view, wrapped); if (second) engine.setWrap(second, wrapped); };
  const zoom = (delta) => { size = Math.max(10, Math.min(24, size + delta)); engine.setFontSize(view, size); if (second) engine.setFontSize(second, size); };
  const select = () => engine.selectAll(view);
  const copy = async () => navigator.clipboard.writeText(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to));
  const paste = async () => { const value = await navigator.clipboard.readText(); view.dispatch(view.state.replaceSelection(value)); view.focus(); };
  const fileActions = () => [
    { label: '新建', icon: 'document-new', shortcut: 'Ctrl+N', action: newDocument },
    { label: '打开…', icon: 'document-open', shortcut: 'Ctrl+O', action: () => controls.pickFile('edit') }, null,
    { label: '保存', icon: 'document-save', shortcut: 'Ctrl+S', action: () => save() },
    { label: '另存为…', icon: 'document-save-as', shortcut: 'Ctrl+Shift+S', action: () => save(true) }, null,
    { label: '关闭文档', shortcut: 'Ctrl+W', action: () => closeDocument() },
    { label: '退出', shortcut: 'Alt+F4', action: () => windows.close('editor') },
  ];
  menubar($('#editor-menubar'), {
    '文件': fileActions,
    '编辑': () => [
      { label: '撤销', icon: 'edit-undo', shortcut: 'Ctrl+Z', action: () => engine.undo(view) },
      { label: '重做', icon: 'edit-redo', shortcut: 'Ctrl+Shift+Z', action: () => engine.redo(view) }, null,
      { label: '复制', icon: 'edit-copy', shortcut: 'Ctrl+C', action: copy }, { label: '粘贴', icon: 'edit-paste', shortcut: 'Ctrl+V', action: paste }, null,
      { label: '查找…', icon: 'edit-find', shortcut: 'Ctrl+F', action: find }, { label: '查找并替换…', shortcut: 'Ctrl+H', action: find },
    ],
    '选择': [{ label: '全选', shortcut: 'Ctrl+A', action: select }],
    '视图': () => [
      { label: '拆分视图', icon: 'view-split-left-right', checked: Boolean(second), action: split },
      { label: '文档侧栏', checked: !$('#editor-sidebar').hidden, action: () => { $('#editor-sidebar').hidden = !$('#editor-sidebar').hidden; } },
      { label: '动态换行', checked: wrapped, shortcut: 'F10', action: wrap }, null,
      { label: '放大', icon: 'zoom-in', shortcut: 'Ctrl++', action: () => zoom(1) }, { label: '缩小', icon: 'zoom-out', shortcut: 'Ctrl+-', action: () => zoom(-1) },
    ],
    '转到': [{ label: '转到行…', shortcut: 'Ctrl+G', action: async () => { const value = await askText('转到行', '', '行号：'); if (value && /^\d+$/.test(value)) { const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Number(value)))); view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true }); view.focus(); } } }],
    '工具': [{ label: '运行', icon: 'media-playback-start', shortcut: 'F5', action: run }, { label: '停止', icon: 'media-playback-stop', action: controls.stop }, null, { label: '缩进', action: () => engine.indentMore(view) }, { label: '取消缩进', action: () => engine.indentLess(view) }, { label: 'JavaScript API', action: () => controls.openFile('/usr/share/doc/javascript.txt') }],
  });
  const actions = {
    '#editor-new': newDocument, '#editor-open': () => controls.pickFile('edit'), '#editor-save': () => save(), '#editor-save-as': () => save(true),
    '#editor-undo': () => engine.undo(view), '#editor-redo': () => engine.redo(view), '#editor-run': run, '#editor-stop': controls.stop,
    '#editor-split': split, '#editor-find': find, '#editor-output-toggle': () => toggleOutput(), '#editor-output-close': () => toggleOutput(false),
    '#editor-terminal': () => controls.openConsole(active?.path ? parent(active.path) : HOME), '#editor-api': () => controls.openFile('/usr/share/doc/javascript.txt'),
    '#editor-sidebar-toggle': () => { $('#editor-sidebar').hidden = !$('#editor-sidebar').hidden; },
  };
  for (const [selector, action] of Object.entries(actions)) $(selector).addEventListener('click', () => Promise.resolve().then(action).catch(report));
  $('#editor-window').addEventListener('keydown', (event) => {
    let action;
    if (shortcut(event, 'n')) action = newDocument;
    else if (shortcut(event, 'o')) action = () => controls.pickFile('edit');
    else if (shortcut(event, 'w')) action = () => closeDocument();
    else if (shortcut(event, 'h')) action = find;
    else if (event.key === 'F5') action = run;
    else if (event.key === 'F10') action = wrap;
    if (action) { event.preventDefault(); event.stopPropagation(); Promise.resolve().then(action).catch(report); }
  }, true);
  $('#editor-window').addEventListener('window:open', () => view?.focus());
  $('#editor-window').addEventListener('window:close', controls.stop);
  decorate($('#editor-window'));
  return { open, newDocument, setPlayer, output, getText: () => view?.state.doc.toString() || '', save };
}

export function enhanceNotes(controls) {
  const input = $('#notes-input');
  let synchronizing = false;
  const view = engine.createView($('#notes-code'), engine.createState(input.value, 'notes.txt', (update) => {
    if (!update.docChanged || synchronizing) return;
    input.value = update.state.doc.toString().slice(0, 30000);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    $('#notes-position').textContent = update.state.doc.lineAt(update.state.selection.main.head).number + ':' + (update.state.selection.main.head - update.state.doc.lineAt(update.state.selection.main.head).from + 1);
  }, { save: () => input.dispatchEvent(new Event('input')) }));
  const reset = () => { synchronizing = true; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: input.value } }); synchronizing = false; };
  input.addEventListener('notes:load', reset);
  const save = () => input.dispatchEvent(new Event('input'));
  menubar($('#notes-menubar'), {
    '文件': [{ label: '保存', icon: 'document-save', shortcut: 'Ctrl+S', action: save }, { label: '另存为…', icon: 'document-save-as', action: () => $('#export-notes').click() }, null, { label: '关闭', action: () => controls.windows.close('notes') }],
    '编辑': [{ label: '撤销', icon: 'edit-undo', action: () => engine.undo(view) }, { label: '重做', icon: 'edit-redo', action: () => engine.redo(view) }, null, { label: '全选', action: () => engine.selectAll(view) }, { label: '查找…', icon: 'edit-find', action: () => engine.openSearchPanel(view) }],
    '视图': () => [{ label: '回执', checked: !$('.receipt-fields').hidden, action: () => { $('.receipt-fields').hidden = !$('.receipt-fields').hidden; } }],
  });
  $('#notes-save').addEventListener('click', save);
  $('#notes-undo').addEventListener('click', () => engine.undo(view));
  $('#notes-redo').addEventListener('click', () => engine.redo(view));
  $('#notes-find').addEventListener('click', () => engine.openSearchPanel(view));
  $('#notes-receipts').addEventListener('click', () => { $('.receipt-fields').hidden = !$('.receipt-fields').hidden; });
  return { reset };
}
