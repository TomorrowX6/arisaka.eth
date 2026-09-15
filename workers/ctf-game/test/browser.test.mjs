import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 20000 });

const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
after(async () => { await browser?.close(); });

async function desktop(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const response = await context.request.post(base + '/api/start', { data: { entry: entryToken }, headers: { 'X-Afterglow': '1' } });
  assert.equal(response.status(), 200, 'test entrance accepted');
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [], missing = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) missing.push(new URL(response.url()).pathname); });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await expect(page.locator('#desktop')).toBeVisible();
    await expect(page.locator('#file-count')).not.toHaveText('0 个文件');
  } catch (error) {
    const status = await page.locator('#gate-status').textContent();
    await context.close();
    throw new Error('Desktop boot failed: ' + JSON.stringify({errors, missing, status}), {cause: error});
  }
  return { context, page, errors, missing };
}
async function launch(page, id, query = id) {
  await page.locator('#launcher-button').click();
  await page.locator('#launcher-search').fill(query);
  await page.locator('#launcher-apps [data-launch="' + id + '"]').click();
  await expect(page.locator('#' + id + '-window')).toBeVisible();
}
async function query(page, sql) {
  await page.locator('#database-sql').fill(sql);
  await page.locator('#database-run').click();
  await expect(page.locator('#database-run')).toBeEnabled({ timeout: 30000 });
}
async function shell(page, text) {
  const field = page.locator('#console-sessions .console-session:not([hidden]) .session-form input').first();
  await field.fill(text); await field.press('Enter');
}

// These tests exercise the public browser modules and the actual application UI.
// No fixture or operator answer data is made available as a public asset.
test('desktop boots every built-in application without missing resources', { timeout: 150000 }, async () => {
  const { context, page, errors, missing } = await desktop();
  try {
    const apps = await page.evaluate(async () => (await import('/applications.js')).applications.filter(app => !app.hidden).map(({id,name}) => ({id,name})));
    for (const { id, name } of apps) {
      await launch(page, id, name);
      await page.locator('#' + id + '-window [data-window-action="close"]').click();
    }
    assert.equal(apps.length >= 22, true);
    assert.deepEqual(errors, []); assert.deepEqual(missing, []);
  } finally { await context.close(); }
});

test('SQLite read-only execution, schema refresh, cancellation, and save confirmation', { timeout: 120000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'database', 'SQLite');
    await page.locator('#database-new').click();
    await expect(page.locator('#database-path')).toHaveText('untitled.sqlite');
    await page.locator('#database-readonly').uncheck();
    await query(page, 'CREATE TABLE evidence (value INTEGER); INSERT INTO evidence VALUES (42); SELECT value FROM evidence;');
    await expect(page.locator('#database-tables button')).toHaveText('evidence');
    await expect(page.locator('#database-results tbody td')).toHaveText('42');
    await page.locator('#database-readonly').check();
    await query(page, 'PRAGMA query_only=OFF; DELETE FROM evidence;');
    await expect(page.locator('#database-status')).toContainText('只读');
    await query(page, 'SELECT value FROM evidence;');
    await expect(page.locator('#database-results tbody td')).toHaveText('42');
    await page.locator('#database-sql').fill('WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<100000000) SELECT sum(x) FROM seq;');
    await page.locator('#database-run').click();
    await expect(page.locator('#database-stop')).toBeEnabled();
    await page.locator('#database-stop').click();
    await query(page, 'SELECT value FROM evidence;');
    await expect(page.locator('#database-results tbody td')).toHaveText('42');
    await page.locator('#database-window [data-window-action="close"]').click();
    await expect(page.getByRole('dialog').filter({ hasText: '保存更改' })).toBeVisible();
    await page.locator('dialog[open]').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('#database-window')).toBeVisible();
    await page.locator('#database-save').click();
    await page.locator('dialog[open] input').fill('evidence.sqlite');
    await page.locator('dialog[open]').getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.locator('#database-path')).toHaveText('/home/user/Documents/evidence.sqlite');
    await page.locator('#database-window [data-window-action="close"]').click();
    await expect(page.locator('#database-window')).toBeHidden();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('IndexedDB preserves large files, migrations, directory trash, and concurrent changes', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const result = await page.evaluate(async () => {
      const { createFilesystem, DOCUMENTS, TRASH } = await import('/filesystem.js');
      const make = () => createFilesystem({ state: () => ({stage: 0, catalog: []}), notes: () => ({text:'',receipts:[]}), api: () => { throw Error('unexpected API'); } });
      const id = 'test-' + crypto.randomUUID(), fs = make(); await fs.setPlayer(id);
      const data = Uint8Array.from({length: 2 * 1024 * 1024 + 7}, (_,i) => i * 17 & 255);
      await fs.writeFile('large.bin', data);
      await Promise.all(Array.from({length: 12}, (_,i) => fs.writeFile('record-' + i + '.txt', String(i))));
      await fs.mkdir('tree'); await fs.mkdir('tree/child'); await fs.writeFile('tree/child/data.bin', data.subarray(0,256));
      await fs.rename(DOCUMENTS + '/tree', 'renamed'); await fs.remove(DOCUMENTS + '/renamed');
      const trash = await fs.entries(TRASH); await fs.restore(trash[0].path);
      const restored = await fs.read(DOCUMENTS + '/renamed/child/data.bin');
      const other = make(); await other.setPlayer(id);
      const reloaded = await other.read(DOCUMENTS + '/large.bin');
      await fs.writeFile('new.txt', 'first');
      let conflict = ''; try { await other.writeFile('new.txt', 'second'); } catch(error) { conflict = error.message; }
      const fresh = make(); await fresh.setPlayer(id);
      const legacyId = 'legacy-' + crypto.randomUUID();
      localStorage.setItem('arisaka/files/' + legacyId, JSON.stringify([[DOCUMENTS + '/legacy.txt', btoa('legacy'), 123]]));
      const legacy = make(); await legacy.setPlayer(legacyId);
      const migrated = await legacy.readText(DOCUMENTS + '/legacy.txt');
      const count = (await fresh.entries(DOCUMENTS)).length;
      return {bytes: reloaded.length, same: reloaded.every((byte,i) => byte === data[i]), restored: restored.length, conflict, current: await fresh.readText(DOCUMENTS + '/new.txt'), migrated, legacyRemoved: !localStorage.getItem('arisaka/files/' + legacyId), count};
    });
    assert.equal(result.bytes, 2 * 1024 * 1024 + 7); assert.equal(result.same, true);
    assert.equal(result.restored, 256); assert.match(result.conflict, /^ESTALE/);
    assert.equal(result.current, 'first'); assert.equal(result.migrated, 'legacy');
    assert.equal(result.legacyRemoved, true); assert.equal(result.count, 15); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('user creation, password validation, switching, and per-user appearance', { timeout: 120000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const original = await page.evaluate(async () => (await (await fetch('/api/session')).json()).player);
    await launch(page, 'settings', '系统设置');
    await page.locator('[data-settings-page="users"]').click();
    await page.locator('#user-add').click();
    await page.locator('dialog[open] [name="username"]').fill('expert');
    await page.locator('dialog[open] [name="name"]').fill('Expert');
    await page.locator('dialog[open] [name="password"]').fill('test-password');
    await page.locator('dialog[open] [type="submit"]').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0).catch(async error => { throw new Error('User creation: ' + await page.locator('body').evaluate(body => body.querySelector('.profile-error')?.textContent || 'unknown'), {cause: error}); });
    await page.locator('.user-card').filter({hasText:'Expert'}).click();
    await page.locator('dialog[open] [name="current"]').fill('incorrect');
    await page.locator('dialog[open] [data-switch]').click();
    await expect(page.locator('.profile-error')).toHaveText('密码错误');
    await page.locator('dialog[open] [name="current"]').fill('test-password');
    await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('dialog[open] [data-switch]').click()]);
    await expect(page.locator('#desktop')).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await import('/filesystem.js')).HOME)).toBe('/home/expert');
    await expect(page.locator('#screen-lock')).toBeHidden();
    const other = await page.evaluate(async () => (await (await (await import('/transport.js')).apiFetch('/api/session')).json()).player);
    assert.notEqual(other, original);
    await launch(page, 'settings', '系统设置');
    await page.locator('[data-settings-page="appearance"]').click();
    await page.locator('[data-theme-choice="nord"]').click();
    await page.locator('#settings-apply').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
    await page.locator('#launcher-button').click(); await page.locator('#launcher-lock').click();
    await page.locator('#lock-users button').filter({hasText:'Arisaka'}).click();
    await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('#unlock-button').click()]);
    await expect.poll(() => page.evaluate(async () => (await import('/filesystem.js')).HOME)).toBe('/home/user');
    await expect(page.locator('#screen-lock')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'breeze-dark');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('script runner loads files on demand and saves output through bounded file RPC', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'console', 'Konsole');
    await shell(page, "echo 'console.log((await fs.readdir(\"/home/user/Documents\")).length); await fs.writeFile(\"rpc.txt\", \"complete\"); console.log(await fs.readText(\"/home/user/Documents/rpc.txt\"));' > /home/user/Documents/rpc.js");
    await expect(page.locator('#console-sessions .session-form input').first()).toBeEnabled();
    await shell(page, 'node /home/user/Documents/rpc.js');
    await expect(page.locator('#console-sessions .session-output')).toContainText('complete');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Python runs in Konsole with real standard libraries, durable files, and isolated networking', { timeout: 120000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'console', 'Konsole');
    const source = [
      'import hashlib, zlib, struct, fractions',
      'data = bytes(range(256)) * 17',
      'assert zlib.decompress(zlib.compress(data)) == data',
      'assert fractions.Fraction(11, 7) + fractions.Fraction(3, 7) == 2',
      'await fs.write_bytes("python-result.bin", data)',
      'assert await fs.read_bytes("/home/user/Documents/python-result.bin") == data',
      'print("PYTHON_OK", hashlib.sha256(data).hexdigest())',
      'from js import XMLHttpRequest',
      'try:',
      '    request = XMLHttpRequest.new()',
      '    request.open("GET", "/api/session", False)',
      '    request.send()',
      '    print("NETWORK_ALLOWED")',
      'except Exception:',
      '    print("NETWORK_DENIED")',
    ].join('\n');
    await page.evaluate(async source => {
      const { createFilesystem } = await import('/filesystem.js');
      const { apiFetch } = await import('/transport.js');
      const state = await (await apiFetch('/api/session')).json();
      const fs = createFilesystem({state:()=>state,notes:()=>({text:'',receipts:[]}),api:async path=>(await apiFetch(path)).json()});
      await fs.setPlayer(state.player); await fs.writeFile('runtime-check.py',source);
    }, source);
    await page.reload(); await expect(page.locator('#desktop')).toBeVisible();
    await launch(page, 'console', 'Konsole');
    await shell(page, 'python3 /home/user/Documents/runtime-check.py');
    await expect(page.locator('#console-sessions .session-output')).toContainText('NETWORK_DENIED', {timeout:60000});
    await expect(page.locator('#console-sessions .session-output')).toContainText('PYTHON_OK');
    await expect(page.locator('#console-sessions .session-output')).not.toContainText('NETWORK_ALLOWED');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

function pdfFixture() {
  const contents=['BT /F1 16 Tf 24 145 Td (Desktop document) Tj ET','BT /F1 16 Tf 24 145 Td (Second page record) Tj ET'];
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>','<< /Length '+contents[0].length+' >>\nstream\n'+contents[0]+'\nendstream','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>','<< /Length '+contents[1].length+' >>\nstream\n'+contents[1]+'\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let data='%PDF-1.4\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(data));data+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n';}
  const xref=Buffer.byteLength(data);data+='xref\n0 '+offsets.length+'\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
  return Buffer.from(data);
}
test('Dolphin imports PDFs and Okular renders, searches, and exports their text', { timeout: 90000 }, async () => {
  const {context,page,errors,missing}=await desktop();
  try {
    await launch(page,'files','Dolphin');
    await page.locator('#files-menubar button').filter({hasText:/^文件$/}).click();
    const choose=page.waitForEvent('filechooser');
    await page.locator('.native-menu').getByRole('menuitem',{name:'导入文件…'}).click();
    await (await choose).setFiles({name:'review.pdf',mimeType:'application/pdf',buffer:pdfFixture()});
    await page.locator('#files-primary .file-item').filter({hasText:'review.pdf'}).dblclick();
    await expect(page.locator('#viewer-sheet canvas')).toBeVisible();
    await expect(page.locator('#viewer-pages')).toHaveText('/ 2');
    await expect(page.locator('#viewer-sheet .textLayer')).toContainText('Desktop document');
    await page.locator('#viewer-edit').click();
    await expect(page.locator('#editor-text')).toHaveValue(/Desktop document[\s\S]*Second page record/);
    await page.locator('#editor-window [data-window-action="minimize"]').click();
    await page.locator('#viewer-find').click();await page.locator('#viewer-search').fill('Second page');
    await expect(page.locator('#viewer-page')).toHaveValue('2');
    await expect(page.locator('#viewer-thumbnails [data-page="1"] pre')).toContainText('Second page record');
    await page.locator('#viewer-edit').click();
    await expect(page.locator('#editor-text')).toHaveValue(/Desktop document[\s\S]*Second page record/);
    assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);
  } finally {await context.close();}
});

test('Kleopatra creates protected keys and performs actual OpenPGP encryption and signatures', { timeout: 120000 }, async () => {
  const {context,page,errors}=await desktop();
  try {
    await launch(page,'keys','Kleopatra');await page.locator('#pgp-create').click();
    await page.locator('dialog[open] [name="name"]').fill('Desktop test');
    await page.locator('dialog[open] [name="email"]').fill('desktop@example.invalid');
    await page.locator('dialog[open] [name="password"]').fill('key-test-password');
    await page.locator('dialog[open] [type="submit"]').click();
    await expect(page.locator('#pgp-key-list button')).toHaveCount(1);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    const message='Forensic document 9274';
    await page.locator('#pgp-input').fill(message);await page.locator('#pgp-run').click();
    await expect(page.locator('#pgp-output')).toHaveValue(/BEGIN PGP MESSAGE/);
    const ciphertext=await page.locator('#pgp-output').inputValue();
    await page.locator('#pgp-operation').selectOption('decrypt');await page.locator('#pgp-input').fill(ciphertext);
    await page.locator('#pgp-password').fill('key-test-password');await page.locator('#pgp-run').click();
    await expect(page.locator('#pgp-output')).toHaveValue(message);
    await page.locator('#pgp-operation').selectOption('sign');await page.locator('#pgp-input').fill(message);
    await page.locator('#pgp-password').fill('key-test-password');await page.locator('#pgp-run').click();
    await expect(page.locator('#pgp-output')).toHaveValue(/BEGIN PGP SIGNATURE/);
    const signature=await page.locator('#pgp-output').inputValue();
    await page.locator('#pgp-operation').selectOption('verify');await page.locator('#pgp-signature').fill(signature);
    await page.locator('#pgp-run').click();await expect(page.locator('#pgp-status')).toHaveText('签名有效');
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('small displays keep application controls within the desktop viewport', { timeout: 120000 }, async () => {
  const {context,page,errors}=await desktop({viewport:{width:320,height:740},isMobile:true,hasTouch:true});
  try {
    for(const [id,name]of [['settings','系统设置'],['database','SQLite'],['keys','Kleopatra'],['media','Elisa'],['imageviewer','Gwenview']]){
      await launch(page,id,name);
      const bounds=await page.locator('#'+id+'-window').boundingBox();
      assert.ok(bounds.x>=0&&bounds.x+bounds.width<=321,id+' window is within viewport');
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
      assert.equal(overflow,false,id+' does not overflow the document');
      await page.locator('#'+id+'-window [data-window-action="close"]').click();
    }
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});
