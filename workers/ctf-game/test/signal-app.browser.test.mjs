import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
import { seededRandom } from '../scripts/core.mjs';
import { powerEvidence } from '../scripts/expert/power.mjs';

const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const expect = baseExpect.configure({ timeout: 20000 });
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
after(async () => { await browser?.close(); });
async function desktop(viewport = { width: 1440, height: 1050 }) {
  const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  assert.equal((await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } })).status(), 200);
  await page.goto(base, { waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible(); return { context, page, errors };
}
async function launch(page, id = 'signal', name = '信号分析台') {
  await page.locator('#launcher-button').click(); await page.locator('#launcher-search').fill(name);
  await page.locator('#launcher-apps [data-launch="' + id + '"]').click(); await expect(page.locator('#' + id + '-window')).toBeVisible();
  await page.waitForFunction(id => !document.querySelector('#' + id + '-window').dataset.motionState, id);
}
async function save(page, button, name) {
  await page.locator(button).click(); await page.locator('dialog[open] input').fill(name);
  await page.locator('dialog[open]').getByRole('button', { name: '确定', exact: true }).click(); await expect(page.locator('dialog[open]')).toHaveCount(0);
}
async function open(page, name) {
  await page.locator('#signal-open').click(); await page.locator('dialog[open] [data-name]').fill(name);
  await page.locator('dialog[open] button[type=submit]').click(); await expect(page.locator('dialog[open]')).toHaveCount(0);
}
async function files(page, value) {
  return page.evaluate(async value => {
    const { createFilesystem } = await import('/filesystem.js'), { apiFetch } = await import('/transport.js');
    const state = await (await apiFetch('/api/session')).json();
    const fs = createFilesystem({ state: () => state, notes: () => ({ text: '', receipts: [] }), api: async path => (await apiFetch(path)).json() });
    await fs.setPlayer(state.player);
    if (value.write) { await fs.writeFile(value.name, value.base64 ? Uint8Array.from(atob(value.base64), c => c.charCodeAt(0)) : value.text); return; }
    return new TextDecoder().decode(await fs.read('/home/user/Documents/' + value.name));
  }, value);
}
async function screenshot(page, name) {
  await mkdir(new URL('../.private/signal-qa/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('../.private/signal-qa/' + name + '.png', import.meta.url).pathname });
}

test('signal FFT runs in a real Worker, preserves calibrated bins and exports reproducible full reports', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop(), workers = [];
  page.on('worker', worker => workers.push(worker.url()));
  try {
    await launch(page); await page.locator('#signal-example').click(); await expect(page.locator('#signal-run')).toBeEnabled();
    await page.locator('#signal-kind').selectOption('spectrum'); await page.locator('#signal-run').click();
    await expect(page.locator('#signal-result-note')).toContainText('峰 64 Hz / 1'); await expect(page.locator('#signal-run')).toBeFocused();
    await save(page, '#signal-save-report', 'spectrum.json');
    const result = JSON.parse(await files(page, { name: 'spectrum.json' })), source = await page.locator('#signal-input').inputValue();
    assert.equal(result.format, 'arisaka-signal-analysis-v1'); assert.equal(result.spectrum.fftSize, 1024); assert.equal(result.spectrum.amplitude.length, 513);
    assert.ok(Math.abs(result.spectrum.amplitude[64] - 1) < 1e-10); assert.equal(result.options.window, 'hann');
    assert.equal(result.sourceSha256, createHash('sha256').update(source).digest('hex')); assert.ok(workers.some(url => url.endsWith('/analysis-worker.js')));
    await save(page, '#signal-save-csv', 'two-tone.selection.signal.csv'); await expect(page.locator('#signal-save-report')).toBeEnabled();
    const csv = await files(page, { name: 'two-tone.selection.signal.csv' }); assert.equal(csv.trim().split('\n').length, 1025); assert.match(csv, /^sample,x_s,A,B\n/);
    await page.locator('#signal-taper').selectOption('blackman'); await expect(page.locator('#signal-save-report')).toBeDisabled(); await expect(page.locator('#signal-statistics tr')).toHaveCount(0);
    await page.locator('#signal-wave').press('Control+Enter'); await expect(page.locator('#signal-result-note')).toContainText('blackman'); await expect(page.locator('#signal-wave')).toBeFocused();
    await page.locator('#signal-db').check(); await expect(page.locator('#signal-save-report')).toBeEnabled();
    await screenshot(page, 'fft-desktop'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('signal selection, correlation delay and CSV round-trip use complete data rather than plot previews', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page); await page.locator('#signal-example').click(); await expect(page.locator('#signal-run')).toBeEnabled();
    await page.locator('#signal-kind').selectOption('correlation'); await page.locator('#signal-lag').fill('32'); await page.locator('#signal-run').click();
    await expect(page.locator('#signal-result-note')).toContainText('lag 7 / r=1');
    await save(page, '#signal-save-report', 'correlation.json');
    const result = JSON.parse(await files(page, { name: 'correlation.json' })); assert.equal(result.correlation.lags.length, 65); assert.equal(result.correlation.peak.lag, 7);
    assert.equal(result.correlation.overlap[32], 1024); assert.equal(result.correlation.peak.overlap, 1017);
    await page.locator('#signal-from').fill('10'); await page.locator('#signal-to').fill('610'); await page.locator('#signal-apply-range').click();
    await expect(page.locator('#signal-save-report')).toBeDisabled(); await save(page, '#signal-save-csv', 'crop.signal.csv');
    const csv = await files(page, { name: 'crop.signal.csv' }); assert.equal(csv.trim().split('\n').length, 601); assert.match(csv.split('\n')[1], /^"10",/);
    await open(page, 'crop.signal.csv'); await expect(page.locator('#signal-source')).toContainText('4 路 × 600 样本');
    await page.locator('#signal-a').selectOption('2'); await expect(page.locator('#signal-run')).toBeEnabled();
    await page.locator('#signal-b').selectOption('3'); await expect(page.locator('#signal-run')).toBeEnabled();
    await page.locator('#signal-time').selectOption('1'); await expect(page.locator('#signal-status')).toContainText('1024 Hz');
    await page.locator('#signal-run').click(); await expect(page.locator('#signal-result-note')).toContainText('lag 7'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('standard TRS file association opens real external traces with full acquisition metadata', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const bytes = await readFile(new URL('./fixtures/trs/90x500xfloat.trs', import.meta.url));
    await files(page, { write: true, name: 'reference.trs', base64: bytes.toString('base64') });
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible();
    await launch(page, 'console', 'Konsole'); const input = page.locator('#console-sessions .console-session:not([hidden]) .session-form input').first();
    await input.fill('open ~/Documents/reference.trs'); await input.press('Enter');
    await expect(page.locator('#signal-window')).toBeVisible(); await expect(page.locator('#signal-source')).toContainText('90 路 × 500 样本');
    await expect(page.locator('#signal-a option')).toHaveCount(90); await expect(page.locator('#signal-warning')).toBeHidden();
    await page.locator('#signal-a').focus(); await page.keyboard.press('End'); await expect(page.locator('#signal-run')).toBeEnabled();
    await expect(page.locator('#signal-a')).toHaveValue('89'); await expect(page.locator('#signal-a')).toBeFocused();
    await page.locator('#signal-run').click(); await expect(page.locator('#signal-save-report')).toBeEnabled();
    await save(page, '#signal-save-report', 'reference.json'); const result = JSON.parse(await files(page, { name: 'reference.json' }));
    assert.equal(result.source.metadata.sampleCoding, 'float32le'); assert.equal(result.selection.a, 89); assert.equal(result.statistics.a.count, 500);
    assert.equal(result.histogram.counts.reduce((sum, count) => sum + count, 0), 500); assert.equal(result.sourceSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('full hardware acquisition remains inspectable and malformed legacy optional tags are warned, never guessed', { timeout: 120000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const source = powerEvidence('browser-signal', undefined, seededRandom(Buffer.alloc(32, 0x53), 'signal-browser'))['acquisition.trs'];
    await files(page, { write: true, name: 'acquisition.trs', base64: source.toString('base64') });
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible();
    await launch(page); await open(page, 'acquisition.trs'); await expect(page.locator('#signal-source')).toContainText('4096 路 × 272 样本');
    await expect(page.locator('#signal-warning')).toContainText('0x4b'); await expect(page.locator('#signal-use-rate')).toBeDisabled();
    await page.locator('#signal-a').selectOption('4095'); await expect(page.locator('#signal-run')).toBeEnabled();
    await page.locator('#signal-rate').fill('24000000'); await page.locator('#signal-rate').press('Tab'); await expect(page.locator('#signal-status')).toContainText('2.40000e+7 Hz');
    await page.locator('#signal-run').click(); await expect(page.locator('#signal-save-report')).toBeEnabled();
    await save(page, '#signal-save-report', 'acquisition-analysis.json'); const result = JSON.parse(await files(page, { name: 'acquisition-analysis.json' }));
    assert.equal(result.statistics.a.min, -25000); assert.equal(result.metadata.a.length, 32); assert.equal(result.source.labels.length, 4096);
    await screenshot(page, 'trs-desktop'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('cancellation, close/reopen and invalid input never re-enable a stale signal report', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop(); let release;
  try {
    await launch(page); await page.locator('#signal-example').click(); await expect(page.locator('#signal-run')).toBeEnabled();
    const barrier = new Promise(resolve => release = resolve);
    await context.route('**/analysis-worker.js', async route => { await barrier; await route.continue().catch(() => {}); });
    await page.locator('#signal-run').click(); await expect(page.locator('#signal-stop')).toBeEnabled(); await page.locator('#signal-stop').click();
    await expect(page.locator('#signal-status')).toHaveText('已停止'); await expect(page.locator('#signal-save-report')).toBeDisabled();
    await page.locator('#signal-run').click(); await expect(page.locator('#signal-stop')).toBeEnabled();
    await page.locator('#signal-window [data-window-action=close]').click(); release(); await context.unroute('**/analysis-worker.js'); await launch(page);
    await expect(page.locator('#signal-save-report')).toBeDisabled(); await page.locator('#signal-run').click(); await expect(page.locator('#signal-save-report')).toBeEnabled();
    await page.locator('.signal-paste summary').click(); await page.locator('#signal-input').fill('A,B\n1,\n2,3'); await page.locator('#signal-load-text').click();
    await expect(page.locator('#signal-status')).toContainText('不是有限数值'); await expect(page.locator('#signal-save-report')).toBeDisabled(); await expect(page.locator('#signal-save-csv')).toBeDisabled();
    await page.locator('#signal-example').click(); await expect(page.locator('#signal-run')).toBeEnabled(); await page.locator('#signal-run').click();
    await expect(page.locator('#signal-save-report')).toBeEnabled(); assert.deepEqual(errors, []);
  } finally { release?.(); await context.close(); }
});

test('narrow signal tools preserve keyboard cursors, pan/zoom, focus and accessible full exports', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop({ width: 390, height: 844 });
  try {
    await launch(page); await page.locator('#signal-example').press('Enter'); await expect(page.locator('#signal-run')).toBeEnabled();
    const node = page.locator('#signal-window'), bounds = await node.boundingBox();
    assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 391); assert.ok(await node.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    const wave = page.locator('#signal-wave'); await wave.focus(); for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('#signal-cursor')).toContainText('C1 #5'); await wave.press('Shift+ArrowRight'); await expect(page.locator('#signal-cursor')).toContainText('C2 #2');
    await wave.press('+'); await expect(page.locator('#signal-to')).toHaveValue('512'); await wave.press('Control+ArrowRight'); await expect(page.locator('#signal-from')).toHaveValue('102');
    await wave.press('Home'); await expect(page.locator('#signal-to')).toHaveValue('1024'); await expect(wave).toBeFocused();
    await wave.press('Control+Enter'); await expect(page.locator('#signal-save-report')).toBeEnabled(); await expect(wave).toBeFocused();
    await save(page, '#signal-save-report', 'narrow.json'); assert.equal(JSON.parse(await files(page, { name: 'narrow.json' })).statistics.a.count, 1024);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await screenshot(page, 'signal-mobile'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('ultrawide maximized plots cap canvas allocation and remain responsive to resizing', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop({ width: 5120, height: 1000 });
  try {
    await launch(page); await page.locator('#signal-example').click(); await expect(page.locator('#signal-run')).toBeEnabled();
    await page.locator('#signal-window [data-window-action=maximize]').click();
    await page.waitForFunction(() => document.querySelector('#signal-wave').clientWidth > 4096);
    await expect(page.locator('#signal-wave')).toHaveAttribute('width', '4096');
    await page.locator('#signal-run').click(); await expect(page.locator('#signal-save-report')).toBeEnabled();
    await page.setViewportSize({ width: 1100, height: 850 }); await page.locator('#signal-wave').press('ArrowRight');
    await expect(page.locator('#signal-cursor')).toContainText('C1 #1'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
