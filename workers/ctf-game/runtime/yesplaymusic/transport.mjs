import { cookieHeader, storeCookies } from './cookies.mjs';

export function prepareMusicRequest(config, basePath, storage) {
  if (!/^\/yesplaymusic\/profiles\/[a-z0-9_-]{1,64}\/$/.test(basePath)) throw new Error('Invalid music profile base');
  if (typeof config.url !== 'string' || !/^\/?[a-z0-9_]+(?:\/[a-z0-9_]+)*$/.test(config.url)) throw new Error('Invalid music API endpoint');
  const params = config.params || {};
  const headers = { Accept: 'application/json' };
  const cookie = cookieHeader(storage);
  if (cookie) headers['X-YesPlayMusic-Cookie'] = cookie;
  let body;
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    body = config.data;
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ ...params, ...(config.data || {}) });
  }
  return {
    url: basePath + 'api/' + config.url.replace(/^\//, ''),
    options: { method: 'POST', credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', headers, body },
  };
}

export async function musicRequest(config, basePath, storage, fetcher = globalThis.fetch) {
  if (config.url === '/song/detail' || config.url === 'song/detail') {
    const params = { ...config.params, ...config.data };
    const ids = Array.isArray(params.ids) ? params.ids : typeof params.ids === 'string' ? params.ids.split(',') : [];
    if (ids.length > 1000) {
      let combined;
      // A library playlist may exceed the upstream endpoint's per-call limit.
      // Preserve its full result while bounding each request and its body.
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const result = await musicRequest({ ...config, data: undefined, params: { ...params, ids: ids.slice(offset, offset + 1000).join(',') } }, basePath, storage, fetcher);
        if (!Array.isArray(result.songs) || !Array.isArray(result.privileges)) throw new Error('Invalid song detail response');
        if (!combined) combined = { ...result, songs: [], privileges: [] };
        combined.songs.push(...result.songs);
        combined.privileges.push(...result.privileges);
      }
      return combined;
    }
  }
  const request = prepareMusicRequest(config, basePath, storage);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(config.timeout || 15000, 1000), 200000));
  try {
    const response = await fetcher(request.url, { ...request.options, signal: controller.signal });
    const result = await response.json();
    if (result && typeof result.cookie === 'string') storeCookies(storage, result.cookie);
    if (!response.ok) {
      const error = new Error(result?.message || result?.msg || ('音乐服务返回 HTTP ' + response.status));
      error.response = { status: response.status, data: result };
      throw error;
    }
    return result;
  } finally { clearTimeout(timeout); }
}
