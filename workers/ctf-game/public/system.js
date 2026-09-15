import { createFilesystem, HOME, caseLocation, normalize, basename, parent } from '/filesystem.js';
import { createFileManager, pickFile as chooseFile } from '/files.js';
import { createEditor, enhanceNotes } from '/editor.js';
import { createConsole } from '/console.js';
import { createViewer } from '/viewer.js';
import { $, $$, menubar, decorate, formatSize } from '/ui.js';
import { apiFetch } from '/transport.js';
import { applications as desktopApplications } from '/applications.js';

export function createSystem(controls) {
  const fs = createFilesystem(controls);
  let runner, runnerTimer, runnerAbort, running = false, generation = 0;
  let finishRun;
  let editor, viewer, files, consoleApp;
  let applications = {};
  let pythonRuntime;
  async function loadPython() {
    pythonRuntime ||= Promise.all(['pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'].map(async name => {
      const response = await fetch('/vendor/pyodide/' + name, { cache: 'force-cache' });
      if (!response.ok) throw new Error('Python: ' + response.status);
      return [name, name.endsWith('.json') ? await response.json() : await response.arrayBuffer()];
    })).catch(error => { pythonRuntime = null; throw error; });
    return pythonRuntime;
  }
  function stop(result = { exitCode: 130, cancelled: true }) {
    if (!Number.isInteger(result?.exitCode)) result = { exitCode: 130, cancelled: true };
    generation++;
    clearTimeout(runnerTimer); runner?.terminate(); runner = null; running = false;
    runnerAbort?.abort(); runnerAbort = null;
    $('#editor-run').disabled = false; $('#editor-stop').disabled = true;
    const finish = finishRun; finishRun = undefined; finish?.(result);
  }
  async function run(source, output = (text) => editor.output(text + '\n'), options = {}) {
    if (running) throw new Error('EBUSY');
    if (typeof source !== 'string' || source.length > 500000) throw new Error('EFBIG');
    running = true; const token = ++generation;
    const context = options.recoveryContext || controls.captureRecovery?.();
    const completion = new Promise((resolve) => { finishRun = resolve; });
    let transcript = '', transcriptOverflow = false;
    $('#editor-run').disabled = true; $('#editor-stop').disabled = false;
    try {
      await fs.ready();
      if (!running || token !== generation) return completion;
      const python = options.language === 'python';
      const resources = python ? await loadPython() : null;
      if (!running || token !== generation) return completion;
      runner = python ? new Worker('/python-runner.js', { type: 'module' }) : new Worker('/runner.js');
      runnerAbort = new AbortController();
      let messages = 0, outputSize = 0, ioBytes = 0, inFlight = 0, finished = false;
      const seen = new Set();
      async function fileRequest(message) {
        const { id, operation, path, bytes } = message;
        if (!Number.isSafeInteger(id) || id < 1 || seen.has(id) || typeof path !== 'string' || path.length > 1024) throw new Error('EINVAL');
        seen.add(id);
        if (seen.size > 4096 || ++inFlight > 16) throw new Error('EMFILE');
        try {
          let reply;
          if (operation === 'runtime' && python) {
            if (!/^[a-zA-Z0-9_.-]+\.whl$/.test(path) || !Object.values(resources.find(([name]) => name.endsWith('.json'))[1].packages).some(item => item.file_name === path)) throw new Error('EACCES');
            const response = await fetch('/vendor/pyodide/' + path, { cache: 'force-cache', credentials: 'omit', signal: runnerAbort.signal });
            if (!response.ok) throw new Error('Python package unavailable');
            const bytes = new Uint8Array(await response.arrayBuffer());
            ioBytes += bytes.length;
            if (bytes.length > 25 * 1024 * 1024 || ioBytes > 128 * 1024 * 1024) throw new Error('EFBIG');
            reply = { bytes };
          } else if (operation === 'read') {
            const data = await fs.read(path);
            ioBytes += data.length;
            if (ioBytes > 128 * 1024 * 1024) throw new Error('EFBIG');
            reply = { bytes: data };
          } else if (operation === 'write') {
            if (!(bytes instanceof Uint8Array)) throw new Error('EINVAL');
            ioBytes += bytes.length;
            if (ioBytes > 128 * 1024 * 1024) throw new Error('EFBIG');
            reply = { path: await fs.writeFile(path, bytes, true, context) };
          } else if (operation === 'request') {
            if (!/^\/api\/(?:labs\/[1-9][0-9]{0,2}|echo|shop(?:\/(?:quote|checkout|redeem|reset))?)$/.test(path)) throw new Error('EACCES');
            const options = message.options || {};
            const method = options.method || 'GET';
            if (!['GET', 'POST'].includes(method) || options.body !== undefined && (typeof options.body !== 'string' || new TextEncoder().encode(options.body).length > 8192)) throw new Error('EINVAL');
            const headers = new Headers({ 'X-Afterglow': '1' });
            if (method === 'POST') headers.set('Content-Type', 'application/json');
            if (typeof options.etag === 'string' && options.etag.length <= 256) headers.set('If-None-Match', options.etag);
            const response = await apiFetch(path, { method, headers, body: method === 'POST' ? options.body || '{}' : undefined,
              credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([runnerAbort.signal, AbortSignal.timeout(20000)]) });
            const body = await response.text();
            ioBytes += body.length;
            if (ioBytes > 128 * 1024 * 1024 || body.length > 100000) throw new Error('EFBIG');
            reply = { response: { status: response.status, headers: Object.fromEntries(response.headers), body } };
          } else if (operation === 'list') reply = { entries: await fs.entries(path) };
          else if (operation === 'mkdir') reply = { path: await fs.mkdir(path) };
          else throw new Error('EINVAL');
          if (token === generation) runner.postMessage({ type: 'result', id, ...reply }, reply.bytes ? [reply.bytes.buffer] : []);
        } catch (error) {
          if (token === generation) runner.postMessage({ type: 'result', id, error: error.message });
        } finally {
          inFlight--;
          if (token === generation && finished && !inFlight) stop({ exitCode: 0 });
        }
      }
      runner.onmessage = (event) => {
        if (token !== generation) return;
        if (++messages > 8192) { output('EOUTPUT'); stop({ exitCode: 1 }); return; }
        const message = event.data || {}, { type, value } = message;
        if (type === 'fs') { void fileRequest(message).catch(error => { if (token === generation) { output(error.message); stop({ exitCode: 1 }); } }); return; }
        if (type === 'log' || type === 'error') {
          const text = String(value).slice(0, 65536); outputSize += text.length;
          if (outputSize > 4 * 1024 * 1024) { output('EOUTPUT'); stop({ exitCode: 1 }); return; }
          if (type === 'log' && !transcriptOverflow) {
            if (transcript.length + text.length + 1 <= 64 * 1024) transcript += text + '\n';
            else { transcript = ''; transcriptOverflow = true; }
          }
          output(text); if (type === 'error') stop({ exitCode: 1 });
        } else if (type === 'done') { finished = true; if (!inFlight) stop({ exitCode: 0 }); }
      };
      runner.onerror = (error) => { if (token === generation) { output(error.message || 'Execution failed'); stop({ exitCode: 1 }); } };
      const runtime = resources?.filter(([name]) => !name.endsWith('.json')).map(([name, bytes]) => [name, bytes.slice(0)]);
      runner.postMessage({ type: 'run', source, ...(python ? { runtime, lock: resources.find(([name]) => name.endsWith('.json'))[1], home: HOME, filename: options.filename } : {}) }, runtime?.map(([, bytes]) => bytes) || []);
      runnerTimer = setTimeout(() => { output('ETIMEDOUT'); stop({ exitCode: 124 }); }, 120000);
    } catch (error) { if (token === generation) { output(error.message); stop({ exitCode: 1 }); } }
    const result = await completion;
    if (options.recover !== false && result.exitCode === 0 && !transcriptOverflow) void controls.recover?.(transcript, context);
    return result;
  }
  async function openFile(input, mode) {
    const path = normalize(input);
    if (!mode && path.startsWith('/usr/share/applications/') && path.endsWith('.desktop')) {
      const id = basename(path).slice(0, -8);
      if (!desktopApplications.some(app => !app.hidden && app.id === id)) throw Error('ENOENT');
      controls.windows.open(id); return;
    }
    const match = caseLocation(path);
    if (match?.name.endsWith('.desktop')) {
      const entry = (await fs.entries(parent(path))).find((entry) => entry.path === path && entry.kind === 'application');
      if (!entry) throw new Error('ENOENT');
      await controls.loadCase(match.stage); return;
    }
    try {
      await fs.entries(path);
      await files.navigate(path); controls.windows.open('files'); return;
    } catch (error) { if (!error.message.startsWith('ENOTDIR')) throw error; }
    if (path === HOME + '/notes.txt' || path === HOME + '/receipts.txt') {
      controls.windows.open('notes');
      if (path.endsWith('receipts.txt')) $('.receipt-fields').hidden = false;
      return;
    }
    const kind = mode === 'hex' ? 'hex' : /(?:callgrind|cachegrind)(?:\.out)?(?:\.\d+)?$|\.callgrind$/i.test(path) ? 'profiler' : /\.(zip|tar|gz|tgz)$/i.test(path) ? 'archive'
      : /\.vcd$/i.test(path) ? 'logic' : /\.(pcap|pcapng|cap)$/i.test(path) ? 'packets' : /\.(db|sqlite|sqlite3)$/i.test(path) ? 'database'
      : /\.(png|jpe?g|webp)$/i.test(path) ? 'imageviewer' : /\.(wav|mp3|ogg|flac)$/i.test(path) ? 'media'
      : /\.(bin|elf|wasm|o)$/i.test(path) ? 'hex' : null;
    if (mode !== 'edit' && kind && applications[kind]) { await applications[kind].open(path); return; }
    if (mode === 'edit' || mode !== 'view' && mode !== 'hex' && /\.(?:[cm]?js|ts|json|txt|md|py|c|h|cpp|hpp|sh|sql|csv|log|xml|yaml|yml|wat)$/i.test(path)) {
      editor.open(basename(path), await fs.readText(path), path); return;
    }
    await viewer.open(path, mode);
  }
  const pickFile = (mode) => chooseFile(fs, (path) => openFile(path, mode), files?.currentPath() || HOME);
  const shared = { ...controls, fs, run, stop, openFile, pickFile, edit: (...args) => editor.open(...args), openConsole: (path) => consoleApp.open(path) };
  consoleApp = createConsole(shared);
  editor = createEditor(shared);
  viewer = createViewer(shared);
  files = createFileManager({ ...shared, terminal: (path) => consoleApp.embedded(path) });
  const notesEditor = enhanceNotes(shared);
  const requestHistory = [];
  let pendingRequest;
  function setPlayer(player) {
    pendingRequest?.abort(); pendingRequest = undefined; $('#network-send').disabled = false;
    stop(); fs.setPlayer(player); files.reset(); editor.setPlayer(player); consoleApp.setPlayer(player); viewer.reset(); notesEditor.reset();
    requestHistory.splice(0);
    applications.reset?.();
    $('#network-output').textContent = ''; $('#network-history').replaceChildren();
  }
  function renderHistory() {
    const list = $('#network-history'); list.replaceChildren();
    for (const request of requestHistory) {
      const button = document.createElement('button'); button.type = 'button';
      const method = document.createElement('span'); method.className = 'request-method'; method.textContent = request.method;
      const path = document.createElement('span'); path.textContent = request.path;
      button.append(method, path); button.title = request.path;
      button.addEventListener('click', () => { $('#network-path').value = request.path; $('#network-method').value = request.method; $('#network-headers').value = request.headers; $('#network-body').value = request.body; }); list.append(button);
    }
  }
  $('#network-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#network-send'); button.disabled = true;
    const start = performance.now(); pendingRequest?.abort();
    const request = pendingRequest = new AbortController();
    const context = controls.captureRecovery?.();
    try {
      const path = $('#network-path').value.trim(); const url = new URL(path, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) throw new Error('EINVAL');
      const method = $('#network-method').value;
      const headersText = $('#network-headers').value, body = $('#network-body').value;
      const headers = new Headers({ 'X-Afterglow': '1' });
      if (method === 'POST') headers.set('Content-Type', 'application/json');
      for (const line of headersText.split('\n').filter((line) => line.trim())) {
        const colon = line.indexOf(':'); if (colon < 1) throw new Error('EINVAL');
        headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      const response = await apiFetch(url, { method, headers, body: method === 'POST' ? body || '{}' : undefined, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]) });
      const text = (await response.text()).slice(0, 100000);
      if (request !== pendingRequest || request.signal.aborted) return;
      $('#network-output').textContent = 'HTTP ' + response.status + '\n' + [...response.headers].map(([name, value]) => name + ': ' + value).join('\n') + '\n\n' + text;
      $('#network-status').textContent = String(response.status); $('#network-status').className = response.ok || response.status === 304 ? 'success-text' : 'error-text';
      $('#network-time').textContent = Math.round(performance.now() - start) + ' ms'; $('#network-size').textContent = formatSize(new TextEncoder().encode(text).length);
      requestHistory.unshift({ path, method, headers: headersText, body }); requestHistory.splice(30); renderHistory();
      if (response.ok) await controls.recover?.(text, context);
      if (method === 'POST') await controls.refresh();
    } catch (error) { if (request === pendingRequest) { $('#network-output').textContent = error.name === 'AbortError' ? '已停止' : error.message; $('#network-status').textContent = ''; } }
    finally { if (request === pendingRequest) { button.disabled = false; pendingRequest = undefined; } }
  });
  $('#network-stop').addEventListener('click', () => pendingRequest?.abort());
  $('#network-clear').addEventListener('click', () => { $('#network-output').textContent = ''; $('#network-status').textContent = ''; });
  $('#network-history-toggle').addEventListener('click', () => { $('#network-sidebar').hidden = !$('#network-sidebar').hidden; });
  $$('[data-request-tab]').forEach((button) => button.addEventListener('click', () => {
    $$('[data-request-tab]').forEach((item) => item.setAttribute('aria-selected', String(item === button)));
    $('#network-headers-panel').hidden = button.dataset.requestTab !== 'headers'; $('#network-body-panel').hidden = button.dataset.requestTab !== 'body';
  }));
  menubar($('#network-menubar'), {
    '文件': [{ label: '新建请求', icon: 'document-new', action: () => { $('#network-path').value = '/api/'; $('#network-headers').value = ''; $('#network-body').value = ''; $('#network-output').textContent = ''; } }, { label: '保存响应…', icon: 'document-save-as', action: () => controls.download('response.txt', $('#network-output').textContent) }, null, { label: '关闭', action: () => controls.windows.close('http') }],
    '编辑': [{ label: '复制响应', icon: 'edit-copy', action: () => navigator.clipboard.writeText($('#network-output').textContent) }, { label: '清空响应', icon: 'edit-clear', action: () => $('#network-clear').click() }],
    '视图': () => [{ label: '历史记录', checked: !$('#network-sidebar').hidden, action: () => $('#network-history-toggle').click() }],
    '转到': [{ label: '发送', icon: 'go-next', action: () => $('#network-form').requestSubmit() }, { label: '停止', icon: 'media-playback-stop', action: () => pendingRequest?.abort() }],
  });
  $('#http-window').addEventListener('window:close', () => pendingRequest?.abort());
  decorate();
  return { fs, attachApplications(value) { applications = value; }, setPlayer, setCase: fs.setCase, openFile,
    openConsole: (path) => consoleApp.open(path),
    openHttp(path) { $('#network-path').value = path; $('#network-method').value = 'GET'; $('#network-headers').value = ''; $('#network-body').value = ''; controls.windows.open('http'); $('#network-path').focus(); },
    read: fs.read, edit: editor.open, run, snapshot: fs.snapshot, navigate: files.navigate, refreshFiles: files.refresh };
}
