import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
import { seededRandom } from '../scripts/core.mjs';
import { frostEvidence } from '../scripts/expert/frost.mjs';

const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const expect = baseExpect.configure({ timeout: 20000 });
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
after(async () => { await browser?.close(); });

async function desktop(viewport = { width: 1440, height: 980 }) {
  const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  assert.equal((await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } })).status(), 200);
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
  await page.locator(button).click(); await page.locator('dialog[open] [data-name]').fill(name);
  await page.locator('dialog[open] button[type=submit]').click(); await expect(page.locator('dialog[open]')).toHaveCount(0);
}
async function files(page, value) {
  return page.evaluate(async value => {
    const { createFilesystem, DOCUMENTS } = await import('/filesystem.js'), { apiFetch } = await import('/transport.js');
    const state = await (await apiFetch('/api/session')).json();
    const fs = createFilesystem({ state: () => state, notes: () => ({ text: '', receipts: [] }), api: async path => (await apiFetch(path)).json() });
    await fs.setPlayer(state.player);
    if (value.write) { await fs.writeFile(value.name, value.bytes ? new Uint8Array(value.bytes) : value.text); return; }
    return Array.from(await fs.read(DOCUMENTS + '/' + value.name));
  }, value);
}
async function shell(page, command) {
  const input = page.locator('#console-sessions .console-session:not([hidden]) .session-form input').first();
  await expect(input).toBeEditable(); await input.fill(command); await input.press('Enter'); await expect(input).toBeEditable();
}
async function screenshot(page, name) {
  await mkdir(new URL('../.private/elite-qa/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('../.private/elite-qa/' + name + '.png', import.meta.url).pathname });
}

test('exact algebra runs in a real Worker and saves reproducible jobs and unimodular transforms', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'algebra', '离散数学工坊'); await page.locator('#algebra-input').press('Control+Enter');
    await expect(page.locator('#algebra-status')).toContainText('已完成');
    assert.deepEqual(JSON.parse(await page.locator('#algebra-output').inputValue()).particular, ['2', '1']);
    await page.locator('#algebra-operation').selectOption('lll');
    await page.locator('#algebra-input').fill(JSON.stringify({ basis: [['18446744073709551617', 1], ['18446744073709551616', 1]] }));
    await page.locator('#algebra-run').click(); await expect(page.locator('#algebra-status')).toContainText('已完成');
    const result = JSON.parse(await page.locator('#algebra-output').inputValue());
    assert.ok(result.basis.flat().every(value => ['-1', '0', '1'].includes(value)));
    assert.ok(result.transform.flat().some(value => BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(value) < -BigInt(Number.MAX_SAFE_INTEGER)));
    await saveAs(page, '#algebra-save-job', 'exact-job.json'); await saveAs(page, '#algebra-save-result', 'exact-result.json');
    const saved = JSON.parse(Buffer.from(await files(page, { name: 'exact-result.json' })).toString());
    assert.equal(saved.format, 'arisaka-discrete-result-v1'); assert.deepEqual(saved.result, result);
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible();
    await launch(page, 'algebra', '离散数学工坊'); await openWith(page, '#algebra-open', 'exact-job.json');
    await expect(page.locator('#algebra-operation')).toHaveValue('lll'); await page.locator('#algebra-input').press('Control+Enter');
    await expect(page.locator('#algebra-status')).toContainText('已完成'); assert.deepEqual(JSON.parse(await page.locator('#algebra-output').inputValue()), result);
    await screenshot(page, 'algebra-desktop'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('algebra rejects unsupported rings, reports inconsistent CRT and cancels without stale results', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'algebra', '离散数学工坊');
    await page.locator('#algebra-input').fill('{"modulus":6,"matrix":[[2,1]]}'); await page.locator('#algebra-run').click();
    await expect(page.locator('#algebra-status')).toContainText('单位主元'); await expect(page.locator('#algebra-save-result')).toBeDisabled();
    await page.locator('#algebra-operation').selectOption('crt'); await page.locator('#algebra-input').fill('{"congruences":[[1,4],[2,6]]}'); await page.locator('#algebra-run').click();
    await expect(page.locator('#algebra-summary')).toHaveText('约束不一致：无解');
    await page.locator('#algebra-example').click();
    let release; const barrier = new Promise(resolve => release = resolve);
    await context.route('**/analysis-worker.js', async route => { await barrier; await route.continue().catch(() => {}); });
    await page.locator('#algebra-run').click(); await expect(page.locator('#algebra-stop')).toBeEnabled();
    await page.locator('#algebra-window [data-window-action="close"]').click(); release();
    await context.unroute('**/analysis-worker.js'); await launch(page, 'algebra', '离散数学工坊');
    await expect(page.locator('#algebra-status')).toHaveText('已停止'); await expect(page.locator('#algebra-output')).toHaveValue('');
    await page.locator('#algebra-run').click(); await expect(page.locator('#algebra-summary')).toHaveText('x ≡ 14 (mod 18)');
    await page.locator('#algebra-input').fill('not json'); await expect(page.locator('#algebra-save-result')).toBeDisabled();
    await page.locator('#algebra-run').click(); await expect(page.locator('#algebra-stop')).toBeDisabled(); await expect(page.locator('#algebra-output')).toHaveValue('');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('DER tree keyboard navigation and exact selection exports preserve source bytes', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'structure', '结构检查器'); await page.locator('.structure-manual summary').click();
    await page.locator('#structure-hex').fill('30 0d 02 01 ff 06 08 2a 86 48 86 f7 0d 01 01'); await page.locator('#structure-parse-hex').click();
    await expect(page.locator('#structure-nodes tr')).toHaveCount(3);
    await page.locator('#structure-nodes tr').first().press('ArrowRight');
    await expect(page.locator('#structure-detail')).toContainText('INTEGER'); await expect(page.locator('#structure-detail')).toContainText('原始负载：[4, 5)');
    await saveAs(page, '#structure-save-payload', 'integer-payload.bin'); assert.deepEqual(await files(page, { name: 'integer-payload.bin' }), [255]);
    await saveAs(page, '#structure-save-node', 'integer.der'); assert.deepEqual(await files(page, { name: 'integer.der' }), [2, 1, 255]);
    await page.locator('#structure-nodes tr[aria-selected=true]').press('ArrowLeft');
    await page.locator('#structure-nodes tr[aria-selected=true]').press('ArrowLeft'); await expect(page.locator('#structure-nodes tr')).toHaveCount(1);
    await page.locator('#structure-nodes tr').press('ArrowRight'); await expect(page.locator('#structure-nodes tr')).toHaveCount(3);
    await page.locator('#structure-nodes tr[aria-selected=true]').press('End'); await expect(page.locator('#structure-detail')).toContainText('1.2.840.113549.1.1');
    await saveAs(page, '#structure-save-report', 'tree.json');
    const report = JSON.parse(Buffer.from(await files(page, { name: 'tree.json' })).toString()); assert.equal(report.tree.nodeCount, 3);
    await page.locator('#structure-filter').fill('integer'); await expect(page.locator('#structure-nodes tr')).toHaveCount(1);
    await page.locator('#structure-hex').fill('30 80 00 00'); await page.locator('#structure-parse-hex').click();
    await expect(page.locator('#structure-status')).toContainText('DER 不允许不定长'); await expect(page.locator('#structure-nodes tr')).toHaveCount(0);
    await expect(page.locator('#structure-save-report')).toBeDisabled(); await expect(page.locator('#structure-save-node')).toBeDisabled(); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('CBOR file association inspects a complete threshold transcript and exports all nodes beyond the first page', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const input = frostEvidence('browser-test-only', seededRandom(Buffer.alloc(32, 99), 'elite-browser'))['sessions.cbor'];
    await files(page, { write: true, name: 'rounds.cbor', bytes: [...input] });
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible();
    await launch(page, 'console', 'Konsole'); await shell(page, 'open ~/Documents/rounds.cbor');
    await expect(page.locator('#structure-window')).toBeVisible(); await expect(page.locator('#structure-format')).toHaveValue('cbor');
    await expect(page.locator('#structure-nodes tr')).toHaveCount(100); await expect(page.locator('#structure-next')).toBeEnabled();
    await saveAs(page, '#structure-save-node', 'encoded-rounds.cbor'); assert.deepEqual(await files(page, { name: 'encoded-rounds.cbor' }), [...input]);
    await page.locator('#structure-nodes tr').first().press('End'); await expect(page.locator('#structure-next')).toBeDisabled(); await expect(page.locator('#structure-prev')).toBeEnabled();
    await saveAs(page, '#structure-save-report', 'full-rounds.json');
    const report = JSON.parse(Buffer.from(await files(page, { name: 'full-rounds.json' })).toString()); assert.ok(report.tree.nodeCount > 100); assert.equal(report.tree.byteLength, input.length);
    await page.locator('#structure-filter').fill('byte string'); await expect(page.locator('#structure-nodes tr')).not.toHaveCount(0);
    await screenshot(page, 'structure-desktop'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('elite tools remain usable on narrow screens with keyboard and explicit result bounds', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop({ width: 390, height: 844 });
  try {
    for (const [id, name] of [['algebra', '离散数学工坊'], ['structure', '结构检查器']]) {
      await launch(page, id, name); await page.waitForFunction(id => !document.querySelector('#' + id + '-window').dataset.motionState, id);
      const node = page.locator('#' + id + '-window'), bounds = await node.boundingBox();
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 391); assert.ok(await node.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      if (id === 'algebra') {
        await page.locator('#algebra-operation').selectOption('polynomial'); await page.locator('#algebra-example').press('Enter');
        await page.locator('#algebra-input').press('Control+Enter'); await expect(page.locator('#algebra-summary')).toHaveText('0xc1');
      } else {
        await page.locator('.structure-manual summary').press('Enter'); await page.locator('#structure-hex').fill('30 03 02 01 2a');
        await page.locator('#structure-parse-hex').press('Enter'); await expect(page.locator('#structure-nodes tr')).toHaveCount(2);
        await page.locator('#structure-nodes tr').first().press('ArrowRight'); await expect(page.locator('#structure-detail')).toContainText('42');
      }
      await screenshot(page, id + '-mobile'); await node.locator('[data-window-action=close]').click();
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
