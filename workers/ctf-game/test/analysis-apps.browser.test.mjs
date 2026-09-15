import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
import { seededRandom } from '../scripts/core.mjs';
import { logicEvidence } from '../scripts/expert/logic.mjs';

const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const expect = baseExpect.configure({ timeout: 20000 });
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
after(async () => { await browser?.close(); });

async function desktop(viewport = { width: 1440, height: 980 }) {
  const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  const started = await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } });
  assert.equal(started.status(), 200);
  await page.goto(base, { waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible();
  return { context, page, errors };
}
async function launch(page, id, name) {
  await page.locator('#launcher-button').click(); await page.locator('#launcher-search').fill(name);
  await page.locator('#launcher-apps [data-launch="' + id + '"]').click(); await expect(page.locator('#' + id + '-window')).toBeVisible();
  await page.waitForFunction(id => !document.querySelector('#' + id + '-window').dataset.motionState, id);
}
async function saveAs(page, button, name) {
  await page.locator(button).click(); await page.locator('dialog[open] input').fill(name);
  await page.locator('dialog[open]').getByRole('button', { name: '确定', exact: true }).click(); await expect(page.locator('dialog[open]')).toHaveCount(0);
}
async function openWith(page, button, name) {
  await page.locator(button).click();
  try { await page.locator('dialog[open] [data-name]').fill(name); }
  catch (error) {
    const state = await page.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, focus: document.activeElement?.outerHTML, dialogs: [...document.querySelectorAll('dialog')].map(node => node.outerHTML.slice(0, 1000)) }));
    throw new Error('File chooser did not open: ' + JSON.stringify(state), { cause: error });
  }
  await page.locator('dialog[open] button[type=submit]').click(); await expect(page.locator('dialog[open]')).toHaveCount(0);
}
async function files(page, value) {
  return page.evaluate(async value => {
    const { createFilesystem } = await import('/filesystem.js'), { apiFetch } = await import('/transport.js');
    const state = await (await apiFetch('/api/session')).json();
    const fs = createFilesystem({ state: () => state, notes: () => ({ text: '', receipts: [] }), api: async path => (await apiFetch(path)).json() });
    await fs.setPlayer(state.player);
    if (value.write) { await fs.writeFile(value.name, value.bytes ? new Uint8Array(value.bytes) : value.text); return; }
    return Array.from(await fs.read('/home/user/Documents/' + value.name));
  }, value);
}

test('desktop readiness waits for delayed initial navigation before exposing launcher input', { timeout: 90000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } }), page = await context.newPage();
  let release; const barrier = new Promise(resolve => release = resolve);
  try {
    assert.equal((await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } })).status(), 200);
    await context.route('**/api/cases/1', async route => { await barrier; await route.continue().catch(() => {}); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#desktop')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#desktop')).toBeHidden(); await expect(page.locator('#gate')).toBeVisible();
    release(); await expect(page.locator('#desktop')).toBeVisible(); await expect(page.locator('#gate')).toBeHidden();
    await expect(page.locator('#desktop')).not.toHaveAttribute('aria-busy', 'true');
    await launch(page, 'pipeline', '数据工坊'); await page.locator('#pipeline-input').fill('41'); await page.locator('#pipeline-run').click();
    await expect(page.locator('#pipeline-output')).toHaveValue('41'); await expect(page.locator('#pipeline-window')).toHaveClass(/focused/);
  } finally { release(); await context.close(); }
});

test('data recipes execute in a real Worker, save exact bytes and round-trip through the workspace', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'pipeline', '数据工坊');
    await page.locator('#pipeline-input').fill('48 69 00 ff');
    await page.locator('#pipeline-input').press('Control+Enter');
    await expect(page.locator('#pipeline-output')).toHaveValue('48 69 00 ff');
    await expect(page.locator('#pipeline-history')).toContainText('fromHex: 11 → 4 B');
    await saveAs(page, '#pipeline-save-output', 'exact.bin');
    assert.deepEqual(await files(page, { name: 'exact.bin' }), [72, 105, 0, 255]);
    await saveAs(page, '#pipeline-save-recipe', 'byte-recipe.json');
    await page.locator('#pipeline-add').click(); await page.locator('#pipeline-steps li').nth(1).locator('select').selectOption('reverse');
    await expect(page.locator('#pipeline-save-output')).toBeDisabled();
    await page.locator('#pipeline-run').click(); await expect(page.locator('#pipeline-output')).toHaveValue('ff 00 69 48');
    await openWith(page, '#pipeline-load-recipe', 'byte-recipe.json');
    await expect(page.locator('#pipeline-steps li')).toHaveCount(1); await page.locator('#pipeline-run').click();
    await expect(page.locator('#pipeline-output')).toHaveValue('48 69 00 ff');
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible();
    await launch(page, 'pipeline', '数据工坊'); await openWith(page, '#pipeline-open', 'exact.bin');
    await expect(page.locator('#pipeline-input')).toHaveAttribute('readonly', '');
    await page.locator('#pipeline-steps li select').selectOption('toBase64'); await page.locator('#pipeline-run').click();
    await page.locator('#pipeline-output-format').selectOption('UTF-8'); await expect(page.locator('#pipeline-output')).toHaveValue('SGkA/w==');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('data recipe failure, cancellation and subsequent execution never expose stale output', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'pipeline', '数据工坊'); await page.locator('#pipeline-input').fill('not hex'); await page.locator('#pipeline-run').click();
    await expect(page.locator('#pipeline-status')).toContainText('第 1 步'); await expect(page.locator('#pipeline-save-output')).toBeDisabled();
    let release; const blocker = new Promise(resolve => { release = resolve; });
    await context.route('**/analysis-worker.js', async route => { await blocker; await route.continue().catch(() => {}); });
    await page.locator('#pipeline-input').fill('41'); await page.locator('#pipeline-run').click();
    await expect(page.locator('#pipeline-stop')).toBeEnabled(); await page.locator('#pipeline-stop').click(); release();
    await expect(page.locator('#pipeline-status')).toHaveText('已停止'); await expect(page.locator('#pipeline-output')).toHaveValue('');
    await context.unroute('**/analysis-worker.js');
    await page.locator('#pipeline-run').click(); await expect(page.locator('#pipeline-output')).toHaveValue('41');
    await page.locator('#pipeline-input').fill('42'); await expect(page.locator('#pipeline-save-output')).toBeDisabled(); await expect(page.locator('#pipeline-output')).toHaveValue('');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('VCD application renders full hardware evidence, decodes SPI, paginates and saves lossless analysis', { timeout: 120000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const evidence = logicEvidence('browser-fixture', seededRandom(Buffer.alloc(32, 0x65), 'vcd-browser'));
    await files(page, { write: true, name: 'probe.vcd', text: evidence['bus.vcd'] });
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible();
    await launch(page, 'logic', '逻辑分析仪'); await openWith(page, '#logic-open', 'probe.vcd');
    await expect(page.locator('#logic-signals input')).toHaveCount(5); await expect(page.locator('#logic-status')).toContainText('5 路');
    await page.locator('#logic-mode').selectOption('3'); await page.locator('#logic-decode').click();
    await expect(page.locator('#logic-status')).toContainText('1 段不完整'); await expect(page.locator('#logic-transfers tr')).toHaveCount(80);
    await page.locator('#logic-transfers tr').first().press('Enter'); await expect(page.locator('#logic-detail')).toContainText('MOSI: 9f 00 00 00');
    await expect(page.locator('#logic-detail')).toContainText('MISO: 00 ef 40 19');
    await page.locator('#logic-next').click(); await expect(page.locator('#logic-page')).toContainText('2 /');
    await page.locator('#logic-prev').click(); await page.locator('#logic-zoom-in').click();
    const old = await page.locator('#logic-start').inputValue(); await page.locator('#logic-wave').press('ArrowRight');
    assert.notEqual(await page.locator('#logic-start').inputValue(), old);
    await page.locator('#logic-wave').click({ position: { x: 250, y: 70 } }); await expect(page.locator('#logic-cursor')).toContainText('游标');
    await saveAs(page, '#logic-save', 'captured-spi.json');
    const saved = JSON.parse(Buffer.from(await files(page, { name: 'captured-spi.json' })).toString());
    assert.equal(saved.format, 'arisaka-spi-capture-v1'); assert.equal(saved.options.mode, 3); assert.equal(saved.timescale.femtoseconds, '1000000');
    assert.equal(saved.transfers[1].complete, false); assert.ok(saved.transfers.length > 100); assert.deepEqual(saved.transfers[0].rx, [0, 239, 64, 25]);
    await page.locator('#logic-mode').selectOption('0'); await expect(page.locator('#logic-save')).toBeDisabled(); await expect(page.locator('#logic-transfers tr')).toHaveCount(0);
    await mkdir(new URL('../.private/professional-qa/', import.meta.url), { recursive: true });
    await page.screenshot({ path: new URL('../.private/professional-qa/logic-desktop.png', import.meta.url).pathname });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('new tools stay inside narrow screens and recipe controls remain keyboard-operable', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop({ width: 390, height: 844 });
  try {
    for (const [id, name] of [['pipeline', '数据工坊'], ['logic', '逻辑分析仪']]) {
      await launch(page, id, name); await page.waitForFunction(id => !document.querySelector('#' + id + '-window').dataset.motionState, id);
      const window = page.locator('#' + id + '-window'), bounds = await window.boundingBox();
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 391);
      assert.ok(await window.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      if (id === 'pipeline') {
        await page.locator('#pipeline-add').focus(); await page.keyboard.press('Enter'); await expect(page.locator('#pipeline-steps li')).toHaveCount(2);
        await page.locator('#pipeline-steps li').nth(1).getByRole('button', { name: '上移第 2 步' }).press('Enter');
        await expect(page.locator('#pipeline-steps li select').first()).toHaveValue('toHex');
        await mkdir(new URL('../.private/professional-qa/', import.meta.url), { recursive: true });
        await page.screenshot({ path: new URL('../.private/professional-qa/pipeline-mobile.png', import.meta.url).pathname });
      }
      await window.locator('[data-window-action=close]').click();
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
