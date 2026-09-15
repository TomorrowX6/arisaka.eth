import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';

const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788', expect = baseExpect.configure({ timeout: 20000 });
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
after(async () => { await browser?.close(); });
async function desktop(viewport = { width: 1440, height: 1080 }) {
  const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [], failedResources = [];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message)); page.on('response', response => { if (response.status() >= 400) failedResources.push(response.status() + ' ' + new URL(response.url()).pathname); });
  assert.equal((await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } })).status(), 200);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  try { await expect(page.locator('#desktop')).toBeVisible(); }
  catch (error) { await context.close(); throw Error(error.message + '\n' + [...errors, ...failedResources].join('\n')); }
  return { context, page, errors };
}
async function launch(page, id = 'rf', name = 'RF / IQ 工坊') {
  await page.locator('#launcher-button').click(); await page.locator('#launcher-search').fill(name); await page.locator('#launcher-apps [data-launch="' + id + '"]').click();
  await expect(page.locator('#' + id + '-window')).toBeVisible(); await page.waitForFunction(id => !document.querySelector('#' + id + '-window').dataset.motionState, id);
}
async function workspace(page, value) {
  return page.evaluate(async value => {
    const { createFilesystem, DOCUMENTS } = await import('/filesystem.js'), { apiFetch } = await import('/transport.js'), state = await (await apiFetch('/api/session')).json();
    const fs = createFilesystem({ state: () => state, notes: () => ({ text: '', receipts: [] }), api: async path => (await apiFetch(path)).json() }); await fs.setPlayer(state.player);
    if (value.write) { await fs.writeFiles(value.write.map(item => ({ path: item.name, value: item.text ?? new Uint8Array(item.bytes) }))); return; }
    const bytes = await fs.read(DOCUMENTS + '/' + value.name); return value.binary ? Array.from(bytes) : new TextDecoder().decode(bytes);
  }, value);
}
async function save(page, selector, name) {
  await page.locator(selector).click(); await page.locator('dialog[open] input').fill(name); await page.locator('dialog[open]').getByRole('button', { name: '确定', exact: true }).click(); await expect(page.locator('dialog[open]')).toHaveCount(0);
}
async function openDocument(page, name) {
  await launch(page, 'console', 'Konsole'); const input = page.locator('#console-sessions .console-session:not([hidden]) .session-form input').first(); await input.fill('open ~/Documents/' + name); await input.press('Enter'); await expect(page.locator('#rf-window')).toBeVisible();
}
async function screenshot(page, name) {
  await mkdir(new URL('../.private/rf-qa/', import.meta.url), { recursive: true }); await page.screenshot({ path: new URL('../.private/rf-qa/' + name + '.png', import.meta.url).pathname });
}
function fixture(count, overrides = {}) {
  const bytes = Buffer.alloc(count * 8); for (let i = 0; i < count; i++) { bytes.writeFloatLE(Math.cos(2 * Math.PI * i / 16), i * 8); bytes.writeFloatLE(Math.sin(2 * Math.PI * i / 16), i * 8 + 4); }
  const metadata = JSON.stringify({ global: { 'core:datatype': 'cf32_le', 'core:version': '1.2.6', 'core:sample_rate': 1024, ...overrides }, captures: [{ 'core:sample_start': 0 }], annotations: [] }, null, 2) + '\n'; return { bytes, metadata };
}

test('RF Welch analysis runs in a real Worker, preserves signed calibrated bins and exports complete CSV and paired source hashes', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop(), workers = []; page.on('worker', worker => workers.push(worker.url()));
  try {
    await launch(page); await page.locator('#rf-example').click(); await expect(page.locator('#rf-run')).toBeEnabled(); await expect(page.locator('#rf-source')).toContainText('4096 复数样本');
    await page.locator('#rf-run').click(); await expect(page.locator('#rf-result-note')).toContainText('峰 192 Hz'); await expect(page.locator('#rf-run')).toBeFocused();
    await save(page, '#rf-save-report', 'welch.json'); const result = JSON.parse(await workspace(page, { name: 'welch.json' }));
    assert.equal(result.format, 'arisaka-rf-analysis-v1'); assert.equal(result.kind, 'spectrum'); assert.equal(result.spectrum.frequency.length, 1024); assert.equal(result.spectrum.frequency[0], -2048); assert.equal(result.spectrum.frequency.at(-1), 2044); assert.equal(result.spectrum.coveredSamples, 4096);
    assert.ok(Math.abs(result.spectrum.mean.reduce((a, b) => a + b, 0) * result.spectrum.binWidth - 1.1225) < 1e-7);
    const negative = result.spectrum.frequency.indexOf(-384), positive = result.spectrum.frequency.indexOf(192); assert.ok(Math.abs(result.spectrum.mean[negative] / result.spectrum.mean[positive] - .1225) < 1e-7);
    await save(page, '#rf-save-pair', 'original'); await expect(page.locator('#rf-status')).toContainText('原子保存');
    assert.equal(createHash('sha256').update(await workspace(page, { name: 'original.sigmf-meta' })).digest('hex'), result.metadataSha256);
    assert.equal(createHash('sha256').update(Buffer.from(await workspace(page, { name: 'original.sigmf-data', binary: true }))).digest('hex'), result.datasetSha256);
    await save(page, '#rf-save-csv', 'all-iq.csv'); await expect(page.locator('#rf-status')).toContainText('完整选区 CSV');
    assert.equal((await workspace(page, { name: 'all-iq.csv' })).trim().split('\n').length, 4097); assert.ok(workers.some(url => url.endsWith('/analysis-worker.js')));
    await page.locator('#rf-result').press('ArrowRight'); await expect(page.locator('#rf-bin')).toContainText('196 Hz');
    await screenshot(page, 'welch-desktop'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('RF frequency translation and FIR decimation produce reopenable cf64 files with exact provenance and reversible originals', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page); await page.locator('#rf-example').click(); await expect(page.locator('#rf-run')).toBeEnabled(); await page.locator('.rf-transform summary').click();
    await page.locator('#rf-shift').fill('192'); await page.locator('#rf-decimation').selectOption('4'); await page.locator('#rf-transform').click();
    await expect(page.locator('#rf-source')).toContainText('cf64_le · 992 复数样本 · 1024 Hz'); await expect(page.locator('#rf-transform')).toBeFocused();
    await save(page, '#rf-save-report', 'transform.json'); const result = JSON.parse(await workspace(page, { name: 'transform.json' }));
    assert.equal(result.operation.firstOutputSourceLocalSample, 64); assert.equal(result.operation.sourceStep, 4); assert.equal(result.operation.filter.taps.length, 129); assert.equal(result.operation.shift, 192);
    await save(page, '#rf-save-pair', 'decimated'); await expect(page.locator('#rf-status')).toContainText('原子保存'); const metadata = JSON.parse(await workspace(page, { name: 'decimated.sigmf-meta' }));
    assert.equal(metadata.global['core:sample_rate'], 1024); assert.equal(metadata.captures[0]['core:frequency'], 915000192); assert.equal(metadata.global['arisaka-rf:provenance'].datasetSha256, result.provenance.datasetSha256);
    const bytes = Buffer.from(await workspace(page, { name: 'decimated.sigmf-data', binary: true })); assert.equal(bytes.length, 992 * 16); assert.ok(Math.abs(bytes.readDoubleLE(0) - 1) < .001);
    await page.locator('#rf-restore').click(); await expect(page.locator('#rf-source')).toContainText('cf32_le · 4096 复数样本 · 4096 Hz'); await expect(page.locator('#rf-save-report')).toBeDisabled();
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible(); await openDocument(page, 'decimated.sigmf-data'); await expect(page.locator('#rf-source')).toContainText('992 复数样本');
    await page.locator('#rf-fft').selectOption('256'); await page.locator('#rf-run').click(); await expect(page.locator('#rf-result-note')).toContainText('峰 0 Hz'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('paired NCD import respects endian headers, offsets, SHA-512 and non-inherited capture frequencies without fetching metadata URLs', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop(), requested = []; page.on('request', request => requested.push(request.url()));
  try {
    const bytes = Buffer.alloc(128 * 4 + 12, 255); for (let i = 0; i < 128; i++) { const at = 4 + i * 4 + (i >= 64 ? 6 : 0); bytes.writeInt16BE(i * 3, at); bytes.writeInt16BE(-i * 5, at + 2); }
    const metadata = JSON.stringify({ global: { 'core:datatype': 'ci16_be', 'core:version': '1.2.6', 'core:dataset': 'physical.dat', 'core:offset': 4096, 'core:trailing_bytes': 2, 'core:sample_rate': 1024, 'core:sha512': createHash('sha512').update(bytes).digest('hex'), 'core:license': 'https://do-not-fetch.invalid/license' }, captures: [{ 'core:sample_start': 4096, 'core:header_bytes': 4, 'core:frequency': 1e8 }, { 'core:sample_start': 4160, 'core:header_bytes': 6 }], annotations: [{ 'core:sample_start': 4100, 'core:label': '<img src=x onerror=alert(1)>' }] });
    await workspace(page, { write: [{ name: 'ncd.sigmf-meta', text: metadata }, { name: 'physical.dat', bytes: [...bytes] }] }); await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible(); await openDocument(page, 'ncd.sigmf-meta');
    await expect(page.locator('#rf-source')).toContainText('128 复数样本'); await expect(page.locator('#rf-metadata')).toContainText('SHA-512: 已验证'); await expect(page.locator('#rf-warning')).toContainText('原始 ADC'); await expect(page.locator('#rf-metadata img')).toHaveCount(0);
    await page.locator('#rf-segment').selectOption('1'); await expect(page.locator('#rf-from')).toHaveValue('64'); await expect(page.locator('#rf-to')).toHaveValue('128');
    const row = page.locator('#rf-table tr').first(); await expect(row).toContainText('64 / 4160'); assert.equal(await row.locator('td').nth(1).textContent(), '266'); assert.equal(await row.locator('td').nth(2).textContent(), '192'); assert.equal(await row.locator('td').nth(3).textContent(), '-320');
    await page.locator('#rf-fft').selectOption('64'); await page.locator('#rf-run').click(); await expect(page.locator('#rf-result-note')).toContainText('1 个完整窗');
    assert.equal(requested.some(url => url.includes('do-not-fetch.invalid')), false); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the actual OFDM SigMF acquisition remains a generic inspectable waveform, with a complete bounded spectrogram export', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const metadata = await readFile(new URL('../public/_puzzles/34/receiver.sigmf-meta', import.meta.url)), bytes = await readFile(new URL('../public/_puzzles/34/receiver.sigmf-data', import.meta.url));
    await launch(page); await page.locator('#rf-local-files').setInputFiles([{ name: 'receiver.sigmf-meta', mimeType: 'application/json', buffer: metadata }, { name: 'receiver.sigmf-data', mimeType: 'application/octet-stream', buffer: bytes }]);
    await expect(page.locator('#rf-source')).toContainText(bytes.length / 8 + ' 复数样本'); await expect(page.locator('#rf-source')).toContainText('2000000 Hz');
    await page.locator('#rf-kind').selectOption('spectrogram'); await page.locator('#rf-fft').selectOption('128'); await page.locator('#rf-run').click(); await expect(page.locator('#rf-save-report')).toBeEnabled();
    await expect(page.locator('#rf-color-scale')).toBeVisible();
    const colorMin = parseFloat(await page.locator('#rf-color-min').textContent()), colorMax = parseFloat(await page.locator('#rf-color-max').textContent()); assert.ok(Math.abs(colorMax - colorMin - 100) < .0001);
    await save(page, '#rf-save-report', 'radio-waterfall.json'); const report = JSON.parse(await workspace(page, { name: 'radio-waterfall.json' }));
    assert.equal(report.datasetSha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(report.spectrum.power.length, report.spectrum.frames.length * 128); assert.equal(report.statistics.count, bytes.length / 8); assert.equal(report.metadata.annotations.length, 0);
    assert.equal(report.spectrum.coveredSamples + report.spectrum.omittedSamples, bytes.length / 8); assert.ok(report.spectrum.power.some(value => value > 0));
    await page.locator('#rf-result').press('ArrowDown'); await expect(page.locator('#rf-bin')).toContainText('frame 1 / 起点 n=64');
    await page.locator('#rf-result').scrollIntoViewIfNeeded(); await screenshot(page, 'radio-waterfall'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('constellation previews and paged samples stay bounded while reports retain all points; unsafe metadata clears stale exports', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const source = fixture(8192); await launch(page); await page.locator('#rf-local-files').setInputFiles([{ name: 'large.sigmf-meta', mimeType: 'application/json', buffer: Buffer.from(source.metadata) }, { name: 'large.sigmf-data', mimeType: 'application/octet-stream', buffer: source.bytes }]);
    await expect(page.locator('#rf-run')).toBeEnabled(); await expect(page.locator('#rf-table tr')).toHaveCount(100); await page.locator('#rf-next').click(); await expect(page.locator('#rf-page')).toHaveText('8192 项 · 2 / 82');
    await page.locator('#rf-table button').first().click(); await expect(page.locator('#rf-cursor')).toContainText('A n=100 / abs=100'); await expect(page.locator('#rf-table button').first()).toBeFocused();
    await page.locator('#rf-kind').selectOption('constellation'); await page.locator('#rf-run').click(); await expect(page.locator('#rf-result-note')).toContainText('8192 个手动抽样点 · 预览 4096 点');
    const aspect = await page.locator('#rf-result').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), xs = [], ys = [], scale = canvas.width / canvas.clientWidth;
      for (let y = Math.ceil(24 * scale); y < Math.floor((canvas.clientHeight - 30) * scale); y++) for (let x = Math.ceil(58 * scale); x < Math.floor((canvas.clientWidth - 15) * scale); x++) { const at = (y * canvas.width + x) * 4; if (pixels.data[at + 2] > pixels.data[at] + 40 && pixels.data[at + 1] > pixels.data[at] + 20) { xs.push(x); ys.push(y); } }
      return { points: xs.length, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    });
    assert.ok(aspect.points > 20); assert.ok(Math.abs(aspect.width - aspect.height) <= 3, 'unit circle must not become a stretched ellipse');
    await page.locator('#rf-stride').fill('3'); await page.locator('#rf-phase').fill('1'); await expect(page.locator('#rf-save-report')).toBeDisabled(); await page.locator('#rf-run').click(); await expect(page.locator('#rf-save-report')).toBeEnabled();
    await save(page, '#rf-save-report', 'constellation.json'); const report = JSON.parse(await workspace(page, { name: 'constellation.json' })); assert.equal(report.constellation.indices.length, 2731); assert.equal(report.constellation.indices[0], 1); assert.equal(report.constellation.indices.at(-1), 8191); assert.equal(report.constellation.points.length, 5462);
    const bad = fixture(16, { 'core:dataset': 'https://do-not-fetch.invalid/evidence' }); await page.locator('#rf-local-files').setInputFiles([{ name: 'bad.sigmf-meta', mimeType: 'application/json', buffer: Buffer.from(bad.metadata) }, { name: 'bad.sigmf-data', mimeType: 'application/octet-stream', buffer: bad.bytes }]);
    await expect(page.locator('#rf-status')).toContainText('不访问 URL'); for (const id of ['run', 'save-report', 'save-pair', 'save-csv', 'transform']) await expect(page.locator('#rf-' + id)).toBeDisabled(); await expect(page.locator('#rf-table tr')).toHaveCount(0); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('RF cancel and close terminate real Workers without replacing data or resurrecting stale transform reports', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop(); let release;
  try {
    await launch(page); await page.locator('#rf-example').click(); await expect(page.locator('#rf-run')).toBeEnabled();
    const barrier = new Promise(resolve => release = resolve); await context.route('**/analysis-worker.js', async route => { await barrier; await route.continue().catch(() => {}); });
    await page.locator('#rf-run').click(); await expect(page.locator('#rf-stop')).toBeEnabled(); await page.locator('#rf-stop').click(); await expect(page.locator('#rf-status')).toContainText('已停止'); await expect(page.locator('#rf-save-report')).toBeDisabled();
    await page.locator('.rf-transform summary').click(); await page.locator('#rf-decimation').selectOption('4'); await page.locator('#rf-transform').click(); await expect(page.locator('#rf-stop')).toBeEnabled(); await page.locator('#rf-window [data-window-action=close]').click();
    release(); await context.unroute('**/analysis-worker.js'); await launch(page); await expect(page.locator('#rf-source')).toContainText('4096 复数样本'); await expect(page.locator('#rf-save-report')).toBeDisabled();
    await page.locator('#rf-run').click(); await expect(page.locator('#rf-save-report')).toBeEnabled(); await page.locator('#rf-to').fill('999999'); await expect(page.locator('#rf-save-report')).toBeDisabled(); await page.locator('#rf-run').click(); await expect(page.locator('#rf-status')).toContainText('选区须满足');
    await page.locator('#rf-fit').click(); await page.locator('#rf-run').click(); await expect(page.locator('#rf-save-report')).toBeEnabled(); assert.deepEqual(errors, []);
  } finally { release?.(); await context.close(); }
});

test('scientific file pairs commit atomically across collisions, missing directories, quota, revision conflicts and profile changes', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const result = await page.evaluate(async () => {
      const { createFilesystem, DOCUMENTS } = await import('/filesystem.js'), { apiFetch } = await import('/transport.js'), state = await (await apiFetch('/api/session')).json();
      const controls = { state: () => state, notes: () => ({ text: '', receipts: [] }), api: async path => (await apiFetch(path)).json() }, fs = createFilesystem(controls); await fs.setPlayer(state.player);
      await fs.writeFile('occupied.sigmf-data', 'x'); const outcomes = [];
      for (const entries of [[{ path: 'occupied.sigmf-meta', value: '{}' }, { path: 'occupied.sigmf-data', value: 'new' }], [{ path: 'partial', value: 'a' }, { path: 'missing/child', value: 'b' }], [{ path: 'same', value: 'a' }, { path: './same', value: 'b' }], [{ path: 'big-a', value: new Uint8Array(32 * 1024 * 1024) }, { path: 'big-b', value: new Uint8Array(32 * 1024 * 1024) }]]) {
        try { await fs.writeFiles(entries); outcomes.push('unexpected success'); } catch (error) { outcomes.push(error.message); }
      }
      const remaining = (await fs.entries(DOCUMENTS)).map(item => item.name);
      await fs.writeFiles([{ path: 'valid.sigmf-meta', value: '{}' }, { path: 'valid.sigmf-data', value: new Uint8Array([1, 2, 3]) }]);
      const other = createFilesystem(controls); await other.setPlayer(state.player); await fs.writeFile('revision', 'new');
      let conflict; try { await other.writeFiles([{ path: 'conflict-meta', value: '{}' }, { path: 'conflict-data', value: 'x' }]); } catch (error) { conflict = error.message; }
      const afterConflict = (await other.entries(DOCUMENTS)).map(item => item.name);
      const pending = fs.writeFiles([{ path: 'wrong-profile', value: 'x' }]).then(() => 'unexpected success', error => error.message); await fs.setPlayer('rf-isolated-profile'); const canceled = await pending;
      return { outcomes, remaining, conflict, afterConflict, canceled, profileFiles: (await fs.entries(DOCUMENTS)).map(item => item.name) };
    });
    assert.match(result.outcomes[0], /EEXIST/); assert.match(result.outcomes[1], /EACCES/); assert.match(result.outcomes[2], /duplicate/); assert.match(result.outcomes[3], /ENOSPC/); assert.deepEqual(result.remaining, ['occupied.sigmf-data']);
    assert.match(result.conflict, /ESTALE/); assert.equal(result.afterConflict.includes('conflict-meta'), false); assert.equal(result.afterConflict.includes('conflict-data'), false); assert.match(result.canceled, /ECANCELED/); assert.deepEqual(result.profileFiles, []);
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible(); await launch(page); await page.locator('#rf-example').click(); await expect(page.locator('#rf-run')).toBeEnabled();
    await save(page, '#rf-save-pair', 'occupied'); await expect(page.locator('#rf-status')).toContainText('EEXIST'); assert.equal(await workspace(page, { name: 'occupied.sigmf-data' }), 'x'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('narrow RF controls retain keyboard cursors, pan/zoom, exact exports and focus without overflowing the desktop', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop({ width: 390, height: 844 });
  try {
    await launch(page); await page.locator('#rf-example').press('Enter'); await expect(page.locator('#rf-run')).toBeEnabled(); const window = page.locator('#rf-window'), bounds = await window.boundingBox();
    assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 391); assert.ok(await window.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    const wave = page.locator('#rf-wave'); await wave.press('ArrowRight'); await expect(page.locator('#rf-cursor')).toContainText('A n=1 / abs=1'); await wave.press('Shift+ArrowRight'); await expect(page.locator('#rf-cursor')).toContainText('B n=2 / abs=2');
    await wave.press('+'); await expect(page.locator('#rf-to')).toHaveValue('2048'); await wave.press('Control+ArrowRight'); await expect(page.locator('#rf-from')).toHaveValue('410'); await wave.press('Home'); await expect(page.locator('#rf-to')).toHaveValue('4096');
    await wave.press('Control+Enter'); await expect(page.locator('#rf-save-report')).toBeEnabled(); await expect(wave).toBeFocused(); await save(page, '#rf-save-report', 'narrow-rf.json'); assert.equal(JSON.parse(await workspace(page, { name: 'narrow-rf.json' })).statistics.count, 4096);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await wave.scrollIntoViewIfNeeded(); await screenshot(page, 'rf-mobile'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('ultrawide RF canvases cap backing storage and continue receiving input after resize', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop({ width: 5120, height: 1050 });
  try {
    await launch(page); await page.locator('#rf-example').click(); await expect(page.locator('#rf-run')).toBeEnabled(); await page.locator('#rf-window [data-window-action=maximize]').click();
    await page.waitForFunction(() => document.querySelector('#rf-wave').clientWidth > 4096); await expect(page.locator('#rf-wave')).toHaveAttribute('width', '4096');
    await page.setViewportSize({ width: 1100, height: 900 }); await page.locator('#rf-wave').press('ArrowRight'); await expect(page.locator('#rf-cursor')).toContainText('A n=1 / abs=1'); await page.locator('#rf-run').click(); await expect(page.locator('#rf-result-note')).toContainText('峰 192 Hz'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
