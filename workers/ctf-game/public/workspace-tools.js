import { $, $$, askText, askSave, decorate, formatSize, menubar, report, shortcut } from '/ui.js';
import { DOCUMENTS, TRASH, MAX_WORKSPACE_SIZE, normalize, basename, parent } from '/filesystem.js';
import { profileKey, getSettings } from '/preferences.js';
import { pickFile } from '/files.js';
import { diffLines, mergeThreeWay, renderMerge } from '/diff.js';

export const workspaceLayouts = {
  diff: `<nav id="diff-menubar" class="native-menubar"></nav>
    <div class="native-toolbar"><button id="diff-open-a" data-icon="document-open">A…</button><button id="diff-open-b" data-icon="document-open">B…</button><button id="diff-open-base" data-icon="document-open">基础版本…</button><button id="diff-compare" data-icon="view-refresh">比较</button><span class="toolbar-spacer"></span><button id="diff-save" data-icon="document-save">保存合并结果…</button></div>
    <div class="native-toolbar"><label class="setting-check"><input id="diff-three" type="checkbox">三方合并</label><label class="setting-check"><input id="diff-whitespace" type="checkbox">比较时忽略空白</label></div>
    <div class="diff-inputs"><label id="diff-base-panel" hidden><span id="diff-base-path">基础版本</span><textarea id="diff-base" aria-label="基础版本" spellcheck="false"></textarea></label><label><span id="diff-a-path">A</span><textarea id="diff-a" aria-label="文件 A" spellcheck="false"></textarea></label><label><span id="diff-b-path">B</span><textarea id="diff-b" aria-label="文件 B" spellcheck="false"></textarea></label></div>
    <div id="diff-lines" class="diff-lines utility-scroll" role="log" aria-label="差异"></div>
    <div class="native-toolbar"><button id="diff-previous" data-icon="go-previous" aria-label="上一个冲突"></button><span id="diff-conflict-count">0 / 0</span><button id="diff-next" data-icon="go-next" aria-label="下一个冲突"></button><button data-diff-choice="a">选择 A</button><button data-diff-choice="b">选择 B</button><button data-diff-choice="both">A + B</button><span class="toolbar-spacer"></span><span id="diff-save-path"></span></div>
    <textarea id="diff-output" class="diff-output" spellcheck="false" aria-label="合并结果"></textarea><footer class="statusbar" id="diff-status"></footer>`,
  disk: `<div class="native-toolbar"><button id="disk-up" data-icon="go-up">上一级</button><button id="disk-home" data-icon="user-home">文档</button><button id="disk-trash" data-icon="user-trash">回收站</button><button id="disk-refresh" data-icon="view-refresh">重新扫描</button><span class="toolbar-spacer"></span><button id="disk-purge" data-icon="edit-delete">清空回收站…</button></div><div class="utility-path" id="disk-path"></div><div class="disk-summary"><strong id="disk-used">0 B</strong><progress id="disk-progress" max="${MAX_WORKSPACE_SIZE}" value="0"></progress><span id="disk-quota"></span></div><div class="disk-content"><div id="disk-chart" aria-label="存储分布"></div><div class="utility-scroll"><table class="data-table"><thead><tr><th>名称</th><th>大小</th><th>文件</th></tr></thead><tbody id="disk-list"></tbody></table></div></div><footer class="statusbar" id="disk-status"></footer>`,
  logs: `<div class="native-toolbar"><select id="logs-kind" aria-label="日志类型"><option value="">全部</option><option value="file">文件系统</option><option value="application">应用程序</option></select><input id="logs-filter" type="search" aria-label="过滤日志" placeholder="过滤…"><button id="logs-export" data-icon="document-save-as">导出…</button><button id="logs-clear" data-icon="edit-clear">清空</button></div><div class="utility-scroll"><table class="data-table log-table"><thead><tr><th>时间</th><th>来源</th><th>操作</th><th>对象</th></tr></thead><tbody id="logs-list"></tbody></table></div><footer class="statusbar" id="logs-status"></footer>`,
};
const listen = (id, action, event = 'click') => $('#' + id).addEventListener(event, e => { Promise.resolve().then(() => action(e)).catch(report); });

export function createWorkspaceTools(controls) {
  const { fs, windows } = controls;
  return { diff: createDiff(), disk: createDisk(), logs: createLogs() };

  function createDiff() {
    let path = '', dirty = false, segments = [], choices = new Map(), conflict = 0, conflicts = [], closing = false;
    const node = $('#diff-window');
    function updateConflicts() {
      $('#diff-conflict-count').textContent = (conflicts.length ? conflict + 1 : 0) + ' / ' + conflicts.length;
      for (const button of $$('[data-diff-choice],#diff-previous,#diff-next')) button.disabled = !conflicts.length;
      $$('#diff-lines [data-conflict]').forEach(row => row.classList.toggle('selected', Number(row.dataset.conflict) === conflicts[conflict]));
      $('#diff-lines [data-conflict="' + conflicts[conflict] + '"]')?.scrollIntoView({ block: 'nearest' });
    }
    function compare() {
      const a = $('#diff-a').value, b = $('#diff-b').value, base = $('#diff-base').value;
      if ([a, b, base].some(text => text.length > 2_000_000 || (text.match(/\n/g)?.length || 0) > 20000)) throw Error('文本超过比较限制');
      const operations = diffLines(a, b, { ignoreWhitespace: $('#diff-whitespace').checked });
      const output = $('#diff-lines'); output.replaceChildren();
      let lineA = 1, lineB = 1, changes = 0;
      for (const entry of operations.slice(0, 6000)) {
        const row = document.createElement('div'); row.className = 'diff-line diff-' + entry.type;
        const numberA = document.createElement('span'), numberB = document.createElement('span'), text = document.createElement('pre');
        numberA.textContent = entry.type === 'insert' ? '' : lineA++;
        numberB.textContent = entry.type === 'delete' ? '' : lineB++;
        text.textContent = (entry.type === 'delete' ? '− ' : entry.type === 'insert' ? '+ ' : '  ') + entry.value.replace(/\r?\n$/, '');
        row.append(numberA, numberB, text); output.append(row);
      }
      changes = operations.filter(entry => entry.type !== 'equal').length;
      choices = new Map(); conflict = 0;
      segments = $('#diff-three').checked ? mergeThreeWay(base, a, b) : [{ type: 'change', text: b }];
      conflicts = segments.flatMap((segment, index) => segment.type === 'conflict' ? [index] : []);
      if ($('#diff-three').checked) {
        output.replaceChildren();
        segments.forEach((segment, index) => {
          const row = document.createElement('pre'); row.className = 'merge-block';
          if (segment.type === 'conflict') { row.dataset.conflict = String(index); row.textContent = renderMerge([segment]); row.onclick = () => { conflict = conflicts.indexOf(index); updateConflicts(); }; }
          else row.textContent = segment.text;
          output.append(row);
        });
      }
      $('#diff-output').value = renderMerge(segments, choices); dirty = true;
      $('#diff-status').textContent = changes + ' 行差异 · ' + conflicts.length + ' 个冲突' + (operations.length > 6000 ? ' · 差异视图显示前 6000 行' : '');
      updateConflicts();
    }
    async function save() {
      const name = await askText('保存合并结果', basename(path) || 'merged.txt');
      if (!name) return false;
      path = await fs.writeFile(normalize(name, DOCUMENTS), $('#diff-output').value);
      dirty = false; $('#diff-save-path').textContent = path; return true;
    }
    async function confirm() { if (!dirty) return true; const choice = await askSave(basename(path) || 'merged.txt'); return choice === 'discard' || choice === 'save' && await save(); }
    for (const side of ['a', 'b', 'base']) {
      listen('diff-open-' + side, () => pickFile(fs, async path => {
        const bytes = await fs.read(path); if (bytes.length > 2_000_000) throw Error('文件过大');
        $('#diff-' + side).value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); $('#diff-' + side + '-path').textContent = path;
        if (side === 'base') { $('#diff-three').checked = true; $('#diff-base-panel').hidden = false; }
      }));
    }
    listen('diff-compare', compare); listen('diff-save', save);
    listen('diff-three', () => { $('#diff-base-panel').hidden = !$('#diff-three').checked; }, 'change');
    listen('diff-output', () => { dirty = true; }, 'input');
    for (const [id, delta] of [['diff-next', 1], ['diff-previous', -1]]) listen(id, () => { if (conflicts.length) conflict = (conflict + delta + conflicts.length) % conflicts.length; updateConflicts(); });
    for (const button of $$('[data-diff-choice]')) button.onclick = () => {
      if (!conflicts.length) return;
      choices.set(conflicts[conflict], button.dataset.diffChoice); $('#diff-output').value = renderMerge(segments, choices); dirty = true;
      const row = $('#diff-lines [data-conflict="' + conflicts[conflict] + '"]'); row.classList.add('resolved');
      $('#diff-status').textContent = (conflicts.length - choices.size) + ' 个未解决冲突';
    };
    node.addEventListener('window:beforeclose', event => {
      if (!dirty) return; event.preventDefault(); if (closing) return; closing = true;
      void confirm().then(ok => { if (ok) { dirty = false; windows.close('diff'); } }).catch(report).finally(() => { closing = false; });
    });
    node.addEventListener('keydown', event => { if (shortcut(event, 's')) { event.preventDefault(); void save().catch(report); } });
    menubar($('#diff-menubar'), { '文件': [{ label: '打开 A…', action: () => $('#diff-open-a').click() }, { label: '打开 B…', action: () => $('#diff-open-b').click() }, { label: '保存合并结果…', shortcut: 'Ctrl+S', action: save }, null, { label: '关闭', action: () => windows.close('diff') }], '比较': [{ label: '比较', action: compare }, { label: '交换 A / B', action: () => { const a = $('#diff-a').value; $('#diff-a').value = $('#diff-b').value; $('#diff-b').value = a; compare(); } }] });
    updateConflicts();
    return { reset() { path = ''; dirty = false; for (const name of ['a', 'b', 'base', 'output']) $('#diff-' + name).value = ''; $('#diff-lines').replaceChildren(); segments = []; conflicts = []; updateConflicts(); } };
  }

  function createDisk() {
    let path = DOCUMENTS, generation = 0;
    const palette = ['#3daee9', '#1abc9c', '#fdbc4b', '#da4453', '#9b59b6', '#f67400', '#27ae60', '#7f8c8d'];
    async function scan(next = path) {
      if (!(next === DOCUMENTS || next.startsWith(DOCUMENTS + '/') || next === TRASH || next.startsWith(TRASH + '/'))) throw Error('EACCES');
      path = next; const token = ++generation; $('#disk-path').textContent = path; $('#disk-status').textContent = '扫描中…';
      async function size(entry) {
        if (token !== generation) throw Error('ECANCELED');
        if (entry.kind !== 'directory') return { ...entry, bytes: entry.size || 0, count: 1 };
        const children = [];
        for (const child of await fs.entries(entry.path)) children.push(await size(child));
        return { ...entry, bytes: children.reduce((sum, child) => sum + child.bytes, 0), count: children.reduce((sum, child) => sum + child.count, 0) };
      }
      const records = [];
      try {
        for (const entry of await fs.entries(path)) records.push(await size(entry));
        if (token !== generation) return;
        records.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
        const total = records.reduce((sum, entry) => sum + entry.bytes, 0), used = fs.used();
        $('#disk-used').textContent = formatSize(used); $('#disk-progress').value = used;
        $('#disk-quota').textContent = '/ ' + formatSize(MAX_WORKSPACE_SIZE); $('#disk-up').disabled = path === DOCUMENTS || path === TRASH;
        const list = $('#disk-list'), chart = $('#disk-chart'); list.replaceChildren(); chart.replaceChildren();
        const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 320 320');
        let angle = -Math.PI / 2;
        records.forEach((entry, index) => {
          const color = palette[index % palette.length], row = document.createElement('tr'); row.tabIndex = 0;
          for (const value of [entry.name, formatSize(entry.bytes), entry.count]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
          row.firstElementChild.style.borderLeft = '4px solid ' + color;
          const open = () => { if (entry.kind === 'directory') void scan(entry.path).catch(report); else void controls.system.openFile(entry.path).catch(report); };
          row.ondblclick = open; row.onkeydown = event => { if (event.key === 'Enter') open(); }; list.append(row);
          if (!entry.bytes || !total) return;
          const end = angle + entry.bytes / total * Math.PI * 2;
          const wedge = document.createElementNS(ns, 'path'), title = document.createElementNS(ns, 'title');
          const point = (r, a) => (160 + r * Math.cos(a)).toFixed(3) + ' ' + (160 + r * Math.sin(a)).toFixed(3);
          const a = angle, b = end - .00001, large = b - a > Math.PI ? 1 : 0;
          wedge.setAttribute('d', 'M ' + point(128, a) + ' A 128 128 0 ' + large + ' 1 ' + point(128, b) + ' L ' + point(68, b) + ' A 68 68 0 ' + large + ' 0 ' + point(68, a) + ' Z');
          wedge.setAttribute('fill', color); wedge.setAttribute('tabindex', '0'); wedge.setAttribute('role', 'button'); wedge.setAttribute('aria-label', entry.name + ' ' + formatSize(entry.bytes));
          title.textContent = entry.name + '\n' + formatSize(entry.bytes); wedge.append(title); wedge.onclick = open; wedge.onkeydown = event => { if (event.key === 'Enter') open(); }; svg.append(wedge); angle = end;
        });
        const center = document.createElementNS(ns, 'text'); center.setAttribute('x', '160'); center.setAttribute('y', '166'); center.setAttribute('text-anchor', 'middle'); center.textContent = formatSize(total); svg.append(center); chart.append(svg);
        $('#disk-status').textContent = records.length + ' 个项目 · ' + records.reduce((sum, item) => sum + item.count, 0) + ' 个文件 · ' + formatSize(total);
      } catch (error) { if (token === generation && error.message !== 'ECANCELED') { $('#disk-status').textContent = error.message; throw error; } }
    }
    for (const [id, action] of [['disk-refresh', () => scan()], ['disk-home', () => scan(DOCUMENTS)], ['disk-trash', () => scan(TRASH)], ['disk-up', () => scan(parent(path))]]) listen(id, action);
    listen('disk-purge', async () => {
      const entries = await fs.entries(TRASH); if (!entries.length) return;
      const confirmation = await askText('永久清空回收站', '', '输入 DELETE');
      if (confirmation !== 'DELETE') return;
      await fs.purge(); await scan(path.startsWith(TRASH) ? TRASH : path);
    });
    $('#disk-window').addEventListener('window:open', () => void scan().catch(report));
    $('#disk-window').addEventListener('window:close', () => { generation++; });
    fs.events.addEventListener('change', () => { if (!$('#disk-window').hidden) void scan().catch(report); });
    return { reset() { path = DOCUMENTS; generation++; $('#disk-chart').replaceChildren(); $('#disk-list').replaceChildren(); } };
  }

  function createLogs() {
    const key = 'arisaka/audit/' + profileKey(); let records = [];
    try { const value = JSON.parse(localStorage.getItem(key)); if (Array.isArray(value)) records = value.filter(item => item && Number.isFinite(item.time) && typeof item.path === 'string').slice(-500); } catch {}
    function render() {
      const kind = $('#logs-kind').value, filter = $('#logs-filter').value.toLowerCase();
      const selected = records.filter(item => (!kind || item.kind === kind) && [item.path, item.operation, item.destination].join(' ').toLowerCase().includes(filter));
      const list = $('#logs-list'); list.replaceChildren();
      for (const record of selected.toReversed()) {
        const row = document.createElement('tr');
        const time = new Intl.DateTimeFormat('zh-CN', { timeZone: getSettings().timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(record.time);
        for (const value of [time, record.kind, record.operation, record.path + (record.destination ? ' → ' + record.destination : '') + (record.bytes !== undefined ? ' · ' + formatSize(record.bytes) : '')]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        list.append(row);
      }
      $('#logs-status').textContent = selected.length + ' / ' + records.length;
    }
    function persist() { try { localStorage.setItem(key, JSON.stringify(records)); } catch {} }
    function record(item) { records.push(item); records = records.slice(-500); persist(); if (!$('#logs-window').hidden) render(); }
    fs.events.addEventListener('audit', event => record({ ...event.detail, kind: 'file' }));
    window.addEventListener('plasma:launch', event => record({ time: Date.now(), kind: 'application', operation: 'activate', path: event.detail }));
    listen('logs-kind', render, 'change'); listen('logs-filter', render, 'input');
    listen('logs-clear', () => { records = []; persist(); render(); });
    listen('logs-export', () => controls.download('desktop-log.json', JSON.stringify(records, null, 2), 'application/json'));
    $('#logs-window').addEventListener('window:open', render); render();
    return { reset() { render(); } };
  }
}
