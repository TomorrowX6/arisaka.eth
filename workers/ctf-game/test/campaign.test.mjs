import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
import { openSeal, decodeQr, decodeWave, decodeImages, decodeSignatures, decodeWasm, reconstruct } from '../scripts/decoders.mjs';
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
import { decodePowerEvidence } from '../scripts/expert/power-decoder.mjs';

const base = process.env.CTF_E2E_URL || 'http://127.0.0.1:8788';
const expect = baseExpect.configure({ timeout: 20000 });
// Only the entrance is read from the private fixture. Every submitted answer
// below is recovered from the same authenticated evidence available to a player.
const { entryToken } = JSON.parse(await readFile(new URL('../.private/answers.json', import.meta.url), 'utf8'));
let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
after(async () => { await browser?.close(); });

test('the complete campaign is independently solved from served evidence and submitted through Plasma', { timeout: 300000 }, async t => {
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
  try {
    const started = await call('/api/start', { entry: entryToken });
    const receipts = [];
    const final = started.total;
    assert.equal(final, 26);
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
        let result;
        if (stage === 1) {
          const envelope = json('capsule.json');
          result = openSeal(envelope, recoverGitSeed(files['objects.pack'], files['checkpoint.tar'], envelope.recipient.x));
        } else if (stage === 2) {
          const first = await context.request.get(base + '/api/echo');
          const response = await context.request.get(base + '/api/echo', { headers: { 'If-None-Match': first.headers().etag } });
          assert.equal(response.status(), 304);
          result = { code: Buffer.from(response.headers()['x-afterimage'], 'base64').toString().trim().split('\n')[1] };
        } else if (stage === 3) result = decodeSequencerEvidence(files);
        else if (stage === 4) {
          const quote = await call('/api/shop/quote', { item: 'stand', quantity: -3 });
          await call('/api/shop/checkout', { quoteId: quote.quoteId });
          result = await call('/api/shop/redeem', {});
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
        else if (stage === 17) result = await lab({ action: 'redeem', token: forgeGcmToken(json('capture.json'), (await lab()).binding) });
        else if (stage === 18) {
          const token = await forgePaddingToken(await lab(), async tokens => (await lab({ action: 'probe', tokens })).results);
          result = await lab({ action: 'redeem', token });
        } else if (stage === 19) {
          const proof = await recoverCurveProof(json('parameters.json'), files['peers.bin'], await lab(), point => lab({ action: 'exchange', ...point }));
          result = await lab({ action: 'redeem', proof });
        } else if (stage === 20) result = decodeTrieEvidence(files);
        else if (stage === 21) result = decodeCoreEvidence(files['process.core'], json('capsule.json'));
        else if (stage === 22) result = decodePdfEvidence(files);
        else if (stage === 23) result = decodeLatticeEvidence(json('signatures.json'), files['trace.bin'], json('capsule.json'));
        else if (stage === 24) result = await lab({ action: 'redeem', ...forgeWotsSignature(json('device.json'), json('capture.json'), (await lab()).binding) });
        else if (stage === 25) result = decodePowerEvidence(files);
        else if (stage === final) result = openSeal(json('last-letter.json'), reconstruct(receipts));
        else throw Error('Missing independent decoder for case ' + stage);
        assert.match(result.code, /^[a-z0-9]{20}$/, 'recovered code format');
        if (result.receipt) receipts.push(result.receipt);
        await page.goto(base + '/#case-' + stage, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#play')).toBeVisible();
        await expect(page.locator('#case-title')).toHaveText(String(stage).padStart(2, '0'));
        await expect(page.locator('#answer-form')).toBeVisible();
        await expect(page.locator('#answer-button')).toBeEnabled({ timeout: 30000 });
        await page.locator('#answer-input').fill(result.code);
        await page.locator('#answer-button').click();
        await expect(page.locator('#solved-panel')).toBeVisible();
        assert.equal((await call('/api/session')).stage, stage + 1);
        completed = true;
      });
      // Report the actual failed case instead of 25 follow-up "locked" errors.
      if (!completed) return;
    }
    await page.locator('#next-button').click();
    await expect(page.locator('#completion')).toBeVisible();
    const proof = await call('/api/proof');
    assert.equal(proof.completion.cases, final);
    assert.equal(proof.completion.attempts, final);
    assert.deepEqual((await call('/api/proof/verify', { proof: proof.proof })).completion, proof.completion);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#proof-output')).toHaveValue(proof.proof);
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#case-title')).toHaveText(String(final - 1).padStart(2, '0'));
    await expect(page.locator('#solved-panel')).toBeVisible();
    await page.goForward({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#completion')).toBeVisible();
    await expect(page.locator('#proof-output')).toHaveValue(proof.proof);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
