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
  await edit('src/views/home.vue', source => {
    source = replaceOnce(source, '<div v-show="show" class="home">', '<div class="home">', 'independent homepage sections');
    source = replaceOnce(source, '      show: false,', `      homeErrors: {
        recommendPlaylist: '', newReleasesAlbum: '', recommendArtists: '', topList: '',
      },
      homeLoading: {
        recommendPlaylist: false, newReleasesAlbum: false, recommendArtists: false, topList: false,
      },`, 'homepage request state');
    for (const [section, cover] of [
      ['recommendPlaylist', '      <CoverRow\n        :type="\'playlist\'"\n        :items="recommendPlaylist.items"'],
      ['recommendArtists', '      <CoverRow\n        type="artist"\n        :column-number="6"\n        :items="recommendArtists.items"'],
      ['newReleasesAlbum', '      <CoverRow\n        type="album"\n        :items="newReleasesAlbum.items"'],
      ['topList', '      <CoverRow\n        type="playlist"\n        :items="topList.items"'],
    ]) {
      source = replaceOnce(source, cover, `      <div v-if="homeErrors.${section}" class="home-error" role="alert">
        <span>{{ homeErrors.${section} }}</span>
        <button
          type="button"
          :disabled="homeLoading.${section}"
          @click="loadData('${section}')"
        >重试</button>
      </div>
` + cover, 'homepage error for ' + section);
    }
    const start = source.indexOf('    loadData() {');
    const ending = '      this.$refs.DailyTracksCard.loadDailyTracks();\n    },';
    const end = source.indexOf(ending, start);
    if (start < 0 || end < start) throw new Error('Pinned homepage request layout changed');
    source = source.slice(0, start) + `    loadData(section) {
      const toplistOfArtistsAreaTable = {
        all: null, zh: 1, ea: 2, jp: 4, kr: 3,
      };
      const loaders = {
        recommendPlaylist: () => getRecommendPlayList(10, false).then(items => {
          this.recommendPlaylist.items = items;
        }),
        newReleasesAlbum: () => newAlbums({
          area: this.settings.musicLanguage ?? 'ALL',
          limit: 10,
        }).then(data => {
          this.newReleasesAlbum.items = data.albums;
        }),
        recommendArtists: () => toplistOfArtists(
          toplistOfArtistsAreaTable[this.settings.musicLanguage ?? 'all']
        ).then(data => {
          let indexs = [];
          while (indexs.length < 6) {
            let tmp = ~~(Math.random() * 100);
            if (!indexs.includes(tmp)) indexs.push(tmp);
          }
          this.recommendArtists.indexs = indexs;
          this.recommendArtists.items = data.list.artists.filter((l, index) =>
            indexs.includes(index)
          );
        }),
        topList: () => toplists().then(data => {
          this.topList.items = data.list.filter(l =>
            this.topList.ids.includes(l.id)
          );
        }),
      };
      for (const key of section ? [section] : Object.keys(loaders)) {
        this.loadHomeSection(key, loaders[key]);
      }
      if (!section) this.$refs.DailyTracksCard.loadDailyTracks();
    },
    async loadHomeSection(section, load) {
      if (this.homeLoading[section]) return;
      this.homeLoading[section] = true;
      const progress = setTimeout(() => NProgress.start(), 1000);
      try {
        await load();
        this.homeErrors[section] = '';
      } catch (error) {
        const data = error?.response?.data;
        this.homeErrors[section] =
          data?.message || data?.msg || error?.message || '加载失败，请重试';
      } finally {
        clearTimeout(progress);
        this.homeLoading[section] = false;
        if (!Object.values(this.homeLoading).some(Boolean)) NProgress.done();
      }
    },` + source.slice(end + ending.length);
    return replaceOnce(source, '<style lang="scss" scoped>', `<style lang="scss" scoped>
.home-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--color-secondary-bg);
  color: var(--color-text);
  font-size: 14px;
  line-height: 1.5;
  span { overflow-wrap: anywhere; }
  button {
    flex-shrink: 0;
    padding: 8px 12px;
    border-radius: 6px;
    background: var(--color-primary-bg);
    color: var(--color-primary);
    font-weight: 600;
    &:disabled { opacity: 0.5; cursor: default; }
    &:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
  }
}`, 'homepage error styles');
  });
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
