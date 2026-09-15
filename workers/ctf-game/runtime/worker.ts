import type { RuntimeEnv } from './worker-configuration';
const prefix = '/minecraft/1.12.2/';
const files = new Set(['index.html', 'boot.js', 'config.js', 'storage.js', 'style.css', 'manifest.json', 'NOTICE.txt',
  'assets/u3-loader.js', 'assets/u3-game.epw', 'assets/u3-game.js.gz', 'assets/u3-game.epk', 'assets/u3-lang.epk']);

function secured(response: Response, env: RuntimeEnv, immutable = false): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Cache-Control', immutable && response.ok ? 'public, max-age=31536000, immutable' : 'no-cache');
  headers.set('Content-Security-Policy', [
    "default-src 'none'", "script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:", "media-src 'self' blob: data:", "font-src 'self' data:",
    "connect-src 'self' blob: data: https: wss:", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
    "form-action 'none'", 'frame-ancestors ' + env.DESKTOP_ORIGIN,
  ].join('; '));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method)) return secured(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }), env);
    if (url.pathname === '/runtime-policy.json') return secured(Response.json({ desktopOrigin: env.DESKTOP_ORIGIN }), env);
    if (url.pathname === '/health') {
      const result = await env.ASSETS.fetch(new Request(new URL(prefix + 'manifest.json', url)));
      if (!result.ok) return secured(Response.json({ ok: false }, { status: 503 }), env);
      const manifest = await result.json<{ version: string; build: string }>();
      return secured(Response.json({ ok: manifest.version === '1.12.2' && manifest.build === 'u3', app: 'minecraft', version: manifest.version, build: manifest.build }), env);
    }
    const name = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || 'index.html' : '';
    if (!files.has(name)) return secured(new Response('Not found', { status: 404 }), env);
    const response = await env.ASSETS.fetch(new Request(new URL(prefix + name, url), request));
    const headers = new Headers(response.headers);
    if (name.endsWith('.gz')) { headers.set('Content-Type', 'application/gzip'); headers.delete('Content-Encoding'); }
    else if (name.endsWith('.epw') || name.endsWith('.epk')) headers.set('Content-Type', 'application/octet-stream');
    return secured(new Response(response.body, { status: response.status, headers }), env, name.startsWith('assets/'));
  },
};
