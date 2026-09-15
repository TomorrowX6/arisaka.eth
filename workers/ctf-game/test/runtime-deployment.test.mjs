import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyRuntimeDeployment, verifyMusicDeployment } from '../scripts/runtime-deployment-health.mjs';

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

const musicFiles = {
  'index.html': { body: '<!doctype html><title>YesPlayMusic</title>', type: 'text/html' },
  'bridge.js': { body: 'installProfile();', type: 'text/javascript' },
  'js/index.abc123.js': { body: 'mountMusic();', type: 'text/javascript' },
  'img/logos/music.svg': { body: '<svg/>', type: 'image/svg+xml' },
  'img/icons/menu-dark@88.png': { body: 'icon fixture', type: 'image/png' },
  'fonts/font.abc123.woff2': { body: 'font fixture', type: 'font/woff2' },
};
const musicManifest = {
  app: 'yesplaymusic', version: '0.4.10', source: { commit: 'pinned-source' },
  files: Object.fromEntries(Object.entries(musicFiles).map(([name, { body }]) => [name, { size: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') }])),
};
const musicSecurity = { ...security, 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cache-Control': 'no-cache' };
function musicFixture(url, options) {
  const path = new URL(url).pathname;
  if (path.includes('@')) return new Response(null, { status: 307, headers: { Location: path.replace('@', '%40') } });
  if (path === '/runtime-policy.json') return fixture(url);
  if (path === '/yesplaymusic/manifest.json') return Response.json(musicManifest, { headers: musicSecurity });
  if (path === '/yesplaymusic/profiles/default/api/login/qr/create') {
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).qrimg, false);
    return Response.json({ code: 200, data: { qrurl: 'https://music.163.com/login?codekey=runtime-deployment-health', qrimg: '' } }, { headers: { ...musicSecurity, 'Cache-Control': 'no-store' } });
  }
  const name = path === '/yesplaymusic/profiles/default/settings' ? 'index.html' : decodeURIComponent(path.slice('/yesplaymusic/'.length));
  const file = musicFiles[name];
  return file ? new Response(file.body, { headers: { ...musicSecurity, 'Content-Type': file.type } }) : new Response('Not found', { status: 404 });
}

test('music deployment checks every asset, a deep profile page, and POST API routing', async () => {
  const visited = [];
  await verifyMusicDeployment(origin, musicManifest, {
    desktopOrigin,
    request: async (url, options) => { visited.push(new URL(url).pathname); return musicFixture(url, options); },
    wait: () => assert.fail('healthy music deployment needs no retry'),
  });
  assert.deepEqual(new Set(visited), new Set([
    '/runtime-policy.json', '/yesplaymusic/manifest.json', '/yesplaymusic/profiles/default/settings',
    '/yesplaymusic/profiles/default/api/login/qr/create', ...Object.keys(musicFiles).map(name => '/yesplaymusic/' + name.split('/').map(encodeURIComponent).join('/')),
  ]));
});

test('music deployment rejects stale builds, corrupt assets, blocked media, and cached API responses', async () => {
  for (const [path, response] of [
    ['/yesplaymusic/manifest.json', () => Response.json({ ...musicManifest, version: 'old' }, { headers: musicSecurity })],
    ['/yesplaymusic/bridge.js', () => new Response('invalid bridge', { headers: { ...musicSecurity, 'Content-Type': 'text/javascript' } })],
    ['/yesplaymusic/index.html', () => new Response(musicFiles['index.html'].body, { headers: { ...musicSecurity, 'Cross-Origin-Embedder-Policy': 'require-corp', 'Content-Type': 'text/html' } })],
    ['/yesplaymusic/profiles/default/settings', () => new Response('Not found', { status: 404 })],
    ['/yesplaymusic/profiles/default/api/login/qr/create', () => Response.json({ code: 200 }, { headers: musicSecurity })],
    ['/yesplaymusic/fonts/font.abc123.woff2', () => new Response(musicFiles['fonts/font.abc123.woff2'].body, { headers: { ...musicSecurity, 'Content-Type': 'text/html' } })],
  ]) {
    await assert.rejects(verifyMusicDeployment(origin, musicManifest, {
      desktopOrigin, attempts: 1,
      request: async (url, options) => new URL(url).pathname === path ? response() : musicFixture(url, options),
    }), /Music deployment verification failed/, path);
  }
});
