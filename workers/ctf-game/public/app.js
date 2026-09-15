import { mountWorkbench } from '/widgets.js';
import { createDesktop } from '/desktop.js';
import { createSystem } from '/system.js';
import { menubar } from '/ui.js';
import { prepareShell, createShell } from '/shell.js';
import { prepareUtilities, createUtilities } from '/utilities.js';
import { apiFetch } from '/transport.js';
import { HOME } from '/filesystem.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const pad = (number) => String(number).padStart(2, '0');
const totalCases = () => state.catalog.length || state.total || 0;
const applications = {
  terminal: ['Konsole', 'console'], http: ['HTTP', 'http'], midi: ['MIDI', 'workbench'],
  shop: ['Exchange', 'workbench'], qr: ['Gwenview', 'viewer'], audio: ['Haruna', 'viewer'],
  images: ['Gwenview', 'viewer'], signature: ['Archive', 'workbench'],
  wasm: ['WebAssembly', 'workbench'], final: ['Archive', 'workbench'], artifacts: ['Dolphin', 'files'],
};
let state = { started: false, catalog: [] };
let current = null;
let navigation = 0;
let workbenchController;
let disposeWorkbench = () => {};
let workbenchReady = false;
let workbenchLoading = false;
let toastTimer;
let proofData;
let notes = { text: '', receipts: ['', '', '', ''] };
prepareShell();
prepareUtilities();
const windows = createDesktop();
const system = createSystem({
  api, windows, state: () => state, notes: () => notes,
  loadCase, refresh: refreshState, toast, download,
});
const shell = createShell({ windows, system, toast, download });
const utilities = createUtilities({ fs: system.fs, windows, system, shell, toast, download });
system.attachApplications(utilities);
window.addEventListener('system:message', (event) => toast(event.detail));
menubar($('#case-menubar'), {
  '文件': [{ label: '打开所在文件夹', action: () => { renderFiles(); windows.open('files'); } }, null, { label: '关闭', action: () => windows.close('workbench') }],
  '编辑': [{ label: '复制', shortcut: 'Ctrl+C', action: () => navigator.clipboard.writeText(getSelection()?.toString() || '') }],
  '视图': [{ label: '最大化 / 还原', action: () => windows.maximize('workbench') }, { label: '最小化', action: () => windows.minimize('workbench') }],
});

async function api(path, value, signal) {
  const timeout = AbortSignal.timeout(20_000);
  const response = await apiFetch(path, {
    method: value === undefined ? 'GET' : 'POST',
    headers: value === undefined ? {} : { 'Content-Type': 'application/json', 'X-Afterglow': '1' },
    body: value === undefined ? undefined : JSON.stringify(value),
    credentials: 'same-origin', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || '请求失败');
    error.status = response.status;
    throw error;
  }
  return result;
}
function toast(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}
function message(node, text, kind = '') {
  node.textContent = text;
  node.classList.toggle('error', kind === 'error');
  node.classList.toggle('success', kind === 'success');
}
function download(name, content, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch { toast('复制失败'); }
}
function updateState(value) {
  const previousPlayer = state.player;
  state = { ...state, ...value };
  if (previousPlayer !== state.player) {
    readNotes();
    system.setPlayer(state.player || '');
  }
  if (current) current.solved = state.stage > current.id;
  renderIndex();
  renderAnswer();
}
async function refreshState() { updateState(await api('/api/session')); }
function renderIndex() {
  if (!state.started) return;
  $('#progress-count').textContent = pad(state.stage - 1) + ' / ' + totalCases();
  $('#progress-bar').max = totalCases();
  $('#progress-bar').value = state.stage - 1;
  $('#player-label').textContent = (state.player || '').toUpperCase();
  void system.refreshFiles();
}
function showFolder(kind) {
  void system.navigate(kind === 'root' ? HOME : kind === 'documents' ? HOME + '/Documents' : HOME + '/' + pad(current.id));
}
function renderFiles() {
  if (!current) return;
  showFolder('case');
}
function renderAnswer() {
  if (!current) return;
  $('#answer-form').hidden = current.solved;
  $('#solved-panel').hidden = !current.solved;
  $('#case-number').textContent = current.solved ? '已通过' : '';
  $('#next-button').textContent = current.id === totalCases() ? '完成' : '下一关';
}
function closeWorkbench() {
  navigation++;
  workbenchController?.abort();
  disposeWorkbench(); disposeWorkbench = () => {};
  workbenchReady = false; workbenchLoading = false;
}
async function loadCase(number, show = true) {
  if (!state.started || state.outdated || number > Math.min(state.stage, totalCases())) return;
  if (current?.id === number && workbenchReady) {
    renderFiles();
    if (show) windows.open('workbench');
    return;
  }
  closeWorkbench();
  const token = navigation;
  workbenchController = new AbortController();
  const signal = workbenchController.signal;
  workbenchLoading = true;
  $('#workbench').inert = true;
  $('#workbench').textContent = '';
  $('#answer-button').disabled = true;
  try {
    const record = await api('/api/cases/' + number, undefined, signal);
    if (token !== navigation) return;
    current = record;
    system.setCase(record);
    history.replaceState(null, '', '#case-' + number);
    $('#case-title').textContent = pad(number);
    $('#answer-input').value = '';
    $('#answer-input').removeAttribute('aria-invalid');
    message($('#answer-message'), '');
    renderFiles(); renderIndex(); renderAnswer();
    const [title, kind] = applications[record.widget];
    $('#play').dataset.widget = record.widget;
    windows.setTitle('workbench', pad(number) + ' — ' + title, kind);
    if (show) windows.open('workbench');
    const cleanup = await mountWorkbench($('#workbench'), record, {
      api, toast, download, copy, fill: putAnswer, saveReceipt, signal, openFile: system.openFile,
    });
    if (token !== navigation) cleanup?.();
    else {
      disposeWorkbench = cleanup || (() => {});
      workbenchReady = true; workbenchLoading = false;
      $('#workbench').inert = false;
      $('#answer-button').disabled = false;
      if (show && record.widget === 'terminal') $('#terminal-input')?.focus();
    }
  } catch (error) {
    if (signal.aborted) return;
    workbenchLoading = false;
    const box = document.createElement('div');
    box.className = 'workbench-body error-text'; box.textContent = error.message;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试';
    retry.addEventListener('click', () => void loadCase(number));
    box.append(document.createElement('br'), retry); $('#workbench').replaceChildren(box);
    $('#workbench').inert = false;
    toast(error.message);
  }
}
function putAnswer(code) {
  if (!current || current.solved) return;
  windows.open('workbench');
  $('#answer-input').value = code;
  $('#answer-input').removeAttribute('aria-invalid');
  $('#answer-input').focus();
}
$('#play').addEventListener('window:close', closeWorkbench);
$('#play').addEventListener('window:open', () => {
  if (current && !workbenchReady && !workbenchLoading) void loadCase(current.id, false);
});
$('#answer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!current) return;
  const number = current.id;
  $('#answer-button').disabled = true;
  message($('#answer-message'), '');
  try {
    const result = await api('/api/answer', { stage: number, code: $('#answer-input').value.trim() });
    updateState(result.state);
    if (current?.id !== number) return;
    if (result.result === 'incorrect') {
      $('#answer-input').setAttribute('aria-invalid', 'true');
      message($('#answer-message'), '错误', 'error');
    } else {
      current.solved = true;
      renderAnswer();
      $('#next-button').focus();
    }
  } catch (error) {
    if (current?.id === number) message($('#answer-message'), error.message, 'error');
  } finally { if (current?.id === number) $('#answer-button').disabled = false; }
});
$('#answer-input').addEventListener('input', () => $('#answer-input').removeAttribute('aria-invalid'));
$('#next-button').addEventListener('click', () => void (current?.id === totalCases() ? showCompletion() : loadCase(current.id + 1)));

function notesKey() { return 'afterglow/notes/' + (state.player || 'visitor'); }
function readNotes() {
  notes = { text: '', receipts: ['', '', '', ''] };
  try {
    const saved = JSON.parse(localStorage.getItem(notesKey()) || 'null');
    if (saved && typeof saved.text === 'string') notes.text = saved.text.slice(0, 30_000);
    if (saved && Array.isArray(saved.receipts)) notes.receipts = Array.from({ length: 4 }, (_, i) => String(saved.receipts[i] || '').slice(0, 35));
  } catch {}
  $('#notes-input').value = notes.text;
  $('#notes-input').dispatchEvent(new Event('notes:load'));
  $$('[data-receipt]').forEach((input, i) => { input.value = notes.receipts[i]; });
}
function persistNotes() {
  notes = { text: $('#notes-input').value.slice(0, 30_000), receipts: $$('[data-receipt]').map((input) => input.value.trim()) };
  try { localStorage.setItem(notesKey(), JSON.stringify(notes)); $('#notes-status').textContent = '已保存'; }
  catch { $('#notes-status').textContent = '保存失败'; }
}
function saveReceipt(value) {
  if (!/^0[1-4]-[0-9a-f]{32}$/.test(value)) return;
  const number = parseInt(value.slice(0, 2), 16);
  $('[data-receipt="' + number + '"]').value = value;
  persistNotes();
  toast('已保存');
}
$('#notes-input').addEventListener('input', persistNotes);
$$('[data-receipt]').forEach((input) => input.addEventListener('input', persistNotes));
$('#export-notes').addEventListener('click', () => download('notes.txt', notes.text + '\n\n' + notes.receipts.filter(Boolean).join('\n') + '\n'));
$('#restart-button').addEventListener('click', () => $('#restart-dialog').showModal());
$$('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$('#confirm-restart').addEventListener('click', async () => {
  $('#confirm-restart').disabled = true;
  try {
    closeWorkbench(); current = null;
    for (const id of ['files', 'workbench', 'console', 'editor', 'http', 'viewer', 'notes', 'proof']) windows.close(id);
    updateState(await api('/api/restart', {}));
    proofData = undefined;
    $('#restart-dialog').close();
    windows.open('files');
    await loadCase(1);
  } catch (error) { toast(error.message); }
  finally { $('#confirm-restart').disabled = false; }
});
async function showCompletion() {
  try {
    proofData = await api('/api/proof');
    $('#proof-output').value = proofData.proof;
    $('#completion h1').textContent = proofData.completion.cases + ' / ' + proofData.completion.cases;
    windows.open('proof');
    history.replaceState(null, '', '#complete');
  } catch (error) { toast(error.message); }
}
$('#copy-proof').addEventListener('click', () => proofData && void copy(proofData.proof));
$('#download-proof').addEventListener('click', () => proofData && download('completion-' + state.player + '.json', JSON.stringify(proofData, null, 2), 'application/json'));
$('#revisit-button').addEventListener('click', () => void loadCase(totalCases()));
$('#verify-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#verify-form button'); button.disabled = true;
  try {
    const result = await api('/api/proof/verify', { proof: $('#verify-input').value.trim() });
    $('#verify-result').textContent = result.completion.cases + ' / ' + result.completion.cases + ' · ' + result.completion.player + ' · ' + new Date(result.completion.completedAt).toLocaleString('zh-CN');
    $('#verify-result').className = 'success-text';
  } catch (error) {
    $('#verify-result').textContent = error.message;
    $('#verify-result').className = 'error-text';
  } finally { button.disabled = false; }
});

async function openLocation(restoreDefault = false) {
  if (!state.started || state.outdated) return;
  const match = /^#case-([1-9][0-9]{0,2})$/.exec(location.hash);
  if (location.hash === '#complete' && state.stage === totalCases() + 1) await showCompletion();
  else if (match || restoreDefault) {
    const number = Math.min(match ? Number(match[1]) : state.stage, state.stage, totalCases());
    await loadCase(number, Boolean(match));
  }
}
// Fragment links and browser back/forward navigation do not reload this document.
window.addEventListener('hashchange', () => void openLocation());

async function boot() {
  try {
    let session = await api('/api/session');
    if (!session.started) {
      const entry = new URLSearchParams(location.hash.slice(1)).get('entry') || '';
      if (!session.canStart && !/^[a-z0-9]{20}$/.test(entry)) { $('#gate-status').textContent = '403'; return; }
      session = await api('/api/start', { entry });
    }
    updateState(session);
    $('#gate').hidden = true;
    $('#desktop').hidden = false;
    windows.open('files');
    showFolder('root');
    shell.ready();
    if (state.outdated) { toast('存档版本已失效'); return; }
    await openLocation(true);
  } catch (error) {
    $('.connection').classList.add('offline');
    $('#connection-label').textContent = '离线';
    $('#gate-status').textContent = error.status === 403 ? '403' : '连接失败';
  }
}
await boot();
