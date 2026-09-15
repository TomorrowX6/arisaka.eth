import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
import caseCatalog from '../src/case-catalog.json' with { type: 'json' };
import { openSeal, decodeQr, decodeWave, decodeImages, decodeSignatures, signatureMaterial, decodeWasm, reconstruct } from '../scripts/decoders.mjs';
import { recoverMachineInput } from '../scripts/expert/vm-decoder.mjs';
import { recoverGitSeed } from '../scripts/expert/git-decoder.mjs';
import { decodeSequencerEvidence } from '../scripts/expert/sequencer-decoder.mjs';
import { decodeTlsEvidence } from '../scripts/expert/tls-decoder.mjs';
import { decodeWalEvidence } from '../scripts/expert/wal-decoder.mjs';
import { decodeRsaEvidence } from '../scripts/expert/rsa-decoder.mjs';
import { recoverFaultKey } from '../scripts/expert/fault-decoder.mjs';
import { decodeOciEvidence } from '../scripts/expert/oci-decoder.mjs';
import { decodeStorageEvidence } from '../scripts/expert/storage-decoder.mjs';
import { decodeNandEvidence } from '../scripts/expert/nand-decoder.mjs';
import { forgeGcmToken } from '../scripts/expert/gcm-decoder.mjs';
import { forgePaddingToken } from '../scripts/expert/padding-decoder.mjs';
import { recoverCurveProof } from '../scripts/expert/curve-decoder.mjs';
import { decodeTrieEvidence } from '../scripts/expert/trie-decoder.mjs';
import { decodeCoreEvidence } from '../scripts/expert/core-decoder.mjs';
import { decodePdfEvidence } from '../scripts/expert/pdf-decoder.mjs';
import { decodeLatticeEvidence } from '../scripts/expert/lattice-decoder.mjs';
import { forgeWotsSignature } from '../scripts/expert/wots-decoder.mjs';
import { decodeQuicEvidence } from '../scripts/expert/quic-decoder.mjs';
import { decodeDnssecEvidence } from '../scripts/expert/dnssec-decoder.mjs';
import { decodeLogicEvidence } from '../scripts/expert/logic-decoder.mjs';
import { decodeFrostEvidence, recoverFrostMaterial } from '../scripts/expert/frost-decoder.mjs';
import { decodeRs16Evidence, recoverRs16Material } from '../scripts/expert/rs16-decoder.mjs';
import { decodeBpfEvidence } from '../scripts/expert/bpf-decoder.mjs';
import { decodeMlkemEvidence } from '../scripts/expert/mlkem-decoder.mjs';
import { decodePowerEvidence } from '../scripts/expert/power-decoder.mjs';

const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const expect = baseExpect.configure({ timeout: 20000 });
// A live deployment has many more network round trips than the local fixture.
// Keep every individual action's 20 s deadline; only the whole campaign budget
// is explicitly adjustable for release verification. Never silently retry it.
const campaignTimeout = Number(process.env.CTF_CAMPAIGN_TIMEOUT_MS ?? 300000);
if (!Number.isSafeInteger(campaignTimeout) || campaignTimeout < 300000 || campaignTimeout > 1800000) {
  throw Error('CTF_CAMPAIGN_TIMEOUT_MS must be an integer from 300000 to 1800000');
}
// Only the entrance is read from the private fixture. Every recovered document
// below comes from the same authenticated evidence available to a player.
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
after(async () => { await browser?.close(); });

test('the complete campaign is independently recovered through Plasma applications', { timeout: campaignTimeout }, async t => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const call = async (path, data) => {
    const response = data === undefined
      ? await context.request.get(base + path)
      : await context.request.post(base + path, { data, headers: { 'X-Afterglow': '1' } });
    assert.equal(response.status(), 200, path + ' status');
    return response.json();
  };
  const launch = async (id, name) => {
    await page.locator('#launcher-button').click();
    await page.locator('#launcher-search').fill(name);
    await page.locator('#launcher-apps [data-launch="' + id + '"]').click();
    await expect(page.locator('#' + id + '-window')).toBeVisible();
  };
  const shell = async command => {
    const input = page.locator('#console-sessions .console-session:not([hidden]) .session-form input').first();
    await expect(input).toBeEditable();
    await input.fill(command); await input.press('Enter');
    await expect(input).toBeEditable();
  };
  const http = async (path, data, headers = '') => {
    if (!await page.locator('#http-window').evaluate(node => node.classList.contains('focused'))) await launch('http', 'HTTP');
    await page.locator('#network-path').fill(path);
    await page.locator('#network-method').selectOption(data === undefined ? 'GET' : 'POST');
    await page.locator('[data-request-tab="headers"]').click();
    await page.locator('#network-headers').fill(headers);
    if (data !== undefined) {
      await page.locator('[data-request-tab="body"]').click();
      await page.locator('#network-body').fill(JSON.stringify(data));
    }
    await page.locator('#network-send').click();
    await expect(page.locator('#network-send')).toBeEnabled();
    const text = await page.locator('#network-output').textContent();
    assert.match(text, /^HTTP (200|304)\n/);
    return text;
  };
  const httpJson = async (path, data) => JSON.parse((await http(path, data)).split('\n\n').slice(1).join('\n\n'));
  const saveDocument = async (stage, result) => {
    await launch('editor', 'Kate');
    await page.locator('#editor-new').click();
    await page.locator('#editor-code .cm-content').fill(JSON.stringify(result, null, 2));
    await page.locator('#editor-save').click();
    const name = 'recovered-' + String(stage).padStart(2, '0') + '.json';
    await page.locator('dialog[open] input').fill(name);
    await page.locator('dialog[open]').getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.locator('#editor-name')).toHaveValue(name);
  };
  try {
    const started = await call('/api/start', { entry: entryToken });
    const receipts = [];
    let frostMaterial, rs16Material;
    const final = started.total;
    assert.equal(final, caseCatalog.length);
    for (let stage = 1; stage <= final; stage++) {
      let completed = false;
      await t.test('case ' + String(stage).padStart(2, '0'), async () => {
        const detail = await call('/api/cases/' + stage);
        const files = Object.fromEntries(await Promise.all(detail.files.map(async ({ name, url }) => {
          const response = await context.request.get(base + url);
          assert.equal(response.status(), 200, 'artifact ' + name);
          return [name, await response.body()];
        })));
        const json = name => JSON.parse(files[name]);
        const lab = value => call('/api/labs/' + stage, value);
        await page.goto(base + '/#case-' + stage, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#desktop')).toBeVisible();
        await expect(page.locator('#answer-form, .answer-section')).toHaveCount(0);
        const directory = '/home/user/档案/' + String(stage).padStart(2, '0');
        if (detail.widget === 'terminal') {
          await expect(page.locator('#console-window')).toBeVisible();
          await expect(page.locator('#console-directory')).toHaveText(directory);
        } else if (detail.widget === 'http') {
          await expect(page.locator('#http-window')).toBeVisible();
          await expect(page.locator('#network-path')).toHaveValue('/api/echo');
        } else if (detail.widget === 'audio') await expect(page.locator('#media-window')).toBeVisible();
        else if (detail.widget === 'artifacts') {
          await expect(page.locator('[data-window="files"]')).toBeVisible();
          await expect(page.locator('#file-location')).toHaveValue(directory);
        } else {
          await expect(page.locator('#play')).toBeVisible();
          await expect(page.locator('#workbench')).not.toHaveAttribute('inert', '');
        }
        let result, recoveredInApp = false;
        if (stage === 1) {
          const envelope = json('capsule.json');
          result = openSeal(envelope, recoverGitSeed(files['objects.pack'], files['checkpoint.tar'], envelope.recipient.x));
          await shell('node -e \'console.log(' + JSON.stringify(result) + ');\' > ~/Documents/recovered-01.json');
          recoveredInApp = true;
        } else if (stage === 2) {
          const first = await http('/api/echo');
          const etag = /^etag: (.+)$/mi.exec(first)?.[1];
          assert.ok(etag, 'the HTTP client exposes response headers');
          const response = await http('/api/echo', undefined, 'If-None-Match: ' + etag);
          assert.match(response, /^HTTP 304/);
          const encoded = /^x-afterimage: (.+)$/mi.exec(response)?.[1];
          result = { code: Buffer.from(encoded, 'base64').toString().trim().split('\n')[1] };
          await launch('console', 'Konsole');
          await shell('printf \'%s\' \'' + encoded + '\' | base64 -d');
          recoveredInApp = true;
        } else if (stage === 3) result = decodeSequencerEvidence(files);
        else if (stage === 4) {
          const quote = await httpJson('/api/shop/quote', { item: 'stand', quantity: -3 });
          await httpJson('/api/shop/checkout', { quoteId: quote.quoteId });
          result = await httpJson('/api/shop/redeem', {});
          recoveredInApp = true;
        } else if (stage === 5) result = { code: decodeQr(files) };
        else if (stage === 6) result = decodeWave(files['last-broadcast.wav']);
        else if (stage === 7) result = decodeImages(files['before.png'], files['after.png'], receipts[0]);
        else if (stage === 8) result = decodeSignatures(json('ledger.json'), json('sealed-letter.json'));
        else if (stage === 9) result = await decodeWasm(files['glass.wasm'], json('sealed-receipt.json'));
        else if (stage === 10) result = decodeTlsEvidence(files['wire.pcapng']);
        else if (stage === 11) result = await decodeWalEvidence(files['catalog.db'], files['journal.segment'], json('capsule.json'));
        else if (stage === 12) result = decodeRsaEvidence(json('telemetry.json'), files['emitter.py'], json('capsule.json'));
        else if (stage === 13) result = openSeal(json('capsule.json'), recoverFaultKey(files['acquisition.csv']));
        else if (stage === 14) result = decodeOciEvidence(files);
        else if (stage === 15) result = decodeStorageEvidence(files['fragments.tar']);
        else if (stage === 16) result = decodeNandEvidence(files['nand.bin']);
        else if (stage === 17) {
          result = await httpJson('/api/labs/17', { action: 'redeem', token: forgeGcmToken(json('capture.json'), (await lab()).binding) });
          recoveredInApp = true;
        }
        else if (stage === 18) {
          const token = await forgePaddingToken(await lab(), async tokens => (await lab({ action: 'probe', tokens })).results);
          result = await httpJson('/api/labs/18', { action: 'redeem', token });
          recoveredInApp = true;
        } else if (stage === 19) {
          const proof = await recoverCurveProof(json('parameters.json'), files['peers.bin'], await lab(), point => lab({ action: 'exchange', ...point }));
          result = await httpJson('/api/labs/19', { action: 'redeem', proof });
          recoveredInApp = true;
        } else if (stage === 20) result = decodeTrieEvidence(files);
        else if (stage === 21) result = decodeCoreEvidence(files['process.core'], json('capsule.json'));
        else if (stage === 22) result = decodePdfEvidence(files);
        else if (stage === 23) result = decodeLatticeEvidence(json('signatures.json'), files['trace.bin'], json('capsule.json'));
        else if (stage === 24) {
          result = await httpJson('/api/labs/24', { action: 'redeem', ...forgeWotsSignature(json('device.json'), json('capture.json'), (await lab()).binding) });
          recoveredInApp = true;
        }
        else if (stage === 25) result = decodePowerEvidence(files);
        else if (stage === 26) result = openSeal(json('last-letter.json'), reconstruct(receipts));
        else if (stage === 27) result = decodeQuicEvidence(files);
        else if (stage === 28) result = decodeDnssecEvidence(files);
        else if (stage === 29) result = decodeLogicEvidence(files);
        else if (stage === 30) { result = decodeFrostEvidence(files); frostMaterial = recoverFrostMaterial(files).material; }
        else if (stage === 31) { result = decodeRs16Evidence(files); rs16Material = recoverRs16Material(files).material; }
        else if (stage === 32) result = decodeBpfEvidence(files, frostMaterial, rs16Material);
        else if (stage === 33) result = decodeMlkemEvidence(files);
        else throw Error('Missing independent decoder for case ' + stage);
        assert.match(result.code, /^[a-z0-9]{20}$/, 'recovered code format');
        if (result.receipt) receipts.push(result.receipt);
        if ([8, 9, 26].includes(stage)) {
          const material = stage === 8 ? signatureMaterial(json('ledger.json')).toString('hex')
            : stage === 9 ? (await recoverMachineInput(files['glass.wasm'])).toString('ascii')
            : reconstruct(receipts).toString('hex');
          await page.locator('#seal-input').fill(material);
          await page.locator('.decrypt-form button').click();
          await expect(page.locator('#seal-result')).toContainText(result.code);
          recoveredInApp = true;
        }
        if (!recoveredInApp) await saveDocument(stage, result);
        await expect(page.locator('#progress-count')).toHaveText(String(stage).padStart(2, '0') + ' / ' + final);
        if (result.receipt) await expect(page.locator('[data-receipt="' + Number(result.receipt.slice(0, 2)) + '"]')).toHaveValue(result.receipt);
        assert.equal((await call('/api/session')).stage, stage + 1);
        completed = true;
      });
      // Report the actual failed case instead of 25 follow-up "locked" errors.
      if (!completed) return;
    }
    await expect(page.locator('#completion')).toBeVisible();
    const proof = await call('/api/proof');
    assert.equal(proof.completion.cases, final);
    assert.equal(proof.completion.attempts, final);
    assert.deepEqual((await call('/api/proof/verify', { proof: proof.proof })).completion, proof.completion);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#proof-output')).toHaveValue(proof.proof);
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#file-location')).toHaveValue('/home/user/档案/' + String(final - 1).padStart(2, '0'));
    await expect(page.locator('#progress-count')).toHaveText(final + ' / ' + final);
    await page.goForward({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#completion')).toBeVisible();
    await expect(page.locator('#proof-output')).toHaveValue(proof.proof);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
