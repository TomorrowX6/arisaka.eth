import { icon } from '/desktop.js';
import { profileKey } from '/preferences.js';
import { decorate } from '/ui.js';
import { showSurface } from '/motion.js';

const apps = [
  { id: 'minecraft', title: 'Minecraft 1.12.2' },
  { id: 'firefox', title: 'Firefox' },
  { id: 'yesplaymusic', title: 'YesPlayMusic' },
];

export function prepareRuntimeApps() {
  for (const { id, title } of apps) {
    const node = document.createElement('section');
    node.id = id + '-window'; node.className = 'window runtime-window'; node.hidden = true;
    Object.assign(node.dataset, { window: id, title, width: '1100', height: '760', restoreSession: 'false' });
    node.innerHTML = `<div class="window-body runtime-body">
      <div class="native-toolbar runtime-toolbar" role="toolbar" aria-label="${title} 工具栏">
        <button type="button" data-runtime-reload data-icon="view-refresh" title="重新启动应用">重新启动</button>
        ${id === 'minecraft' ? '<label class="runtime-engine-label">运行模式 <select aria-label="Minecraft 运行模式" data-runtime-engine><option value="auto">自动选择</option><option value="wasm">WebAssembly</option><option value="javascript">JavaScript 兼容</option></select></label>' : id === 'firefox' ? '<span class="runtime-session-label">临时会话</span>' : ''}
        <span class="runtime-toolbar-spacer"></span>
        <a data-runtime-source target="_blank" rel="noopener noreferrer" hidden>项目来源</a>
        <a data-runtime-external target="_blank" rel="noopener noreferrer" hidden>独立打开</a>
      </div>
      <div class="runtime-content">
        <div class="runtime-placeholder" role="status"><span class="runtime-app-icon">${icon(id)}</span><h2>${title}</h2><p data-runtime-message>正在准备应用…</p><button type="button" data-runtime-retry hidden>重试</button></div>
      </div>
      <footer class="runtime-footer"><span data-runtime-status role="status">尚未启动</span></footer>
    </div>`;
    document.getElementById('desktop').append(node);
    decorate(node);
  }
}

function firefoxUnsupported() {
  if (!globalThis.isSecureContext || !globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') return 'Firefox 需要安全且隔离的浏览环境。请通过 HTTPS 重新打开此桌面。';
  if (typeof globalThis.WebAssembly?.Suspending !== 'function' || typeof globalThis.WebAssembly?.promising !== 'function'
    || !('credentialless' in HTMLIFrameElement.prototype)) return '此浏览器尚不支持 Firefox WASM。请使用最新版 Chrome 或 Edge 打开此桌面。';
  return '';
}

function confirmMinecraft(action) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'native-dialog';
    dialog.setAttribute('aria-label', action + ' Minecraft');
    const title = document.createElement('h2'); title.textContent = action + ' Minecraft';
    const message = document.createElement('p'); message.textContent = '请先在游戏菜单中选择“保存并退出”。直接' + action + '可能丢失尚未自动保存的进度。';
    const row = document.createElement('div'); row.className = 'button-row';
    for (const [value, label] of [['cancel', '继续游戏'], ['accept', action]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => dialog.close(value)); row.append(button);
    }
    dialog.append(title, message, row); document.body.append(dialog);
    dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'accept'; dialog.remove(); resolve(accepted); }, { once: true });
    dialog.showModal(); showSurface(dialog, { effect: 'window', origin: 'center' }); row.firstElementChild.focus();
  });
}

export function createRuntimeApps({ windows }) {
  const states = new Map();
  for (const app of apps) {
    const node = document.getElementById(app.id + '-window');
    const placeholder = node.querySelector('.runtime-placeholder');
    const content = node.querySelector('.runtime-content');
    const message = node.querySelector('[data-runtime-message]');
    const status = node.querySelector('[data-runtime-status]');
    const retry = node.querySelector('[data-runtime-retry]');
    const external = node.querySelector('[data-runtime-external]');
    const source = node.querySelector('[data-runtime-source]');
    const engine = node.querySelector('[data-runtime-engine]');
    const state = { node, frame: null, generation: 0, controller: null, timer: null, open: false, phase: 'idle', origin: '', channel: '', engine: engine?.value, confirming: false, approvedClose: false };
    states.set(app.id, state);
    function focusFrame() {
      if (state.frame && state.open && windows.active() === app.id && !node.inert && !node.hidden) state.frame.focus({ preventScroll: true });
    }
    function phase(value, text, overlay = false) {
      state.phase = value; node.dataset.runtimePhase = value; status.textContent = text;
      if (overlay) { placeholder.hidden = false; message.textContent = text; }
      retry.hidden = value !== 'error';
    }
    function dispose() {
      state.generation++; state.controller?.abort(); state.controller = null;
      clearTimeout(state.timer); state.timer = null;
      state.frame?.remove(); state.frame = null; state.channel = ''; state.origin = '';
      placeholder.hidden = false; content.removeAttribute('aria-busy');
    }
    async function start() {
      if (state.frame || state.controller || !state.open) return;
      const generation = ++state.generation;
      const controller = new AbortController(); state.controller = controller;
      phase('loading', '正在打开 ' + app.title + '…', true);
      content.setAttribute('aria-busy', 'true');
      try {
        const response = await fetch('/runtime-config.json', { signal: controller.signal });
        if (!response.ok) throw new Error('无法读取应用配置，请重试。');
        const config = (await response.json())[app.id];
        if (!state.open || generation !== state.generation) return;
        const url = new URL(config.url);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('应用地址无效。');
        state.origin = url.origin; state.channel = crypto.randomUUID();
        if (app.id === 'minecraft') {
          state.engine = engine.value;
          url.hash = new URLSearchParams({ profile: profileKey(), channel: state.channel, engine: state.engine, parent: location.origin }).toString();
        } else if (app.id === 'yesplaymusic') {
          url.pathname = url.pathname.replace(/\/?$/, '/') + 'profiles/' + encodeURIComponent(profileKey()) + '/';
          url.hash = new URLSearchParams({ channel: state.channel, parent: location.origin }).toString();
        }
        const standalone = new URL(url);
        if (app.id === 'minecraft') standalone.hash = new URLSearchParams({ profile: profileKey(), engine: engine.value }).toString();
        else if (app.id === 'yesplaymusic') standalone.hash = '';
        external.href = standalone.href; external.hidden = false;
        source.href = config.source; source.hidden = false;
        if (app.id === 'firefox') {
          const unsupported = firefoxUnsupported();
          if (unsupported) throw new Error(unsupported);
        }
        const frame = document.createElement('iframe'); state.frame = frame;
        frame.className = 'runtime-frame'; frame.title = app.title;
        frame.referrerPolicy = 'no-referrer';
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox');
        frame.allow = 'cross-origin-isolated; fullscreen; autoplay; clipboard-read; clipboard-write';
        frame.allowFullscreen = true;
        if (app.id === 'firefox') frame.credentialless = true;
        frame.addEventListener('load', () => {
          if (generation !== state.generation || state.frame !== frame) return;
          clearTimeout(state.timer); placeholder.hidden = state.phase !== 'error'; content.removeAttribute('aria-busy');
          // Document load is not engine readiness. Firefox's own loader owns
          // download progress and the user-gesture Launch Firefox button.
          if (state.phase === 'loading') phase('document', app.id === 'firefox' ? 'Firefox · Gecko WebAssembly' : '正在启动 ' + app.title + '…');
          focusFrame();
        });
        frame.addEventListener('error', () => {
          if (generation === state.generation) phase('error', '无法载入应用，请检查网络后重试。', true);
        });
        frame.src = url.href; content.append(frame);
        state.timer = setTimeout(() => {
          if (generation === state.generation && state.phase === 'loading') {
            message.textContent = '应用仍在加载。您可以继续等待或重试。'; retry.hidden = false;
          }
        }, 30000);
      } catch (error) {
        if (generation === state.generation && !controller.signal.aborted) {
          content.removeAttribute('aria-busy'); phase('error', error.message, true);
        }
      } finally {
        if (state.controller === controller) state.controller = null;
      }
    }
    async function restart() {
      if (!state.open || state.confirming) return;
      if (app.id === 'minecraft' && state.phase === 'running') {
        state.confirming = true;
        const accepted = await confirmMinecraft('重新启动'); state.confirming = false;
        if (!accepted) { engine.value = state.engine; focusFrame(); return; }
        if (!state.open) return;
      }
      dispose(); void start();
    }
    node.addEventListener('window:open', () => { state.open = true; focusFrame(); void start(); });
    // Canvas apps cancel mousedown's default action, which otherwise focuses
    // the child browsing context. Hand keyboard input to the active app before
    // the pointer reaches its canvas, including after using the native toolbar.
    content.addEventListener('pointerenter', focusFrame);
    node.addEventListener('pointerdown', event => {
      if (event.target !== content || !state.frame) return;
      // The window manager's earlier handler on this node has activated the app.
      // Prevent mousedown's default action from taking focus back to the desktop.
      event.preventDefault(); focusFrame();
    });
    node.addEventListener('window:beforeclose', event => {
      if (app.id !== 'minecraft' || state.phase !== 'running' || state.approvedClose) return;
      event.preventDefault();
      if (state.confirming) return;
      state.confirming = true;
      void confirmMinecraft('关闭').then(accepted => {
        state.confirming = false;
        if (!accepted) { focusFrame(); return; }
        if (accepted && state.open) {
          state.approvedClose = true; windows.close(app.id); state.approvedClose = false;
        }
      });
    });
    node.addEventListener('window:close', () => { state.open = false; dispose(); phase('idle', '已关闭'); });
    node.querySelector('[data-runtime-reload]').addEventListener('click', restart);
    retry.addEventListener('click', restart);
    engine?.addEventListener('change', restart);
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (!['minecraft', 'yesplaymusic'].includes(data?.app)) return;
    const state = states.get(data.app);
    if (!state.open || !state.frame || event.source !== state.frame.contentWindow || event.origin !== state.origin
      || data.type !== 'arisaka:runtime' || data.channel !== state.channel
      || !['loading', 'running', 'error'].includes(data.phase) || typeof data.message !== 'string') return;
    state.phase = data.phase; state.node.dataset.runtimePhase = data.phase;
    state.node.querySelector('[data-runtime-status]').textContent = data.message.slice(0, 300);
    if (data.phase === 'running') {
      state.node.querySelector('.runtime-placeholder').hidden = true;
      state.node.querySelector('[data-runtime-retry]').hidden = true;
      state.node.querySelector('.runtime-content').removeAttribute('aria-busy');
    }
    if (data.phase === 'error') {
      state.node.querySelector('[data-runtime-retry]').hidden = false;
      state.node.querySelector('[data-runtime-message]').textContent = data.message.slice(0, 300);
      state.node.querySelector('.runtime-placeholder').hidden = false;
    }
  });
  // Pointer/key events do not bubble out of cross-origin frames. Focus the
  // native window when the browser hands input to its iframe.
  window.addEventListener('blur', () => queueMicrotask(() => {
    for (const [id, state] of states) if (state.open && document.activeElement === state.frame) windows.focus(id);
  }));
  window.addEventListener('pagehide', () => {
    for (const state of states.values()) { state.controller?.abort(); clearTimeout(state.timer); state.frame?.remove(); }
  });
}
