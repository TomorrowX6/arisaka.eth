import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 30000 });
const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

// This opt-in suite uses the real NetEase service and actual audio, without
// intercepting API or media responses. Run via scripts/test-runtimes.mjs.
test('real YesPlayMusic searches, plays audio, survives minimize, and closes cleanly', { timeout: 180000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  const media = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.request().resourceType() === 'media') media.push({ status: response.status(), type: response.headers()['content-type'] });
  });
  const output = '.private/yesplaymusic-qa';
  await mkdir(output, { recursive: true });
  try {
    assert.equal((await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } })).status(), 200);
    const config = await (await context.request.get(base + '/runtime-config.json')).json();
    const profileBase = config.yesplaymusic.url + 'profiles/default/';
    async function api(endpoint, params) {
      const response = await context.request.post(profileBase + 'api/' + endpoint, { data: params });
      assert.equal(response.status(), 200, endpoint + ' HTTP status');
      assert.equal(response.headers()['cache-control'], 'no-store');
      const body = await response.json();
      assert.equal(body.code, 200, endpoint + ' upstream status');
      return body;
    }
    const trackID = Number(process.env.YESPLAYMUSIC_TRACK_ID || 29723096);
    assert.ok(Number.isSafeInteger(trackID) && trackID > 0, 'YESPLAYMUSIC_TRACK_ID must be a positive song ID');
    const track = (await api('song/detail', { ids: String(trackID) })).songs[0];
    const audio = (await api('song/url', { id: String(trackID) })).data[0];
    assert.equal(track.id, trackID);
    assert.equal(audio.freeTrialInfo, null, 'live fixture must have a full audio source');
    assert.ok(audio.url && audio.size > 1_000_000);

    await page.goto(base);
    await expect(page.locator('#desktop')).toBeVisible();
    await page.evaluate(async () => { await import('/app.js'); });
    await page.locator('#launcher-button').click();
    await page.locator('#launcher-search').fill('YesPlayMusic');
    await page.locator('#launcher-apps [data-launch="yesplaymusic"]').click();
    const appWindow = page.locator('#yesplaymusic-window');
    const frame = page.frameLocator('#yesplaymusic-window iframe');
    await expect(frame.locator('.home')).toBeVisible();
    await expect(appWindow).toHaveAttribute('data-runtime-phase', 'running');
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    assert.deepEqual(await frame.locator('body').evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('settings'));
      return { language: settings.lang, appearance: settings.appearance, profile: window.__ARISAKA_MUSIC__.profile };
    }), { language: 'zh-CN', appearance: 'dark', profile: 'default' });

    await frame.locator('input[type="search"]').fill(track.name + ' ' + track.ar[0].name);
    await frame.locator('input[type="search"]').press('Enter');
    await expect(frame.locator('.search-page .track').first()).toBeVisible();
    const index = await frame.locator('.search-page .track').evaluateAll((nodes, id) => nodes.findIndex(node => node.__vue__?.track?.id === id), trackID);
    assert.ok(index >= 0, 'the real search results contain the verified playable track');
    await frame.locator('.search-page .track').nth(index).locator('.title').dblclick();
    await expect.poll(() => frame.locator('body').evaluate((_body, id) => {
      const player = window.yesplaymusic.player;
      return player.currentTrackID === id && player.playing && player.seek() > 1;
    }, trackID), { timeout: 45000 }).toBe(true);
    const playing = await frame.locator('body').evaluate(() => {
      const player = window.yesplaymusic.player;
      const node = player._howler._sounds[0]._node;
      window.musicInstance = crypto.randomUUID();
      return { instance: window.musicInstance, position: player.seek(), duration: node.duration, readyState: node.readyState };
    });
    assert.ok(playing.duration > 120 && playing.readyState >= 2, 'browser has decoded the full audio resource');
    assert.ok(media.some(response => [200, 206].includes(response.status) && /audio\//.test(response.type)), 'browser fetched real audio bytes');
    await page.screenshot({ path: output + '/desktop-playing.png' });

    await appWindow.locator('[data-window-action="minimize"]').click();
    await expect(appWindow).toBeHidden();
    await expect.poll(() => frame.locator('body').evaluate(() => window.yesplaymusic.player.seek())).toBeGreaterThan(playing.position + 1);
    await page.locator('#tasks [data-task="yesplaymusic"]').click();
    await expect(appWindow).toBeVisible();
    assert.equal(await frame.locator('body').evaluate(() => window.musicInstance), playing.instance);

    await frame.locator('.player .middle-control-buttons .play').click();
    await expect.poll(() => frame.locator('body').evaluate(() => window.yesplaymusic.player.playing)).toBe(false);
    await frame.locator('.player .middle-control-buttons .play').click();
    await expect.poll(() => frame.locator('body').evaluate(() => window.yesplaymusic.player.playing)).toBe(true);
    await frame.locator('body').evaluate(() => {
      document.querySelector('#app').__vue__.$store.commit('updateSettings', { key: 'musicQuality', value: 128000 });
    });
    await appWindow.locator('[data-window-action="close"]').click();
    await expect(appWindow.locator('iframe')).toHaveCount(0);
    assert.equal(page.frames().length, 1, 'closing disposes the entire audio document');
    await page.locator('.desktop-icons [data-launch="yesplaymusic"]').dblclick();
    await expect(frame.locator('.home')).toBeVisible();
    assert.equal(await frame.locator('body').evaluate(() => JSON.parse(localStorage.getItem('settings')).musicQuality), 128000);
    assert.equal(await frame.locator('body').evaluate(() => window.musicInstance), undefined);
    await appWindow.locator('[data-window-action="close"]').click();

    const qr = await api('login/qr/key', {});
    const image = await api('login/qr/create', { key: qr.data.unikey, qrimg: true });
    assert.match(image.data.qrimg, /^data:image\/svg\+xml;base64,/);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: output + '/live-failure.png' }).catch(() => {});
    const musicFrame = page.frames().find(frame => /\/yesplaymusic\/profiles\//.test(frame.url()));
    const playback = await musicFrame?.evaluate(() => {
      const player = window.yesplaymusic?.player;
      const node = player?._howler?._sounds?.[0]?._node;
      return {
        trackID: player?.currentTrackID, playing: player?.playing, position: player?.seek(),
        audio: node && { readyState: node.readyState, networkState: node.networkState, paused: node.paused, duration: node.duration, error: node.error?.code },
      };
    }).catch(() => undefined);
    throw new Error(error.message + '\nBrowser errors: ' + JSON.stringify(errors)
      + '\nPlayback: ' + JSON.stringify(playback) + '\nMedia responses: ' + JSON.stringify(media), { cause: error });
  } finally { await context.close(); }
});
