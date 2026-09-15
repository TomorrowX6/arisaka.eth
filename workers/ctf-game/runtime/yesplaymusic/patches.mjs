import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceOnce(source, before, after, name) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error('Pinned YesPlayMusic source patch no longer matches: ' + name);
  }
  return source.replace(before, after);
}

export async function patchUpstream(directory) {
  async function edit(name, transform) {
    const path = resolve(directory, name);
    await writeFile(path, transform(await readFile(path, 'utf8')));
  }
  await edit('src/main.js', source => {
    source = replaceOnce(source, "import VueGtag from 'vue-gtag';\n", '', 'analytics import');
    source = replaceOnce(source, "import './registerServiceWorker';\n", '', 'service worker');
    source = replaceOnce(source, "  document.cookie.split(';').forEach(function (c) {\n    document.cookie = c\n      .replace(/^ +/, '')\n      .replace(/=.*/, '=;expires=' + new Date().toUTCString() + ';path=/');\n  });", '  sessionStorage.clear();', 'shared cookie reset');
    source = replaceOnce(source, "Vue.use(\n  VueGtag,\n  {\n    config: { id: 'G-KMJJCFZDKF' },\n  },\n  router\n);\n", '', 'analytics registration');
    source = replaceOnce(source, "new Vue({\n", "const app = new Vue({\n", 'Vue instance');
    return source + "\nrouter.onReady(() => app.$nextTick(() => {\n  window.__ARISAKA_MUSIC__.report('running', 'YesPlayMusic 0.4.10');\n}), () => window.__ARISAKA_MUSIC__.report('error', 'YesPlayMusic 页面未能启动。'));\n";
  });
  await edit('src/router/index.js', source => replaceOnce(source,
    "  mode: process.env.IS_ELECTRON ? 'hash' : 'history',",
    "  mode: 'history',\n  base: window.__ARISAKA_MUSIC__.basePath,", 'profile router base'));
  await edit('src/store/initLocalStorage.js', source => {
    source = replaceOnce(source, '    lang: null,', "    lang: 'zh-CN',", 'default language');
    return replaceOnce(source, "    appearance: 'auto',", "    appearance: 'dark',", 'default appearance');
  });
  // This embedded build has no Last.fm application credentials. Remove its
  // connection row from the rendered settings rather than opening broken OAuth.
  await edit('src/views/settings.vue', source => replaceOnce(source,
    '      <div class="item">\n        <div class="left">\n          <div class="title">\n            {{\n              isLastfmConnected',
    '      <div v-if="false" class="item">\n        <div class="left">\n          <div class="title">\n            {{\n              isLastfmConnected',
    'unconfigured Last.fm connection controls'));
  await edit('src/api/track.js', source => replaceOnce(source, "        crypto: 'eapi',\n", '', 'fixed cloud lyric crypto'));
  await edit('src/utils/Player.js', source => {
    const start = source.indexOf('  _getAudioSourceFromNetease(track) {');
    const end = source.indexOf('  async _getAudioSourceFromUnblockMusic(track) {', start);
    if (start < 0 || end < start || !source.slice(start, end).includes('https://music.163.com/song/media/outer/url?id=')) {
      throw new Error('Pinned guest playback layout changed');
    }
    return source.slice(0, start) + `  _getAudioSourceFromNetease(track) {
    return getMP3(track.id).then(result => {
      if (!result.data[0]) return null;
      if (!result.data[0].url) return null;
      if (result.data[0].freeTrialInfo !== null) return null;
      const source = result.data[0].url.replace(/^http:/, 'https:');
      if (store.state.settings.automaticallyCacheSongs) {
        cacheTrackSource(track, source, result.data[0].br);
      }
      return source;
    });
  }
` + source.slice(end);
  });
  await edit('src/utils/auth.js', source => {
    source = replaceOnce(source, "import Cookies from 'js-cookie';", "import { storeCookies, getStoredCookie } from '../arisaka/cookies.mjs';", 'profile cookie helpers');
    const start = source.indexOf('export function setCookies(');
    const end = source.indexOf('// MUSIC_U', start);
    if (start < 0 || end < start) throw new Error('Pinned auth layout changed');
    return source.slice(0, start) + `export function setCookies(value) {
  storeCookies(localStorage, value);
}

export function getCookie(key) {
  return getStoredCookie(localStorage, key);
}

export function removeCookie(key) {
  localStorage.removeItem('cookie-' + key);
}

` + source.slice(end);
  });
  await writeFile(resolve(directory, 'src/utils/request.js'), `import router from '@/router';
import { doLogout } from '@/utils/auth';
import { musicRequest } from '../arisaka/transport.mjs';

export default async function request(config) {
  try {
    return await musicRequest(config, window.__ARISAKA_MUSIC__.basePath, localStorage);
  } catch (error) {
    const data = error.response && error.response.data;
    if (config.url !== '/logout' && data && data.code === 301 && data.msg === '需要登录') {
      doLogout();
      router.push({ name: 'login' });
    }
    throw error;
  }
}
`);
  await edit('public/index.html', source => {
    source = replaceOnce(source, '<html lang="en">', '<html lang="zh-CN">', 'document language');
    // changeAppearance() expects the meta element normally added by the PWA
    // plugin, even though the embedded app deliberately has no service worker.
    return replaceOnce(source, '<head>', '<head>\n  <meta name="theme-color" content="#222" />\n  <script src="/yesplaymusic/bridge.js"></script>', 'synchronous profile bridge');
  });
  // Upstream public images use root-absolute paths in these three templates.
  for (const name of ['src/views/login.vue', 'src/views/loginAccount.vue', 'src/views/lastfmCallback.vue']) {
    await edit(name, source => source.replaceAll('src="/img/', 'src="/yesplaymusic/img/'));
  }
  await edit('src/components/Navbar.vue', source => source.replace('http://s4.music.126.net/', 'https://s4.music.126.net/'));
}
