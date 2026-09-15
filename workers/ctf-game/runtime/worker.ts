import type { RuntimeEnv } from './worker-configuration';
import { handleMusicApi } from './music-api';

const prefix = '/minecraft/1.12.2/';
const files = new Set(['index.html', 'boot.js', 'config.js', 'storage.js', 'style.css', 'manifest.json', 'NOTICE.txt',
  'assets/u3-loader.js', 'assets/u3-game.epw', 'assets/u3-game.js.gz', 'assets/u3-game.epk', 'assets/u3-lang.epk']);
const musicPrefix = '/yesplaymusic/';
const musicFiles = new Set(['index.html', 'bridge.js', 'manifest.json', 'favicon.ico', 'LICENSE.txt', 'NOTICE.txt']);

function musicAsset(name: string): boolean {
  if (name.split('/').some(part => !part || part.startsWith('.'))) return false;
  return musicFiles.has(name)
    || /^js\/[a-zA-Z0-9_.-]+\.js(?:\.LICENSE\.txt)?$/.test(name)
    || /^css\/[a-zA-Z0-9_.-]+\.css$/.test(name)
    || /^(?:img|fonts)\/[a-zA-Z0-9_./@-]+\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/.test(name);
}

function musicPage(path: string): boolean {
  return /^\/(?:login(?:\/(?:username|account))?|playlist\/\d+|album\/\d+|artist\/\d+(?:\/mv)?|mv\/\d+|next|search(?:\/[^/]+(?:\/[^/]+)?)?|new-album|explore|library(?:\/liked-songs)?|settings|daily\/songs|lastfm\/callback)?\/?$/.test(path);
}

function secured(response: Response, env: RuntimeEnv, immutable = false, music = false): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', music ? 'credentialless' : 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Cache-Control', immutable && response.ok ? 'public, max-age=31536000, immutable' : 'no-cache');
  headers.set('Content-Security-Policy', [
    "default-src 'none'", "script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:", "media-src 'self' blob: data:" + (music ? ' https:' : ''), "font-src 'self' data:",
    "connect-src 'self' blob: data: https: wss:", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
    "form-action 'none'", 'frame-ancestors ' + env.DESKTOP_ORIGIN,
  ].join('; '));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    const music = url.pathname === '/yesplaymusic' || url.pathname.startsWith(musicPrefix);
    const profile = /^\/yesplaymusic\/profiles\/([a-z0-9_-]{1,64})(\/.*)?$/.exec(url.pathname);
    if (profile?.[2]?.startsWith('/api/')) {
      const response = secured(await handleMusicApi(request, profile[2].slice(4)), env, false, true);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
    if (!['GET', 'HEAD'].includes(request.method)) return secured(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }), env, false, music);
    if (music) {
      if (url.pathname === '/yesplaymusic' || url.pathname === musicPrefix || (profile && !profile[2])) {
        url.pathname = profile ? url.pathname + '/' : musicPrefix + 'profiles/default/';
        return secured(new Response(null, { status: 302, headers: { Location: url.pathname + url.search } }), env, false, true);
      }
      const name = profile && musicPage(profile[2]) ? 'index.html' : url.pathname.slice(musicPrefix.length);
      if (!musicAsset(name)) return secured(new Response('Not found', { status: 404 }), env, false, true);
      const response = await env.ASSETS.fetch(new Request(new URL(musicPrefix + name, url), request));
      return secured(response, env, /\.[a-f0-9]{6,64}\./.test(name), true);
    }
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
