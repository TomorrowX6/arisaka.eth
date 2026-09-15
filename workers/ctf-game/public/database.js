import { $, askText, askSave, report, formatSize, decorate } from '/ui.js';
import { DOCUMENTS, normalize, basename } from '/filesystem.js';
import { pickFile } from '/files.js';

export const databaseLayout=`<div class="native-toolbar"><button id="database-open" data-icon="document-open">打开…</button><button id="database-new" data-icon="document-new">新建</button><button id="database-save" data-icon="document-save-as">另存为…</button><span class="toolbar-spacer"></span><label class="setting-check"><input id="database-readonly" type="checkbox" checked>只读</label></div><div class="database-layout"><aside><header>数据库结构</header><div id="database-tables"></div></aside><div class="database-main"><label class="sr-only" for="database-sql">SQL</label><textarea id="database-sql" spellcheck="false" aria-label="SQL" maxlength="100000"></textarea><div class="native-toolbar"><button id="database-run" class="button primary" data-icon="media-playback-start">执行</button><button id="database-stop" data-icon="media-playback-stop" disabled>停止</button><button id="database-schema">结构</button><span class="toolbar-spacer"></span><button id="database-csv" data-icon="document-save-as">导出 CSV…</button></div><div id="database-results" class="utility-scroll"></div></div></div><footer class="statusbar"><span id="database-path"></span><span class="toolbar-spacer"></span><span id="database-status" role="status"></span></footer>`;

export function createDatabase(controls) {
  const { fs, windows } = controls;
  let worker = null, path = '', source = null, saved = null, generation = 0, requestId = 0;
  let selected = '', tables = [], savedTables = [], results = [], pending = new Map(), modified = false, closing = false;
  const on = (id, fn) => $('#' + id).addEventListener('click', () => { Promise.resolve().then(fn).catch(report); });
  const title = () => windows.setTitle('database', (modified ? '* ' : '') + basename(path) + ' — SQLite');
  const equal = (a, b) => a?.length === b?.length && a?.every((byte, index) => byte === b[index]);
  function stop(message = '已停止') {
    generation++; worker?.terminate(); worker = null;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    pending.clear(); $('#database-stop').disabled = true; $('#database-run').disabled = false;
  }
  function ensureWorker() {
    if (worker) return;
    worker = new Worker('/database-worker.js', { type: 'module' });
    worker.onmessage = (event) => {
      const response = event.data || {}, entry = pending.get(response.id);
      if (!entry) return;
      clearTimeout(entry.timer); pending.delete(response.id);
      response.error ? entry.reject(new Error(response.error)) : entry.resolve(response);
    };
    worker.onerror = () => stop('数据库线程异常');
  }
  function rpc(type, data = {}, timeout = 8000) {
    ensureWorker();
    return new Promise((resolve, reject) => {
      const id = ++requestId, timer = setTimeout(() => stop('执行超时'), timeout);
      pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, type, ...data });
    });
  }
  function renderTables() {
    const list = $('#database-tables'); list.replaceChildren();
    for (const [name, type] of tables) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = name; button.title = type;
      button.classList.toggle('selected', name === selected);
      button.onclick = () => {
        selected = name; $('#database-sql').value = 'SELECT * FROM "' + name.replaceAll('"', '""') + '" LIMIT 1000;';
        renderTables(); void query().catch(report);
      };
      list.append(button);
    }
  }
  async function confirmChange() {
    if (!modified) return true;
    const choice = await askSave(basename(path));
    if (choice === 'cancel') return false;
    return choice === 'save' ? save() : true;
  }
  async function openBytes(next, bytes) {
    if (!await confirmChange()) return;
    stop(); const token = generation;
    // Preserve the previous document until SQLite accepts the new one.
    try {
      const result = await rpc('open', { bytes }, 20000);
      if (token !== generation) return;
      const exported = await rpc('export');
      if (token !== generation) return;
      source = exported.bytes; saved = source.slice(); path = next; modified = false;
      tables = result.tables; savedTables = tables; selected = ''; results = []; renderTables();
      $('#database-results').replaceChildren(); $('#database-path').textContent = path;
      $('#database-status').textContent = formatSize(source.length); title(); windows.open('database');
    } catch (error) {
      if (token === generation) stop();
      throw error;
    }
  }
  async function open(next) { await openBytes(next, await fs.read(next)); }
  function renderResults() {
    const container = $('#database-results'); container.replaceChildren();
    for (const result of results) {
      if (!result.columns.length) continue;
      const table = document.createElement('table'); table.className = 'data-table';
      const head = document.createElement('thead'), heading = document.createElement('tr');
      for (const column of result.columns) {
        const cell = document.createElement('th'); cell.textContent = column; heading.append(cell);
      }
      head.append(heading); table.append(head); const body = document.createElement('tbody');
      for (const row of result.rows) {
        const tr = document.createElement('tr');
        for (const item of row) {
          const td = document.createElement('td');
          td.textContent = item === null ? 'NULL' : typeof item === 'object' && item.type === 'blob' ? 'BLOB(' + item.length + ') ' + item.hex : String(item);
          if (item === null) td.className = 'sql-null'; tr.append(td);
        }
        body.append(tr);
      }
      table.append(body); container.append(table);
    }
  }
  async function query() {
    if (!source) throw new Error('未打开数据库');
    if (pending.size) return;
    const token = generation, start = performance.now();
    $('#database-run').disabled = true; $('#database-stop').disabled = false;
    try {
      if (!worker) await rpc('open', { bytes: source }, 20000);
      const result = await rpc('query', { sql: $('#database-sql').value, readonly: $('#database-readonly').checked });
      if (token !== generation) return;
      if (result.bytes) { source = result.bytes; modified = !equal(source, saved); title(); }
      tables = result.tables; renderTables(); results = result.results; renderResults();
      const count = results.reduce((n, result) => n + result.rows.length, 0);
      $('#database-status').textContent = count + ' 行' + (results.some(result => result.truncated) ? ' · 已截断' : '') + ' · ' + Math.round(performance.now() - start) + ' ms';
    } catch (error) {
      if (token === generation || error.message === '执行超时' || error.message === '已停止') $('#database-status').textContent = error.message;
    } finally {
      if (token === generation) { $('#database-run').disabled = false; $('#database-stop').disabled = true; }
    }
  }
  async function save() {
    if (!source) throw new Error('未打开数据库');
    const token = generation, bytes = source.slice(), schema = tables;
    const name = await askText('另存为', basename(path) || 'database.sqlite');
    if (!name || token !== generation) return false;
    const target = await fs.writeFile(normalize(name, DOCUMENTS), bytes);
    if (token !== generation) return false;
    saved = bytes; savedTables = schema; modified = !equal(source, saved); path = target;
    $('#database-path').textContent = path; title(); controls.toast(path); return true;
  }
  async function exportCsv() {
    const result = results.find(item => item.columns.length);
    if (!result) throw new Error('没有结果');
    const quote = value => '"' + String(value === null ? '' : typeof value === 'object' ? value.hex : value).replaceAll('"', '""') + '"';
    const content = [result.columns, ...result.rows].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
    const name = await askText('导出 CSV', 'query.csv');
    if (name) controls.toast(await fs.writeFile(normalize(name, DOCUMENTS), content));
  }
  on('database-open', () => pickFile(fs, open));
  on('database-new', () => openBytes('untitled.sqlite', new Uint8Array()));
  on('database-save', save); on('database-run', query); on('database-stop', () => stop()); on('database-csv', exportCsv);
  on('database-schema', () => { $('#database-sql').value = 'SELECT name,type,sql FROM sqlite_schema ORDER BY name;'; return query(); });
  $('#database-sql').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void query().catch(report); }
  });
  $('#database-window').addEventListener('window:beforeclose', (event) => {
    if (!modified) return;
    event.preventDefault(); if (closing) return; closing = true;
    void confirmChange().then(yes => { if (yes) { modified = false; windows.close('database'); } }).catch(report).finally(() => { closing = false; });
  });
  $('#database-window').addEventListener('window:close', () => {
    stop(); source = saved?.slice() || null; tables = savedTables; results = []; selected = ''; modified = false;
    renderTables(); renderResults(); title(); $('#database-status').textContent = source ? formatSize(source.length) : '';
  });
  window.addEventListener('beforeunload', event => { if (modified) { event.preventDefault(); event.returnValue = ''; } });
  decorate($('#database-window'));
  return { open, reset() {
    stop(); source = saved = null; path = ''; modified = false; tables = savedTables = []; results = []; renderTables();
    $('#database-results').replaceChildren(); $('#database-sql').value = ''; $('#database-path').textContent = ''; $('#database-status').textContent = '';
  } };
}
