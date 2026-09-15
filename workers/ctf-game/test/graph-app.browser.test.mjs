import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';

const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const expect = baseExpect.configure({ timeout: 20000 });
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
after(async () => { await browser?.close(); });
async function desktop(viewport = { width: 1440, height: 1050 }) {
  const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [], failedResources = [];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failedResources.push(response.status() + ' ' + new URL(response.url()).pathname); });
  assert.equal((await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } })).status(), 200);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  try { await expect(page.locator('#desktop')).toBeVisible(); }
  catch (error) { const gate = await page.locator('#gate-status').textContent(); await context.close(); throw Error(error.message + '\nStartup errors: ' + errors.join(' | ') + '\nResources: ' + failedResources.join(' | ') + '\nGate: ' + gate); }
  return { context, page, errors };
}
async function launch(page, id = 'graph', name = '图分析台') {
  await page.locator('#launcher-button').click(); await page.locator('#launcher-search').fill(name);
  await page.locator('#launcher-apps [data-launch="' + id + '"]').click(); await expect(page.locator('#' + id + '-window')).toBeVisible();
  await page.waitForFunction(id => !document.querySelector('#' + id + '-window').dataset.motionState, id);
}
async function files(page, value) {
  return page.evaluate(async value => {
    const { createFilesystem } = await import('/filesystem.js'), { apiFetch } = await import('/transport.js');
    const state = await (await apiFetch('/api/session')).json();
    const fs = createFilesystem({ state: () => state, notes: () => ({ text: '', receipts: [] }), api: async path => (await apiFetch(path)).json() });
    await fs.setPlayer(state.player);
    if (value.write) { await fs.writeFile(value.name, value.text); return; }
    return new TextDecoder().decode(await fs.read('/home/user/Documents/' + value.name));
  }, value);
}
async function save(page, button, name) {
  await page.locator(button).click(); await page.locator('dialog[open] input').fill(name);
  await page.locator('dialog[open]').getByRole('button', { name: '确定', exact: true }).click(); await expect(page.locator('dialog[open]')).toHaveCount(0);
}
async function input(page, value) {
  if (!await page.locator('.graph-paste').evaluate(node => node.open)) await page.locator('.graph-paste summary').click();
  await page.locator('#graph-input').fill(typeof value === 'string' ? value : JSON.stringify(value)); await page.locator('#graph-load-text').click();
}
async function screenshot(page, name) {
  await mkdir(new URL('../.private/graph-qa/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('../.private/graph-qa/' + name + '.png', import.meta.url).pathname });
}

test('graph analysis uses a real Worker and exports exact full paths, normalized graphs, DOT and source provenance', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop(), workers = [];
  page.on('worker', worker => workers.push(worker.url()));
  try {
    await launch(page); await page.locator('#graph-example').click(); await expect(page.locator('#graph-run')).toBeEnabled();
    await expect(page.locator('#graph-summary')).toContainText('9 节点 / 9 边'); await expect(page.locator('#graph-result-text')).toContainText('非 DAG');
    await page.locator('#graph-kind').selectOption('shortest'); await expect(page.locator('#graph-save-report')).toBeDisabled(); await page.locator('#graph-run').click();
    await expect(page.locator('#graph-result-text')).toContainText('距离 6'); await expect(page.locator('#graph-run')).toBeFocused();
    await save(page, '#graph-save-report', 'shortest.json'); const result = JSON.parse(await files(page, { name: 'shortest.json' }));
    assert.equal(result.format, 'arisaka-graph-analysis-v1'); assert.equal(result.analysis.algorithm, 'Dijkstra'); assert.equal(result.analysis.distance, '6');
    assert.deepEqual(result.analysis.path.nodes, ['entry', 'decode', 'fast', 'join', 'loop', 'guard', 'exit']); assert.equal(result.analysis.distances.length, 9);
    assert.equal(result.sourceSha256, createHash('sha256').update(await page.locator('#graph-input').inputValue()).digest('hex'));
    assert.ok(workers.some(url => url.endsWith('/analysis-worker.js')));
    await save(page, '#graph-save-json', 'saved.graph.json'); assert.deepEqual(JSON.parse(await files(page, { name: 'saved.graph.json' })), result.graph);
    await save(page, '#graph-save-dot', 'saved.dot'); const dot = await files(page, { name: 'saved.dot' });
    assert.match(dot, /^digraph G/); assert.ok(dot.includes('"guard" -> "exit"')); assert.ok(dot.includes('"dead" [label="unreachable block"]'));
    await screenshot(page, 'shortest-desktop'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('dominator chains, loop frontiers and keyboard endpoint changes are functional and invalidate stale reports', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page); await page.locator('#graph-example').click(); await expect(page.locator('#graph-run')).toBeEnabled();
    await page.locator('#graph-kind').selectOption('dominators'); await page.locator('#graph-frontier').check();
    const canvas = page.locator('#graph-canvas'); await canvas.press('Control+Enter'); await expect(page.locator('#graph-result-text')).toContainText('entry → decode → join → loop → guard → exit');
    await expect(canvas).toBeFocused(); for (let i = 0; i < 5; i++) await canvas.press('ArrowRight');
    await expect(page.locator('#graph-selection')).toHaveText('选中 loop'); await expect(page.locator('#graph-node-detail')).toContainText('直接支配者：join');
    await expect(page.locator('#graph-node-detail')).toContainText('支配边界：loop');
    await save(page, '#graph-save-report', 'dominator.json'); const result = JSON.parse(await files(page, { name: 'dominator.json' }));
    assert.equal(result.analysis.rows.find(row => row.id === 'dead').reachable, false); assert.deepEqual(result.analysis.rows.find(row => row.id === 'guard').frontier, ['loop']);
    await canvas.press('Enter'); await expect(page.locator('#graph-source')).toHaveValue('loop'); await expect(page.locator('#graph-save-report')).toBeDisabled();
    await canvas.press('Control+Enter'); await expect(page.locator('#graph-result-text')).toContainText('loop → guard → exit');
    await expect(canvas).toBeFocused(); await canvas.press('Shift+Enter'); await expect(page.locator('#graph-target')).toHaveValue('loop');
    await expect(page.locator('#graph-save-report')).toBeDisabled(); await canvas.press('Control+Enter'); await expect(page.locator('#graph-save-report')).toBeEnabled();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('CSV file association preserves quoted IDs and large exact weights; labels are never HTML and direction is explicit', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const value = 900719925474099312345678901n, id = 'a,<img src=x>', csv = 'id,source,target,weight\r\np,"' + id + '",b,' + value + '\r\nq,b,c,' + (-value + 2n) + '\r\nr,"' + id + '",c,3\r\n';
    await files(page, { write: true, name: 'quoted.edges.csv', text: csv });
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('#desktop')).toBeVisible();
    await launch(page, 'console', 'Konsole'); const shell = page.locator('#console-sessions .console-session:not([hidden]) .session-form input').first();
    await shell.fill('open ~/Documents/quoted.edges.csv'); await shell.press('Enter'); await expect(page.locator('#graph-window')).toBeVisible();
    await expect(page.locator('#graph-summary')).toContainText('3 节点 / 3 边'); await expect(page.locator('#graph-table-body img')).toHaveCount(0);
    await expect(page.locator('#graph-selection')).toHaveText('选中 ' + id);
    await page.locator('#graph-kind').selectOption('shortest'); await page.locator('#graph-target').fill('c'); await page.locator('#graph-run').click();
    await expect(page.locator('#graph-result-text')).toContainText('距离 2'); await save(page, '#graph-save-report', 'exact.json');
    const result = JSON.parse(await files(page, { name: 'exact.json' })); assert.equal(result.graph.edges[0].weight, String(value)); assert.equal(result.sourceSha256, createHash('sha256').update(csv).digest('hex'));
    await page.locator('.graph-paste summary').click(); await page.locator('#graph-csv-directed').uncheck(); await expect(page.locator('#graph-summary')).toContainText('无向多重图');
    await expect(page.locator('#graph-result-text')).toContainText('不报告有向拓扑序');
    await page.locator('#graph-kind').selectOption('shortest'); await page.locator('#graph-run').click(); await expect(page.locator('#graph-result-text')).toContainText('距离无下界');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('reachable negative cycles affect only descendants and report verifiable witnesses, not fake finite paths', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page); await input(page, { edges: [['s', 'a', 0], ['a', 'b', -2], ['b', 'a', 1], ['b', 't', 2], ['s', 'safe', 5], ['x', 'y', -2], ['y', 'x', 1]] });
    await expect(page.locator('#graph-run')).toBeEnabled(); await page.locator('.graph-paste summary').click(); await page.locator('#graph-kind').selectOption('shortest');
    await page.locator('#graph-source').fill('s'); await page.locator('#graph-target').fill('safe'); await page.locator('#graph-run').click();
    await expect(page.locator('#graph-result-text')).toContainText('距离 5'); await expect(page.locator('#graph-result-text')).toContainText('影响 3 节点');
    await page.locator('#graph-target').fill('t'); await expect(page.locator('#graph-save-report')).toBeDisabled(); await page.locator('#graph-canvas').press('Control+Enter');
    await expect(page.locator('#graph-result-text')).toContainText('不存在有限最短路'); await save(page, '#graph-save-report', 'negative.json');
    const result = JSON.parse(await files(page, { name: 'negative.json' })); assert.equal(result.analysis.path, null); assert.equal(result.analysis.distance, null);
    assert.deepEqual(result.analysis.affected, ['a', 'b', 't']); assert.equal(result.analysis.negativeCycle.weight, '-1');
    assert.equal(result.analysis.distances.find(row => row.id === 'x').status, 'unreachable'); await screenshot(page, 'negative-cycle'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('large graphs have bounded previews and paged searchable tables but full-graph analysis and exports', { timeout: 120000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const nodes = Array.from({ length: 600 }, (_, i) => 'node-' + String(i).padStart(3, '0'));
    const edges = [...nodes.slice(1).map((id, i) => [nodes[i], id]), ...Array.from({ length: 1600 }, () => [nodes[0], nodes[1], 2])];
    await launch(page); await input(page, { nodes, edges }); await expect(page.locator('#graph-run')).toBeEnabled();
    await page.locator('.graph-paste summary').click(); await expect(page.locator('#graph-table-body tr')).toHaveCount(100);
    await expect(page.locator('#graph-preview-note')).toContainText('400 / 600 节点，1500 /');
    await page.locator('#graph-next').click(); await expect(page.locator('#graph-page')).toHaveText('600 项 · 2 / 6');
    await page.locator('#graph-filter').fill('node-599'); await expect(page.locator('#graph-table-body tr')).toHaveCount(1); await expect(page.locator('#graph-filter')).toBeFocused();
    await page.locator('#graph-table-body button').click(); await expect(page.locator('#graph-selection')).toHaveText('选中 node-599'); await expect(page.locator('#graph-table-body button')).toBeFocused();
    await page.locator('#graph-kind').selectOption('dominators'); await page.locator('#graph-run').click(); await expect(page.locator('#graph-save-report')).toBeEnabled();
    await save(page, '#graph-save-report', 'large.json'); const result = JSON.parse(await files(page, { name: 'large.json' }));
    assert.equal(result.graph.nodes.length, 600); assert.equal(result.graph.edges.length, 2199); assert.equal(result.analysis.chain.length, 600);
    assert.equal(result.summary.layout.positions.length, 600); assert.equal(result.analysis.rows.at(-1).immediate, 'node-598');
    await page.locator('#graph-table-kind').selectOption('edges'); await page.locator('#graph-incident').check(); await expect(page.locator('#graph-page')).toHaveText('1 项 · 1 / 1');
    await page.locator('#graph-table-body button').first().click(); await expect(page.locator('#graph-selection')).toHaveText('选中 node-598');
    await expect(page.locator('#graph-table-body button').first()).toBeFocused(); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('cancellation, close/reopen and invalid graph input cannot resurrect an old export', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop(); let release;
  try {
    await launch(page); await page.locator('#graph-example').click(); await expect(page.locator('#graph-run')).toBeEnabled();
    const barrier = new Promise(resolve => release = resolve); await context.route('**/analysis-worker.js', async route => { await barrier; await route.continue().catch(() => {}); });
    await page.locator('#graph-run').click(); await expect(page.locator('#graph-stop')).toBeEnabled(); await page.locator('#graph-stop').click();
    await expect(page.locator('#graph-status')).toHaveText('已停止'); await expect(page.locator('#graph-save-report')).toBeDisabled();
    await page.locator('#graph-run').click(); await expect(page.locator('#graph-stop')).toBeEnabled(); await page.locator('#graph-window [data-window-action=close]').click();
    release(); await context.unroute('**/analysis-worker.js'); await launch(page); await expect(page.locator('#graph-save-report')).toBeDisabled();
    await page.locator('#graph-run').click(); await expect(page.locator('#graph-save-report')).toBeEnabled();
    await input(page, { nodes: ['declared'], edges: [['declared', 'missing']] }); await expect(page.locator('#graph-status')).toContainText('未声明节点');
    for (const id of ['run', 'save-report', 'save-json', 'save-dot']) await expect(page.locator('#graph-' + id)).toBeDisabled();
    await expect(page.locator('#graph-table-body tr')).toHaveCount(0); await page.locator('#graph-example').click(); await expect(page.locator('#graph-save-report')).toBeEnabled(); assert.deepEqual(errors, []);
  } finally { release?.(); await context.close(); }
});

test('narrow graph tools retain keyboard selection, zoom, focus and accessible exports without horizontal overflow', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop({ width: 390, height: 844 });
  try {
    await launch(page); await page.locator('#graph-example').press('Enter'); await expect(page.locator('#graph-run')).toBeEnabled();
    const node = page.locator('#graph-window'), bounds = await node.boundingBox(); assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 391);
    assert.ok(await node.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    const canvas = page.locator('#graph-canvas'); await canvas.press('ArrowRight'); await expect(page.locator('#graph-selection')).toHaveText('选中 decode');
    // Camera rendering is requestAnimationFrame-driven. Check each exact scale
    // after its frame, not a one-shot DOM read that may see the previous frame.
    await expect(page.locator('#graph-zoom')).toHaveText('40%'); await canvas.press('+');
    await expect(page.locator('#graph-zoom')).toHaveText('56%');
    await canvas.press('Shift+ArrowRight'); await canvas.press('Home'); await canvas.press('Control+Enter'); await expect(page.locator('#graph-save-report')).toBeEnabled(); await expect(canvas).toBeFocused();
    await save(page, '#graph-save-report', 'narrow-graph.json'); assert.equal(JSON.parse(await files(page, { name: 'narrow-graph.json' })).graph.nodes.length, 9);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await canvas.scrollIntoViewIfNeeded(); await screenshot(page, 'graph-mobile'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('ultrawide graph canvas allocation remains capped and input works after resizing', { timeout: 90000 }, async () => {
  const { context, page, errors } = await desktop({ width: 5120, height: 1000 });
  try {
    await launch(page); await page.locator('#graph-example').click(); await expect(page.locator('#graph-run')).toBeEnabled();
    await page.locator('#graph-window [data-window-action=maximize]').click(); await page.waitForFunction(() => document.querySelector('#graph-canvas').clientWidth > 4096);
    await expect(page.locator('#graph-canvas')).toHaveAttribute('width', '4096'); await page.setViewportSize({ width: 1100, height: 850 });
    await page.locator('#graph-canvas').press('ArrowRight'); await expect(page.locator('#graph-selection')).toHaveText('选中 decode'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
