import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { chromium, expect as baseExpect } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 30000 });
const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser, config;
before(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext();
  config = await (await context.request.get(base + '/runtime-config.json')).json();
  await context.close(); await mkdir('.private/runtime-qa', { recursive: true });
});
after(async () => { await browser?.close(); });

async function desktop() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  assert.equal((await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } })).status(), 200);
  const page = await context.newPage();
  await page.goto(base); await expect(page.locator('#desktop')).toBeVisible();
  return { context, page };
}
async function launch(page, id) {
  await page.locator('.desktop-icons [data-launch="' + id + '"]').dblclick();
  await expect(page.locator('#' + id + '-window iframe')).toBeVisible();
  return page.frameLocator('#' + id + '-window iframe');
}

test('profile storage stays separate in the real IndexedDB API and both worker types', { timeout: 90000 }, async () => {
  const context = await browser.newContext();
  const origin = new URL(config.minecraft.url).origin;
  await context.route(origin + '/storage-probe', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Storage verification</title>',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  }));
  async function realm(namespace) {
    const page = await context.newPage(); await page.goto(origin + '/storage-probe');
    await page.evaluate(async ({ module, namespace }) => {
      window.physicalDatabases = IDBFactory.prototype.databases.bind(indexedDB);
      const { installRuntimeStorage } = await import(module); installRuntimeStorage(namespace);
    }, { module: new URL('storage.js', config.minecraft.url).href, namespace });
    return page;
  }
  try {
    const first = await realm('runtime-qa.first');
    await first.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('worlds', 1); request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onerror = () => reject(request.error); request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('files', 'readwrite');
        transaction.objectStore('files').put('saved world', 'level.dat'); transaction.oncomplete = () => { db.close(); resolve(); };
      };
    }));
    for (const type of ['classic', 'module']) {
      const read = await first.evaluate(type => new Promise((resolve, reject) => {
        const source = 'onmessage=()=>{const r=indexedDB.open("worlds");r.onsuccess=()=>{const d=r.result;const q=d.transaction("files").objectStore("files").get("level.dat");q.onsuccess=()=>{d.close();postMessage(q.result)}}};';
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Worker(url, { type });
        worker.onmessage = event => { worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
        worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
        worker.postMessage('read');
      }), type);
      assert.equal(read, 'saved world', type + ' worker uses its parent profile');
    }
    const second = await realm('runtime-qa.second');
    assert.deepEqual(await second.evaluate(() => indexedDB.databases()), []);
    const reopened = await realm('runtime-qa.first');
    assert.equal((await reopened.evaluate(() => indexedDB.databases()))[0].name, 'worlds');
    assert.equal((await first.evaluate(() => physicalDatabases()))[0].name, 'runtime-qa.first.vfs.worlds');
  } finally { await context.close(); }
});

async function minecraftCanvas(frame) {
  const canvas = frame.locator('canvas._eaglercraftX_canvas_element');
  await expect(canvas).toBeVisible({ timeout: 120000 });
  const { width, height } = await canvas.evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  const scale = Math.max(1, Math.min(Math.floor(width / 320), Math.floor(height / 240)));
  async function click(x, y) {
    await canvas.click({ position: { x: x * scale, y: y * scale }, delay: 150 });
    await new Promise(resolve => setTimeout(resolve, 220));
  }
  async function hasButton(x, y, buttonWidth = 200) {
    // Canvas creation precedes the Mojang loading screen. Wait for the actual
    // Minecraft button's black border and gray/hovered face before clicking.
    const screenshot = await canvas.screenshot();
    const [edge, ...face] = await canvas.page().evaluate(async ({ base64, points }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), value => value.charCodeAt(0))], { type: 'image/png' }));
      const output = new OffscreenCanvas(bitmap.width, bitmap.height), context = output.getContext('2d');
      context.drawImage(bitmap, 0, 0); bitmap.close();
      return points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
    }, { base64: screenshot.toString('base64'), points: [[x - buttonWidth / 2, y], [x - buttonWidth / 2 + 5, y - 4], [x - buttonWidth / 2 + 5, y + 4]].map(point => point.map(value => Math.floor(value * scale))) });
    return edge.slice(0, 3).every(value => value < 15)
      && face.every(([r, g, b]) => r >= 80 && r <= 190 && Math.abs(r - g) < 20 && b >= r - 3 && b <= r + 100);
  }
  async function waitButton(x, y, buttonWidth) {
    await expect.poll(() => hasButton(x, y, buttonWidth), { timeout: 120000, message: 'Minecraft menu button is ready at ' + x + ', ' + y }).toBe(true);
  }
  return { canvas, width: width / scale, height: height / scale, click, hasButton, waitButton,
    async button(x, y, buttonWidth) { await waitButton(x, y, buttonWidth); await click(x, y); } };
}
async function finishMinecraftStartup(gui) {
  const screens = { title: gui.height / 4 + 58, profile: gui.height / 6 + 179, notice: gui.height / 6 + 150 };
  // The pinned client can show Edit Profile again when it is relaunched.
  // Follow its real startup screens without assuming a direct title screen.
  for (let step = 0; step < 3; step++) {
    let screen;
    await expect.poll(async () => {
      for (const [name, y] of Object.entries(screens)) if (await gui.hasButton(gui.width / 2, y)) return screen = name;
      return null;
    }, { timeout: 120000 }).not.toBeNull();
    if (screen === 'title') return;
    await gui.click(gui.width / 2, screens[screen]);
  }
  throw new Error('Minecraft did not reach its title screen');
}
async function worldRecords(frame) {
  return frame.locator('body').evaluate(async () => {
    const records = [];
    for (const { name } of await indexedDB.databases()) await new Promise((resolve, reject) => {
      const open = indexedDB.open(name); open.onerror = () => reject(open.error); open.onsuccess = async () => {
        const db = open.result;
        for (const store of db.objectStoreNames) await new Promise((done, fail) => {
          const cursor = db.transaction(store).objectStore(store).openCursor();
          cursor.onerror = () => fail(cursor.error); cursor.onsuccess = () => {
            if (!cursor.result) { done(); return; }
            const { key, value } = cursor.result;
            if (JSON.stringify(key).endsWith('/level.dat"]')) records.push({ name, key, bytes: [...new Uint8Array(value.data)] });
            cursor.result.continue();
          };
        });
        db.close(); resolve();
      };
    });
    return records;
  });
}
async function acceptClose(page) {
  await page.locator('#minecraft-window [data-window-action="close"]').click();
  await page.getByRole('dialog', { name: '关闭 Minecraft', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('#minecraft-window iframe')).toHaveCount(0);
}

test('Minecraft 1.12.2 creates, plays, saves, and reopens the same world in both engines', { timeout: 300000 }, async () => {
  const { context, page } = await desktop();
  let joins = 0;
  page.on('console', message => { if (message.text().includes('joined the game')) joins++; });
  try {
    let frame = await launch(page, 'minecraft');
    let gui = await minecraftCanvas(frame);
    // The upstream UI is rendered entirely by WebGL. These coordinates are
    // Minecraft GUI units, scaled from its actual canvas, not DOM substitutes.
    await gui.waitButton(gui.width / 2, gui.height / 6 + 179);
    await gui.click(gui.width / 2 + 50, gui.height / 6 + 35);
    await page.keyboard.press('End', { delay: 150 });
    for (let i = 0; i < 16; i++) await page.keyboard.press('Backspace', { delay: 40 });
    await page.keyboard.type('ArisakaQA', { delay: 80 });
    await gui.button(gui.width / 2, gui.height / 6 + 179);
    await gui.button(gui.width / 2, gui.height / 6 + 150); // Upstream first-run notice.
    await gui.button(gui.width / 2, gui.height / 4 + 58); // Singleplayer.
    await gui.button(gui.width / 2 + 79, gui.height - 42, 150); // Create world.
    await gui.button(gui.width / 2, gui.height / 2 - 32); // Create, rather than import.
    await gui.waitButton(gui.width / 2, 125, 150);
    await gui.click(gui.width / 2, 70);
    await page.keyboard.press('Control+a', { delay: 150 }); await page.keyboard.type('Arisaka_QA', { delay: 80 });
    await gui.click(gui.width / 2, 125); await gui.click(gui.width / 2, 125); // Creative.
    await gui.button(gui.width / 2 - 80, gui.height - 18, 150);
    await expect.poll(() => joins, { timeout: 120000 }).toBe(1);
    await expect.poll(async () => (await worldRecords(frame)).some(record => String(record.key).includes('Arisaka_QA')), { timeout: 120000 }).toBe(true);
    await page.waitForTimeout(5000);
    await page.keyboard.press('Space', { delay: 100 }); await page.keyboard.press('Space', { delay: 100 });
    await page.keyboard.down('Space'); await page.waitForTimeout(2000); await page.keyboard.up('Space');
    await page.keyboard.down('w'); await page.waitForTimeout(300); await page.keyboard.up('w');
    await page.keyboard.press('Escape', { delay: 150 });
    await gui.waitButton(gui.width / 2, gui.height / 4 + 114);
    await page.screenshot({ path: '.private/runtime-qa/minecraft-world.png' });
    await gui.button(gui.width / 2, gui.height / 4 + 114); // Save and quit.
    await gui.waitButton(gui.width / 2, gui.height / 4 + 58);
    await expect.poll(async () => {
      const [record] = await worldRecords(frame);
      return record ? gunzipSync(Buffer.from(record.bytes)).includes(Buffer.from('Player')) : false;
    }, { timeout: 30000 }).toBe(true);
    const [saved] = await worldRecords(frame);
    const data = gunzipSync(Buffer.from(saved.bytes));
    assert.ok(data.includes(Buffer.from('Arisaka_QA')), 'the game saved the typed world name');
    assert.ok(data.includes(Buffer.from('1.12.2')), 'the save records the actual Minecraft version');
    const originalData = Buffer.from(saved.bytes);
    await acceptClose(page);
    await page.locator('#minecraft-window [data-runtime-engine]').selectOption('javascript');
    frame = await launch(page, 'minecraft'); gui = await minecraftCanvas(frame);
    await expect(page.locator('#minecraft-window [data-runtime-status]')).toContainText('JavaScript', { timeout: 120000 });
    await finishMinecraftStartup(gui);
    assert.deepEqual(Buffer.from((await worldRecords(frame))[0].bytes), originalData, 'compatibility mode sees the exact saved world');
    await gui.button(gui.width / 2, gui.height / 4 + 58);
    await gui.waitButton(gui.width / 2 + 79, gui.height - 42, 150);
    await gui.click(gui.width / 2, 54);
    await gui.button(gui.width / 2 - 79, gui.height - 42, 150);
    await expect.poll(() => joins, { timeout: 120000 }).toBe(2);
    await page.waitForTimeout(5000);
    await page.keyboard.press('Escape', { delay: 150 });
    await gui.waitButton(gui.width / 2, gui.height / 4 + 114);
    await page.screenshot({ path: '.private/runtime-qa/minecraft-javascript.png' });
    await gui.button(gui.width / 2, gui.height / 4 + 114);
    await gui.waitButton(gui.width / 2, gui.height / 4 + 58);
    await expect.poll(async () => Buffer.from((await worldRecords(frame))[0].bytes).equals(originalData), { timeout: 30000 }).toBe(false);
    await acceptClose(page);
  } catch (error) { await page.screenshot({ path: '.private/runtime-qa/minecraft-failure.png' }).catch(() => {}); throw error; }
  finally { await context.close(); }
});

test('Firefox boots real Gecko, navigates with its address bar, and survives minimize and resize', { timeout: 240000 }, async () => {
  const { context, page } = await desktop();
  try {
    const frame = await launch(page, 'firefox');
    await expect(frame.locator('#start-btn')).toBeVisible({ timeout: 120000 });
    assert.equal(await frame.locator('body').evaluate(() => crossOriginIsolated), true);
    await frame.locator('#start-btn').click();
    await expect.poll(() => frame.locator('body').evaluate(() => typeof window.geckoEvalChrome), { timeout: 120000 }).toBe('function');
    await expect.poll(() => frame.locator('body').evaluate(() => geckoEvalChrome('gBrowser.selectedBrowser.currentURI.spec')), { timeout: 90000 }).toContain('developer.puter.com');
    // Focus the real Firefox address bar rendered into its canvas, and type
    // a URL using actual keyboard events. No fake URL form or HTTP renderer.
    await page.locator('#firefox-window iframe').focus();
    await frame.locator('#screen').click({ position: { x: 380, y: 62 } });
    await page.keyboard.press('Control+a'); await page.keyboard.type('https://example.com/'); await page.keyboard.press('Enter');
    await expect.poll(() => frame.locator('body').evaluate(() => geckoEvalChrome('gBrowser.selectedBrowser.contentTitle')), { timeout: 90000 }).toBe('Example Domain');
    const info = JSON.parse(await frame.locator('body').evaluate(() => geckoEvalChrome('JSON.stringify({version:Services.appinfo.version,url:gBrowser.selectedBrowser.currentURI.spec})')));
    assert.match(info.version, /^\d+\./); assert.equal(info.url, 'https://example.com/');
    await page.screenshot({ path: '.private/runtime-qa/firefox-website.png' });
    await page.locator('#firefox-window [data-window-action="minimize"]').click();
    await expect(page.locator('#firefox-window')).toBeHidden();
    await page.locator('#tasks [data-task="firefox"]').click();
    assert.equal(await frame.locator('body').evaluate(() => geckoEvalChrome('gBrowser.selectedBrowser.contentTitle')), 'Example Domain');
    await page.locator('#firefox-window [data-window-action="maximize"]').click();
    await expect.poll(() => frame.locator('#screen').evaluate(canvas => canvas.width === innerWidth && canvas.height === innerHeight), { timeout: 30000 }).toBe(true);
    await page.screenshot({ path: '.private/runtime-qa/firefox-maximized.png' });
    await page.locator('#firefox-window [data-window-action="close"]').click();
    await expect(page.locator('#firefox-window iframe')).toHaveCount(0);
  } catch (error) { await page.screenshot({ path: '.private/runtime-qa/firefox-failure.png' }).catch(() => {}); throw error; }
  finally { await context.close(); }
});
