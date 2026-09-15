// Endpoint formats adapted from @neteasecloudmusicapienhanced/api 4.40.1.
// Copyright (c) 2013-2022 Binaryify, MIT; full license in music-transport.ts.
import { createHash } from 'node:crypto';
import { booleanParam, checkFields, choiceParam, idParam, idsParam, MusicApiError, nestedParams, numberParam, textParam, type MusicParams } from './music-common';
import type { MusicCall } from './music-transport';

/** Exactly the NetEase routes used by the pinned YesPlayMusic web client. */
export const musicEndpointFields: Record<string, readonly string[]> = {
  '/search': ['keywords', 'type', 'limit', 'offset'],
  '/personalized': ['limit'],
  '/song/url': ['id', 'br'],
  '/song/detail': ['ids'],
  '/lyric': ['id'],
  '/api': ['uri', 'data'],
  '/login': ['email', 'password', 'md5_password'],
  '/login/cellphone': ['phone', 'password', 'md5_password', 'countrycode', 'captcha', 'sca'],
  '/login/qr/key': [], '/login/qr/create': ['key', 'qrimg'], '/login/qr/check': ['key'], '/login/refresh': [], '/logout': [],
  '/album': ['id'], '/album/new': ['area', 'limit', 'offset'], '/album/detail/dynamic': ['id'], '/album/sub': ['id', 't'],
  '/artists': ['id'], '/artist/album': ['id', 'limit', 'offset'], '/toplist/artist': ['type'],
  '/artist/mv': ['id', 'limit', 'offset'], '/artist/sub': ['id', 't'], '/simi/artist': ['id'],
  '/mv/detail': ['mvid'], '/mv/url': ['id', 'r'], '/simi/mv': ['mvid'], '/mv/sub': ['mvid', 't'],
  '/personal_fm': [], '/fm_trash': ['id', 'time'], '/recommend/resource': ['params', 'limit'],
  '/playlist/detail': ['id', 's'], '/top/playlist/highquality': ['cat', 'limit', 'before'], '/top/playlist': ['cat', 'order', 'limit', 'offset'],
  '/playlist/catlist': [], '/toplist': [], '/playlist/subscribe': ['id', 't'], '/playlist/delete': ['id'],
  '/playlist/create': ['name', 'privacy', 'type'], '/playlist/tracks': ['op', 'pid', 'tracks'], '/recommend/songs': ['afresh'],
  '/playmode/intelligence/list': ['id', 'pid', 'sid', 'count'], '/top/song': ['type'], '/like': ['id', 'like'], '/scrobble': ['id', 'sourceid', 'time'],
  '/user/detail': ['uid'], '/user/account': [], '/user/playlist': ['uid', 'limit', 'offset'], '/user/record': ['uid', 'type'], '/likelist': ['uid'], '/daily_signin': ['type'],
  '/album/sublist': ['limit', 'offset'], '/artist/sublist': ['limit', 'offset'], '/mv/sublist': ['limit', 'offset'],
  '/user/cloud': ['limit', 'offset'], '/user/cloud/detail': ['id'], '/user/cloud/del': ['id'],
  '/cloud': [],
};

const call = (uri: string, data: MusicParams = {}, mode: MusicCall['mode'] = 'eapi'): MusicCall => ({ uri, data, mode });
const page = (params: MusicParams, limit = 30, maximum = 1000) => ({ limit: numberParam(params, 'limit', limit, 1, maximum), offset: numberParam(params, 'offset', 0) });
const subAction = (params: MusicParams) => numberParam(params, 't', 1, 0, 2) === 1 ? 'sub' : 'unsub';
const idNumbers = (ids: string[]) => '[' + ids.join(',') + ']';

function password(params: MusicParams): string {
  if (params.md5_password !== undefined) {
    const value = textParam(params, 'md5_password', undefined, 32);
    if (!/^[a-fA-F0-9]{32}$/.test(value)) throw new MusicApiError(400, 'Invalid md5_password parameter.');
    return value.toLowerCase();
  }
  return createHash('md5').update(textParam(params, 'password', undefined, 1024)).digest('hex');
}

export function qrKey(params: MusicParams): string {
  const key = textParam(params, 'key', undefined, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new MusicApiError(400, 'Invalid QR key.');
  return key;
}

export function musicCalls(endpoint: string, q: MusicParams): MusicCall[] {
  let result: MusicCall;
  switch (endpoint) {
    case '/search': {
      const type = Number(choiceParam(q, 'type', ['1', '10', '100', '1000', '1002', '1004', '1006', '1009', '1014', '1018', '2000'], '1'));
      const keywords = textParam(q, 'keywords', undefined, 1024);
      result = type === 2000
        ? call('/api/search/voice/get', { keyword: keywords, scene: 'normal', ...page(q) })
        : call('/api/search/get', { s: keywords, type, ...page(q) });
      break;
    }
    case '/personalized': result = call('/api/personalized/playlist', { limit: numberParam(q, 'limit', 30, 1, 1000), total: true, n: 1000 }, 'weapi'); break;
    case '/song/url': result = call('/api/song/enhance/player/url', { ids: JSON.stringify(idsParam(q, 'id')), br: numberParam(q, 'br', 999000, 8000, 9_990_000) }); break;
    case '/song/detail': result = call('/api/v3/song/detail', { c: '[' + idsParam(q, 'ids').map(id => '{"id":' + id + '}').join(',') + ']' }, 'weapi'); break;
    case '/lyric': result = call('/api/song/lyric', { id: idParam(q, 'id'), tv: -1, lv: -1, rv: -1, kv: -1, _nmclfl: 1 }); break;
    case '/api': {
      if (q.uri !== '/api/cloud/lyric/get') throw new MusicApiError(400, 'Only the cloud lyrics URI is supported.');
      const data = nestedParams(q.data);
      checkFields(data, ['songId', 'userId', 'lv', 'kv']);
      result = call('/api/cloud/lyric/get', { songId: idParam(data, 'songId'), userId: idParam(data, 'userId'), lv: numberParam(data, 'lv', -1, -1, -1), kv: numberParam(data, 'kv', -1, -1, -1) });
      break;
    }
    case '/login': result = call('/api/w/login', { type: '0', https: 'true', username: textParam(q, 'email', undefined, 254), password: password(q), rememberLogin: 'true' }); break;
    case '/login/cellphone': {
      const data: MusicParams = { type: '1', https: 'true', phone: textParam(q, 'phone', undefined, 32), countrycode: textParam(q, 'countrycode', '86', 8), remember: 'true', secureCaptcha: q.sca === undefined ? '' : textParam(q, 'sca', undefined, 512) };
      if (q.captcha) data.captcha = textParam(q, 'captcha', undefined, 32);
      else data.password = password(q);
      result = call('/api/w/login/cellphone', data, 'weapi'); break;
    }
    case '/login/qr/key': result = call('/api/login/qrcode/unikey', { type: 3 }); break;
    case '/login/qr/check': result = call('/api/login/qrcode/client/login', { key: qrKey(q), type: 3 }); break;
    case '/login/refresh': result = call('/api/login/token/refresh'); break;
    case '/logout': result = call('/api/logout'); break;
    case '/album': result = call('/api/v1/album/' + idParam(q, 'id'), {}, 'weapi'); break;
    case '/album/new': {
      const requestedArea = typeof q.area === 'string' ? q.area.toUpperCase() || 'ALL' : q.area;
      const area = choiceParam({ area: requestedArea }, 'area', ['ALL', 'ZH', 'EA', 'KR', 'JP'], 'ALL');
      result = call('/api/album/new', { ...page(q), total: true, area }, 'weapi'); break;
    }
    case '/album/detail/dynamic': result = call('/api/album/detail/dynamic', { id: idParam(q, 'id') }, 'weapi'); break;
    case '/album/sub': result = call('/api/album/' + subAction(q), { id: idParam(q, 'id') }, 'weapi'); break;
    case '/artists': result = call('/api/v1/artist/' + idParam(q, 'id'), {}, 'weapi'); break;
    case '/artist/album': result = call('/api/artist/albums/' + idParam(q, 'id'), { ...page(q), total: true }, 'weapi'); break;
    case '/toplist/artist': result = call('/api/toplist/artist', { type: numberParam(q, 'type', 1, 1, 4), limit: 100, offset: 0, total: true }, 'weapi'); break;
    case '/artist/mv': result = call('/api/artist/mvs', { artistId: idParam(q, 'id'), ...page(q), total: true }, 'weapi'); break;
    case '/artist/sub': { const id = idParam(q, 'id'); result = call('/api/artist/' + subAction(q), { artistId: id, artistIds: idNumbers([id]) }, 'weapi'); break; }
    case '/simi/artist': result = call('/api/discovery/simiArtist', { artistid: idParam(q, 'id') }, 'weapi'); break;
    case '/mv/detail': result = call('/api/v1/mv/detail', { id: idParam(q, 'mvid') }, 'weapi'); break;
    case '/mv/url': result = call('/api/song/enhance/play/mv/url', { id: idParam(q, 'id'), r: numberParam(q, 'r', 1080, 144, 4320) }, 'weapi'); break;
    case '/simi/mv': result = call('/api/discovery/simiMV', { mvid: idParam(q, 'mvid') }, 'weapi'); break;
    case '/mv/sub': { const id = idParam(q, 'mvid'); result = call('/api/mv/' + subAction(q), { mvId: id, mvIds: JSON.stringify([id]) }, 'weapi'); break; }
    case '/personal_fm': result = call('/api/v1/radio/get', {}, 'weapi'); break;
    case '/fm_trash': result = call('/api/radio/trash/add', { songId: idParam(q, 'id'), alg: 'RT', time: numberParam(q, 'time', 25, 0, 86_400) }, 'weapi'); break;
    case '/recommend/resource':
      if (q.params !== undefined) { const params = nestedParams(q.params); checkFields(params, ['limit']); numberParam(params, 'limit', 30, 1, 1000); }
      if (q.limit !== undefined) numberParam(q, 'limit', 30, 1, 1000);
      result = call('/api/v1/discovery/recommend/resource', {}, 'weapi'); break;
    case '/playlist/detail': result = call('/api/v6/playlist/detail', { id: idParam(q, 'id'), n: 100000, s: numberParam(q, 's', 8, 0, 100) }); break;
    case '/top/playlist/highquality': result = call('/api/playlist/highquality/list', { cat: textParam(q, 'cat', '全部', 128), limit: numberParam(q, 'limit', 50, 1, 1000), lasttime: numberParam(q, 'before', 0, 0, Number.MAX_SAFE_INTEGER), total: true }, 'weapi'); break;
    case '/top/playlist': result = call('/api/playlist/list', { cat: textParam(q, 'cat', '全部', 128), order: choiceParam(q, 'order', ['hot', 'new'], 'hot'), ...page(q, 50), total: true }, 'weapi'); break;
    case '/playlist/catlist': result = call('/api/playlist/catalogue'); break;
    case '/toplist': result = call('/api/toplist'); break;
    case '/playlist/subscribe': result = call('/api/playlist/' + (numberParam(q, 't', 1, 1, 2) === 1 ? 'subscribe' : 'unsubscribe'), { id: idParam(q, 'id') }); break;
    case '/playlist/delete': result = call('/api/playlist/remove', { ids: idNumbers(idsParam(q, 'id')) }, 'weapi'); break;
    case '/playlist/create': result = call('/api/playlist/create', { name: textParam(q, 'name', undefined, 256), privacy: choiceParam(q, 'privacy', ['0', '10'], '0'), type: choiceParam(q, 'type', ['NORMAL', 'VIDEO', 'SHARED'], 'NORMAL') }, 'weapi'); break;
    case '/playlist/tracks': result = call('/api/playlist/manipulate/tracks', { op: choiceParam(q, 'op', ['add', 'del']), pid: idParam(q, 'pid'), trackIds: JSON.stringify(idsParam(q, 'tracks')), imme: 'true' }); break;
    case '/recommend/songs': result = call('/api/v3/discovery/recommend/songs', q.afresh === undefined ? {} : { afresh: booleanParam(q, 'afresh', false) }, 'weapi'); break;
    case '/playmode/intelligence/list': result = call('/api/playmode/intelligence/list', { songId: idParam(q, 'id'), type: 'fromPlayOne', playlistId: idParam(q, 'pid'), startMusicId: q.sid === undefined ? idParam(q, 'id') : idParam(q, 'sid'), count: numberParam(q, 'count', 1, 1, 1000) }); break;
    case '/top/song': result = call('/api/v1/discovery/new/songs', { areaId: Number(choiceParam(q, 'type', ['0', '7', '96', '8', '16'], '0')), total: true }, 'weapi'); break;
    case '/like': result = call('/api/radio/like', { alg: 'itembased', trackId: idParam(q, 'id'), like: booleanParam(q, 'like', true), time: '3' }, 'weapi'); break;
    case '/scrobble': {
      const id = idParam(q, 'id'); const sourceId = idParam(q, 'sourceid', '0');
      const common = { id, type: 'song', mainsite: '1', mainsiteWeb: '1', content: 'id=' + sourceId };
      return [
        { ...call('/api/feedback/weblog', { logs: JSON.stringify([{ action: 'startplay', json: common }]) }), clientLog: true },
        { ...call('/api/feedback/weblog', { logs: JSON.stringify([{ action: 'play', json: { ...common, download: 0, end: 'playend', sourceId, time: numberParam(q, 'time', 0, 0, 86_400), wifi: 0, source: 'list' } }]) }), clientLog: true },
      ];
    }
    case '/user/detail': result = call('/api/v1/user/detail/' + idParam(q, 'uid'), {}, 'weapi'); break;
    case '/user/account': result = call('/api/nuser/account/get', {}, 'weapi'); break;
    case '/user/playlist': result = call('/api/user/playlist', { uid: idParam(q, 'uid'), ...page(q, 30, 2000), includeVideo: true }, 'weapi'); break;
    case '/user/record': result = call('/api/v1/play/record', { uid: idParam(q, 'uid'), type: numberParam(q, 'type', 0, 0, 1) }, 'weapi'); break;
    case '/likelist': result = call('/api/song/like/get', { uid: idParam(q, 'uid') }); break;
    case '/daily_signin': result = call('/api/point/dailyTask', { type: numberParam(q, 'type', 0, 0, 1) }); break;
    case '/album/sublist': result = call('/api/album/sublist', { ...page(q, 25, 2000), total: true }, 'weapi'); break;
    case '/artist/sublist': result = call('/api/artist/sublist', { ...page(q, 25, 2000), total: true }, 'weapi'); break;
    case '/mv/sublist': result = call('/api/cloudvideo/allvideo/sublist', { ...page(q, 25), total: true }, 'weapi'); break;
    case '/user/cloud': result = call('/api/v1/cloud/get', page(q), 'weapi'); break;
    case '/user/cloud/detail': result = call('/api/v1/cloud/get/byids', { songIds: idsParam(q, 'id') }, 'weapi'); break;
    case '/user/cloud/del': result = call('/api/cloud/del', { songIds: idsParam(q, 'id') }, 'weapi'); break;
    default: throw new MusicApiError(404, 'Unknown music API endpoint.');
  }
  return [result];
}
