import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const prefix = 'minecraft/1.12.2/';

export async function verifyRuntimeDeployment(url, manifest, { desktopOrigin, request = fetch, wait = pause, attempts = 3 } = {}) {
  async function retry(check) {
    let failure;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { return await check(); } catch (error) { failure = error; }
      if (attempt + 1 < attempts) await wait(1500);
    }
    throw new Error('Runtime deployment verification failed: ' + failure?.message, { cause: failure });
  }
  async function get(path) {
    const response = await request(new URL(path, url), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
    if (response.headers.get('Cross-Origin-Opener-Policy') !== 'same-origin'
      || response.headers.get('Cross-Origin-Embedder-Policy') !== 'require-corp'
      || response.headers.get('Cross-Origin-Resource-Policy') !== 'cross-origin') throw new Error(path + ' is missing runtime isolation headers');
    const ancestors = response.headers.get('Content-Security-Policy')?.split(';').map(value => value.trim()).find(value => value.startsWith('frame-ancestors '));
    if (ancestors !== 'frame-ancestors ' + desktopOrigin) throw new Error(path + ' has the wrong framing policy');
    return response;
  }
  await retry(async () => {
    const health = await (await get('health')).json();
    if (!health?.ok || health.app !== manifest.app || health.version !== manifest.version || health.build !== manifest.build) throw new Error('published runtime version does not match');
    const policy = await (await get('runtime-policy.json')).json();
    if (policy?.desktopOrigin !== desktopOrigin) throw new Error('runtime desktop origin does not match');
    const published = await (await get(prefix + 'manifest.json')).json();
    if (!isDeepStrictEqual(published, manifest)) throw new Error('published runtime manifest does not match');
  });
  // Stream one file at a time to check the actual published bytes without
  // retaining both large engines in memory or redownloading successful files.
  for (const [name, expected] of Object.entries(manifest.files)) await retry(async () => {
    const response = await get(prefix + name);
    const type = response.headers.get('Content-Type')?.split(';')[0];
    const expectedTypes = name.endsWith('.js') ? ['text/javascript', 'application/javascript']
      : [name.endsWith('.gz') ? 'application/gzip' : name.endsWith('.html') ? 'text/html'
        : name.endsWith('.css') ? 'text/css' : name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream'];
    if (!expectedTypes.includes(type)) throw new Error(name + ' has the wrong content type');
    if (name.endsWith('.gz') && response.headers.has('Content-Encoding')) throw new Error(name + ' must be served as a gzip file');
    let size = 0;
    const hash = createHash('sha256');
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > expected.size) throw new Error(name + ' is larger than its manifest entry');
      hash.update(chunk);
    }
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error(name + ' checksum does not match');
  });
}

export async function verifyMusicDeployment(url, manifest, { desktopOrigin, request = fetch, wait = pause, attempts = 3 } = {}) {
  async function retry(check) {
    let failure;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { return await check(); } catch (error) { failure = error; }
      if (attempt + 1 < attempts) await wait(1500);
    }
    throw new Error('Music deployment verification failed: ' + failure?.message, { cause: failure });
  }
  async function get(path, options = {}) {
    const response = await request(new URL(path, url), { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(60000), ...options });
    if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
    const embedderPolicy = path === 'runtime-policy.json' ? 'require-corp' : 'credentialless';
    if (response.headers.get('Cross-Origin-Opener-Policy') !== 'same-origin'
      || response.headers.get('Cross-Origin-Embedder-Policy') !== embedderPolicy
      || response.headers.get('Cross-Origin-Resource-Policy') !== 'cross-origin') throw new Error(path + ' is missing music isolation headers');
    const ancestors = response.headers.get('Content-Security-Policy')?.split(';').map(value => value.trim()).find(value => value.startsWith('frame-ancestors '));
    if (ancestors !== 'frame-ancestors ' + desktopOrigin) throw new Error(path + ' has the wrong framing policy');
    return response;
  }
  async function checkFile(path, name, expected) {
    const response = await get(path);
    const extension = name.slice(name.lastIndexOf('.') + 1);
    const types = {
      html: ['text/html'], js: ['text/javascript', 'application/javascript'], css: ['text/css'], txt: ['text/plain'],
      svg: ['image/svg+xml'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], gif: ['image/gif'], webp: ['image/webp'],
      ico: ['image/x-icon', 'image/vnd.microsoft.icon'], woff: ['font/woff', 'application/font-woff'],
      woff2: ['font/woff2'], ttf: ['font/ttf', 'application/x-font-ttf'], eot: ['application/vnd.ms-fontobject'],
    };
    if (!types[extension]?.includes(response.headers.get('Content-Type')?.split(';')[0])) throw new Error(name + ' has the wrong content type');
    if (extension === 'html' && response.headers.get('Cache-Control')?.includes('immutable')) throw new Error('Music entry document must be revalidated');
    let size = 0;
    const hash = createHash('sha256');
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > expected.size) throw new Error(name + ' is larger than its manifest entry');
      hash.update(chunk);
    }
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error(name + ' checksum does not match');
  }
  await retry(async () => {
    const policy = await (await get('runtime-policy.json')).json();
    if (policy?.desktopOrigin !== desktopOrigin) throw new Error('music desktop origin does not match');
    const published = await (await get('yesplaymusic/manifest.json')).json();
    if (!isDeepStrictEqual(published, manifest)) throw new Error('published music manifest does not match');
    const response = await get('yesplaymusic/profiles/default/api/login/qr/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'runtime-deployment-health', qrimg: false }),
    });
    const body = await response.json();
    if (response.headers.get('Cache-Control') !== 'no-store' || response.headers.has('Set-Cookie')
      || body?.code !== 200 || body.data?.qrurl !== 'https://music.163.com/login?codekey=runtime-deployment-health') throw new Error('music profile API is not ready');
  });
  for (const [name, expected] of Object.entries(manifest.files)) await retry(() => checkFile('yesplaymusic/' + name, name, expected));
  await retry(() => checkFile('yesplaymusic/profiles/default/settings', 'index.html', manifest.files['index.html']));
}
