/*!
 * NetEase protocol adapted from @neteasecloudmusicapienhanced/api 4.40.1.
 * https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced
 * Copyright (c) 2013-2022 Binaryify. MIT License.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { Buffer } from 'node:buffer';
import { createCipheriv, createHash } from 'node:crypto';
import { isRecord, MusicApiError, readMusicBody, type MusicParams } from './music-common';

export interface MusicCall {
  uri: string;
  data: MusicParams;
  mode: 'weapi' | 'eapi';
  clientLog?: boolean;
}

export interface MusicResult {
  status: number;
  body: MusicParams;
  cookies: string[];
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SESSION_COOKIE_NAMES = new Set(['MUSIC_U', 'MUSIC_A', '__csrf', 'NMTID', '__remember_me', '_ntes_nuid', '_ntes_nnid', 'WNMCID', 'WEVNSM']);
// Public wire-protocol constants, not account credentials.
const RSA_MODULUS = BigInt('0xe0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7');

export function musicCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  if (!header) return cookies;
  if (header.length > 16_384) throw new MusicApiError(431, 'Music session header is too large.');
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    if (!SESSION_COOKIE_NAMES.has(name)) continue;
    try { cookies[name] = decodeURIComponent(item.slice(separator + 1).trim()); }
    catch { throw new MusicApiError(400, 'Malformed music session cookie.'); }
    if (/[\x00-\x1f\x7f]/.test(cookies[name])) throw new MusicApiError(400, 'Malformed music session cookie.');
  }
  return cookies;
}

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

function aes(text: string, key: string, iv?: string): Buffer {
  const cipher = createCipheriv(iv ? 'aes-128-cbc' : 'aes-128-ecb', Buffer.from(key), iv ? Buffer.from(iv) : Buffer.alloc(0));
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
}

function rsaSecret(secret: string): string {
  // RSA_NO_PADDING is not implemented by every workerd Node-crypto version.
  let base = BigInt('0x' + Buffer.from([...secret].reverse().join('')).toString('hex'));
  let exponent = 65537n;
  let result = 1n;
  while (exponent > 0n) {
    if (exponent & 1n) result = result * base % RSA_MODULUS;
    base = base * base % RSA_MODULUS;
    exponent >>= 1n;
  }
  return result.toString(16).padStart(256, '0');
}

function encryptedForm(call: MusicCall, header: Record<string, string>): URLSearchParams {
  const data = { ...call.data, e_r: false };
  if (call.mode === 'weapi') {
    const secret = randomHex(8);
    const inner = aes(JSON.stringify({ ...data, csrf_token: header.__csrf || '' }), '0CoJUm6Qyw8W8jud', '0102030405060708').toString('base64');
    return new URLSearchParams({ params: aes(inner, secret, '0102030405060708').toString('base64'), encSecKey: rsaSecret(secret) });
  }
  const json = JSON.stringify({ ...data, header });
  const digest = createHash('md5').update('nobody' + call.uri + 'use' + json + 'md5forencrypt').digest('hex');
  return new URLSearchParams({ params: aes(call.uri + '-36cd479b6b5-' + json + '-36cd479b6b5-' + digest, 'e82ckenh8dichen8').toString('hex').toUpperCase() });
}

function resultStatus(httpStatus: number, code: unknown): number {
  if (httpStatus >= 400) return httpStatus;
  if (code === 301) return 401;
  if (code === 800 || code === 801 || code === 802 || code === 803) return 200;
  if (typeof code === 'number' && code >= 400 && code < 600) return code;
  if (typeof code === 'number' && (code < 0 || code >= 300)) return 400;
  return 200;
}

export async function requestMusic(call: MusicCall, cookies: Record<string, string>, signal: AbortSignal): Promise<MusicResult> {
  if (!/^\/api\/[A-Za-z0-9_/-]+$/.test(call.uri)) throw new MusicApiError(500, 'Invalid internal music route.');
  const origin = call.clientLog ? 'https://clientlog.music.163.com' : call.mode === 'weapi' ? 'https://music.163.com' : 'https://interfacepc.music.163.com';
  const header: Record<string, string> = {
    os: call.clientLog ? 'osx' : 'pc',
    appver: call.clientLog ? '3.1.10.5100' : '3.1.17.204416',
    osver: call.clientLog ? '15.5' : 'Microsoft-Windows-10-Professional-build-19045-64bit',
    channel: 'netease',
    __csrf: cookies.__csrf || '',
    requestId: Date.now() + '_' + randomHex(2),
  };
  if (cookies.MUSIC_U) header.MUSIC_U = cookies.MUSIC_U;
  if (cookies.MUSIC_A) header.MUSIC_A = cookies.MUSIC_A;
  const cookieHeader = Object.entries({ ...cookies, ...header }).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('; ');
  const response = await fetch(origin + '/' + call.mode + '/' + call.uri.slice(5), {
    method: 'POST', redirect: 'manual', signal,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Referer: 'https://music.163.com/',
      'User-Agent': 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
      Cookie: cookieHeader,
    },
    body: encryptedForm(call, header),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new MusicApiError(502, 'NetEase returned an unexpected redirect.');
  }
  if (Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new MusicApiError(502, 'NetEase response is too large.');
  }
  const bytes = await readMusicBody(response.body, MAX_RESPONSE_BYTES, signal, 502);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new MusicApiError(502, `NetEase returned an invalid JSON response (HTTP ${response.status}).`); }
  if (!isRecord(body)) throw new MusicApiError(502, 'NetEase returned an invalid JSON object.');
  if (typeof body.code === 'string' && /^-?\d+$/.test(body.code)) body.code = Number(body.code);
  const responseCookies = response.headers.getSetCookie();
  if (responseCookies.length > 64 || responseCookies.join('').length > 16_384) throw new MusicApiError(502, 'NetEase returned an oversized session header.');
  const normalized = responseCookies.map(cookie => cookie.replace(/;\s*domain=[^;]*/gi, ''));
  if (normalized.length) body.cookie = normalized.join(';;');
  else if (Array.isArray(body.cookie) && body.cookie.every(value => typeof value === 'string')) body.cookie = body.cookie.join(';;');
  return { status: resultStatus(response.status, body.code), body, cookies: normalized };
}
