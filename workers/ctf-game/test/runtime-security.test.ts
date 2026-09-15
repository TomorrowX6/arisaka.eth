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
