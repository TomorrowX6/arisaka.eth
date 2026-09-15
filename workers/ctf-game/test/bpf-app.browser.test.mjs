import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
import { seededRandom } from '../scripts/core.mjs';
import { bpfEvidence } from '../scripts/expert/bpf.mjs';
import { recoverBpfMaterial } from '../scripts/expert/bpf-decoder.mjs';
import { loadBpf } from '../public/bpf-elf.js';

const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const expect = baseExpect.configure({ timeout: 20000 });
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
after(async () => { await browser?.close(); });

async function desktop(viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  assert.equal((await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } })).status(), 200);
  await page.goto(base, { waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible();
  return { context, page, errors };
}
async function launch(page, id = 'bpf', name = 'eBPF 调试器') {
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
    if (value.write) { await fs.writeFile(value.name, new Uint8Array(value.bytes)); return; }
    return Array.from(await fs.read(DOCUMENTS + '/' + value.name));
  }, value);
}
async function screenshot(page, name) {
  await mkdir(new URL('../.private/bpf-qa/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('../.private/bpf-qa/' + name + '.png', import.meta.url).pathname });
}
async function raw(page, code, packet = '') {
  await page.locator('.bpf-input-panel').evaluate(node => node.open = true);
  await page.locator('#bpf-code-hex').fill(code); await page.locator('#bpf-packet').fill(packet);
  await page.locator('#bpf-load-hex').click(); await expect(page.locator('#bpf-stop')).toBeDisabled();
}

test('BPF real Worker supports exact stepping, initial breakpoints, packet memory and complete exports', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page); await page.locator('#bpf-example').click(); await expect(page.locator('#bpf-run')).toBeEnabled();
    await expect(page.locator('#bpf-memory')).toContainText('??'); await expect(page.locator('#bpf-memory-save')).toBeDisabled();
    await page.locator('#bpf-instructions [data-pc="0"]').click(); await page.keyboard.press('F9');
    await page.keyboard.press('F8'); await expect(page.locator('#bpf-status')).toHaveText('breakpoint · 0 instructions');
    await expect(page.locator('#bpf-instructions [data-pc="0"] button')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('F10'); await expect(page.locator('#bpf-state-label')).toContainText('PC 1 · 1 步');
    await expect(page.locator('#bpf-registers [data-register="2"]')).toContainText('0x0000000010000000');
    await page.keyboard.press('F8'); await expect(page.locator('#bpf-state-label')).toContainText('halted');
    await expect(page.locator('#bpf-registers [data-register="0"]')).toContainText('0x000000000000000a');
    await page.locator('#bpf-memory-region').selectOption('packet'); await expect(page.locator('#bpf-memory')).toContainText('01 02 03 04');
    await saveAs(page, '#bpf-memory-save', 'packet-copy.bin'); assert.deepEqual(await files(page, { name: 'packet-copy.bin' }), [1, 2, 3, 4]);
    await saveAs(page, '#bpf-save-report', 'debug-report.json');
    const report = JSON.parse(Buffer.from(await files(page, { name: 'debug-report.json' })).toString());
    assert.equal(report.snapshot.registers[0].unsigned, '10'); assert.equal(report.program.instructions.length, 9); assert.deepEqual(report.breakpoints, [0]);
    await saveAs(page, '#bpf-save-disassembly', 'checksum-disassembly.txt');
    assert.match(Buffer.from(await files(page, { name: 'checksum-disassembly.txt' })).toString(), /ja pc 3/);
    await screenshot(page, 'checksum-desktop');
    await page.locator('.bpf-input-panel').evaluate(node => node.open = true); await page.locator('#bpf-packet').fill('ff 01');
    await expect(page.locator('#bpf-run')).toBeDisabled(); await expect(page.locator('#bpf-registers tr')).toHaveCount(0);
    await page.locator('#bpf-clear-breakpoints').click(); await page.locator('#bpf-reset').click(); await expect(page.locator('#bpf-run')).toBeEnabled();
    await page.locator('#bpf-run').click(); await expect(page.locator('#bpf-registers [data-register="0"]')).toContainText('0x0000000000000100');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('BPF ELF files open from the workspace, relocate calls and data, and execute an independently recovered packet', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const evidence = bpfEvidence('browser-only', [Buffer.alloc(32, 1), Buffer.alloc(32, 2)], seededRandom(Buffer.alloc(32, 33), 'browser-bpf'));
    const packet = Buffer.concat([Buffer.from('R32\0'), recoverBpfMaterial(evidence).material]), program = loadBpf(evidence['filter.bpf.o']);
    await files(page, { write: true, name: 'filter.bpf.o', bytes: [...evidence['filter.bpf.o']] });
    await files(page, { write: true, name: 'accepted-packet.bin', bytes: [...packet] });
    // Fixture writes use a separate filesystem instance. Reload the desktop to
    // adopt its revision, just as opening files saved by another tab requires.
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible();
    await launch(page, 'console', 'Konsole');
    const input = page.locator('#console-sessions .console-session:not([hidden]) .session-form input').first();
    await input.fill('open ~/Documents/filter.bpf.o'); await input.press('Enter');
    await expect(page.locator('#bpf-window')).toBeVisible(); await expect(page.locator('#bpf-source')).toContainText('ELF64-LE-BPF');
    await expect(page.locator('#bpf-entry')).toHaveValue(String(program.entry));
    await page.locator('.bpf-input-panel').evaluate(node => node.open = true); await openWith(page, '#bpf-open-packet', 'accepted-packet.bin');
    await page.locator('#bpf-reset').click(); await expect(page.locator('#bpf-run')).toBeEnabled();
    await page.locator('.bpf-input-panel').evaluate(node => node.open = false);
    await page.locator('#bpf-filter').fill('call.local'); await expect(page.locator('#bpf-instructions tr')).toHaveCount(1);
    await page.locator('#bpf-instructions tr').click(); await page.keyboard.press('Enter');
    await expect(page.locator('#bpf-filter')).toHaveValue(''); await expect(page.locator('#bpf-instruction-detail')).toContainText('mix_block');
    await page.locator('#bpf-filter').fill('call.local'); await page.locator('#bpf-instructions tr').dblclick();
    await expect(page.locator('#bpf-filter')).toHaveValue(''); await expect(page.locator('#bpf-instruction-detail')).toContainText('mix_block');
    await page.locator('#bpf-run').click(); await expect(page.locator('#bpf-state-label')).toContainText('halted');
    await expect(page.locator('#bpf-registers [data-register="0"]')).toContainText('0x0000000000000002');
    await saveAs(page, '#bpf-save-report', 'elf-debug.json');
    const report = JSON.parse(Buffer.from(await files(page, { name: 'elf-debug.json' })).toString());
    assert.equal(report.program.instructions.length, program.instructions.length);
    assert.equal(report.program.relocations.length, 2); assert.ok(report.program.relocations.every(row => row.applied));
    await screenshot(page, 'elf-desktop'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('BPF uninitialized memory is not zero-filled, runtime errors recover, and malformed code cannot reuse an old program', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page);
    await raw(page, '62 0a fc ff 78 56 34 12 61 a0 fc ff 00 00 00 00 95 00 00 00 00 00 00 00');
    await expect(page.locator('#bpf-run')).toBeEnabled(); await page.locator('#bpf-memory-offset').fill('508'); await page.locator('#bpf-memory-read').click();
    await expect(page.locator('#bpf-memory')).toContainText('?? ?? ?? ??'); await expect(page.locator('#bpf-memory-save')).toBeDisabled();
    await page.locator('#bpf-step').click(); await expect(page.locator('#bpf-memory')).toContainText('78 56 34 12');
    await saveAs(page, '#bpf-memory-save', 'initialized-stack.bin'); assert.deepEqual(await files(page, { name: 'initialized-stack.bin' }), [0x78, 0x56, 0x34, 0x12]);
    await page.locator('#bpf-memory-offset').fill('9007199254740993'); await expect(page.locator('#bpf-memory-save')).toBeDisabled();
    await page.locator('#bpf-memory-read').click(); await expect(page.locator('#bpf-memory')).toContainText('安全范围');
    await raw(page, '61 a0 fc ff 00 00 00 00 95 00 00 00 00 00 00 00');
    await page.locator('#bpf-run').click(); await expect(page.locator('#bpf-status')).toContainText('未初始化的栈'); await expect(page.locator('#bpf-run')).toBeDisabled();
    await raw(page, 'b7 0a 00 00 00 00 00 00 95 00 00 00 00 00 00 00');
    await expect(page.locator('#bpf-status')).toContainText('仅反汇编'); await expect(page.locator('#bpf-save-disassembly')).toBeEnabled();
    await expect(page.locator('#bpf-run')).toBeDisabled(); await expect(page.locator('#bpf-instructions .bpf-invalid')).toHaveCount(1);
    await raw(page, '00'); await expect(page.locator('#bpf-status')).toContainText('8 字节倍数');
    await expect(page.locator('#bpf-instructions tr')).toHaveCount(0); await expect(page.locator('#bpf-save-disassembly')).toBeDisabled();
    await page.locator('#bpf-example').click(); await expect(page.locator('#bpf-run')).toBeEnabled(); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('BPF pagination and keyboard selection export the complete program rather than the filtered page', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page);
    await raw(page, 'b7 00 00 00 ff ff ff ff ' + '07 00 00 00 01 00 00 00 '.repeat(238) + '95 00 00 00 00 00 00 00');
    await expect(page.locator('#bpf-run')).toBeEnabled(); await page.locator('.bpf-input-panel').evaluate(node => node.open = false);
    await expect(page.locator('#bpf-instructions tr')).toHaveCount(100); await expect(page.locator('#bpf-page')).toHaveText('1 / 3');
    await page.locator('#bpf-instructions tr').first().click(); await page.keyboard.press('End');
    await expect(page.locator('#bpf-instructions [data-pc="239"]')).toBeFocused(); await expect(page.locator('#bpf-page')).toHaveText('3 / 3');
    await page.keyboard.press(' '); await expect(page.locator('#bpf-breakpoint-count')).toHaveText('1 个断点');
    await page.locator('#bpf-filter').fill('exit'); await expect(page.locator('#bpf-instructions tr')).toHaveCount(1);
    await saveAs(page, '#bpf-save-report', 'full-program.json');
    const report = JSON.parse(Buffer.from(await files(page, { name: 'full-program.json' })).toString());
    assert.equal(report.program.instructions.length, 240); assert.deepEqual(report.breakpoints, [239]);
    await page.locator('#bpf-run').click(); await expect(page.locator('#bpf-status')).toContainText('breakpoint');
    await expect(page.locator('#bpf-registers [data-register="0"]')).toContainText('0x00000000000000ed');
    await page.keyboard.press('F10'); await expect(page.locator('#bpf-state-label')).toContainText('halted'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('BPF close and stop terminate delayed Workers without stale registers or reports on reopen', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  let release;
  try {
    await launch(page);
    const barrier = new Promise(resolve => release = resolve);
    await context.route('**/bpf-worker.js', async route => { await barrier; await route.continue().catch(() => {}); });
    await page.locator('#bpf-example').click(); await expect(page.locator('#bpf-stop')).toBeEnabled();
    await page.locator('#bpf-stop').click(); await expect(page.locator('#bpf-status')).toContainText('已停止');
    await expect(page.locator('#bpf-registers tr')).toHaveCount(0); await expect(page.locator('#bpf-run')).toBeDisabled();
    await page.locator('#bpf-reset').click(); await expect(page.locator('#bpf-stop')).toBeEnabled();
    await page.locator('#bpf-window [data-window-action="close"]').click(); release();
    await context.unroute('**/bpf-worker.js'); await launch(page);
    await expect(page.locator('#bpf-status')).toContainText('已停止'); await expect(page.locator('#bpf-run')).toBeDisabled();
    await page.locator('#bpf-reset').click(); await expect(page.locator('#bpf-run')).toBeEnabled();
    await page.locator('#bpf-run').click(); await expect(page.locator('#bpf-registers [data-register="0"]')).toContainText('0x000000000000000a');
    assert.deepEqual(errors, []);
  } finally { release?.(); await context.close(); }
});

test('BPF debugger stays within a narrow desktop and keeps keyboard and memory controls usable', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop({ width: 430, height: 932 });
  try {
    await launch(page); await page.locator('#bpf-example').click(); await expect(page.locator('#bpf-run')).toBeEnabled();
    await page.locator('#bpf-instructions tr').first().click(); await page.keyboard.press('F8'); await expect(page.locator('#bpf-state-label')).toContainText('halted');
    await page.locator('#bpf-memory-region').selectOption('packet'); await expect(page.locator('#bpf-memory')).toContainText('01 02 03 04');
    const bounds = await page.locator('#bpf-window').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 431);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await saveAs(page, '#bpf-memory-save', 'narrow-packet.bin'); assert.deepEqual(await files(page, { name: 'narrow-packet.bin' }), [1, 2, 3, 4]);
    await screenshot(page, 'narrow-desktop'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
