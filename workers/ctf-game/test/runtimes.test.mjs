import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { extractClient, verifyArchive, MAX_ASSET_BYTES } from '../scripts/build-runtimes.mjs';
import { profileOptions, selectEngine, trustedParent } from '../runtime/src/config.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const dataURL = bytes => 'data:application/octet-stream;base64,' + bytes.toString('base64');
const core = '\n"use strict"; window.main = function () { return "actual engine"; };\n';
const wasmData = Buffer.alloc(512);
wasmData.write('EAG$WASM'); wasmData.writeUInt32LE(wasmData.length, 8);
const html = payload => '<html><script>window.eaglercraftXOpts={container:"game_frame"};</script><script>' + core + '</script><script>window.eaglercraftXOpts.assetsURI=' + payload + '; setTimeout(main,5000);</script><body>Offline countdown</body></html>';

test('pinned archives reject tampering before decompression and require the named HTML', () => {
  const bytes = Buffer.from(zipSync({ 'client.html': Buffer.from(html(JSON.stringify(dataURL(wasmData)))) }));
  const source = { kind: 'wasm', html: 'client.html', sha256: sha256(bytes) };
  assert.doesNotThrow(() => verifyArchive(bytes, source));
  const changed = Buffer.from(bytes); changed[10] ^= 1;
  assert.throws(() => extractClient(changed, source), /checksum/i);
  assert.throws(() => extractClient(bytes, { ...source, html: 'missing.html' }), /missing/i);
});

test('WASM extraction preserves the loader and EPW without the offline countdown', () => {
  const bytes = Buffer.from(zipSync({ 'client.html': Buffer.from(html(JSON.stringify(dataURL(wasmData)))) }));
  const result = extractClient(bytes, { kind: 'wasm', html: 'client.html', sha256: sha256(bytes) });
  assert.deepEqual(result.files['assets/u3-game.epw'], wasmData);
  assert.equal(result.files['assets/u3-loader.js'].toString(), core);
  assert.equal(result.engine.assetsURI, 'assets/u3-game.epw');
  assert.equal(Object.keys(result.files).some(name => name.endsWith('.html')), false);
});

test('JavaScript extraction preserves program bytes and the language asset mount path', () => {
  const assets = [Buffer.from('EAGPKG$$game'), Buffer.from('EAGPKG$$languages')];
  const body = html('[{url:"' + dataURL(assets[0]) + '"},{url:"' + dataURL(assets[1]) + '",path:"assets/minecraft/lang/"}]');
  const bytes = Buffer.from(zipSync({ 'client.html': Buffer.from(body) }));
  const source = { kind: 'javascript', html: 'client.html', sha256: sha256(bytes) };
  const result = extractClient(bytes, source);
  assert.equal(gunzipSync(result.files['assets/u3-game.js.gz']).toString(), core);
  assert.deepEqual(result.files['assets/u3-game.epk'], assets[0]);
  assert.deepEqual(result.files['assets/u3-lang.epk'], assets[1]);
  assert.deepEqual(result.engine.assetsURI, [{ url: 'assets/u3-game.epk' }, { url: 'assets/u3-lang.epk', path: 'assets/minecraft/lang/' }]);
  assert.deepEqual(extractClient(bytes, source), result, 'extraction and compression are deterministic');
  assert.equal(MAX_ASSET_BYTES, 25 * 1024 * 1024);
});

test('desktop profiles use independent worlds, resource packs, and preferences', () => {
  const first = profileOptions('default');
  const second = profileOptions('12345678-1234-4234-8234-123456789abc');
  for (const key of ['worldsDB', 'resourcePacksDB', 'localStorageNamespace']) {
    assert.notEqual(first[key], second[key]);
    assert.equal(profileOptions('default')[key], first[key]);
  }
  for (const invalid of ['../default', '<script>', '', 'a'.repeat(1024)]) assert.throws(() => profileOptions(invalid), /profile/i);
});

test('engine selection falls back only to a supported client and parent targets stay narrow', () => {
  assert.equal(selectEngine('auto', { wasmGC: true, decompress: true }), 'wasm');
  assert.equal(selectEngine('auto', { wasmGC: false, decompress: true }), 'javascript');
  assert.throws(() => selectEngine('wasm', { wasmGC: false, decompress: true }), /WebAssembly/);
  assert.throws(() => selectEngine('javascript', { wasmGC: true, decompress: false }), /Chrome|Edge|Firefox/);
  assert.throws(() => selectEngine('unknown', { wasmGC: true, decompress: true }), /engine/i);
  assert.equal(trustedParent('https://desktop.example', 'https://desktop.example'), 'https://desktop.example');
  for (const candidate of ['https://evil.example', 'https://desktop.example.evil.test', 'null', 'javascript:alert(1)']) assert.equal(trustedParent(candidate, 'https://desktop.example'), null);
  assert.equal(trustedParent('http://127.0.0.1:41234', 'http://127.0.0.1:*'), 'http://127.0.0.1:41234');
  assert.equal(trustedParent('http://localhost.evil.test:41234', 'http://127.0.0.1:*'), null);
});
