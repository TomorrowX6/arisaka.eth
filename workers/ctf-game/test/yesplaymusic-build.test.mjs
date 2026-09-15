import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const require = createRequire(import.meta.url);
const build = await import('../scripts/build-yesplaymusic.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
let bridge = {};
try { bridge = require('../runtime/yesplaymusic/bridge.cjs'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const cookies = await import('../runtime/yesplaymusic/cookies.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const transport = await import('../runtime/yesplaymusic/transport.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(String(key)) ?? null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
  };
}

function sourceFixture(extra = {}) {
  const commit = 'a'.repeat(40);
  const prefix = `YesPlayMusic-${commit}/`;
  const entries = {
    'src/main.js': 'new Vue()',
    'src/App.vue': '<template><main /></template>',
    'public/index.html': '<div id="app"></div>',
    'package.json': '{"version":"0.4.10"}',
    'babel.config.js': 'module.exports = {}',
    LICENSE: 'MIT License',
    ...extra,
  };
  const archive = zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [prefix + name, strToU8(value)])));
  const source = { commit, sha256: createHash('sha256').update(archive).digest('hex') };
  return { archive, source };
}

test('a changed source archive is rejected before extraction', () => {
  assert.equal(typeof build.verifySourceArchive, 'function');
  const { archive, source } = sourceFixture();
  build.verifySourceArchive(archive, source);
  const changed = archive.slice();
  changed[30] ^= 1;
  assert.throws(() => build.verifySourceArchive(changed, source), /checksum/i);
});

test('source extraction includes web inputs and excludes server, hidden and private files', () => {
  assert.equal(typeof build.extractSourceFiles, 'function');
  const { archive, source } = sourceFixture({
    'src/views/home.vue': '<template />',
    'src/background.js': 'electron',
    'src/ncmModDef.js': 'server',
    'src/electron/services.js': 'server',
    '.env': 'private',
    'public/.env': 'private',
    'public/_redirects': '/* /index.html 200',
    'docs/token.txt': 'private',
    'public/img/logos/yesplaymusic.png': 'image',
  });
  const files = build.extractSourceFiles(archive, source);
  assert.equal(files['src/views/home.vue'].toString(), '<template />');
  assert.equal(files['public/img/logos/yesplaymusic.png'].toString(), 'image');
  for (const key of ['src/background.js', 'src/ncmModDef.js', 'src/electron/services.js', '.env', 'public/.env', 'public/_redirects', 'docs/token.txt']) {
    assert.equal(files[key], undefined, key);
  }
});

test('source archive traversal is rejected, including Windows separators', () => {
  assert.equal(typeof build.extractSourceFiles, 'function');
  for (const name of ['src/../../escape.js', 'src/..\\escape.js', 'public/img/C:escape.png']) {
    const { archive, source } = sourceFixture({ [name]: 'escape' });
    assert.throws(() => build.extractSourceFiles(archive, source), /unsafe.*path/i);
  }
});

test('public build validation rejects maps, source files and oversized assets', () => {
  assert.equal(typeof build.validatePublicFiles, 'function');
  build.validatePublicFiles({ 'index.html': Buffer.from('<div />'), 'js/app.js': Buffer.from('app();') });
  for (const name of ['js/app.js.map', 'src/private.js', 'package.json', '.env', '../escape.js']) {
    assert.throws(() => build.validatePublicFiles({ [name]: Buffer.from('x') }), /public|unsafe/i);
  }
  assert.throws(() => build.validatePublicFiles({ 'js/app.js': Buffer.alloc(25 * 1024 * 1024 + 1) }), /25 MiB/);
});

test('profile paths remain within their own router base and reject encoded or malformed identities', () => {
  assert.equal(typeof bridge.parseProfilePath, 'function');
  assert.deepEqual(bridge.parseProfilePath('/yesplaymusic/profiles/alice-1/search/test'), {
    profile: 'alice-1', basePath: '/yesplaymusic/profiles/alice-1/',
  });
  assert.deepEqual(bridge.parseProfilePath('/yesplaymusic/'), {
    profile: 'default', basePath: '/yesplaymusic/profiles/default/',
  });
  for (const path of ['/other/profiles/alice/', '/yesplaymusic/profiles//', '/yesplaymusic/profiles/Alice/', '/yesplaymusic/profiles/%2e%2e/', '/yesplaymusic/profiles/../', '/yesplaymusic/profiles/' + 'a'.repeat(65) + '/']) {
    assert.throws(() => bridge.parseProfilePath(path), /profile/i, path);
  }
});

test('storage methods, property access and clear expose only the selected profile', () => {
  assert.equal(typeof bridge.createProfileStorage, 'function');
  const native = memoryStorage();
  native.setItem('minecraft-world', 'keep');
  const alice = bridge.createProfileStorage(native, 'alice');
  const bob = bridge.createProfileStorage(native, 'bob');
  alice.setItem('settings', 'dark');
  alice.volume = 0.75;
  bob.setItem('settings', 'light');
  assert.equal(alice.getItem('settings'), 'dark');
  assert.equal(alice.volume, '0.75');
  assert.equal(alice.getItem('absent'), null);
  assert.equal(alice.length, 2);
  assert.deepEqual(Object.keys(alice), ['settings', 'volume']);
  assert.equal(alice.key(1), 'volume');
  assert.equal(alice.key(2), null);
  delete alice.volume;
  alice.clear();
  assert.equal(alice.length, 0);
  assert.equal(bob.settings, 'light');
  assert.equal(native.getItem('minecraft-world'), 'keep');
});

test('IndexedDB open, delete and enumeration use only the selected profile', async () => {
  assert.equal(typeof bridge.createProfileIndexedDB, 'function');
  const names = new Map([['minecraft', 1]]);
  const factory = {
    open(name, version) { names.set(name, version ?? 1); return { name, version }; },
    deleteDatabase(name) { names.delete(name); },
    async databases() { return [...names].map(([name, version]) => ({ name, version })); },
    cmp(a, b) { return a - b; },
  };
  const alice = bridge.createProfileIndexedDB(factory, 'alice');
  const bob = bridge.createProfileIndexedDB(factory, 'bob');
  alice.open('yesplaymusic', 4);
  bob.open('yesplaymusic', 4);
  assert.equal(names.size, 3);
  assert.deepEqual(await alice.databases(), [{ name: 'yesplaymusic', version: 4 }]);
  alice.deleteDatabase('yesplaymusic');
  assert.equal(names.size, 2);
  assert.deepEqual(await bob.databases(), [{ name: 'yesplaymusic', version: 4 }]);
  assert.equal(alice.cmp(4, 2), 2);
});

test('parent trust requires an exact configured HTTPS origin or local loopback pair', () => {
  assert.equal(typeof bridge.isTrustedParent, 'function');
  assert.equal(bridge.isTrustedParent('https://desktop.example', 'https://desktop.example', 'https://apps.example'), true);
  assert.equal(bridge.isTrustedParent('https://desktop.example.evil', 'https://desktop.example', 'https://apps.example'), false);
  assert.equal(bridge.isTrustedParent('https://desktop.example/path', 'https://desktop.example', 'https://apps.example'), false);
  assert.equal(bridge.isTrustedParent('http://desktop.example', 'http://desktop.example', 'https://apps.example'), false);
  assert.equal(bridge.isTrustedParent('http://127.0.0.1:8788', 'https://desktop.example', 'http://127.0.0.1:8789'), true);
  assert.equal(bridge.isTrustedParent('http://127.0.0.1:8788', 'https://desktop.example', 'https://apps.example'), false);
});

test('authentication parses cookie attributes without shared cookies and preserves equals in values', () => {
  assert.equal(typeof cookies.storeCookies, 'function');
  const storage = memoryStorage();
  cookies.storeCookies(storage, 'MUSIC_U=abc==; Path=/; HttpOnly;;__csrf=xyz; Secure;;expired=gone; Max-Age=0');
  assert.equal(cookies.getStoredCookie(storage, 'MUSIC_U'), 'abc==');
  assert.equal(cookies.getStoredCookie(storage, 'absent'), undefined);
  assert.equal(cookies.getStoredCookie(storage, 'expired'), undefined);
  assert.equal(cookies.cookieHeader(storage), 'MUSIC_U=abc==; __csrf=xyz');
  cookies.storeCookies(storage, 'bad=name\r\nCookie:evil;;MUSIC_U=; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  assert.equal(cookies.getStoredCookie(storage, 'MUSIC_U'), undefined);
  assert.equal(cookies.cookieHeader(storage), '__csrf=xyz');
});

test('API preparation keeps login credentials out of the URL and omits HTTP cookies', () => {
  assert.equal(typeof transport.prepareMusicRequest, 'function');
  const storage = memoryStorage();
  storage.setItem('cookie-MUSIC_U', 'alice-session');
  const result = transport.prepareMusicRequest({ url: '/login/cellphone', params: { phone: 'test-user', md5_password: 'test-secret' } }, '/yesplaymusic/profiles/alice/', storage);
  assert.equal(result.url, '/yesplaymusic/profiles/alice/api/login/cellphone');
  assert.equal(result.options.method, 'POST');
  assert.equal(result.options.credentials, 'omit');
  assert.equal(result.options.headers['X-YesPlayMusic-Cookie'], 'MUSIC_U=alice-session');
  assert.deepEqual(JSON.parse(result.options.body), { phone: 'test-user', md5_password: 'test-secret' });
  assert.throws(() => transport.prepareMusicRequest({ url: 'https://evil.example/login', params: {} }, '/yesplaymusic/profiles/alice/', storage), /endpoint/i);
});

test('cloud uploads retain multipart file data and move parameters out of query strings', () => {
  assert.equal(typeof transport.prepareMusicRequest, 'function');
  const form = new FormData();
  form.set('songFile', new Blob(['audio'], { type: 'audio/mpeg' }), 'song.mp3');
  const result = transport.prepareMusicRequest({ url: '/cloud', data: form, params: { timestamp: 123 }, headers: { 'Content-Type': 'multipart/form-data' } }, '/yesplaymusic/profiles/default/', memoryStorage());
  assert.equal(result.url, '/yesplaymusic/profiles/default/api/cloud');
  assert.equal(result.options.body.get('timestamp'), '123');
  assert.equal(result.options.body.get('songFile').name, 'song.mp3');
  assert.equal(result.options.headers['Content-Type'], undefined);
});

test('large playlists use bounded song-detail batches and retain every response and profile cookie', async () => {
  const storage = memoryStorage();
  const requests = [];
  const ids = [...Array(1000).fill('7'), '42'].join(',');
  const result = await transport.musicRequest({ url: '/song/detail', params: { ids, timestamp: 123 } }, '/yesplaymusic/profiles/alice/', storage, async (url, options) => {
    const params = JSON.parse(options.body);
    requests.push({ url, params, cookie: options.headers['X-YesPlayMusic-Cookie'] });
    const ids = params.ids.split(',');
    if (ids.length > 1000) return new Response(JSON.stringify({ code: 400, msg: 'Too many song IDs' }), { status: 400 });
    const id = Number(ids[0]);
    return new Response(JSON.stringify({ code: 200, songs: [{ id }], privileges: [{ id, pl: 320000 }], cookie: 'NMTID=profile-device; Path=/; HttpOnly' }));
  });
  assert.deepEqual(result.songs, [{ id: 7 }, { id: 42 }]);
  assert.deepEqual(result.privileges, [{ id: 7, pl: 320000 }, { id: 42, pl: 320000 }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params.ids.split(',').length, 1000);
  assert.equal(requests[1].params.ids, '42');
  assert.equal(requests[1].params.timestamp, 123);
  assert.equal(requests[1].url, '/yesplaymusic/profiles/alice/api/song/detail');
  assert.equal(requests[1].cookie, 'NMTID=profile-device');
  assert.equal(storage.getItem('cookie-NMTID'), 'profile-device');
});

test('the compiled upstream app mounts, navigates and keeps real browser storage isolated', {
  skip: process.env.YESPLAYMUSIC_BROWSER !== '1', timeout: 90000,
}, async () => {
  const { chromium, expect } = await import('@playwright/test');
  const directory = resolve('runtime/dist/yesplaymusic');
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  const image = await readFile(resolve(directory, 'img/logos/yesplaymusic.png'));
  const calls = [];
  const errors = [];
  let origin;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      const cover = origin + '/yesplaymusic/img/logos/yesplaymusic.png';
      const artist = { id: 10, name: 'Fixture artist', picUrl: cover };
      const album = { id: 20, name: 'Fixture album', picUrl: cover };
      const track = { id: 12345, name: '构建验证曲目', ar: [artist], artists: [artist], al: album, album, dt: 60000, duration: 60000, fee: 0, no: 1 };
      const endpoint = /^\/yesplaymusic\/profiles\/([a-z0-9_-]+)\/api\/(.*)$/.exec(url.pathname);
      if (endpoint) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        calls.push({ profile: endpoint[1], endpoint: endpoint[2], method: request.method, search: url.search, cookie: request.headers.cookie, session: request.headers['x-yesplaymusic-cookie'], params });
        const fixtures = {
          personal_fm: { data: [track, { ...track, id: 12346 }] },
          personalized: { result: [] },
          'album/new': { albums: [] },
          'toplist/artist': { list: { artists: [] } },
          toplist: { list: [] },
          'song/detail': { songs: [track], privileges: [{ id: 12345, pl: 320000, st: 0, fee: 0 }] },
          'song/url': { data: [{ id: params.id, url: params.id === 0 ? null : 'https://media.example/fixture.mp3', br: 320000, freeTrialInfo: params.id === 2 ? { start: 0, end: 30 } : null }] },
          search: { result: params.type === 1 ? { songs: [track], songCount: 1 } : {} },
          'login/qr/key': { data: { unikey: 'build-verification-key' } },
          'login/qr/check': { code: 801 },
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 200, ...fixtures[endpoint[2]] }));
        return;
      }
      if (url.pathname === '/runtime-policy.json') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ desktopOrigin: 'https://desktop.example' }));
        return;
      }
      if (url.pathname === '/harness') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><script>window.reports=[];addEventListener("message",e=>reports.push(e.data));</script><main></main>');
        return;
      }
      const name = url.pathname.startsWith('/yesplaymusic/profiles/') ? 'index.html' : url.pathname.replace(/^\/yesplaymusic\//, '');
      if (!Object.hasOwn(manifest.files, name)) { response.writeHead(404); response.end('Not found'); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
      response.writeHead(200, { 'Content-Type': types[extname(name)] || 'application/octet-stream' });
      response.end(await readFile(resolve(directory, name)));
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 960 } });
  try {
    await context.addCookies([{ name: 'MUSIC_U', value: 'shared-cookie-must-not-leak', url: origin }]);
    await context.addInitScript(() => {
      Object.defineProperty(Document.prototype, 'cookie', {
        get() { throw new Error('Shared document.cookie was read'); },
        set() { throw new Error('Shared document.cookie was written'); },
      });
    });
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      if (route.request().resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: image, headers: { 'Access-Control-Allow-Origin': '*' } });
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/harness');
    await page.evaluate(() => localStorage.setItem('minecraft-world', 'keep'));
    async function frame(profile) {
      await page.evaluate(({ origin, profile }) => {
        const node = document.createElement('iframe');
        node.id = profile;
        node.style.cssText = 'width:1360px;height:880px;border:0';
        node.src = origin + '/yesplaymusic/profiles/' + profile + '/#' + new URLSearchParams({ parent: origin, channel: profile + '-verification-channel' });
        document.querySelector('main').append(node);
      }, { origin, profile });
      const child = page.frameLocator('#' + profile);
      try { await expect(child.locator('.home')).toBeVisible({ timeout: 30000 }); }
      catch (error) {
        await mkdir('.private/yesplaymusic-qa', { recursive: true });
        await page.screenshot({ path: '.private/yesplaymusic-qa/boot-failure.png' });
        throw new Error(error.message + '\nBrowser errors: ' + JSON.stringify(errors) + '\nRuntime reports: ' + JSON.stringify(await page.evaluate(() => reports)));
      }
      return child;
    }
    const alice = await frame('alice');
    await expect.poll(() => page.evaluate(() => reports.some(item => item.app === 'yesplaymusic' && item.phase === 'running' && item.channel === 'alice-verification-channel'))).toBe(true);
    assert.deepEqual(await alice.locator('body').evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('settings'));
      return { language: settings.lang, appearance: settings.appearance, hash: location.hash, profile: window.__ARISAKA_MUSIC__.profile };
    }), { language: 'zh-CN', appearance: 'dark', hash: '', profile: 'alice' });
    const sources = await alice.locator('body').evaluate(async () => {
      const player = window.yesplaymusic.player;
      return Promise.all([12345, 0, 2].map(id => player._getAudioSourceFromNetease({ id })));
    });
    assert.deepEqual(sources, ['https://media.example/fixture.mp3', null, null]);
    await alice.locator('nav .avatar').click();
    await alice.getByText('设置', { exact: true }).click();
    await expect(alice.locator('.settings-page')).toBeVisible();
    await expect(alice.locator('.settings-page select').first()).toHaveValue('zh-CN');
    await expect(alice.getByRole('button', { name: '授权连接', exact: true })).toHaveCount(0);
    await expect(alice.getByText('连接 Last.fm', { exact: true })).toHaveCount(0);
    await alice.locator('nav .avatar').click();
    await alice.getByText('登录', { exact: true }).click();
    await expect(alice.getByText('登录网易云账号', { exact: true })).toBeVisible();
    await alice.getByRole('link', { name: '首页', exact: true }).click();
    await expect(alice.locator('.home')).toBeVisible();
    await alice.locator('body').evaluate(() => {
      const app = document.querySelector('#app').__vue__;
      app.$store.commit('updateSettings', { key: 'musicQuality', value: 128000 });
      localStorage.setItem('cookie-MUSIC_U', 'alice-only');
      sessionStorage.setItem('session-check', 'alice-only');
    });
    await mkdir('.private/yesplaymusic-qa', { recursive: true });
    await page.locator('#alice').screenshot({ path: '.private/yesplaymusic-qa/home.png' });
    await alice.locator('input[type="search"]').fill('fixture');
    await alice.locator('input[type="search"]').press('Enter');
    await expect(alice.getByText('构建验证曲目', { exact: true })).toBeVisible();
    assert.match(await alice.locator('body').evaluate(() => location.pathname), /^\/yesplaymusic\/profiles\/alice\/search\/fixture$/);
    assert(calls.some(call => call.endpoint === 'search' && call.session === 'MUSIC_U=alice-only' && call.params.keywords === 'fixture'));
    assert(calls.every(call => call.method === 'POST' && call.search === '' && call.cookie === undefined));

    const bob = await frame('bob');
    assert.deepEqual(await bob.locator('body').evaluate(() => ({ cookie: localStorage.getItem('cookie-MUSIC_U'), session: sessionStorage.getItem('session-check'), quality: JSON.parse(localStorage.getItem('settings')).musicQuality })), { cookie: null, session: null, quality: 320000 });
    const aliceDB = await alice.locator('body').evaluate(() => indexedDB.databases());
    assert(aliceDB.some(db => db.name === 'yesplaymusic'));
    assert.deepEqual(await bob.locator('body').evaluate(() => indexedDB.databases()), []);
    // Dexie creates its database lazily when the first song is cached.
    await bob.locator('input[type="search"]').fill('bob-fixture');
    await bob.locator('input[type="search"]').press('Enter');
    await expect(bob.getByText('构建验证曲目', { exact: true })).toBeVisible();
    await expect.poll(() => bob.locator('body').evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'yesplaymusic'))).toBe(true);
    await page.locator('#alice').evaluate(node => node.remove());
    const reopened = await frame('alice');
    assert.equal(await reopened.locator('body').evaluate(() => JSON.parse(localStorage.getItem('settings')).musicQuality), 128000);
    await reopened.locator('body').evaluate(() => window.resetApp());
    assert.equal(await bob.locator('body').evaluate(() => JSON.parse(localStorage.getItem('settings')).musicQuality), 320000);
    assert((await bob.locator('body').evaluate(() => indexedDB.databases())).some(db => db.name === 'yesplaymusic'));
    assert.equal(await page.evaluate(() => localStorage.getItem('minecraft-world')), 'keep');
    assert.equal(await bob.locator('body').evaluate(() => navigator.serviceWorker.getRegistrations().then(items => items.length)), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
