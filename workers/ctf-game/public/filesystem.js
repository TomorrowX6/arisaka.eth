import { loadWorkspace, saveWorkspace } from '/storage.js';
import { apiFetch } from '/transport.js';
import { activeProfile, listProfiles, getSettings } from '/preferences.js';
import { applications } from '/applications.js';

const encode = new TextEncoder();
const decode = new TextDecoder();
export const HOME = '/home/' + activeProfile().username;
export const DOCUMENTS = HOME + '/Documents';
export const CASES = HOME + '/档案';
export const casePath = (stage) => CASES + '/' + String(stage).padStart(2, '0');
// Older saved scripts and editor tabs may still use ~/01/... .
export function caseLocation(path) {
  const relative = path.startsWith(CASES + '/') ? path.slice(CASES.length + 1) : path.startsWith(HOME + '/') ? path.slice(HOME.length + 1) : '';
  const match = /^([0-9]{2,3})(?:\/([^/]+))?$/.exec(relative);
  return match ? { stage: Number(match[1]), name: match[2] || '' } : null;
}
export const TRASH = HOME + '/.local/share/Trash/files';
export const USER_DIRECTORIES = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'Templates', 'Public'].map(name => HOME + '/' + name);
export const MAX_FILE_SIZE = 32 * 1024 * 1024;
export const MAX_WORKSPACE_SIZE = 64 * 1024 * 1024;
export const applicationNames = { terminal: 'Konsole', http: 'HTTP', midi: 'MIDI', shop: 'Exchange', qr: 'Gwenview', audio: 'Haruna', images: 'Gwenview', signature: 'Archive', wasm: 'WebAssembly', final: 'Archive', artifacts: 'Dolphin' };
const doc = ['JavaScript / Web Crypto / WebAssembly', 'await fs.readFile("/absolute/path") → Uint8Array', 'await fs.readText("/absolute/path") → string', 'await fs.writeFile("filename", string | Uint8Array | ArrayBuffer)', 'console.log(value)'].join('\n');
const recoveryDoc = [
  '档案恢复',
  '',
  '在主目录的“档案”文件夹中打开关卡，再用相应的应用程序查看、处理文件。',
  '尚未开放的档案会显示“禁止访问”；恢复前一个档案后即可打开。',
  '终端使用当前文件夹；HTTP 客户端保留请求、响应和历史记录。',
  '',
  '解码完成后，直接输出完整结果，或在 Kate 中将恢复的文档保存到 Documents。',
  '终端命令与脚本须成功结束，文件须保存成功；只输入文字不会提交结果。',
  '系统确认恢复后会显示桌面通知，并开放下一个档案文件夹。当前应用会保留。',
  '已恢复文档中的回执会自动记入便笺。',
  '',
  'Konsole',
  '  pwd / ls                       查看当前位置与文件',
  '  node /absolute/path/script.js  运行 JavaScript',
  '  node -e \'console.log("hello")\'  运行一段 JavaScript',
  '  python3 /absolute/path/tool.py  运行 Python',
  '  python3 -c \'print("hello")\'     运行一段 Python',
  '  command | base64               把标准输出传给下一条命令',
  '  command > ~/Documents/out.txt  保存标准输出',
  '  Ctrl+C                         中断当前命令',
  '',
  '脚本文件 API：/usr/share/doc/javascript.txt',
].join('\n');

export function normalize(path, base = HOME) {
  const value = String(path).replace(/^~(?=\/|$)/, HOME);
  const parts = [];
  for (const part of (value.startsWith('/') ? value : base + '/' + value).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return '/' + parts.join('/');
}
export const parent = (path) => normalize(path + '/..');
export const basename = (path) => path.split('/').filter(Boolean).at(-1) || (path ? '/' : '');
export function fileType(name) {
  if (/\.desktop$/.test(name)) return { icon: 'binary', label: '应用程序' };
  if (/\.(png|jpe?g|webp|svg)$/i.test(name)) return { icon: 'image', label: '图像' };
  if (/\.(wav|mp3|ogg|mid)$/i.test(name)) return { icon: 'audio', label: '音频' };
  if (/\.(m?js|cjs|ts)$/i.test(name)) return { icon: 'script', label: 'JavaScript' };
  if (/\.pdf$/i.test(name)) return { icon: 'pdf', label: 'PDF 文档' };
  if (/\.vcd$/i.test(name)) return { icon: 'binary', label: '数字波形' };
  if (/\.bpf(?:\.o)?$/i.test(name)) return { icon: 'binary', label: 'eBPF 程序' };
  if (/\.(der|cer|cbor|cborseq)$/i.test(name)) return { icon: 'binary', label: '结构化二进制' };
  if (/\.(wasm|bin|zip|rom|rs16|journal)$/i.test(name)) return { icon: 'binary', label: '二进制文件' };
  return { icon: 'text', label: /\.json$/i.test(name) ? 'JSON 文档' : '文本文档' };
}
function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function createFilesystem(controls) {
  let player = '';
  let local = new Map();
  let directories = new Set(USER_DIRECTORIES);
  let trash = new Map();
  const records = new Map();
  const cached = new Map();
  const events = new EventTarget();
  let ready = Promise.resolve(), writes = Promise.resolve(), revision = 0, epoch = 0, cachedBytes = 0;
  const MAX_CACHE_SIZE = 32 * 1024 * 1024;
  function cache(path, bytes) {
    if (cached.has(path)) { cachedBytes -= cached.get(path).length; cached.delete(path); }
    if (bytes.length > MAX_CACHE_SIZE) return;
    while (cachedBytes + bytes.length > MAX_CACHE_SIZE) {
      const first = cached.keys().next().value;
      cachedBytes -= cached.get(first).length; cached.delete(first);
    }
    cached.set(path, bytes); cachedBytes += bytes.length;
  }
  const writable = (path) => USER_DIRECTORIES.some(directory => path.startsWith(directory + '/'));
  const totalCases = () => controls.state().catalog?.length || controls.state().total || 0;
  const storageKey = () => 'arisaka/files/' + player;
  async function persist() {
    const token = epoch;
    const bytes = [...local.values()].reduce((total, entry) => total + entry.bytes.length, 0);
    if (bytes > MAX_WORKSPACE_SIZE || local.size + directories.size > 4096) throw new Error('ENOSPC');
    const savedRevision = await saveWorkspace(player, { version: 3, files: [...local].map(([path, item]) => [path, item.bytes, item.modified]), directories: [...directories], trash: [...trash] }, revision);
    if (token === epoch) revision = savedRevision;
  }
  function change(mutation, detail) {
    const token = epoch;
    const task = writes.catch(() => {}).then(async () => {
      await ready;
      if (token !== epoch) throw new Error('ECANCELED');
      const before = { local: new Map(local), directories: new Set(directories), trash: new Map(trash) };
      try {
        const result = mutation(); await persist();
        if (token === epoch) {
          events.dispatchEvent(new Event('change'));
          if (detail) events.dispatchEvent(new CustomEvent('audit', { detail: { ...detail, time: Date.now() } }));
        }
        return result;
      }
      catch (error) { if (token === epoch) ({ local, directories, trash } = before); throw error; }
    });
    writes = task;
    return task;
  }
  function setPlayer(value) {
    const token = ++epoch;
    player = value;
    local = new Map(); directories = new Set(USER_DIRECTORIES); trash = new Map(); records.clear(); cached.clear(); cachedBytes = 0; revision = 0;
    ready = (async () => {
      let saved = await loadWorkspace(value);
      if (token !== epoch) return;
      const legacyKey = storageKey();
      let migrated = false;
      if (!saved) { try { saved = JSON.parse(localStorage.getItem(legacyKey) || 'null'); migrated = Boolean(saved); } catch {} }
      revision = Number.isSafeInteger(saved?.revision) && saved.revision >= 0 ? saved.revision : 0;
      const files = Array.isArray(saved) ? saved : Array.isArray(saved?.files) ? saved.files : [];
      let total = 0;
      for (const entry of files.slice(0, 4095)) {
        if (!Array.isArray(entry)) continue;
        const [path, data, modified] = entry;
        if (typeof path !== 'string' || normalize(path) !== path || !(writable(path) || path.startsWith(TRASH + '/'))) continue;
        let bytes;
        try {
          if (typeof data === 'string') {
            if (data.length > Math.ceil(MAX_FILE_SIZE / 3) * 4) continue;
            bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          } else if (data instanceof Uint8Array || Array.isArray(data)) bytes = Uint8Array.from(data);
          else continue;
        } catch { continue; }
        if (bytes.length <= MAX_FILE_SIZE && total + bytes.length <= MAX_WORKSPACE_SIZE) { local.set(path, { bytes, modified: Number(modified) || 0 }); total += bytes.length; }
      }
      for (const path of (Array.isArray(saved?.directories) ? saved.directories : []).slice(0, 4095 - local.size)) {
        if (typeof path === 'string' && (writable(path) || path.startsWith(TRASH + '/')) && normalize(path) === path && !local.has(path)) directories.add(path);
      }
      for (const entry of (Array.isArray(saved?.trash) ? saved.trash : []).slice(0, 4096)) {
        if (!Array.isArray(entry)) continue;
        const [path, original] = entry;
        if (typeof path === 'string' && typeof original === 'string' && path.startsWith(TRASH + '/') && normalize(path) === path && writable(original) && normalize(original) === original && (local.has(path) || directories.has(path))) trash.set(path, original);
      }
      if (migrated) { await persist(); localStorage.removeItem(legacyKey); }
      if (token === epoch) events.dispatchEvent(new Event('change'));
    })();
    ready.catch((error) => controls.toast?.(error.message));
    return ready;
  }
  async function record(stage) {
    const token = epoch;
    await ready;
    if (token !== epoch) throw new Error('ECANCELED');
    if (!Number.isInteger(stage) || stage < 1 || stage > Math.min(controls.state().stage, totalCases())) throw new Error('EACCES');
    if (!records.has(stage)) {
      const result = await controls.api('/api/cases/' + stage);
      if (token !== epoch) throw new Error('ECANCELED');
      records.set(stage, result);
    }
    return records.get(stage);
  }
  function setCase(value) { records.set(value.id, value); }
  function descriptor(path, extra = {}) {
    return { path, name: basename(path), kind: 'file', ...fileType(path), size: local.get(path)?.bytes.length ?? cached.get(path)?.length, modified: local.get(path)?.modified || 0, writable: writable(path), ...extra };
  }
  function folder(path, extra = {}) { return descriptor(path, { kind: 'directory', icon: 'folder', label: '文件夹', ...extra }); }
  function systemFiles() {
    const settings = getSettings();
    const files = {
      '/etc/hostname': 'arisaka\n',
      '/etc/os-release': 'NAME="Arisaka Desktop"\nID=arisaka\nPRETTY_NAME="Arisaka Desktop"\n',
      '/etc/passwd': listProfiles().map((user, index) => user.username + ':x:' + (1000 + index) + ':' + (1000 + index) + ':' + user.name.replace(/[:\r\n]/g, '') + ':/home/' + user.username + ':/bin/konsole').join('\n') + '\n',
      [HOME + '/.config/kdeglobals']: '[General]\nColorScheme=' + settings.theme + '\nfont=' + settings.fontFamily + ',' + settings.fontSize + '\nfixed=' + settings.monoFont + ',' + settings.monoSize + '\n\n[KDE]\nSingleClick=' + settings.singleClick + '\n',
      [HOME + '/.config/user-dirs.dirs']: USER_DIRECTORIES.map(path => 'XDG_' + basename(path).toUpperCase() + '_DIR="$HOME/' + basename(path) + '"').join('\n') + '\n',
    };
    for (const app of applications.filter(app => !app.hidden)) {
      files['/usr/share/applications/' + app.id + '.desktop'] = '[Desktop Entry]\nType=Application\nName=' + app.name + '\nComment=' + app.description + '\nExec=arisaka-application ' + app.id + '\nX-Arisaka-App=' + app.id + '\nTerminal=false\n';
    }
    return files;
  }
  async function entries(input) {
    await ready;
    const path = normalize(input);
    if (path === '/') return ['/archive', '/etc', '/home', '/usr'].map((path) => folder(path));
    if (path === '/home') return listProfiles().map((profile) => folder('/home/' + profile.username, { icon: 'user-home', locked: profile.username !== activeProfile().username }));
    if (path === '/usr') return [folder('/usr/share')];
    if (path === '/usr/share') return [folder('/usr/share/doc'), folder('/usr/share/applications')];
    if (path === '/etc' || path === '/usr/share/applications' || path === HOME + '/.config') return Object.keys(systemFiles()).filter(file => parent(file) === path).map(file => descriptor(file));
    if (path === HOME + '/.local') return [folder(HOME + '/.local/share')];
    if (path === HOME + '/.local/share') return [folder(HOME + '/.local/share/Trash')];
    if (path === HOME + '/.local/share/Trash') return [folder(TRASH, { icon: 'user-trash' })];
    if (path === '/usr/share/doc') return ['javascript.txt', 'recovery.txt'].map(name => descriptor('/usr/share/doc/' + name));
    if (path === CASES) return Array.from({ length: totalCases() }, (_, i) => folder(casePath(i + 1), { locked: i + 1 > controls.state().stage, solved: i + 1 < controls.state().stage }));
    if (path === HOME) return [
      folder(CASES),
      ...USER_DIRECTORIES.map(path => folder(path, { icon: path === DOCUMENTS ? 'folder-documents' : 'folder' })),
      folder(HOME + '/.config'), folder(HOME + '/.local'), descriptor(HOME + '/notes.txt'), descriptor(HOME + '/receipts.txt'),
    ];
    if (path === TRASH) return [...trash.keys()].map((key) => directories.has(key) ? folder(key, { original: trash.get(key) }) : descriptor(key, { original: trash.get(key) }));
    if (directories.has(path)) return [
      ...[...directories].filter((item) => item !== path && parent(item) === path).map((item) => folder(item)),
      ...[...local.keys()].filter((item) => parent(item) === path).map((item) => descriptor(item)),
    ];
    if (path === '/archive' || path === '/archive/.cache') {
      const result = await controls.api('/api/terminal', { command: 'ls -a ' + path, cwd: '/archive' });
      return result.output.trim().split(/\s+/).filter((name) => name && name !== '.' && name !== '..').map((name) => name.replace(/\/$/, '') === '.cache' ? folder('/archive/.cache') : descriptor(path + '/' + name.replace(/\/$/, '')));
    }
    const match = caseLocation(path);
    if (match && !match.name) {
      const detail = await record(match.stage);
      return [descriptor(path + '/' + applicationNames[detail.widget] + '.desktop', { kind: 'application', app: detail.widget, icon: detail.widget === 'terminal' ? 'konsole' : ['qr', 'images'].includes(detail.widget) ? 'gwenview' : 'binary' }), ...detail.files.map((file) => descriptor(path + '/' + file.name))];
    }
    throw new Error('ENOTDIR: ' + path);
  }
  async function read(input) {
    const token = epoch;
    await ready;
    if (token !== epoch) throw new Error('ECANCELED');
    const path = normalize(input);
    if (local.has(path)) return local.get(path).bytes.slice();
    if (Object.hasOwn(systemFiles(), path)) return encode.encode(systemFiles()[path]);
    if (path === '/usr/share/doc/javascript.txt') return encode.encode(doc);
    if (path === '/usr/share/doc/recovery.txt') return encode.encode(recoveryDoc);
    if (path === HOME + '/notes.txt') return encode.encode(controls.notes().text);
    if (path === HOME + '/receipts.txt') return encode.encode(controls.notes().receipts.filter(Boolean).join('\n'));
    if (path.startsWith('/archive/')) {
      const result = await controls.api('/api/terminal', { command: 'cat ' + path, cwd: '/archive' });
      if (token !== epoch) throw new Error('ECANCELED');
      if (result.output.startsWith('cat:')) throw new Error('ENOENT: ' + path);
      return encode.encode(result.output);
    }
    const match = caseLocation(path);
    if (!match?.name) throw new Error('ENOENT: ' + path);
    const detail = await record(match.stage);
    if (token !== epoch) throw new Error('ECANCELED');
    if (match.name === applicationNames[detail.widget] + '.desktop') return encode.encode('[Desktop Entry]\nType=Application\nName=' + applicationNames[detail.widget] + '\nExec=case ' + detail.id + '\n');
    if (cached.has(path)) { const bytes = cached.get(path); cached.delete(path); cached.set(path, bytes); return bytes.slice(); }
    const file = detail.files.find((file) => file.name === match.name);
    if (!file) throw new Error('ENOENT: ' + path);
    const response = await apiFetch(file.url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (token !== epoch) throw new Error('ECANCELED');
    cache(path, bytes); return bytes.slice();
  }
  async function writeFile(input, value, overwrite = true, recoveryContext = controls.captureRecovery?.()) {
    const token = epoch;
    await ready;
    if (token !== epoch) throw new Error('ECANCELED');
    const path = normalize(input, DOCUMENTS);
    if (!writable(path) || basename(path).length > 120) throw new Error('EACCES: ' + path);
    const bytes = typeof value === 'string' ? encode.encode(value) : new Uint8Array(value);
    if (bytes.length > MAX_FILE_SIZE) throw new Error('EFBIG');
    const copy = bytes.slice();
    return change(() => {
      if (!directories.has(parent(path))) throw new Error('EACCES: ' + path);
      if (directories.has(path) || !overwrite && local.has(path)) throw new Error('EEXIST: ' + path);
      local.set(path, { bytes: copy, modified: Date.now() }); return path;
    }, { operation: 'write', path, bytes: copy.length, recoveryContext });
  }
  async function mkdir(input) {
    await ready;
    const path = normalize(input, DOCUMENTS);
    return change(() => {
      if (!writable(path) || !directories.has(parent(path))) throw new Error('EACCES');
      if (directories.has(path) || local.has(path)) throw new Error('EEXIST');
      directories.add(path); return path;
    }, { operation: 'mkdir', path });
  }
  async function rename(input, destination) {
    await ready;
    const path = normalize(input), target = normalize(destination, parent(path));
    return change(() => {
      if (!writable(path) || !writable(target) || !directories.has(parent(target))) throw new Error('EACCES');
      if (local.has(target) || directories.has(target) || target.startsWith(path + '/')) throw new Error('EEXIST');
      if (!local.has(path) && !directories.has(path)) throw new Error('ENOENT');
      for (const [key, item] of [...local]) if (key === path || key.startsWith(path + '/')) { local.delete(key); local.set(target + key.slice(path.length), item); }
      for (const key of [...directories]) if (key === path || key.startsWith(path + '/')) { directories.delete(key); directories.add(target + key.slice(path.length)); }
      return target;
    }, { operation: 'rename', path, destination: target });
  }
  async function remove(input, recursive = true) {
    await ready;
    const path = normalize(input);
    if (!writable(path)) throw new Error('EROFS');
    return change(() => {
      if (!local.has(path) && !directories.has(path)) throw new Error('ENOENT');
      if (!recursive && directories.has(path)) throw new Error('EISDIR');
      let target = TRASH + '/' + basename(path);
      let index = 1;
      while (local.has(target) || directories.has(target)) target = TRASH + '/' + basename(path) + '.' + index++;
      for (const [key, item] of [...local]) if (key === path || key.startsWith(path + '/')) { local.delete(key); local.set(target + key.slice(path.length), item); }
      for (const key of [...directories]) if (key === path || key.startsWith(path + '/')) { directories.delete(key); directories.add(target + key.slice(path.length)); }
      trash.set(target, path);
    }, { operation: 'trash', path });
  }
  async function restore(input) {
    await ready;
    return change(() => {
      const target = trash.get(input);
      if (!target || !local.has(input) && !directories.has(input)) throw new Error('ENOENT');
      if (local.has(target) || directories.has(target) || !directories.has(parent(target))) throw new Error('EEXIST');
      for (const [key, item] of [...local]) if (key === input || key.startsWith(input + '/')) { local.delete(key); local.set(target + key.slice(input.length), item); }
      for (const key of [...directories]) if (key === input || key.startsWith(input + '/')) { directories.delete(key); directories.add(target + key.slice(input.length)); }
      trash.delete(input); return target;
    }, { operation: 'restore', path: input });
  }
  async function purge(input = TRASH) {
    await ready;
    const path = normalize(input);
    if (path !== TRASH && !trash.has(path)) throw new Error('EACCES');
    return change(() => {
      for (const key of [...local.keys()]) if (key === path || key.startsWith(path + '/')) local.delete(key);
      for (const key of [...directories]) if (key === path || key.startsWith(path + '/')) directories.delete(key);
      for (const key of [...trash.keys()]) if (key === path || key.startsWith(path + '/')) trash.delete(key);
    }, { operation: 'purge', path });
  }
  async function snapshot() {
    await ready;
    const files = new Map([...local].map(([path, entry]) => [path, entry.bytes]));
    for (let stage = 1; stage <= Math.min(controls.state().stage, totalCases()); stage++) {
      const detail = await record(stage);
      await Promise.all(detail.files.map(async (file) => { const path = casePath(stage) + '/' + file.name; files.set(path, await read(path)); }));
    }
    for (const path of [HOME + '/notes.txt', HOME + '/receipts.txt', '/usr/share/doc/javascript.txt', '/usr/share/doc/recovery.txt']) files.set(path, await read(path));
    return [...files].map(([path, bytes]) => [path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)]);
  }
  return { ready: () => ready, flush: () => writes, setPlayer, setCase, entries, read, readText: async (path) => decode.decode(await read(path)), writeFile, mkdir, rename, remove, restore, purge, snapshot, record, events, writable, used: () => [...local.values()].reduce((sum, item) => sum + item.bytes.length, 0) };
}
