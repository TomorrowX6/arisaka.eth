import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 15000 });
const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function desktop(prepare = async () => {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  assert.equal((await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } })).status(), 200);
  const config = await (await context.request.get(base + '/runtime-config.json')).json();
  const calls = [];
  for (const app of Object.values(config)) await context.route(new URL(app.url).origin + '/**', async route => {
    calls.push(route.request().url());
    await route.fulfill({ contentType: 'text/html', headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'cross-origin',
    }, body: '<!doctype html><html><body><button id="fixture-input">Runtime fixture</button><script>window.instanceId=crypto.randomUUID();</script></body></html>' });
  });
  const page = await context.newPage();
  await prepare({ context, page, config });
  await page.goto(base);
  await expect(page.locator('#desktop')).toBeVisible();
  await page.evaluate(async () => { await import('/app.js'); });
  return { context, page, config, calls };
}
async function launch(page, id) {
  await page.locator('.desktop-icons [data-launch="' + id + '"]').dblclick();
  await expect(page.locator('#' + id + '-window')).toBeVisible();
}

test('runtime windows load lazily, retain their frame on minimize, and release it on close', { timeout: 60000 }, async () => {
  const { context, page, calls } = await desktop();
  try {
    assert.equal(calls.length, 0);
    assert.equal(await page.locator('.runtime-frame').count(), 0);
    await page.locator('#launcher-button').click();
    await page.locator('#launcher-search').fill('Minecraft');
    await expect(page.locator('#launcher-apps [data-launch="minecraft"]')).toBeVisible();
    assert.equal(calls.length, 0, 'searching does not download a runtime');
    await page.locator('#launcher-apps [data-launch="minecraft"]').click();
    const frame = page.frameLocator('#minecraft-window iframe');
    await expect(frame.locator('#fixture-input')).toBeVisible();
    assert.equal(await frame.locator('body').evaluate(() => document.hasFocus()), true, 'the runtime receives keyboard focus, including apps that cancel mousedown');
    const identity = await frame.locator('body').evaluate(() => window.instanceId);
    await launch(page, 'minecraft');
    assert.equal(calls.length, 1);
    await page.locator('#minecraft-window [data-window-action="minimize"]').click();
    await expect(page.locator('#minecraft-window')).toBeHidden();
    await page.locator('#tasks [data-task="minecraft"]').click();
    await expect(frame.locator('#fixture-input')).toBeVisible();
    assert.equal(await frame.locator('body').evaluate(() => window.instanceId), identity);
    assert.equal(await frame.locator('body').evaluate(() => document.hasFocus()), true, 'restoring a game hands keyboard input back to its frame');
    assert.equal(await page.evaluate(async () => {
      const { createWindowPreview } = await import('/previews.js');
      const preview = createWindowPreview(document.getElementById('minecraft-window'), { width: 260, height: 160 });
      document.body.append(preview); const count = preview.querySelectorAll('iframe').length; preview.remove(); return count;
    }), 0, 'task previews never instantiate another runtime');
    await page.locator('#minecraft-window [data-window-action="close"]').click();
    await expect(page.locator('#minecraft-window iframe')).toHaveCount(0);
    await launch(page, 'minecraft');
    await expect(frame.locator('#fixture-input')).toBeVisible();
    assert.notEqual(await frame.locator('body').evaluate(() => window.instanceId), identity);
    const source = await page.locator('#minecraft-window [data-runtime-external]').getAttribute('href');
    assert.equal(new URLSearchParams(new URL(source).hash.slice(1)).get('profile'), 'default');
    assert.equal(new URLSearchParams(new URL(source).hash.slice(1)).has('channel'), false);
  } finally { await context.close(); }
});

test('reloading the desktop remembers runtime geometry without downloading or reopening runtimes', { timeout: 60000 }, async () => {
  let configRequests = 0;
  const { context, page, calls } = await desktop(async ({ page }) => {
    page.on('request', request => { if (new URL(request.url()).pathname === '/runtime-config.json') configRequests++; });
  });
  const geometry = {
    minecraft: { left: '180px', top: '90px', width: '990px', height: '700px' },
    firefox: { left: '220px', top: '120px', width: '950px', height: '660px' },
    yesplaymusic: { left: '140px', top: '80px', width: '1080px', height: '740px' },
  };
  const identities = {};
  try {
    assert.equal(configRequests, 0);
    assert.equal(calls.length, 0);
    for (const id of Object.keys(geometry)) {
      await launch(page, id);
      const frame = page.frameLocator('#' + id + '-window iframe');
      await expect(frame.locator('#fixture-input')).toBeVisible();
      identities[id] = await frame.locator('body').evaluate(() => window.instanceId);
      await page.locator('#' + id + '-window').evaluate((node, bounds) => Object.assign(node.style, bounds), geometry[id]);
    }
    assert.equal(configRequests, Object.keys(geometry).length);
    assert.equal(calls.length, Object.keys(geometry).length);
    await page.reload();
    await page.evaluate(async () => { await import('/app.js'); });
    await expect(page.locator('#desktop')).toBeVisible();
    assert.equal(configRequests, Object.keys(geometry).length, 'session restoration does not request runtime configuration');
    assert.equal(calls.length, Object.keys(geometry).length, 'session restoration does not download a runtime');
    await expect(page.locator('.runtime-frame')).toHaveCount(0);
    for (const id of Object.keys(geometry)) {
      const node = page.locator('#' + id + '-window');
      await expect(node).toBeHidden();
      await launch(page, id);
      const frame = page.frameLocator('#' + id + '-window iframe');
      await expect(frame.locator('#fixture-input')).toBeVisible();
      const identity = await frame.locator('body').evaluate(() => window.instanceId);
      assert.notEqual(identity, identities[id]);
      assert.deepEqual(await node.evaluate(node => {
        const { left, top, width, height } = node.style;
        return { left, top, width, height };
      }), geometry[id], 'explicit launch retains the saved window geometry');
      await node.locator('[data-window-action="minimize"]').click();
      await expect(node).toBeHidden();
      await page.locator('#tasks [data-task="' + id + '"]').click();
      await expect(frame.locator('#fixture-input')).toBeVisible();
      assert.equal(await frame.locator('body').evaluate(() => window.instanceId), identity);
    }
    assert.equal(configRequests, Object.keys(geometry).length * 2, 'only an explicit launch fetches fresh configuration');
    assert.equal(calls.length, Object.keys(geometry).length * 2, 'each explicit launch creates one frame, retained across minimize/restore');
  } finally { await context.close(); }
});

test('closing while configuration is pending cannot create a hidden runtime later', { timeout: 45000 }, async () => {
  let release, entered;
  const requested = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { context, page, calls } = await desktop(async ({ page, config }) => {
    await page.route('**/runtime-config.json', async route => {
      entered(); await pending;
      await route.fulfill({ json: config }).catch(() => {});
    });
  });
  try {
    await launch(page, 'minecraft'); await requested;
    await page.locator('#minecraft-window [data-window-action="close"]').click(); release();
    await expect(page.locator('#minecraft-window')).toBeHidden();
    await expect(page.locator('#minecraft-window iframe')).toHaveCount(0);
    assert.equal(calls.length, 0);
    await launch(page, 'minecraft');
    await expect(page.frameLocator('#minecraft-window iframe').locator('#fixture-input')).toBeVisible();
    assert.equal(calls.length, 1);
  } finally { release(); await context.close(); }
});

test('clicking a background runtime hands keyboard input back to its canvas window', { timeout: 45000 }, async () => {
  const { context, page } = await desktop();
  try {
    await launch(page, 'minecraft');
    const frame = page.frameLocator('#minecraft-window iframe');
    await expect(frame.locator('#fixture-input')).toBeVisible();
    await frame.locator('body').evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block;width:100vw;height:100vh';
      canvas.addEventListener('mousedown', event => event.preventDefault());
      document.body.style.margin = '0'; document.body.replaceChildren(canvas);
      window.runtimeKeys = '';
      document.addEventListener('keydown', event => { if (event.key.length === 1) window.runtimeKeys += event.key; });
    });
    await launch(page, 'console');
    await expect(page.locator('#console-window')).toHaveClass(/focused/);
    await page.locator('#minecraft-window .runtime-content').click({ position: { x: 1060, y: 120 } });
    await expect(page.locator('#minecraft-window')).toHaveClass(/focused/);
    assert.equal(await frame.locator('body').evaluate(() => document.hasFocus()), true, 'the activating click restores the child keyboard focus');
    await page.keyboard.type('first');
    assert.equal(await frame.locator('body').evaluate(() => window.runtimeKeys), 'first');
    const engine = page.locator('#minecraft-window [data-runtime-engine]');
    await engine.click(); await page.keyboard.press('Escape');
    await expect(engine).toBeFocused();
    await frame.locator('canvas').click();
    await page.keyboard.type('second');
    assert.equal(await frame.locator('body').evaluate(() => window.runtimeKeys), 'firstsecond', 'canvas input resumes after using the native toolbar');
  } finally { await context.close(); }
});

test('Minecraft status requires the current frame, origin, and launch channel', { timeout: 45000 }, async () => {
  const { context, page } = await desktop();
  try {
    await launch(page, 'minecraft');
    const frame = page.frameLocator('#minecraft-window iframe');
    await expect(frame.locator('#fixture-input')).toBeVisible();
    const original = await page.locator('#minecraft-window iframe').getAttribute('src');
    const channel = new URLSearchParams(new URL(original).hash.slice(1)).get('channel');
    const send = (origin, fromFrame, token, text) => page.evaluate(({ origin, fromFrame, token, text }) => {
      window.dispatchEvent(new MessageEvent('message', { origin, source: fromFrame ? document.querySelector('#minecraft-window iframe').contentWindow : window,
        data: { type: 'arisaka:runtime', app: 'minecraft', channel: token, phase: 'loading', message: text } }));
    }, { origin, fromFrame, token, text });
    const origin = new URL(original).origin;
    await send('https://other.example', true, channel, 'FORGED');
    await send(origin, false, channel, 'FORGED');
    await send(origin, true, 'old-channel', 'FORGED');
    await expect(page.locator('#minecraft-window [data-runtime-status]')).not.toContainText('FORGED');
    await frame.locator('body').evaluate(() => {
      const params = new URLSearchParams(location.hash.slice(1));
      parent.postMessage({ type: 'arisaka:runtime', app: 'minecraft', channel: params.get('channel'), phase: 'loading', message: 'Verified progress' }, params.get('parent'));
    });
    await expect(page.locator('#minecraft-window [data-runtime-status]')).toHaveText('Verified progress');
    await page.locator('#minecraft-window [data-runtime-reload]').click();
    await expect(frame.locator('#fixture-input')).toBeVisible();
    await send(origin, true, channel, 'STALE');
    await expect(page.locator('#minecraft-window [data-runtime-status]')).not.toContainText('STALE');
  } finally { await context.close(); }
});

test('YesPlayMusic keeps its profile and playing instance until the music window closes', { timeout: 60000 }, async () => {
  const { context, page, calls, config } = await desktop();
  try {
    assert.equal(calls.length, 0);
    await page.locator('#launcher-button').click();
    await page.locator('#launcher-search').fill('YesPlayMusic');
    await page.locator('#launcher-apps [data-launch="yesplaymusic"]').click();
    const window = page.locator('#yesplaymusic-window');
    const frame = page.frameLocator('#yesplaymusic-window iframe');
    await expect(frame.locator('#fixture-input')).toBeVisible();
    const identity = await frame.locator('body').evaluate(() => window.instanceId);
    const original = new URL(await window.locator('iframe').getAttribute('src'));
    assert.equal(original.origin, new URL(config.yesplaymusic.url).origin);
    assert.equal(original.pathname, '/yesplaymusic/profiles/default/');
    assert.equal(await window.locator('iframe').evaluate(node => Boolean(node.credentialless)), false, 'the music application retains profile storage');
    await expect(window.locator('.runtime-session-label, [data-runtime-engine]')).toHaveCount(0);
    await expect(window.locator('[data-runtime-external]')).toHaveAttribute('href', original.origin + original.pathname);
    await window.locator('[data-window-action="minimize"]').click();
    await expect(window).toBeHidden();
    await expect(window.locator('iframe')).toHaveCount(1, { timeout: 5000 });
    await page.locator('#tasks [data-task="yesplaymusic"]').click();
    await expect(frame.locator('#fixture-input')).toBeVisible();
    assert.equal(await frame.locator('body').evaluate(() => window.instanceId), identity, 'minimize and restore retain the playing instance');
    await window.locator('[data-window-action="close"]').click();
    await expect(window.locator('iframe')).toHaveCount(0);
    await launch(page, 'yesplaymusic');
    await expect(frame.locator('#fixture-input')).toBeVisible();
    assert.notEqual(await frame.locator('body').evaluate(() => window.instanceId), identity, 'reopening creates a new player');
    const reopened = new URL(await window.locator('iframe').getAttribute('src'));
    assert.equal(reopened.pathname, original.pathname, 'reopening keeps the same desktop profile');
    assert.notEqual(reopened.hash, original.hash, 'each launch has a separate status channel');
  } finally { await context.close(); }
});

test('YesPlayMusic status accepts only its current frame and launch channel', { timeout: 45000 }, async () => {
  const { context, page } = await desktop();
  try {
    await launch(page, 'yesplaymusic');
    const frame = page.frameLocator('#yesplaymusic-window iframe');
    await expect(frame.locator('#fixture-input')).toBeVisible();
    const url = new URL(await page.locator('#yesplaymusic-window iframe').getAttribute('src'));
    const channel = new URLSearchParams(url.hash.slice(1)).get('channel');
    await page.evaluate(({ origin, channel }) => {
      const source = document.querySelector('#yesplaymusic-window iframe').contentWindow;
      for (const event of [
        { origin: 'https://wrong.example', source, channel },
        { origin, source: window, channel },
        { origin, source, channel: 'stale' },
      ]) window.dispatchEvent(new MessageEvent('message', { ...event, data: { type: 'arisaka:runtime', app: 'yesplaymusic', channel: event.channel, phase: 'running', message: 'FORGED' } }));
    }, { origin: url.origin, channel });
    await expect(page.locator('#yesplaymusic-window [data-runtime-status]')).not.toContainText('FORGED');
    await frame.locator('body').evaluate(() => {
      const params = new URLSearchParams(location.hash.slice(1));
      parent.postMessage({ type: 'arisaka:runtime', app: 'yesplaymusic', channel: params.get('channel'), phase: 'running', message: 'YesPlayMusic' }, params.get('parent'));
    });
    await expect(page.locator('#yesplaymusic-window')).toHaveAttribute('data-runtime-phase', 'running');
    await expect(page.locator('#yesplaymusic-window [data-runtime-status]')).toHaveText('YesPlayMusic');
    await page.locator('#yesplaymusic-window [data-window-action="close"]').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('#yesplaymusic-window iframe')).toHaveCount(0);
  } finally { await context.close(); }
});

test('Firefox uses the real external origin in an isolated temporary session', { timeout: 45000 }, async () => {
  const { context, page, config } = await desktop();
  try {
    await launch(page, 'firefox');
    const frame = page.locator('#firefox-window iframe');
    await expect(page.frameLocator('#firefox-window iframe').locator('#fixture-input')).toBeVisible();
    assert.equal(await frame.getAttribute('src'), config.firefox.url);
    assert.equal(await frame.evaluate(frame => frame.credentialless), true);
    assert.equal(await page.frameLocator('#firefox-window iframe').locator('body').evaluate(() => crossOriginIsolated), true);
    await expect(page.locator('#firefox-window .runtime-session-label')).toHaveText('临时会话');
    await expect(page.locator('#firefox-window [data-runtime-external]')).toHaveAttribute('href', config.firefox.url);
    await expect(page.locator('#firefox-window [data-runtime-status]')).not.toContainText('运行中');
    await page.locator('#firefox-window [data-window-action="close"]').click();
    await expect(frame).toHaveCount(0);
  } finally { await context.close(); }
});

test('canceling an engine change retains the running engine and keyboard focus', { timeout: 45000 }, async () => {
  const { context, page, calls } = await desktop();
  try {
    await launch(page, 'minecraft');
    const frame = page.frameLocator('#minecraft-window iframe');
    await expect(frame.locator('#fixture-input')).toBeVisible();
    const identity = await frame.locator('body').evaluate(() => window.instanceId);
    await frame.locator('body').evaluate(() => {
      const params = new URLSearchParams(location.hash.slice(1));
      parent.postMessage({ type: 'arisaka:runtime', app: 'minecraft', channel: params.get('channel'), phase: 'running', message: 'Minecraft 1.12.2' }, params.get('parent'));
    });
    await expect(page.locator('#minecraft-window')).toHaveAttribute('data-runtime-phase', 'running');
    const engine = page.locator('#minecraft-window [data-runtime-engine]');
    await engine.selectOption('javascript');
    await page.getByRole('dialog', { name: '重新启动 Minecraft', exact: true }).getByRole('button', { name: '继续游戏' }).click();
    await expect(engine).toHaveValue('auto');
    assert.equal(await frame.locator('body').evaluate(() => window.instanceId), identity);
    assert.equal(await frame.locator('body').evaluate(() => document.hasFocus()), true);
    assert.equal(calls.length, 1);
    await engine.selectOption('javascript');
    await page.getByRole('dialog', { name: '重新启动 Minecraft', exact: true }).getByRole('button', { name: '重新启动', exact: true }).click();
    await expect.poll(() => frame.locator('body').evaluate(() => window.instanceId)).not.toBe(identity);
    await expect(engine).toHaveValue('javascript');
    const url = await page.locator('#minecraft-window iframe').getAttribute('src');
    assert.equal(new URLSearchParams(new URL(url).hash.slice(1)).get('engine'), 'javascript');
  } finally { await context.close(); }
});

test('unsupported Firefox browsers get an actionable message before engine download', { timeout: 45000 }, async () => {
  const { context, page, calls } = await desktop(async ({ context }) => {
    await context.addInitScript(() => { Object.defineProperty(WebAssembly, 'Suspending', { value: undefined }); });
  });
  try {
    await launch(page, 'firefox');
    await expect(page.locator('#firefox-window [data-runtime-message]')).toContainText('最新版 Chrome 或 Edge');
    await expect(page.locator('#firefox-window iframe')).toHaveCount(0);
    assert.equal(calls.length, 0);
  } finally { await context.close(); }
});
