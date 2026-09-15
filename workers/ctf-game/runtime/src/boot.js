import { capabilities, profileOptions, selectEngine, trustedParent } from './config.js';
import { installRuntimeStorage } from './storage.js';

const params = new URLSearchParams(location.hash.slice(1));
const channel = params.get('channel') || '';
let parentOrigin = null;
let observer;
let startupTimer;
const status = (phase, message) => {
  if (parentOrigin && channel.length <= 100) parent.postMessage({ type: 'arisaka:runtime', app: 'minecraft', channel, phase, message }, parentOrigin);
};
function progress(message, loaded, total) {
  const label = document.getElementById('loading-status');
  if (label) label.textContent = message;
  const bar = document.getElementById('loading-progress');
  if (bar && total) { bar.max = total; bar.value = loaded; }
  status('loading', message);
}
function fail(error) {
  observer?.disconnect(); clearTimeout(startupTimer);
  const message = error instanceof Error ? error.message : String(error);
  status('error', message);
  if (!document.querySelector('.loading-screen')) {
    const screen = document.createElement('main'); screen.className = 'loading-screen';
    const title = document.createElement('h1'); title.textContent = 'Minecraft 未能启动';
    const detail = document.createElement('p'); detail.id = 'loading-status';
    const retry = document.createElement('button'); retry.id = 'retry'; retry.type = 'button'; retry.textContent = '重新加载';
    screen.append(title, detail, retry); document.body.replaceChildren(screen);
  }
  document.getElementById('loading-status').textContent = message;
  document.getElementById('loading-progress')?.remove();
  const button = document.getElementById('retry'); button.hidden = false; button.onclick = () => location.reload();
}
async function getJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('无法读取游戏配置（HTTP ' + response.status + '）。');
  return response.json();
}
async function download(path, expectedSize) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('下载游戏资源失败（HTTP ' + response.status + '）。请重新加载。');
  const chunks = []; let loaded = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk); loaded += chunk.length;
    progress('正在加载游戏资源… ' + (loaded / 1048576).toFixed(1) + ' / ' + (expectedSize / 1048576).toFixed(1) + ' MB', loaded, expectedSize);
  }
  if (loaded !== expectedSize) throw new Error('游戏资源下载不完整，请重新加载。');
  return new Blob(chunks);
}
function script(src) {
  return new Promise((resolve, reject) => {
    const node = document.createElement('script'); node.src = src;
    node.onload = resolve; node.onerror = () => reject(new Error('无法加载游戏程序，请重新加载。'));
    document.head.append(node);
  });
}

try {
  const policy = await getJSON('/runtime-policy.json');
  parentOrigin = trustedParent(params.get('parent'), policy.desktopOrigin);
  const profile = profileOptions(params.get('profile') || 'default');
  installRuntimeStorage(profile.localStorageNamespace);
  const engine = selectEngine(params.get('engine') || 'auto', capabilities());
  const manifest = await getJSON('./manifest.json');
  if (manifest.version !== '1.12.2' || manifest.build !== 'u3') throw new Error('游戏版本配置不匹配。');
  const build = manifest.engines[engine];
  const primaryRelay = Math.floor(Math.random() * 3);
  window.eaglercraftXOpts = {
    container: 'game_frame', ...profile, lang: 'zh_cn', enableDownloadOfflineButton: false,
    relays: ['wss://relay.deev.is/', 'wss://relay.lax1dude.net/', 'wss://relay.shhnowisnottheti.me/'].map((addr, index) => ({ addr, comment: 'Eaglercraft relay ' + (index + 1), primary: index === primaryRelay })),
  };
  if (engine === 'wasm') {
    const payload = await download(build.assetsURI, manifest.files[build.assetsURI].size);
    window.eaglercraftXOpts.assetsURI = URL.createObjectURL(payload);
    await script(build.script);
  } else {
    window.eaglercraftXOpts.assetsURI = build.assetsURI.map(entry => ({ ...entry, url: new URL(entry.url, location.href).href }));
    const compressed = await download(build.script, manifest.files[build.script].size);
    progress('正在准备 JavaScript 兼容模式…');
    const code = await new Response(compressed.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
    // Keep this Blob URL alive: Eaglercraft's integrated server worker imports
    // the same program when a single-player world is opened.
    await script(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  }
  progress('正在启动 Minecraft 1.12.2…');
  observer = new MutationObserver(() => {
    if (!document.querySelector('canvas._eaglercraftX_canvas_element')) return;
    observer.disconnect(); clearTimeout(startupTimer);
    status('running', 'Minecraft 1.12.2 · ' + (engine === 'wasm' ? 'WebAssembly' : 'JavaScript'));
  });
  observer.observe(document.body, { childList: true, subtree: true });
  startupTimer = setTimeout(() => status('loading', '首次启动仍在处理中，请稍候。'), 45000);
  if (typeof window.main !== 'function') throw new Error('游戏程序未能初始化。');
  await window.main();
} catch (error) { fail(error); }
window.addEventListener('pagehide', () => { observer?.disconnect(); clearTimeout(startupTimer); });
