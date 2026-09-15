export function profileOptions(profile) {
  if (profile !== 'default' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(profile)) throw new Error('Invalid desktop profile');
  const namespace = 'arisaka.minecraft.1.12.2.' + profile;
  return { worldsDB: namespace + '.worlds', resourcePacksDB: namespace + '.resourcePacks', localStorageNamespace: namespace };
}

export function selectEngine(requested, capabilities) {
  if (!['auto', 'wasm', 'javascript'].includes(requested)) throw new Error('Unknown Minecraft engine');
  const engine = requested === 'auto' ? (capabilities.wasmGC ? 'wasm' : 'javascript') : requested;
  if (engine === 'wasm' && !capabilities.wasmGC) throw new Error('当前浏览器不支持 WebAssembly GC，请选择 JavaScript 兼容模式。');
  if (engine === 'javascript' && !capabilities.decompress) throw new Error('请使用新版 Chrome、Edge 或 Firefox 运行 Minecraft。');
  return engine;
}

export function trustedParent(candidate, allowed) {
  try {
    const url = new URL(candidate);
    if (candidate !== url.origin) return null;
    if (candidate === allowed && ['https:', 'http:'].includes(url.protocol)) return candidate;
    if (allowed === 'http://127.0.0.1:*' && url.protocol === 'http:' && url.hostname === '127.0.0.1') return candidate;
  } catch { /* Standalone launches have no parent to notify. */ }
  return null;
}

export function capabilities() {
  let wasmGC = false;
  // A module containing a mutable i32 struct field requires WebAssembly GC.
  try { wasmGC = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 95, 1, 127, 1])); } catch {}
  return { wasmGC, decompress: typeof DecompressionStream === 'function' };
}
