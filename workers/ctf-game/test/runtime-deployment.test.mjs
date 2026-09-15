import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyRuntimeDeployment } from '../scripts/runtime-deployment-health.mjs';

const origin = 'https://apps.example/';
const desktopOrigin = 'https://desktop.example';
const files = {
  'index.html': { body: '<!doctype html><title>Minecraft</title>', type: 'text/html' },
  'boot.js': { body: 'window.main();', type: 'text/javascript' },
  'assets/u3-game.js.gz': { body: 'compressed fixture', type: 'application/gzip' },
};
const manifest = {
  app: 'minecraft', version: '1.12.2', build: 'u3', sources: [{ sha256: 'pinned-source' }],
  files: Object.fromEntries(Object.entries(files).map(([name, { body }]) => [name, { size: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') }])),
};
const security = {
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Security-Policy': 'frame-ancestors ' + desktopOrigin,
};
function fixture(url) {
  const path = new URL(url).pathname;
  if (path === '/health') return Response.json({ ok: true, app: 'minecraft', version: '1.12.2', build: 'u3' }, { headers: security });
  if (path === '/runtime-policy.json') return Response.json({ desktopOrigin }, { headers: security });
  if (path === '/minecraft/1.12.2/manifest.json') return Response.json(manifest, { headers: security });
  const file = files[path.slice('/minecraft/1.12.2/'.length) || 'index.html'];
  return file ? new Response(file.body, { headers: { ...security, 'Content-Type': file.type } }) : new Response('Not found', { status: 404 });
}

test('runtime deployment verifies the real resource bodies and configured desktop policy', async () => {
  const visited = [];
  await verifyRuntimeDeployment(origin, manifest, {
    desktopOrigin,
    request: async (url, options) => { visited.push(new URL(url).pathname); assert.equal(options.cache, 'no-store'); assert.ok(options.signal instanceof AbortSignal); return fixture(url); },
    wait: () => assert.fail('healthy deployment needs no retry'),
  });
  assert.deepEqual(new Set(visited), new Set(['/health', '/runtime-policy.json', '/minecraft/1.12.2/manifest.json', ...Object.keys(files).map(name => '/minecraft/1.12.2/' + name)]));
});

test('runtime deployment rejects stale metadata, corrupt bodies, missing resources, and isolation failures', async () => {
  for (const [path, response] of [
    ['/health', () => Response.json({ ok: true, app: 'minecraft', version: '1.8.8', build: 'u3' }, { headers: security })],
    ['/health', () => Response.json(null, { headers: security })],
    ['/runtime-policy.json', () => Response.json({ desktopOrigin: 'https://wrong.example' }, { headers: security })],
    ['/minecraft/1.12.2/manifest.json', () => Response.json({ ...manifest, sources: [] }, { headers: security })],
    ['/minecraft/1.12.2/boot.js', () => new Response('window.fail();', { headers: { ...security, 'Content-Type': 'text/javascript' } })],
    ['/minecraft/1.12.2/boot.js', () => new Response('Not found', { status: 404, headers: security })],
    ['/minecraft/1.12.2/index.html', () => new Response(files['index.html'].body, { headers: { ...security, 'Cross-Origin-Embedder-Policy': 'unsafe-none', 'Content-Type': 'text/html' } })],
    ['/minecraft/1.12.2/assets/u3-game.js.gz', () => new Response(files['assets/u3-game.js.gz'].body, { headers: { ...security, 'Content-Type': 'text/html' } })],
  ]) {
    await assert.rejects(verifyRuntimeDeployment(origin, manifest, {
      desktopOrigin, attempts: 1,
      request: async url => new URL(url).pathname === path ? response() : fixture(url), wait: async () => {},
    }), /Runtime deployment verification failed/, path);
  }
});

test('runtime deployment retries propagation errors without accepting a stale version', async () => {
  let calls = 0, waits = 0;
  await verifyRuntimeDeployment(origin, manifest, {
    desktopOrigin,
    request: async url => ++calls === 1 ? new Response('edge not ready', { status: 503 }) : fixture(url),
    wait: async milliseconds => { assert.equal(milliseconds, 1500); waits++; },
  });
  assert.equal(waits, 1);
});
