// The outer worker has connect-src 'none'; its disposable child inherits that
// policy. Bounded file and game-service RPC cross back to the desktop;
// credentials and arbitrary network access remain outside the worker.
let running;
self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'result') { running?.postMessage(message, message.bytes ? [message.bytes.buffer] : []); return; }
  running?.terminate(); running = null;
  const { source } = message;
  if (message.type !== 'run' || typeof source !== 'string' || source.length > 500000) return;
  const prelude = [
    "'use strict';",
    'const requests = new Map(); let sequence = 0, active = false;',
    'const encoder = new TextEncoder(), decoder = new TextDecoder();',
    'const send = self.postMessage.bind(self);',
    'const request = (operation, path, bytes, options) => new Promise((resolve, reject) => {',
    ' if (requests.size >= 16) { reject(new Error("EMFILE")); return; }',
    ' const id = ++sequence; requests.set(id, {resolve, reject});',
    ' send({type:"fs", id, operation, path, ...(bytes ? {bytes} : {}), ...(options ? {options} : {})}, bytes ? [bytes.buffer] : []);',
    '});',
    'const net = Object.freeze({',
    ' request: async (path, options = {}) => (await request("request", String(path), undefined, options)).response,',
    ' json: async (path, value) => { const result = await net.request(path, value === undefined ? {} : {method:"POST", body:JSON.stringify(value)}); return JSON.parse(result.body); }',
    '});',
    'const fs = Object.freeze({',
    ' readFile: async path => (await request("read", String(path))).bytes,',
    ' readText: async path => decoder.decode((await request("read", String(path))).bytes),',
    ' writeFile: async (path, value) => {',
    '  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value).slice();',
    '  if (bytes.length > 33554432) throw new Error("EFBIG");',
    '  return (await request("write", String(path), bytes)).path;',
    ' },',
    ' readdir: async path => (await request("list", String(path))).entries,',
    ' mkdir: async path => (await request("mkdir", String(path))).path',
    '});',
    'const format = value => typeof value === "string" ? value : typeof value === "bigint" ? value.toString() : JSON.stringify(value, (_,item) => typeof item === "bigint" ? item.toString() : item);',
    'const console = Object.freeze({log: (...args) => send({type:"log",value:args.map(format).join(" ")}), error: (...args) => send({type:"log",value:args.map(format).join(" ")})});',
    'self.onmessage = async event => {',
    ' const message = event.data || {};',
    ' if (message.type === "result") {',
    '  const pending = requests.get(message.id); if (!pending) return;',
    '  requests.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message); return;',
    ' }',
    ' if (message.type !== "start" || active) return; active = true;',
    ' try {',
    source,
    '  send({type:"done"});',
    ' } catch (error) { send({type:"error",value:String(error && error.message || error)}); }',
    '};',
  ].join('\n');
  const url = URL.createObjectURL(new Blob([prelude], { type: 'text/javascript' }));
  try {
    running = new Worker(url);
    running.onmessage = (event) => {
      const data = event.data || {};
      self.postMessage(data, data.bytes instanceof Uint8Array ? [data.bytes.buffer] : []);
    };
    running.onerror = (error) => self.postMessage({ type: 'error', value: error.message || 'Execution failed' });
    running.postMessage({ type: 'start' });
  } catch (error) { self.postMessage({ type: 'error', value: error.message }); }
  finally { URL.revokeObjectURL(url); }
};
