import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
import { openSeal } from '../scripts/decoders.mjs';
import { recoverGitSeed } from '../scripts/expert/git-decoder.mjs';
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
  await expect(field).toBeEditable();
  await field.fill(text); await field.press('Enter');
}
async function firstRecovery(context) {
  const record = await (await context.request.get(base + '/api/cases/1')).json();
  const files = Object.fromEntries(await Promise.all(record.files.map(async ({ name, url }) => [name, await (await context.request.get(base + url)).body()])));
  const envelope = JSON.parse(files['capsule.json']);
  const material = recoverGitSeed(files['objects.pack'], files['checkpoint.tar'], envelope.recipient.x);
  return { material, result: openSeal(envelope, material) };
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

test('user creation, password validation, switching, appearance, and save deletion', { timeout: 120000 }, async () => {
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
    await expect(page.locator('#console-window')).toBeVisible();
    await expect(page.locator('#console-directory')).toHaveText('/home/user/档案/01');
    const expertId = await page.evaluate(async () => (await import('/preferences.js')).listProfiles().find(user => user.username === 'expert').id);
    const previousCookies = (await context.cookies()).map(cookie => cookie.name + '=' + cookie.value).join('; ');
    await launch(page, 'settings', '系统设置');
    await page.locator('[data-settings-page="users"]').click();
    await page.locator('.user-card').filter({hasText:'Expert'}).click();
    await page.locator('dialog[open] [name="current"]').fill('test-password');
    await page.locator('dialog[open] [data-delete]').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('.user-card').filter({hasText:'Expert'})).toHaveCount(0);
    const retired = await context.request.get(base + '/api/cases/1', { headers: { Cookie: previousCookies, 'X-Desktop-Profile': expertId } });
    assert.equal(retired.status(), 401, 'deleted profile cookie no longer opens the save');
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
    for(const [id,name]of [['console','Konsole'],['http','HTTP'],['editor','Kate'],['settings','系统设置'],['database','SQLite'],['keys','Kleopatra'],['media','Elisa'],['imageviewer','Gwenview'],['discover','Discover']]){
      await launch(page,id,name);
      // Geometry assertions compare the final layout, after the entrance scale settles.
      await page.waitForFunction(id => !document.getElementById(id + '-window').dataset.motionState, id);
      const bounds=await page.locator('#'+id+'-window').boundingBox();
      assert.ok(bounds.x>=0&&bounds.x+bounds.width<=321,id+' window is within viewport');
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
      assert.equal(overflow,false,id+' does not overflow the document');
      if (id === 'discover') {
        const search = await page.locator('#discover-search').boundingBox();
        const list = await page.locator('#discover-list').boundingBox();
        const body = await page.locator('#discover-window .window-body').boundingBox();
        assert.ok(search.height <= 45, 'Discover search remains a single-line control');
        assert.ok(list.width >= body.width - 2 && list.height > body.height * .7, 'Discover list fills the available window: ' + JSON.stringify({ search, list, body }));
      }
      await page.locator('#'+id+'-window [data-window-action="close"]').click();
    }
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('native cases open the real Konsole without a passcode form', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await page.goto(base + '/#case-1', { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#console-window')).toBeVisible();
    await expect(page.locator('#answer-form, .answer-section')).toHaveCount(0);
    await expect(page.locator('#console-directory')).toHaveText('/home/user/档案/01');
    await shell(page, 'pwd');
    await expect(page.locator('#console-sessions .session-output')).toContainText('/home/user/档案/01');
    await shell(page, 'ls');
    await expect(page.locator('#console-sessions .session-output')).toContainText('objects.pack');
    await shell(page, 'printf \'%s\' \'ordinary note\' > ~/Documents/notes-check.txt');
    await expect(page.locator('#console-sessions .session-form input')).toBeEditable();
    assert.equal((await (await context.request.get(base + '/api/session')).json()).stage, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Konsole awaits script stdout before piping and saving it', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'console', 'Konsole');
    await shell(page, 'node -e \'await new Promise(resolve => setTimeout(resolve, 80)); console.log("pipeline-ready");\' | base64 > ~/Documents/pipeline.txt');
    await expect(page.locator('#editor-run')).toBeEnabled();
    await expect(page.locator('#console-sessions .session-form input')).toBeEditable();
    await shell(page, 'base64 -d ~/Documents/pipeline.txt');
    await expect(page.locator('#console-sessions .session-output .shell-line').last()).toHaveText('pipeline-ready');
    assert.equal((await (await context.request.get(base + '/api/session')).json()).stage, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Ctrl+C settles a running script without recovering partial stdout or saving its redirect', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const { result } = await firstRecovery(context);
    await launch(page, 'console', 'Konsole');
    await shell(page, 'node -e \'console.log(' + JSON.stringify(result) + '); await new Promise(resolve => setTimeout(resolve, 60000));\' > ~/Documents/interrupted.json');
    await expect(page.locator('#editor-stop')).toBeEnabled();
    const input = page.locator('#console-sessions .session-form input').first();
    await input.press('Control+c');
    await expect(input).toBeEditable();
    await expect(page.locator('#editor-run')).toBeEnabled();
    await expect(page.locator('#console-sessions .session-output')).toContainText('Interrupted');
    await shell(page, 'cat ~/Documents/interrupted.json');
    await expect(page.locator('#console-sessions .session-output .shell-line').last()).toContainText('ENOENT');
    assert.equal((await (await context.request.get(base + '/api/session')).json()).stage, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a decrypted capsule saved by Konsole recovers its case and keeps the terminal in place', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const { material, result } = await firstRecovery(context);
    const attempts = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/answer') attempts.push(request.postDataJSON()); });
    await page.goto(base + '/#case-1', { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#console-directory')).toHaveText('/home/user/档案/01');
    const source = [
      'const seal = JSON.parse(await fs.readText("/home/user/档案/01/capsule.json"));',
      'const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));',
      'const material = new Uint8Array(' + JSON.stringify([...material]) + ');',
      'const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", material), "AES-GCM", false, ["decrypt"]);',
      'const ciphertext = bytes(seal.ciphertext), tag = bytes(seal.tag);',
      'const data = new Uint8Array(ciphertext.length + tag.length); data.set(ciphertext); data.set(tag, ciphertext.length);',
      'const clear = await crypto.subtle.decrypt({name:"AES-GCM", iv:bytes(seal.nonce), additionalData:new TextEncoder().encode(seal.context), tagLength:128}, key, data);',
      'console.log(JSON.parse(new TextDecoder().decode(clear)));',
    ].join(' ');
    await shell(page, "node -e '" + source + "' > ~/Documents/recovered-01.json");
    await expect(page.locator('#progress-count')).toHaveText('01 / 26');
    await expect(page.locator('#console-window')).toBeVisible();
    await expect(page.locator('#console-directory')).toHaveText('/home/user/档案/01');
    await expect(page.locator('#console-sessions .session-form input').first()).toBeFocused();
    await expect(page.locator('#http-window')).toBeHidden();
    await shell(page, 'cat ~/Documents/recovered-01.json');
    await expect(page.locator('#console-sessions .session-output .shell-line').last()).toHaveText(JSON.stringify(result));
    assert.deepEqual(attempts, [{ stage: 1, code: result.code }]);
    await shell(page, 'cat /usr/share/doc/recovery.txt');
    await expect(page.locator('#console-sessions .session-output .shell-line').last()).toContainText('Ctrl+C');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Kate recovers only a successfully saved document and restores it after reload', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    const { result } = await firstRecovery(context);
    const attempts = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/answer') attempts.push(request.postDataJSON()); });
    await launch(page, 'editor', 'Kate');
    const text = JSON.stringify(result, null, 2);
    await page.locator('#editor-code .cm-content').fill(text);
    await expect(page.locator('#editor-text')).toHaveValue(text);
    assert.equal(attempts.length, 0, 'typing a recovered document is not a submission');
    await page.locator('#editor-save').click();
    await page.locator('dialog[open] input').fill('/home/user/档案/01/recovered.json');
    await page.locator('dialog[open]').getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('EACCES');
    assert.equal(attempts.length, 0, 'a rejected file write is not a submission');
    await page.locator('#editor-save').click();
    await page.locator('dialog[open] input').fill('recovered-01.json');
    await page.locator('dialog[open]').getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.locator('#progress-count')).toHaveText('01 / 26');
    await expect(page.locator('#editor-name')).toHaveValue('recovered-01.json');
    await expect(page.locator('#editor-window')).toHaveClass(/focused/);
    await page.locator('#editor-save').click();
    assert.deepEqual(attempts, [{ stage: 1, code: result.code }]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#progress-count')).toHaveText('01 / 26');
    await expect(page.locator('#console-window')).toBeVisible();
    await expect(page.locator('#console-directory')).toHaveText('/home/user/档案/01');
    await launch(page, 'editor', 'Kate');
    await expect(page.locator('#editor-name')).toHaveValue('recovered-01.json');
    await expect(page.locator('#editor-text')).toHaveValue(text);
    assert.equal((await (await context.request.get(base + '/api/session')).json()).stage, 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a delayed HTTP session refresh cannot roll back a recovery from another application', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  let release;
  const resume = new Promise(resolve => { release = resolve; });
  try {
    const { result } = await firstRecovery(context);
    let reached;
    const refreshing = new Promise(resolve => { reached = resolve; });
    await page.route('**/api/session', async route => {
      const response = await route.fetch();
      reached();
      await resume;
      await route.fulfill({ response });
    });
    await launch(page, 'http', 'HTTP');
    await page.locator('#network-path').fill('/api/terminal');
    await page.locator('#network-method').selectOption('POST');
    await page.locator('[data-request-tab="body"]').click();
    await page.locator('#network-body').fill(JSON.stringify({ command: 'pwd', cwd: '/archive' }));
    await page.locator('#network-send').click();
    await refreshing;
    await launch(page, 'console', 'Konsole');
    await shell(page, 'node -e \'console.log(' + JSON.stringify(result) + ');\'');
    await expect(page.locator('#progress-count')).toHaveText('01 / 26');
    release();
    await expect(page.locator('#network-send')).toBeEnabled();
    await expect(page.locator('#progress-count')).toHaveText('01 / 26');
    assert.equal((await (await context.request.get(base + '/api/session')).json()).stage, 2);
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test('a background Konsole command leaves keyboard focus in the application being edited', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  let release;
  const resume = new Promise(resolve => { release = resolve; });
  try {
    const record = await (await context.request.get(base + '/api/cases/1')).json();
    let reached;
    const reading = new Promise(resolve => { reached = resolve; });
    await page.route(base + record.files.find(file => file.name === 'capsule.json').url, async route => {
      const response = await route.fetch();
      reached();
      await resume;
      await route.fulfill({ response });
    });
    await launch(page, 'console', 'Konsole');
    await shell(page, 'node -e \'await fs.readText("/home/user/档案/01/capsule.json"); console.log("read complete");\'');
    await reading;
    await launch(page, 'editor', 'Kate');
    const content = page.locator('#editor-code .cm-content');
    await content.fill('Continue editing here');
    await content.focus();
    release();
    await expect(page.locator('#console-sessions .session-output .shell-line').last()).toHaveText('read complete');
    await expect(page.locator('#console-sessions .session-form input').first()).toBeEditable();
    await expect(content).toBeFocused();
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test('Dolphin groups all cases in one folder and reports access denied when opening a locked case', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await page.locator('#files-home').click();
    const archive = page.locator('#files-primary [data-file-path="/home/user/档案"]');
    await expect(archive).toBeVisible();
    await expect(page.locator('#files-primary [data-file-path="/home/user/01"]')).toHaveCount(0);
    await archive.dblclick();
    await expect(page.locator('#file-location')).toHaveValue('/home/user/档案');
    await expect(page.locator('#files-primary .file-item')).toHaveCount(26);
    const locked = page.locator('#files-primary [data-file-path="/home/user/档案/02"]');
    await locked.dblclick();
    await expect(page.getByRole('dialog', { name: '禁止访问', exact: true })).toBeVisible();
    await expect(page.locator('#file-location')).toHaveValue('/home/user/档案');
    await page.locator('dialog[open]').getByRole('button', { name: '确定', exact: true }).click();
    await page.locator('#files-primary [data-file-path="/home/user/档案/01"]').dblclick();
    await expect(page.locator('#file-location')).toHaveValue('/home/user/档案/01');
    await expect(page.locator('#files-primary [data-file-path="/home/user/档案/01/objects.pack"]')).toBeVisible();
    assert.equal((await (await context.request.get(base + '/api/session')).json()).stage, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('window motion survives rapid minimize, restore, close, and reopen', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop({ viewport: { width: 1525, height: 998 } });
  try {
    await launch(page, 'calculator', 'KCalc');
    const window = page.locator('#calculator-window');
    await page.waitForFunction(() => !document.querySelector('#calculator-window').dataset.motionState);
    await page.evaluate(async () => {
      const { getSettings, updateSettings } = await import('/preferences.js');
      updateSettings({ pinnedApps: [...getSettings().pinnedApps, 'calculator'] });
    });
    const original = await window.boundingBox();
    for (const action of ['minimize', 'close']) {
      const during = await page.evaluate(action => {
        const node = document.querySelector('#calculator-window');
        node.querySelector('[data-window-action=' + action + ']').click();
        const during = { hidden: node.hidden, inert: node.inert, animating: node.getAnimations().length > 0 };
        document.querySelector('#tasks [data-task=calculator]').click();
        return during;
      }, action);
      assert.deepEqual(during, { hidden: false, inert: true, animating: true }, action + ' animates an inactive outgoing window');
      await page.waitForFunction(() => !document.querySelector('#calculator-window').dataset.motionState);
      await expect(window).toBeVisible();
      assert.equal(await window.evaluate(node => node.inert), false, 'reopened window accepts input');
      await expect(page.locator('#tasks [data-task=calculator]')).toHaveAttribute('aria-pressed', 'true');
    }
    for (let i = 0; i < 2; i++) {
      await window.locator('[data-window-action=maximize]').click();
      await page.waitForFunction(() => !document.querySelector('#calculator-window').dataset.motionState);
      if (i === 0) await expect(page.locator('.plasma-panel')).toHaveClass(/touching-window/);
      else await expect(page.locator('.plasma-panel')).not.toHaveClass(/touching-window/);
    }
    const restored = await window.boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(original[key] - restored[key]) <= 1, 'restore preserves ' + key);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('virtual desktops follow the KWin spring and preserve momentum on reversal', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop({ viewport: { width: 1525, height: 998 } });
  try {
    await launch(page, 'calculator', 'KCalc');
    await page.waitForFunction(() => !document.querySelector('#calculator-window').dataset.motionState);
    const samples = await page.evaluate(async () => {
      const { isSurfaceOpen } = await import('/motion.js');
      const node = document.querySelector('#calculator-window');
      const select = index => document.querySelectorAll('#desktop-pager button')[index].click();
      const slide = () => node.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.translate));
      const x = () => parseFloat(getComputedStyle(node).translate) || 0;
      select(1);
      const outgoing = { hidden: node.hidden, inert: node.inert, open: isSurfaceOpen(node) };
      const forward = slide(); forward.pause();
      forward.currentTime = 100; const at100 = x();
      forward.currentTime = 300; const at300 = x();
      forward.currentTime = 100; const beforeReverse = x();
      select(0);
      const reverse = slide(); reverse.pause();
      reverse.currentTime = 0; const atReverse = x();
      reverse.currentTime = 10; const afterReverse = x();
      reverse.play();
      return { outgoing, at100, at300, beforeReverse, atReverse, afterReverse };
    });
    assert.deepEqual(samples.outgoing, { hidden: false, inert: true, open: false });
    // Independent samples from KWin v6.3.5 SpringMotion, with a 1525px desktop.
    assert.ok(Math.abs(samples.at100 + 719.867913) < .5, '100ms position follows the reference spring');
    assert.ok(Math.abs(samples.at300 + 1445.677936) < .5, '300ms position follows the reference spring');
    assert.ok(Math.abs(samples.atReverse - samples.beforeReverse) < .5, 'reversal does not jump');
    assert.ok(samples.afterReverse < samples.atReverse - 50, 'reversal retains outgoing momentum');
    await page.waitForFunction(() => !document.querySelector('#calculator-window').dataset.motionState);
    await expect(page.locator('#calculator-window')).toBeVisible();
    assert.equal(await page.locator('#calculator-window').evaluate(node => node.inert), false);
    await page.keyboard.press('Control+Alt+ArrowRight');
    await expect(page.locator('#calculator-window')).toBeHidden();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('Control+Alt+ArrowLeft');
    const restored = await page.locator('#calculator-window').evaluate(node => ({ hidden: node.hidden, inert: node.inert, animations: node.getAnimations().length }));
    assert.deepEqual(restored, { hidden: false, inert: false, animations: 0 });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('desktop and system reduced-motion preferences settle windows immediately', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop({ reducedMotion: 'reduce' });
  try {
    await launch(page, 'calculator', 'KCalc');
    const minimized = await page.evaluate(() => {
      const node = document.querySelector('#calculator-window');
      node.querySelector('[data-window-action=minimize]').click();
      return { hidden: node.hidden, animations: node.getAnimations().length };
    });
    assert.deepEqual(minimized, { hidden: true, animations: 0 });
    await page.locator('#tasks [data-task=calculator]').click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(async () => (await import('/preferences.js')).updateSettings({ animations: false }));
    const closed = await page.evaluate(() => {
      const node = document.querySelector('#calculator-window');
      node.querySelector('[data-window-action=close]').click();
      return { hidden: node.hidden, animations: node.getAnimations().length };
    });
    assert.deepEqual(closed, { hidden: true, animations: 0 });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('task previews are inert and activate, restore, and close their window', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'calculator', 'KCalc');
    const task = page.locator('#tasks [data-task=calculator]');
    const preview = page.locator('#task-preview');
    await task.hover();
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute('data-task', 'calculator');
    await expect(preview.locator('.window-thumbnail [id]')).toHaveCount(0);
    assert.equal(await preview.locator('.window-thumbnail').evaluate(node => node.inert), true);
    await preview.locator('#task-preview-activate').click();
    await expect(page.locator('#calculator-window')).toHaveClass(/focused/);
    await page.locator('#calculator-window [data-window-action=minimize]').click();
    await expect(page.locator('#calculator-window')).toBeHidden();
    await task.focus();
    await expect(preview).toBeVisible();
    await preview.locator('#task-preview-activate').click();
    await expect(page.locator('#calculator-window')).toBeVisible();
    await task.focus();
    await expect(preview).toBeVisible();
    await preview.locator('[data-preview-close]').click();
    await expect(page.locator('#calculator-window')).toBeHidden();
    await expect(preview).toBeHidden();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Kickoff aligns its header and supports keyboard search and dismissal', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await page.locator('#launcher-button').click();
    const search = page.locator('#launcher-search');
    // Read both controls in the same frame while the popup slides into view.
    const { user, field } = await page.locator('#launcher').evaluate(node => ({
      user: node.querySelector('#launcher-user').getBoundingClientRect().toJSON(),
      field: node.querySelector('#launcher-search').getBoundingClientRect().toJSON(),
    }));
    assert.ok(Math.abs(user.y + user.height / 2 - field.y - field.height / 2) < 12, 'user and search share the Kickoff header');
    await search.fill('Konsole');
    const result = page.locator('#launcher-apps [data-launch=console]');
    await expect(page.locator('#launcher-apps [data-launch]')).toHaveCount(1);
    await search.press('ArrowDown');
    await expect(result).toBeFocused();
    await result.press('Enter');
    await expect(page.locator('#console-window')).toBeVisible();
    await expect(page.locator('#launcher')).toBeHidden();
    await expect(page.locator('#launcher-button')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#launcher-button').click();
    await search.press('Escape');
    await expect(page.locator('#launcher')).toBeHidden();
    await expect(page.locator('#launcher-button')).toBeFocused();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('KRunner restores application focus after repeated shortcut activation', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'console', 'Konsole');
    const command = page.locator('#console-sessions .console-session:not([hidden]) .session-form input').first();
    await command.focus();
    await page.keyboard.press('Alt+Space');
    await expect(page.locator('#runner-search')).toBeFocused();
    await page.keyboard.press('Alt+Space');
    await page.keyboard.press('Escape');
    await expect(page.locator('#krunner')).toBeHidden();
    await expect(command).toBeFocused();
    await page.keyboard.type('focus-restored');
    await expect(command).toHaveValue('focus-restored');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('window thumbnails preserve the current scroll position and decoration', { timeout: 60000 }, async () => {
  const { context, page, errors } = await desktop();
  try {
    await launch(page, 'discover', 'Discover');
    const list = page.locator('#discover-list');
    await list.evaluate(node => { node.scrollTop = 600; });
    const position = await list.evaluate(node => node.scrollTop);
    assert.ok(position > 0, 'the app is showing a scrolled list');
    await page.locator('#tasks [data-task=discover]').hover();
    const preview = page.locator('#task-preview');
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.locator('.discover-list').evaluate(node => node.scrollTop)).toBe(position);
    assert.equal(await list.evaluate(node => node.scrollTop), position, 'preview leaves the live app scroll unchanged');
    const closeGlyph = await preview.locator('[data-window-action=close]').evaluate(node => getComputedStyle(node, '::after').content);
    assert.notEqual(closeGlyph, 'none', 'window decoration is present in the thumbnail');
    await expect(preview.locator('.window-thumbnail [id]')).toHaveCount(0);
    await page.locator('#discover-window [data-window-action=maximize]').click();
    await page.waitForFunction(() => !document.querySelector('#discover-window').dataset.motionState);
    await page.locator('#tasks [data-task=discover]').hover();
    await expect(preview).toBeVisible();
    const originalGlyph = await page.locator('#discover-window [data-window-action=maximize]').evaluate(node => getComputedStyle(node, '::after').transform);
    const previewGlyph = await preview.locator('[data-window-action=maximize]').evaluate(node => getComputedStyle(node, '::after').transform);
    assert.equal(previewGlyph, originalGlyph, 'maximized thumbnail preserves the restore button glyph');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
