import { exports } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import runtime from '../runtime/worker';
import configuration from '../public/runtime-config.json';

test('desktop allows only the app origins to frame and preserves runner restrictions', async () => {
  const page = await exports.default.fetch(new Request('https://archive.example/'));
  expect(page.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  expect(page.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  const csp = page.headers.get('Content-Security-Policy')!;
  expect(csp).toContain('frame-src ' + new URL(configuration.minecraft.url).origin + ' ' + new URL(configuration.firefox.url).origin);
  expect(csp).not.toContain("'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).toContain("connect-src 'self'");
  expect(page.headers.get('Permissions-Policy')).toContain('cross-origin-isolated=');
  for (const path of ['/runner.js', '/python-runner.js']) {
    const runner = await exports.default.fetch(new Request('https://archive.example' + path));
    expect(runner.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
    expect(runner.headers.get('Content-Security-Policy')).not.toContain('frame-src');
  }
  const config = await exports.default.fetch(new Request('https://archive.example/runtime-config.json'));
  expect(await config.json()).toEqual(configuration);
});

test('runtime serves only known assets and isolates framing from the desktop APIs', async () => {
  const visited: string[] = [];
  const env = {
    DESKTOP_ORIGIN: 'https://desktop.example',
    ASSETS: { fetch: async (request: Request) => {
      visited.push(new URL(request.url).pathname);
      return new Response('binary fixture', { headers: { 'Content-Type': 'application/octet-stream' } });
    } } as unknown as Fetcher,
  };
  const response = await runtime.fetch(new Request('https://apps.example/minecraft/1.12.2/assets/u3-game.js.gz'), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('application/gzip');
  expect(response.headers.has('Content-Encoding')).toBe(false);
  expect(response.headers.get('Cache-Control')).toContain('immutable');
  expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  expect(response.headers.get('Content-Security-Policy')).toContain('frame-ancestors https://desktop.example');
  for (const path of ['/api/session', '/.private/answers.json', '/minecraft/1.12.2/unknown.js', '/minecraft/1.12.2/../../worker.ts']) {
    expect((await runtime.fetch(new Request('https://apps.example' + path), env)).status).toBe(404);
  }
  expect((await runtime.fetch(new Request('https://apps.example/minecraft/1.12.2/', { method: 'POST' }), env)).status).toBe(405);
  expect(visited).toEqual(['/minecraft/1.12.2/assets/u3-game.js.gz']);
  const policy = await runtime.fetch(new Request('https://apps.example/runtime-policy.json'), env);
  expect(await policy.json()).toEqual({ desktopOrigin: 'https://desktop.example' });
});

test('music profile routes serve the app with media isolation and reject private paths', async () => {
  const visited: string[] = [];
  const env = {
    DESKTOP_ORIGIN: 'https://desktop.example',
    ASSETS: { fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      visited.push(path);
      if (path === '/yesplaymusic/index.html') return new Response('<!doctype html><title>YesPlayMusic</title>', { headers: { 'Content-Type': 'text/html' } });
      if (path === '/yesplaymusic/js/app.abc123.js') return new Response('app();', { headers: { 'Content-Type': 'text/javascript' } });
      return new Response('Not found', { status: 404 });
    } } as unknown as Fetcher,
  };
  for (const path of [
    '/yesplaymusic/profiles/default/',
    '/yesplaymusic/profiles/12345678-1234-4234-8234-123456789abc/settings',
    '/yesplaymusic/profiles/default/search/%E9%9F%B3%E4%B9%90',
  ]) {
    const response = await runtime.fetch(new Request('https://apps.example' + path), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('YesPlayMusic');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('credentialless');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(response.headers.get('Content-Security-Policy')).toContain('frame-ancestors https://desktop.example');
    expect(response.headers.get('Content-Security-Policy')).toContain("media-src 'self' blob: data: https:");
    expect(response.headers.get('Cache-Control')).not.toContain('immutable');
  }
  expect(visited).toEqual(Array(3).fill('/yesplaymusic/index.html'));
  for (const path of [
    '/yesplaymusic/package.json', '/yesplaymusic/worker.ts', '/yesplaymusic/js/app.js.map',
    '/yesplaymusic/.private/answers.json', '/yesplaymusic/profiles/%2Fsecret/',
    '/yesplaymusic/profiles/default/.env', '/yesplaymusic/profiles/default/unknown.js',
  ]) expect((await runtime.fetch(new Request('https://apps.example' + path), env)).status).toBe(404);
  expect(visited, 'invalid routes never reach the static asset binding').toHaveLength(3);
  const script = await runtime.fetch(new Request('https://apps.example/yesplaymusic/js/app.abc123.js'), env);
  expect(script.status).toBe(200);
  expect(script.headers.get('Cache-Control')).toContain('immutable');
  expect((await runtime.fetch(new Request('https://apps.example/yesplaymusic/profiles/default/', { method: 'POST' }), env)).status).toBe(405);
});

test('music profile API uses POST without falling through to assets or shared cookies', async () => {
  const env = {
    DESKTOP_ORIGIN: 'https://desktop.example',
    ASSETS: { fetch: async () => { throw new Error('API must not read a static asset'); } } as unknown as Fetcher,
  };
  const response = await runtime.fetch(new Request('https://apps.example/yesplaymusic/profiles/default/api/login/qr/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'MUSIC_U=shared-cookie' },
    body: JSON.stringify({ key: 'runtime-deployment-health', qrimg: false }),
  }), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.has('Set-Cookie')).toBe(false);
  expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('credentialless');
  expect(await response.json()).toEqual({ code: 200, data: { qrurl: 'https://music.163.com/login?codekey=runtime-deployment-health', qrimg: '' } });
  for (const path of ['unknown', 'search/extra', '%73earch']) {
    const missing = await runtime.fetch(new Request('https://apps.example/yesplaymusic/profiles/default/api/' + path, { method: 'POST' }), env);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Cache-Control')).toBe('no-store');
  }
});

test('music assets use Cloudflare canonical encoding while retaining the public allowlist', async () => {
  const visited: string[] = [];
  const canonical = '/yesplaymusic/img/icons/menu-dark%4088.png';
  const env = {
    DESKTOP_ORIGIN: 'https://desktop.example',
    ASSETS: { fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      visited.push(path);
      if (path.includes('@')) return new Response(null, { status: 307, headers: { Location: canonical } });
      if (path === canonical) return new Response('icon bytes', { headers: { 'Content-Type': 'image/png' } });
      throw new Error('Unexpected static asset');
    } } as unknown as Fetcher,
  };
  for (const path of ['/yesplaymusic/img/icons/menu-dark@88.png', canonical]) {
    const response = await runtime.fetch(new Request('https://apps.example' + path), env);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode('icon bytes'));
  }
  for (const path of ['/yesplaymusic/img/%2Eprivate/secret.png', '/yesplaymusic/img/%2540private.png', '/yesplaymusic/img/%FF.png']) {
    expect((await runtime.fetch(new Request('https://apps.example' + path), env)).status).toBe(404);
  }
  expect(visited).toEqual([canonical, canonical]);
});
