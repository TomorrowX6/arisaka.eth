import { createDecipheriv, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, expect, test, vi } from 'vitest';
import { handleMusicApi } from '../runtime/music-api';
import { requestMusic } from '../runtime/music-transport';

const base = 'https://apps.example/yesplaymusic/profiles/default/api';

function jsonRequest(endpoint: string, data: unknown, headers: Record<string, string> = {}) {
  return new Request(base + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
}

function upstream(body: unknown = { code: 200 }, headers: HeadersInit = {}, status = 200) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(body, { headers, status });
  });
  return requests;
}

async function eapiData(request: Request) {
  const params = new URLSearchParams(Buffer.from(await request.arrayBuffer()).toString()).get('params')!;
  const cipher = createDecipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), Buffer.alloc(0));
  const clear = Buffer.concat([cipher.update(Buffer.from(params, 'hex')), cipher.final()]).toString();
  const [uri, data, digest] = clear.split('-36cd479b6b5-');
  expect(digest).toBe(createHash('md5').update('nobody' + uri + 'use' + data + 'md5forencrypt').digest('hex'));
  return { uri, data: JSON.parse(data) };
}

function fixedEntropy() {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(buffer => {
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).fill(1);
    return buffer;
  });
}

async function weapiData(request: Request) {
  const form = new URLSearchParams(Buffer.from(await request.arrayBuffer()).toString());
  // Independent RSA_NO_PADDING fixture generated with Node/OpenSSL from the public protocol key.
  expect(form.get('encSecKey')).toBe('3b7a4694932b6db908cfc056bd1a171cb6321f9b4bf2a0ca496f05ab7cf5a58f57cff717bf5c81a6660f39a7d32250667b25fd8541bdd6433a73898f6fa5bab0e9baf4489128f850f5308e32e11a6f47cb4c56fdfb88801a4bda336f3d33238bd33696d698a8f1c32869e4973f540ef10ce73329f0f9e6a81d3e7de928b7107f');
  const outer = createDecipheriv('aes-128-cbc', Buffer.from('0101010101010101'), Buffer.from('0102030405060708'));
  const innerText = Buffer.concat([outer.update(Buffer.from(form.get('params')!, 'base64')), outer.final()]).toString();
  const inner = createDecipheriv('aes-128-cbc', Buffer.from('0CoJUm6Qyw8W8jud'), Buffer.from('0102030405060708'));
  return JSON.parse(Buffer.concat([inner.update(Buffer.from(innerText, 'base64')), inner.final()]).toString());
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test('the eapi transport encrypts successfully in workerd', async () => {
  upstream({ code: 200 });
  const result = await requestMusic({ uri: '/api/search/get', mode: 'eapi', data: { s: 'test' } }, {}, new AbortController().signal);
  expect(result.status).toBe(200);
});

test('unknown music routes cannot fetch arbitrary upstream endpoints', async () => {
  const requests = upstream();
  for (const endpoint of ['/not-allowed', '/api/../../login', '/search/extra', '//music.163.com/api/search/get']) {
    const response = await handleMusicApi(new Request(base + endpoint), endpoint);
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  }
  expect(requests).toHaveLength(0);
});

test('only GET and bounded JSON POST requests are accepted', async () => {
  const requests = upstream();
  const put = await handleMusicApi(new Request(base + '/search', { method: 'PUT' }), '/search');
  expect(put.status).toBe(405);
  const wrongType = await handleMusicApi(new Request(base + '/search', { method: 'POST', body: 'keywords=test' }), '/search');
  expect(wrongType.status).toBe(415);
  for (const body of ['{', '[]', 'null']) {
    const response = await handleMusicApi(new Request(base + '/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }), '/search');
    expect(response.status).toBe(400);
  }
  const tooLarge = await handleMusicApi(jsonRequest('/search', { keywords: 'a'.repeat(70_000) }), '/search');
  expect(tooLarge.status).toBe(413);
  expect(requests).toHaveLength(0);
});

test('transport overrides and body or query credentials are rejected before fetching', async () => {
  const requests = upstream();
  for (const key of ['proxy', 'domain', 'headers', 'header', 'crypto', 'cookie', 'realIP', 'ua', 'url', 'uri', 'timeout', '__proto__']) {
    const response = await handleMusicApi(jsonRequest('/search', { keywords: 'test', [key]: 'https://outside.example' }), '/search');
    expect(response.status, key).toBe(400);
  }
  expect((await handleMusicApi(new Request(base + '/search?keywords=test&cookie=MUSIC_U%3Dquery'), '/search')).status).toBe(400);
  expect(requests).toHaveLength(0);
});

test('search uses the fixed encrypted NetEase route with GET query semantics', async () => {
  const requests = upstream({ code: 200, result: { songs: [{ id: 347230, name: 'Song fixture' }], songCount: 1 } });
  const response = await handleMusicApi(new Request(base + '/search?keywords=hello%20world&type=1&limit=3&offset=0&timestamp=123'), '/search');
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect((await response.json() as { result: { songCount: number } }).result.songCount).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('https://interfacepc.music.163.com/eapi/search/get');
  expect(requests[0].redirect).toBe('manual');
  expect(requests[0].method).toBe('POST');
  const decoded = await eapiData(requests[0]);
  expect(decoded.uri).toBe('/api/search/get');
  expect(decoded.data).toMatchObject({ s: 'hello world', type: 1, limit: 3, offset: 0, e_r: false });
});

test('profile credentials come only from the request header and never leak to another request', async () => {
  const requests = upstream();
  const headerRequest = jsonRequest('/search', { keywords: 'first' }, { 'X-YesPlayMusic-Cookie': 'MUSIC_U=profile-one;;__csrf=csrf-one' });
  const browserCookieRequest = jsonRequest('/search', { keywords: 'second' }, { Cookie: 'MUSIC_U=shared-browser' });
  expect((await handleMusicApi(headerRequest, '/search')).status).toBe(200);
  expect((await handleMusicApi(browserCookieRequest, '/search')).status).toBe(200);
  expect(requests).toHaveLength(2);
  const first = await eapiData(requests[0]);
  const second = await eapiData(requests[1]);
  expect(first.data.header).toMatchObject({ MUSIC_U: 'profile-one', __csrf: 'csrf-one' });
  expect(requests[0].headers.get('Cookie')).toContain('MUSIC_U=profile-one');
  expect(second.data.header.MUSIC_U).toBeUndefined();
  expect(requests[1].headers.get('Cookie')).not.toMatch(/profile-one|shared-browser/);
});

test('QR keys preserve the frontend envelope and QR polling codes remain successful HTTP responses', async () => {
  const requests = upstream({ code: 200, unikey: 'public-qr-key' });
  const key = await handleMusicApi(jsonRequest('/login/qr/key', {}), '/login/qr/key');
  expect(key.status).toBe(200);
  expect(await key.json()).toMatchObject({ code: 200, data: { code: 200, unikey: 'public-qr-key' } });
  expect(requests).toHaveLength(1);
  expect((await eapiData(requests[0])).uri).toBe('/api/login/qrcode/unikey');
  vi.restoreAllMocks();
  upstream({ code: 801, message: 'Waiting for scan' });
  const poll = await handleMusicApi(jsonRequest('/login/qr/check', { key: 'public-qr-key' }), '/login/qr/check');
  expect(poll.status).toBe(200);
  expect(await poll.json()).toMatchObject({ code: 801, message: 'Waiting for scan' });
});

test('login cookies are returned in JSON separated by double semicolons without setting browser cookies', async () => {
  const headers = new Headers();
  headers.append('Set-Cookie', 'MUSIC_U=profile-token; Domain=.music.163.com; Path=/; HttpOnly');
  headers.append('Set-Cookie', '__csrf=profile-csrf; Domain=.music.163.com; Path=/');
  upstream({ code: 803, message: 'Authorized' }, headers);
  const response = await handleMusicApi(jsonRequest('/login/qr/check', { key: 'public-qr-key' }), '/login/qr/check');
  expect(response.status).toBe(200);
  expect(response.headers.has('Set-Cookie')).toBe(false);
  expect((await response.json() as { cookie: string }).cookie).toBe('MUSIC_U=profile-token; Path=/; HttpOnly;;__csrf=profile-csrf; Path=/');
});

test('only the cloud lyrics URI and fields are accepted through the legacy api endpoint', async () => {
  const requests = upstream({ code: 200, lrc: { lyric: 'Cloud lyric fixture' } });
  const rejected = [
    { uri: '/api/logout' },
    { uri: 'https://outside.example/api/cloud/lyric/get' },
    { uri: '/api/cloud/lyric/get', data: { songId: 1, userId: 2, cookie: 'MUSIC_U=injected' } },
  ];
  for (const data of rejected) expect((await handleMusicApi(jsonRequest('/api', data), '/api')).status).toBe(400);
  expect(requests).toHaveLength(0);
  const response = await handleMusicApi(jsonRequest('/api', { uri: '/api/cloud/lyric/get', data: { songId: 1, userId: 2, lv: '-1', kv: '-1' } }), '/api');
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect((await eapiData(requests[0])).data).toMatchObject({ songId: '1', userId: '2', lv: -1, kv: -1 });
});

test('upstream account and HTTP errors retain their real codes without credentials or fake success', async () => {
  upstream({ code: 301, msg: '需要登录' });
  const account = await handleMusicApi(jsonRequest('/recommend/songs', {}), '/recommend/songs');
  expect(account.status).toBe(401);
  expect(await account.json()).toMatchObject({ code: 301, msg: '需要登录' });
  vi.restoreAllMocks();
  upstream({ code: 429, message: 'Too many requests' }, {}, 429);
  const limited = await handleMusicApi(jsonRequest('/search', { keywords: 'test' }), '/search');
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ code: 429, message: 'Too many requests' });
});

const webEndpoints: [string, Record<string, unknown>, string, 'weapi' | 'eapi', Record<string, unknown>][] = [
  ['/personalized', { limit: 3 }, '/api/personalized/playlist', 'weapi', { limit: 3, total: true, n: 1000 }],
  ['/song/detail', { ids: '347230, 347231' }, '/api/v3/song/detail', 'weapi', { c: '[{"id":347230},{"id":347231}]' }],
  ['/lyric', { id: 347230 }, '/api/song/lyric', 'eapi', { id: '347230', lv: -1, tv: -1, rv: -1, kv: -1 }],
  ['/album', { id: 1 }, '/api/v1/album/1', 'weapi', {}],
  ['/album/new', { area: 'JP', limit: 2, offset: 3 }, '/api/album/new', 'weapi', { area: 'JP', limit: 2, offset: 3, total: true }],
  ['/album/detail/dynamic', { id: 1 }, '/api/album/detail/dynamic', 'weapi', { id: '1' }],
  ['/album/sub', { id: 1, t: 1 }, '/api/album/sub', 'weapi', { id: '1' }],
  ['/artists', { id: 1 }, '/api/v1/artist/1', 'weapi', {}],
  ['/artist/album', { id: 1, limit: 2 }, '/api/artist/albums/1', 'weapi', { limit: 2, offset: 0, total: true }],
  ['/toplist/artist', { type: 2 }, '/api/toplist/artist', 'weapi', { type: 2, limit: 100 }],
  ['/artist/mv', { id: 1, limit: 5, offset: 2 }, '/api/artist/mvs', 'weapi', { artistId: '1', limit: 5, offset: 2 }],
  ['/artist/sub', { id: 1, t: 0 }, '/api/artist/unsub', 'weapi', { artistId: '1', artistIds: '[1]' }],
  ['/simi/artist', { id: 1 }, '/api/discovery/simiArtist', 'weapi', { artistid: '1' }],
  ['/mv/detail', { mvid: 1 }, '/api/v1/mv/detail', 'weapi', { id: '1' }],
  ['/mv/url', { id: 1 }, '/api/song/enhance/play/mv/url', 'weapi', { id: '1', r: 1080 }],
  ['/simi/mv', { mvid: 1 }, '/api/discovery/simiMV', 'weapi', { mvid: '1' }],
  ['/mv/sub', { mvid: 1, t: 1 }, '/api/mv/sub', 'weapi', { mvId: '1', mvIds: '["1"]' }],
  ['/personal_fm', {}, '/api/v1/radio/get', 'weapi', {}],
  ['/fm_trash', { id: 1 }, '/api/radio/trash/add', 'weapi', { songId: '1', alg: 'RT', time: 25 }],
  ['/recommend/resource', { params: { limit: 10 } }, '/api/v1/discovery/recommend/resource', 'weapi', {}],
  ['/playlist/detail', { id: 1 }, '/api/v6/playlist/detail', 'eapi', { id: '1', n: 100000, s: 8 }],
  ['/top/playlist/highquality', { cat: 'ACG', before: 123 }, '/api/playlist/highquality/list', 'weapi', { cat: 'ACG', limit: 50, lasttime: 123, total: true }],
  ['/top/playlist', { order: 'new' }, '/api/playlist/list', 'weapi', { order: 'new', cat: '全部', limit: 50, offset: 0 }],
  ['/playlist/catlist', {}, '/api/playlist/catalogue', 'eapi', {}],
  ['/toplist', {}, '/api/toplist', 'eapi', {}],
  ['/playlist/subscribe', { id: 1, t: 2 }, '/api/playlist/unsubscribe', 'eapi', { id: '1' }],
  ['/playlist/delete', { id: '1,2' }, '/api/playlist/remove', 'weapi', { ids: '[1,2]' }],
  ['/playlist/create', { name: 'My playlist' }, '/api/playlist/create', 'weapi', { name: 'My playlist', privacy: '0', type: 'NORMAL' }],
  ['/playlist/tracks', { pid: 1, tracks: '2,3', op: 'add' }, '/api/playlist/manipulate/tracks', 'eapi', { op: 'add', pid: '1', trackIds: '["2","3"]', imme: 'true' }],
  ['/recommend/songs', {}, '/api/v3/discovery/recommend/songs', 'weapi', {}],
  ['/playmode/intelligence/list', { id: 1, pid: 2 }, '/api/playmode/intelligence/list', 'eapi', { songId: '1', playlistId: '2', startMusicId: '1', count: 1 }],
  ['/top/song', { type: 7 }, '/api/v1/discovery/new/songs', 'weapi', { areaId: 7, total: true }],
  ['/like', { id: 1, like: false }, '/api/radio/like', 'weapi', { trackId: '1', like: false, alg: 'itembased', time: '3' }],
  ['/user/detail', { uid: 1 }, '/api/v1/user/detail/1', 'weapi', {}],
  ['/user/account', {}, '/api/nuser/account/get', 'weapi', {}],
  ['/user/playlist', { uid: 1 }, '/api/user/playlist', 'weapi', { uid: '1', limit: 30, offset: 0, includeVideo: true }],
  ['/user/record', { uid: 1, type: 1 }, '/api/v1/play/record', 'weapi', { uid: '1', type: 1 }],
  ['/likelist', { uid: 1 }, '/api/song/like/get', 'eapi', { uid: '1' }],
  ['/daily_signin', { type: 1 }, '/api/point/dailyTask', 'eapi', { type: 1 }],
  ['/album/sublist', {}, '/api/album/sublist', 'weapi', { limit: 25, offset: 0, total: true }],
  ['/artist/sublist', {}, '/api/artist/sublist', 'weapi', { limit: 25, offset: 0, total: true }],
  ['/mv/sublist', {}, '/api/cloudvideo/allvideo/sublist', 'weapi', { limit: 25, offset: 0, total: true }],
  ['/user/cloud', { limit: 200 }, '/api/v1/cloud/get', 'weapi', { limit: 200, offset: 0 }],
  ['/user/cloud/detail', { id: '1,2' }, '/api/v1/cloud/get/byids', 'weapi', { songIds: ['1', '2'] }],
  ['/user/cloud/del', { id: [1, 2] }, '/api/cloud/del', 'weapi', { songIds: ['1', '2'] }],
  ['/login', { email: 'test@example.com', password: 'test-password' }, '/api/w/login', 'eapi', { username: 'test@example.com', password: 'dfb450efddbb5387197c84460623675b' }],
  ['/login/cellphone', { phone: '12345678900', password: 'test-password' }, '/api/w/login/cellphone', 'weapi', { phone: '12345678900', countrycode: '86', password: 'dfb450efddbb5387197c84460623675b' }],
  ['/login/refresh', {}, '/api/login/token/refresh', 'eapi', {}],
  ['/logout', {}, '/api/logout', 'eapi', {}],
];

test.each(webEndpoints)('%s preserves its web endpoint contract', async (endpoint, params, uri, mode, fields) => {
  fixedEntropy();
  const requests = upstream({ code: 200 });
  const response = await handleMusicApi(jsonRequest(endpoint, params), endpoint);
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe((mode === 'weapi' ? 'https://music.163.com/weapi/' : 'https://interfacepc.music.163.com/eapi/') + uri.slice(5));
  const data = mode === 'weapi' ? await weapiData(requests[0]) : (await eapiData(requests[0])).data;
  expect(data).toMatchObject(fields);
});

test.each(['GET', 'POST'])('new albums treats the stock empty area as ALL for %s requests', async method => {
  fixedEntropy();
  const requests = upstream({ code: 200, albums: [] });
  const request = method === 'GET'
    ? new Request(base + '/album/new?area=&limit=10')
    : jsonRequest('/album/new', { area: '', limit: 10 });
  const response = await handleMusicApi(request, '/album/new');
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(await weapiData(requests[0])).toMatchObject({ area: 'ALL', limit: 10 });
});

test.each([['all', 'ALL'], ['aLl', 'ALL'], ['zh', 'ZH'], ['eA', 'EA'], ['kr', 'KR'], ['jp', 'JP']])('new albums normalizes the known area %s to %s', async (area, expected) => {
  fixedEntropy();
  const requests = upstream({ code: 200, albums: [] });
  const response = await handleMusicApi(jsonRequest('/album/new', { area, limit: 10 }), '/album/new');
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(await weapiData(requests[0])).toMatchObject({ area: expected, limit: 10 });
});

test('new albums still rejects nonempty invalid areas and invalid parameter types', async () => {
  const requests = upstream();
  for (const area of ['EU', ' ', 'https://outside.example', false, 0, [], {}]) {
    expect((await handleMusicApi(jsonRequest('/album/new', { area }), '/album/new')).status).toBe(400);
  }
  expect(requests).toHaveLength(0);
});

test('song URL results retain requested ID order and real playability metadata', async () => {
  const requests = upstream({ code: 200, data: [{ id: 2, url: null, freeTrialInfo: null }, { id: 1, url: 'https://m.example/audio.mp3', freeTrialInfo: { start: 0, end: 30 } }] });
  const response = await handleMusicApi(jsonRequest('/song/url', { id: '1,2', br: '128000' }), '/song/url');
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect((await eapiData(requests[0])).data).toMatchObject({ ids: '["1","2"]', br: 128000 });
  expect(await response.json()).toMatchObject({ code: 200, data: [{ id: 1, freeTrialInfo: { start: 0, end: 30 } }, { id: 2, url: null }] });
});

test('QR creation only encodes the fixed login URL and produces a usable image', async () => {
  const requests = upstream();
  const response = await handleMusicApi(jsonRequest('/login/qr/create', { key: 'public-qr-key', qrimg: true }), '/login/qr/create');
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { qrurl: string; qrimg: string } };
  expect(body.data.qrurl).toBe('https://music.163.com/login?codekey=public-qr-key');
  expect(body.data.qrimg).toMatch(/^data:image\/(svg\+xml|png);base64,/);
  expect(body.data.qrimg.length).toBeGreaterThan(100);
  expect(requests).toHaveLength(0);
  expect((await handleMusicApi(jsonRequest('/login/qr/create', { key: 'key&redirect=https://outside.example' }), '/login/qr/create')).status).toBe(400);
});

test('malformed IDs and excessive batches never reach NetEase', async () => {
  const requests = upstream();
  for (const [endpoint, params] of [
    ['/album', { id: '../user/account' }], ['/song/detail', { ids: '1,2];malformed' }],
    ['/song/url', { id: Array.from({ length: 1001 }, (_, i) => i + 1) }], ['/search', { keywords: 'test', limit: 100000 }],
  ] as const) expect((await handleMusicApi(jsonRequest(endpoint, params), endpoint)).status).toBe(400);
  expect(requests).toHaveLength(0);
});

test('redirects and non-JSON upstream responses become bounded gateway errors', async () => {
  for (const fixture of [new Response(null, { status: 302, headers: { Location: 'https://outside.example' } }), new Response('<html>unavailable</html>')]) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fixture);
    const response = await handleMusicApi(jsonRequest('/search', { keywords: 'test' }), '/search');
    expect(response.status).toBe(502);
    expect((await response.json() as { message: string }).message).toMatch(/NetEase|upstream/i);
    vi.restoreAllMocks();
  }
});

test('oversized upstream streams are cancelled instead of buffered without a limit', async () => {
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { cancelled = true; },
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
  const response = await handleMusicApi(jsonRequest('/search', { keywords: 'test' }), '/search');
  expect(response.status).toBe(502);
  expect(cancelled).toBe(true);
  expect(chunks).toBeLessThan(70);
});

test('an upstream request that never completes is aborted within the API timeout', async () => {
  vi.useFakeTimers();
  let aborted = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }));
  const responsePromise = handleMusicApi(jsonRequest('/search', { keywords: 'test' }), '/search');
  await vi.advanceTimersByTimeAsync(15_000);
  const response = await responsePromise;
  expect(response.status).toBe(504);
  expect(aborted).toBe(true);
});

test.each(['/user/playlist', '/album/sublist', '/artist/sublist'])('%s accepts the stock library request for 2000 entries', async endpoint => {
  fixedEntropy();
  const requests = upstream();
  const response = await handleMusicApi(jsonRequest(endpoint, { limit: 2000, ...(endpoint === '/user/playlist' ? { uid: 1 } : {}) }), endpoint);
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(await weapiData(requests[0])).toMatchObject({ limit: 2000 });
});

test('playlist changes return body.code as the stock dialogs require', async () => {
  upstream({ code: 200, trackIds: [2] });
  const response = await handleMusicApi(jsonRequest('/playlist/tracks', { pid: 1, tracks: '2', op: 'add' }), '/playlist/tracks');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ body: { code: 200, trackIds: [2] } });
});

test('playlist error 512 retries the upstream duplicate-ID workaround only once', async () => {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(requests.length === 1 ? { code: 512 } : { code: 200 });
  });
  const response = await handleMusicApi(jsonRequest('/playlist/tracks', { pid: 1, tracks: '2,3', op: 'add' }), '/playlist/tracks');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ body: { code: 200 } });
  expect(requests).toHaveLength(2);
  expect((await eapiData(requests[1])).data).toMatchObject({ trackIds: '["2","3","2","3"]' });
});

function waveFixture(): Buffer {
  const chunk = (name: string, bytes: Buffer) => {
    const header = Buffer.alloc(8); header.write(name); header.writeUInt32LE(bytes.length, 4);
    return Buffer.concat([header, bytes, ...(bytes.length % 2 ? [Buffer.alloc(1)] : [])]);
  };
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1); format.writeUInt16LE(1, 2); format.writeUInt32LE(8000, 4); format.writeUInt32LE(16000, 8); format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14);
  const info = Buffer.concat([Buffer.from('INFO'), chunk('INAM', Buffer.from('Upload fixture\0')), chunk('IART', Buffer.from('Fixture artist\0')), chunk('IPRD', Buffer.from('Fixture album\0'))]);
  const content = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', format), chunk('LIST', info), chunk('data', Buffer.alloc(16))]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(content.length, 4);
  return Buffer.concat([header, content]);
}

function uploadRequest(fields: Record<string, string> = {}, cookie = 'MUSIC_U=upload-profile'): Request {
  const form = new FormData();
  form.append('songFile', new File([waveFixture()], 'my track.wav', { type: 'audio/wav' }));
  form.append('timestamp', '123');
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request(base + '/cloud', { method: 'POST', headers: { 'X-YesPlayMusic-Cookie': cookie }, body: form });
}

function uploadUpstream(storage = 'http://nosup-jd1.127.net', storageStatus = 200) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === '/eapi/cloud/upload/check') return Response.json({ code: 200, needUpload: true, songId: '55' });
    if (url.pathname === '/eapi/nos/token/alloc') return Response.json({ code: 200, result: { resourceId: 'resource-55' } });
    if (url.pathname === '/weapi/nos/token/alloc') return Response.json({ code: 200, result: { objectKey: 'audio/file.wav', token: 'upload-only-token', resourceId: 'resource-55' } });
    if (url.hostname === 'wanproxy.127.net') return Response.json({ upload: [storage] });
    if (url.hostname === 'nosup-jd1.127.net') return Response.json({ offset: waveFixture().length }, { status: storageStatus, headers: storageStatus === 302 ? { Location: 'https://outside.example' } : {} });
    if (url.pathname === '/eapi/upload/cloud/info/v2') return Response.json({ code: 200, songId: '55' });
    if (url.pathname === '/eapi/cloud/pub/v2') return Response.json({ code: 200, privateCloud: { songId: 55 } });
    return Response.json({ code: 500, message: 'Unexpected fixture request' }, { status: 500 });
  });
  return requests;
}

test('cloud upload preserves audio bytes and tags while restricting credentials to the NetEase API', async () => {
  fixedEntropy();
  const requests = uploadUpstream();
  const response = await handleMusicApi(uploadRequest(), '/cloud');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ code: 200, privateCloud: { songId: 55 } });
  expect(requests).toHaveLength(7);
  const uploaded = requests.find(request => new URL(request.url).hostname === 'nosup-jd1.127.net')!;
  expect(uploaded.url).toBe('https://nosup-jd1.127.net/jd-musicrep-privatecloud-audio-public/audio%2Ffile.wav?offset=0&complete=true&version=1.0');
  expect(uploaded.headers.get('x-nos-token')).toBe('upload-only-token');
  expect(uploaded.headers.has('Cookie')).toBe(false);
  expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(waveFixture());
  const discovery = requests.find(request => new URL(request.url).hostname === 'wanproxy.127.net')!;
  expect(discovery.headers.has('Cookie')).toBe(false);
  const metadata = requests.find(request => new URL(request.url).pathname === '/eapi/upload/cloud/info/v2')!;
  expect((await eapiData(metadata)).data).toMatchObject({ song: 'Upload fixture', artist: 'Fixture artist', album: 'Fixture album', filename: 'my track.wav', resourceId: 'resource-55' });
  expect(metadata.headers.get('Cookie')).toContain('MUSIC_U=upload-profile');
});

test('cloud upload refuses hosts outside its fixed NetEase bucket', async () => {
  const requests = uploadUpstream('https://outside.example');
  const response = await handleMusicApi(uploadRequest(), '/cloud');
  expect(response.status).toBe(502);
  expect(requests).toHaveLength(4);
  expect(requests.every(request => new URL(request.url).hostname !== 'outside.example')).toBe(true);
});

test('cloud upload never follows a storage redirect or publishes after upload failure', async () => {
  const requests = uploadUpstream('http://nosup-jd1.127.net', 302);
  const response = await handleMusicApi(uploadRequest(), '/cloud');
  expect(response.status).toBe(502);
  expect(requests).toHaveLength(5);
  expect(requests.at(-1)!.redirect).toBe('manual');
});

test('cloud upload requires profile authentication and bounded multipart fields', async () => {
  const requests = upstream();
  expect((await handleMusicApi(uploadRequest({}, ''), '/cloud')).status).toBe(401);
  expect((await handleMusicApi(uploadRequest({ cookie: 'MUSIC_U=body-token' }), '/cloud')).status).toBe(400);
  const oversized = new Request(base + '/cloud', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=fixture', 'Content-Length': String(18 * 1024 * 1024), 'X-YesPlayMusic-Cookie': 'MUSIC_U=profile' }, body: '--fixture--' });
  expect((await handleMusicApi(oversized, '/cloud')).status).toBe(413);
  expect((await handleMusicApi(new Request(base + '/cloud'), '/cloud')).status).toBe(405);
  expect(requests).toHaveLength(0);
});

test('numeric IDs with leading zeroes become valid numeric JSON in song-detail requests', async () => {
  fixedEntropy();
  const requests = upstream();
  expect((await handleMusicApi(jsonRequest('/song/detail', { ids: '0001,0002' }), '/song/detail')).status).toBe(200);
  expect(await weapiData(requests[0])).toMatchObject({ c: '[{"id":1},{"id":2}]' });
});

test('scrobbling reports the real startplay and play results only to the fixed NetEase log host', async () => {
  const requests = upstream({ code: 200 });
  const response = await handleMusicApi(jsonRequest('/scrobble', { id: 1, sourceid: 2, time: 30 }, { 'X-YesPlayMusic-Cookie': 'MUSIC_U=profile' }), '/scrobble');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ code: 200, details: { startplay: { code: 200 }, play: { code: 200 } } });
  expect(requests).toHaveLength(2);
  expect(requests.map(request => request.url)).toEqual(['https://clientlog.music.163.com/eapi/feedback/weblog', 'https://clientlog.music.163.com/eapi/feedback/weblog']);
  const start = (await eapiData(requests[0])).data;
  const end = (await eapiData(requests[1])).data;
  expect(JSON.parse(start.logs)).toMatchObject([{ action: 'startplay', json: { id: '1', content: 'id=2' } }]);
  expect(JSON.parse(end.logs)).toMatchObject([{ action: 'play', json: { id: '1', sourceId: '2', time: 30 } }]);
});
