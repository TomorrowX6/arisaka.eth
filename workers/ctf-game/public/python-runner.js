import { loadPyodide } from '/vendor/pyodide/pyodide.mjs';

// Runtime files arrive from the desktop. The worker's CSP denies all network
// connections, including same-origin APIs; game services use bounded RPC.
const pending = new Map();
let sequence = 0, started = false;
const send = self.postMessage.bind(self);
function request(operation, path, bytes, options) {
  if (pending.size >= 16) return Promise.reject(new Error('EMFILE'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'fs', id, operation, path, ...(bytes ? { bytes } : {}), ...(options ? { options } : {}) }, bytes ? [bytes.buffer] : []);
  });
}
self.onmessage = async ({ data: message }) => {
  if (message?.type === 'result') {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    message.error ? item.reject(new Error(message.error)) : item.resolve(message);
    return;
  }
  if (started || message?.type !== 'run' || typeof message.source !== 'string' || message.source.length > 500000) return;
  started = true;
  try {
    const assets = new Map(message.runtime);
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
      const name = url.pathname.slice('/vendor/pyodide/'.length);
      if (url.origin !== location.origin || !url.pathname.startsWith('/vendor/pyodide/') || !/^[a-zA-Z0-9_.-]+\.(wasm|zip|whl)$/.test(name)) throw new Error('EACCES');
      const bytes = assets.get(name) || (await request('runtime', name)).bytes;
      return new Response(bytes, { headers: { 'Content-Type': name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
    };
    const log = value => send({ type: 'log', value });
    const pyodide = await loadPyodide({
      indexURL: '/vendor/pyodide/', packageBaseUrl: new URL('/vendor/pyodide/', location.origin).href, lockFileContents: message.lock,
      stdout: log, stderr: log, stdin: () => null,
      env: { HOME: message.home, PYTHONHASHSEED: '0' },
    });
    pyodide.registerJsModule('desktop_rpc', {
      read: async path => (await request('read', String(path))).bytes,
      write: async (path, value) => {
        const converted = typeof value?.toJs === 'function' ? value.toJs() : value;
        const bytes = new Uint8Array(converted).slice();
        if (bytes.length > 33554432) throw new Error('EFBIG');
        return (await request('write', String(path), bytes)).path;
      },
      list: async path => JSON.stringify((await request('list', String(path))).entries),
      mkdir: async path => (await request('mkdir', String(path))).path,
      network: async (path, options) => JSON.stringify((await request('request', String(path), undefined, JSON.parse(options))).response),
    });
    await pyodide.runPythonAsync(`
import json as _json
import desktop_rpc as _rpc

class _Workspace:
    async def read_bytes(self, path):
        return bytes((await _rpc.read(str(path))).to_py())
    async def read_text(self, path, encoding="utf-8"):
        return (await self.read_bytes(path)).decode(encoding)
    async def write_bytes(self, path, value):
        return await _rpc.write(str(path), bytes(value))
    async def write_text(self, path, value, encoding="utf-8"):
        return await self.write_bytes(path, str(value).encode(encoding))
    async def readdir(self, path):
        return _json.loads(await _rpc.list(str(path)))
    async def mkdir(self, path):
        return await _rpc.mkdir(str(path))
    async def pull(self, path):
        import os
        data = await self.read_bytes(path)
        os.makedirs(os.path.dirname(str(path)), exist_ok=True)
        with open(str(path), "wb") as stream:
            stream.write(data)
        return str(path)
    async def push(self, path, destination=None):
        with open(str(path), "rb") as stream:
            return await self.write_bytes(destination or path, stream.read())

class _Network:
    async def request(self, path, **options):
        return _json.loads(await _rpc.network(str(path), _json.dumps(options)))
    async def json(self, path, value=None):
        options = {} if value is None else {"method": "POST", "body": _json.dumps(value)}
        return _json.loads((await self.request(path, **options))["body"])

fs = _Workspace()
net = _Network()
`);
    pyodide.globals.set('__file__', message.filename || 'untitled.py');
    pyodide.globals.set('__name__', '__main__');
    await pyodide.loadPackagesFromImports(message.source, { messageCallback: () => {}, errorCallback: () => {} });
    const result = await pyodide.runPythonAsync(message.source, { filename: message.filename || 'untitled.py' });
    result?.destroy?.();
    send({ type: 'done' });
  } catch (error) { send({ type: 'error', value: String(error?.message || error) }); }
};
