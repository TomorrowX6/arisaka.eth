// Bounded Workers adaptation of @neteasecloudmusicapienhanced/api 4.40.1 cloud/songUpload.
// Copyright (c) 2013-2022 Binaryify, MIT; full license in music-transport.ts.
import { createHash } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import { checkFields, isRecord, MusicApiError, numberParam, readMusicBody, type MusicParams } from './music-common';
import { requestMusic, type MusicCall, type MusicResult } from './music-transport';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_FILE_BYTES + 16 * 1024;
const CLOUD_BUCKET = 'jd-musicrep-privatecloud-audio-public';
const CLOUD_STORAGE_HOST = 'nosup-jd1.127.net';

async function songFile(request: Request, signal: AbortSignal): Promise<File> {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  if (url.search.length > 1024) throw new MusicApiError(414, 'Cloud upload query is too large.');
  checkFields(query, ['timestamp']);
  if (query.timestamp !== undefined) numberParam(query, 'timestamp', 0, 0, Number.MAX_SAFE_INTEGER);
  const contentType = request.headers.get('Content-Type') || '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new MusicApiError(415, 'Cloud upload requires multipart/form-data.');
  if (Number(request.headers.get('Content-Length')) > MAX_MULTIPART_BYTES) throw new MusicApiError(413, 'Cloud audio files must be at most 16 MiB.');
  const bytes = await readMusicBody(request.body, MAX_MULTIPART_BYTES, signal, 413);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); }
  catch { throw new MusicApiError(400, 'Invalid cloud upload form.'); }
  const names = new Set<string>();
  for (const [name, value] of form) {
    if (!['songFile', 'timestamp'].includes(name) || names.has(name)) throw new MusicApiError(400, 'Unsupported or repeated cloud upload field.');
    names.add(name);
    if (name === 'timestamp') numberParam({ timestamp: value }, 'timestamp', 0, 0, Number.MAX_SAFE_INTEGER);
  }
  const file = form.get('songFile');
  if (!(file instanceof File) || !file.size) throw new MusicApiError(400, 'Cloud upload requires one audio file.');
  if (file.size > MAX_FILE_BYTES) throw new MusicApiError(413, 'Cloud audio files must be at most 16 MiB.');
  if (file.name.length > 256 || !/\.(mp3|flac|wav|m4a|aac|ogg|opus|wma|ape)$/i.test(file.name)) throw new MusicApiError(415, 'Unsupported cloud audio filename.');
  if (file.type && !/^audio\//i.test(file.type) && file.type !== 'application/octet-stream') throw new MusicApiError(415, 'Cloud upload requires an audio file.');
  return file;
}

async function storageJson(response: Response, signal: AbortSignal): Promise<MusicParams> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new MusicApiError(502, `NetEase upload service returned HTTP ${response.status}.`);
  }
  if (Number(response.headers.get('Content-Length')) > 64 * 1024) {
    await response.body?.cancel();
    throw new MusicApiError(502, 'NetEase upload service response is too large.');
  }
  const bytes = await readMusicBody(response.body, 64 * 1024, signal, 502);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new MusicApiError(502, 'NetEase upload service returned invalid JSON.'); }
  if (!isRecord(body)) throw new MusicApiError(502, 'NetEase upload service returned an invalid object.');
  return body;
}

function allocation(body: MusicParams, key: string): string {
  const value = isRecord(body.result) ? body.result[key] : undefined;
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value) || String(value).length > 4096 || /[\x00-\x1f\x7f]/.test(String(value))) {
    throw new MusicApiError(502, 'NetEase did not allocate the cloud upload resource.');
  }
  return String(value);
}

export async function uploadMusic(request: Request, cookies: Record<string, string>, signal: AbortSignal): Promise<MusicResult> {
  if (!cookies.MUSIC_U) return { status: 401, body: { code: 301, msg: '需要登录' }, cookies: [] };
  const file = await songFile(request, signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const md5 = createHash('md5').update(bytes).digest('hex');
  const filename = file.name.replace(/\\/g, '/').split('/').at(-1)!;
  const ext = filename.split('.').at(-1)!.toLowerCase();
  const title = filename.replace(/\.[^.]+$/, '').replace(/\s/g, '').replace(/\./g, '_');
  const api = (uri: string, data: MusicParams, mode: MusicCall['mode'] = 'eapi') => requestMusic({ uri, data, mode }, cookies, signal);
  const check = await api('/api/cloud/upload/check', { bitrate: '999000', ext: '', length: file.size, md5, songId: '0', version: 1 });
  if (check.status !== 200) return check;

  let metadata = { title, album: '未知专辑', artist: '未知艺术家' };
  try {
    const tags = (await parseBuffer(bytes, { mimeType: file.type || 'audio/' + ext, path: filename, size: file.size }, { duration: false, skipCovers: true })).common;
    metadata = { title: tags.title || title, album: tags.album || metadata.album, artist: tags.artist || metadata.artist };
  } catch {
    // Upstream permits audio with no readable tags and uses the filename instead.
  }
  const tokenData = { bucket: '', ext, filename: title, local: false, nos_product: 3, type: 'audio', md5 };
  const resource = await api('/api/nos/token/alloc', tokenData);
  if (resource.status !== 200) return resource;
  const resourceId = allocation(resource.body, 'resourceId');
  if (check.body.needUpload) {
    const uploadToken = await api('/api/nos/token/alloc', { ...tokenData, bucket: CLOUD_BUCKET }, 'weapi');
    if (uploadToken.status !== 200) return uploadToken;
    const key = allocation(uploadToken.body, 'objectKey');
    if (key === '.' || key === '..') throw new MusicApiError(502, 'NetEase returned an invalid upload object key.');
    const token = allocation(uploadToken.body, 'token');
    const discovery = await storageJson(await fetch('https://wanproxy.127.net/lbs?version=1.0&bucketname=' + CLOUD_BUCKET, { redirect: 'manual', signal }), signal);
    let host: URL;
    try { host = new URL(Array.isArray(discovery.upload) ? String(discovery.upload[0]) : ''); }
    catch { throw new MusicApiError(502, 'NetEase returned an invalid upload host.'); }
    if (!['http:', 'https:'].includes(host.protocol) || host.hostname !== CLOUD_STORAGE_HOST || host.username || host.password || host.port || host.pathname !== '/' || host.search || host.hash) {
      throw new MusicApiError(502, 'NetEase returned an unsupported upload host.');
    }
    // The discovery service advertises HTTP. The fixed storage service also supports HTTPS.
    const uploaded = await storageJson(await fetch('https://' + CLOUD_STORAGE_HOST + '/' + CLOUD_BUCKET + '/' + encodeURIComponent(key) + '?offset=0&complete=true&version=1.0', {
      method: 'POST', redirect: 'manual', signal,
      headers: { 'x-nos-token': token, 'Content-MD5': md5, 'Content-Type': file.type || 'audio/mpeg' },
      body: bytes,
    }), signal);
    if (uploaded.offset !== undefined && Number(uploaded.offset) !== file.size) throw new MusicApiError(502, 'NetEase did not receive the complete audio file.');
  }
  const info = await api('/api/upload/cloud/info/v2', { md5, songid: check.body.songId, filename, song: metadata.title, album: metadata.album, artist: metadata.artist, bitrate: '999000', resourceId });
  if (info.status !== 200) return info;
  if (info.body.songId === undefined) throw new MusicApiError(502, 'NetEase did not return the uploaded song ID.');
  const publish = await api('/api/cloud/pub/v2', { songid: info.body.songId });
  if (publish.status !== 200) return publish;
  return { status: 200, body: { ...check.body, ...publish.body }, cookies: publish.cookies };
}
