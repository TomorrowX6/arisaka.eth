import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';

export const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const runtimeSources = [
  { kind: 'wasm', archive: 'Eaglercraft_1.12.2_u3_WASM_Offline.zip', html: 'Eaglercraft_1.12.2_u3_WASM_Offline.html', sha256: '6a16e549b293ffca7a787fccb7f5ca77eca688d34ca3ca6170b8dfdd82eabea7' },
  { kind: 'javascript', archive: 'Eaglercraft_1.12.2_u3_Offline.zip', html: 'Eaglercraft_1.12.2_u3_Offline.html', sha256: '5797a24950c3eefb665a7158fb648440924352ad19d120efe3a07f125b0d7834' },
].map(source => ({ ...source, url: 'https://cdn.eaglercraft.ru/dl/1.12.2/' + source.archive }));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyArchive(bytes, source) {
  if (sha256(bytes) !== source.sha256) throw new Error('Runtime archive checksum mismatch: ' + (source.archive || source.html));
}

export function extractClient(bytes, source) {
  verifyArchive(bytes, source);
  // Only the hash-pinned, explicitly named HTML is decoded. Archive paths are
  // never joined to the filesystem and unrelated zip entries are not inflated.
  const entry = unzipSync(bytes, { filter: file => file.name === source.html })[source.html];
  if (!entry) throw new Error('Runtime archive is missing ' + source.html);
  const html = Buffer.from(entry).toString('utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  if (scripts.length !== 3 || !scripts[0].includes('eaglercraftXOpts')) throw new Error('Unexpected offline client layout');
  const files = {};
  const payloads = [...scripts[2].matchAll(/data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/g)]
    .map(match => Buffer.from(match[1], 'base64'));
  let engine;
  if (source.kind === 'wasm') {
    if (payloads.length !== 1 || payloads[0].length < 384 || payloads[0].subarray(0, 8).toString() !== 'EAG$WASM'
      || payloads[0].readUInt32LE(8) !== payloads[0].length) throw new Error('Invalid WASM EPW payload');
    files['assets/u3-loader.js'] = Buffer.from(scripts[1]);
    files['assets/u3-game.epw'] = payloads[0];
    engine = { script: 'assets/u3-loader.js', assetsURI: 'assets/u3-game.epw' };
  } else if (source.kind === 'javascript') {
    // The upstream script begins with "use strict". Inspect the assets
    // assignment itself and require its one language-pack mount point.
    const paths = [...scripts[2].matchAll(/\bpath\s*:\s*"([^"]*)"/g)].map(match => match[1]);
    if (payloads.length !== 2 || paths.length !== 1 || paths[0] !== 'assets/minecraft/lang/') throw new Error('Unexpected EPK asset mounts');
    files['assets/u3-game.js.gz'] = gzipSync(Buffer.from(scripts[1]), { level: 9 });
    files['assets/u3-game.epk'] = payloads[0];
    files['assets/u3-lang.epk'] = payloads[1];
    engine = { script: 'assets/u3-game.js.gz', assetsURI: [{ url: 'assets/u3-game.epk' }, { url: 'assets/u3-lang.epk', path: paths[0] }] };
  } else throw new Error('Unknown runtime engine');
  for (const [name, content] of Object.entries(files)) {
    if (!content.length || content.length > MAX_ASSET_BYTES) throw new Error('Runtime asset exceeds the static asset limit: ' + name);
  }
  return { files, engine };
}

async function archive(source, cache) {
  const path = resolve(cache, source.archive);
  try {
    const bytes = await readFile(path);
    verifyArchive(bytes, source);
    return bytes;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  console.log('Downloading pinned Eaglercraft ' + source.kind + ' client…');
  const response = await fetch(source.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('Runtime download failed: HTTP ' + response.status);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 32 * 1024 * 1024) throw new Error('Unexpected runtime archive size');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  verifyArchive(bytes, source);
  const temporary = path + '.' + process.pid + '.download';
  try { await writeFile(temporary, bytes); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  return bytes;
}

export async function buildRuntimes({ directory = resolve(runtimeRoot, 'runtime/dist'), cache = resolve(runtimeRoot, '.private/runtimes') } = {}) {
  await mkdir(cache, { recursive: true });
  const files = {};
  const engines = {};
  // Sequential extraction keeps peak memory bounded for the 83 MB JS HTML.
  for (const source of runtimeSources) {
    const result = extractClient(await archive(source, cache), source);
    Object.assign(files, result.files);
    engines[source.kind] = result.engine;
  }
  for (const name of ['index.html', 'boot.js', 'config.js', 'storage.js', 'style.css', 'NOTICE.txt']) {
    files[name] = await readFile(resolve(runtimeRoot, 'runtime/src', name));
  }
  const manifest = {
    app: 'minecraft', version: '1.12.2', build: 'u3',
    sources: runtimeSources.map(({ kind, url, sha256 }) => ({ kind, url, sha256 })), engines,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { size: bytes.length, sha256: sha256(bytes) }])),
  };
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  for (const [name, bytes] of Object.entries(files)) {
    if (bytes.length > MAX_ASSET_BYTES) throw new Error('Runtime asset exceeds 25 MiB: ' + name);
    const path = resolve(directory, 'minecraft/1.12.2', name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  console.log('Prepared Minecraft 1.12.2 u3: ' + Object.keys(files).length + ' assets, largest ' + Math.max(...Object.values(files).map(bytes => bytes.length)) + ' bytes.');
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildRuntimes();
