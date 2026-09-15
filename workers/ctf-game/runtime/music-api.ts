import { booleanParam, checkFields, idsParam, isRecord, MusicApiError, numberParam, readMusicBody, type MusicParams } from './music-common';
import { musicCalls, musicEndpointFields, qrKey } from './music-endpoints';
import { musicQrImage } from './music-qr';
import { musicCookies, requestMusic, type MusicResult } from './music-transport';
import { uploadMusic } from './music-upload';

const MAX_REQUEST_BYTES = 64 * 1024;

function json(body: MusicParams, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function parameters(request: Request, endpoint: string, signal: AbortSignal): Promise<MusicParams> {
  const url = new URL(request.url);
  if (url.search.length > 32_768) throw new MusicApiError(414, 'Music API query is too large.');
  const query: MusicParams = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key)) throw new MusicApiError(400, 'Repeated music API parameter.');
    query[key] = value;
  }
  const allowed = [...musicEndpointFields[endpoint], 'timestamp'];
  checkFields(query, allowed);
  let params = query;
  if (request.method === 'POST') {
    if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new MusicApiError(415, 'Music API POST requests require application/json.');
    if (Number(request.headers.get('Content-Length')) > MAX_REQUEST_BYTES) throw new MusicApiError(413, 'Music API request is too large.');
    const bytes = await readMusicBody(request.body, MAX_REQUEST_BYTES, signal, 413);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
    catch { throw new MusicApiError(400, 'Invalid music API JSON.'); }
    if (!isRecord(body)) throw new MusicApiError(400, 'Music API JSON must be an object.');
    checkFields(body, allowed);
    params = { ...query, ...body };
  }
  if (params.timestamp !== undefined) numberParam(params, 'timestamp', 0, 0, Number.MAX_SAFE_INTEGER);
  return params;
}

function finish(endpoint: string, params: MusicParams, result: MusicResult): Response {
  let body = result.body;
  if (result.status === 200 && body.code === 200) {
    if (endpoint === '/login/qr/key') body = { code: 200, data: body, ...(body.cookie ? { cookie: body.cookie } : {}) };
    if (endpoint === '/song/url' && Array.isArray(body.data)) {
      const ids = idsParam(params, 'id');
      body.data.sort((first: unknown, second: unknown) => {
        const firstId = isRecord(first) ? String(first.id) : '';
        const secondId = isRecord(second) ? String(second.id) : '';
        return ids.indexOf(firstId) - ids.indexOf(secondId);
      });
    }
    if (['/login', '/login/cellphone', '/user/detail', '/top/playlist'].includes(endpoint)) {
      body = JSON.parse(JSON.stringify(body).replace(/"avatarImgId_str"\s*:/g, '"avatarImgIdStr":'));
    }
  }
  if (endpoint === '/login/qr/check' && body.cookie === undefined) body.cookie = '';
  if (endpoint === '/playlist/tracks') body = { code: body.code, status: result.status, body, ...(body.cookie ? { cookie: body.cookie } : {}) };
  return json(body, result.status);
}

export async function handleMusicApi(request: Request, endpoint: string): Promise<Response> {
  if (!Object.hasOwn(musicEndpointFields, endpoint)) return json({ code: 404, message: 'Unknown music API endpoint.' }, 404);
  if ((request.method !== 'GET' && request.method !== 'POST') || (endpoint === '/cloud' && request.method !== 'POST')) {
    const response = json({ code: 405, message: endpoint === '/cloud' ? 'Cloud upload requires POST.' : 'Music API supports GET and POST.' }, 405);
    response.headers.set('Allow', endpoint === '/cloud' ? 'POST' : 'GET, POST');
    return response;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), endpoint === '/cloud' ? 60_000 : 12_000);
  const signal = AbortSignal.any([request.signal, controller.signal]);
  try {
    const cookies = musicCookies(request.headers.get('X-YesPlayMusic-Cookie'));
    if (endpoint === '/cloud') {
      const result = await uploadMusic(request, cookies, signal);
      return json(result.body, result.status);
    }
    const params = await parameters(request, endpoint, signal);
    if (endpoint === '/login/qr/create') {
      const url = 'https://music.163.com/login?codekey=' + qrKey(params);
      return json({ code: 200, data: { qrurl: url, qrimg: booleanParam(params, 'qrimg', false) ? musicQrImage(url) : '' } });
    }
    const calls = musicCalls(endpoint, params);
    const results: MusicResult[] = [];
    for (const call of calls) {
      let result = await requestMusic(call, cookies, signal);
      if (endpoint === '/playlist/tracks' && result.body.code === 512) {
        const tracks = idsParam(params, 'tracks');
        result = await requestMusic({ ...call, data: { ...call.data, trackIds: JSON.stringify([...tracks, ...tracks]) } }, cookies, signal);
      }
      if (result.status !== 200) return finish(endpoint, params, result);
      results.push(result);
    }
    if (endpoint === '/scrobble') return json({ code: 200, data: 'success', details: { startplay: results[0].body, play: results[1].body } });
    return finish(endpoint, params, results[0]);
  } catch (error) {
    if (error instanceof MusicApiError) return json({ code: error.status, message: error.message }, error.status);
    if (signal.aborted) return json({ code: 504, message: 'NetEase request timed out.' }, 504);
    return json({ code: 502, message: 'NetEase request failed.' }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
