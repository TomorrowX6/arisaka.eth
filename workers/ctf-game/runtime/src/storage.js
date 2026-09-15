// Eaglercraft u3's new VFS opens a fixed database even when worldsDB is set.
// Install the profile namespace before its program starts, in this realm and
// each dedicated worker. The upstream program and its database schema stay intact.
export function installRuntimeStorage(namespace) {
  const marker = Symbol.for('arisaka.minecraft.storage');
  if (globalThis[marker]) {
    if (globalThis[marker] !== namespace) throw new Error('Runtime profile cannot change while running');
    return;
  }
  globalThis[marker] = namespace;
  const prefix = namespace + '.vfs.';
  const factory = globalThis.IDBFactory?.prototype;
  if (!factory) throw new Error('此浏览器无法保存世界，请允许浏览器存储后重试。');
  for (const method of ['open', 'deleteDatabase']) {
    const original = factory[method];
    factory[method] = function (name, ...args) { return original.call(this, prefix + String(name), ...args); };
  }
  if (factory.databases) {
    const databases = factory.databases;
    factory.databases = async function () {
      return (await databases.call(this)).filter(item => item.name.startsWith(prefix)).map(item => ({ ...item, name: item.name.slice(prefix.length) }));
    };
  }
  const NativeWorker = globalThis.Worker;
  if (typeof NativeWorker !== 'function') return;
  const install = '(' + installRuntimeStorage.toString() + ')(' + JSON.stringify(namespace) + ');';
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      const target = JSON.stringify(new URL(String(url), location.href).href);
      // Buffer early messages during a module's asynchronous evaluation. A
      // classic worker imports synchronously before its event loop can dispatch.
      const launch = options?.type === 'module'
        ? 'const pending=[];const hold=e=>{e.stopImmediatePropagation();pending.push(e)};addEventListener("message",hold);await import(' + target + ');removeEventListener("message",hold);for(const e of pending)dispatchEvent(new MessageEvent("message",{data:e.data,ports:e.ports,origin:e.origin}));'
        : 'importScripts(' + target + ');';
      const bootstrap = URL.createObjectURL(new Blob([install, '\n', launch], { type: 'text/javascript' }));
      try { super(bootstrap, options); }
      catch (error) { URL.revokeObjectURL(bootstrap); throw error; }
      this.addEventListener('error', () => URL.revokeObjectURL(bootstrap), { once: true });
      const terminate = this.terminate.bind(this);
      this.terminate = () => { URL.revokeObjectURL(bootstrap); terminate(); };
    }
  };
}
