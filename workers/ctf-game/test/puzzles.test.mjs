import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generate } from '../scripts/build-challenges.mjs';
import { recoverGitSeed } from '../scripts/expert/git-decoder.mjs';
import { decodeSequencerEvidence } from '../scripts/expert/sequencer-decoder.mjs';
import {
  decodeTerminal, decodeMidi, decodeQr, decodeWave, decodeImages,
  decodeSignatures, decodeWasm, openSeal, reconstruct,
} from '../scripts/decoders.mjs';

test('the campaign artifacts remain solvable for independent random editions', async (t) => {
  for (let edition = 0; edition < 4; edition++) {
    await t.test('edition ' + (edition + 1), async () => {
      const { artifacts: a, answers, manifest } = await generate(randomBytes(32));
      const codes = answers.codes;
      const capsule = JSON.parse(a[1]['capsule.json']);
      assert.equal(openSeal(capsule, recoverGitSeed(a[1]['objects.pack'], a[1]['checkpoint.tar'], capsule.recipient.x)).code, codes[0]);
      assert.throws(() => recoverGitSeed(a[1]['objects.pack'], Buffer.alloc(1024), capsule.recipient.x), /thin pack/);
      assert.equal(Buffer.from(manifest.conditionalClue, 'base64').toString('ascii').trim().split('\n')[1], codes[1]);
      assert.equal(decodeSequencerEvidence(a[3]).code, codes[2]);
      assert.equal(manifest.shopCode, codes[3]);
      assert.equal(decodeQr(a[5]), codes[4]);
      const six = decodeWave(a[6]['last-broadcast.wav']);
      assert.equal(six.code, codes[5]);
      assert.equal(six.receipt, answers.shares[0]);
      const seven = decodeImages(a[7]['before.png'], a[7]['after.png'], six.receipt);
      assert.equal(seven.code, codes[6]);
      assert.equal(seven.receipt, answers.shares[1]);
      assert.throws(() => decodeImages(a[7]['before.png'], a[7]['after.png'], 'incorrect-receipt'));
      const ledger = JSON.parse(a[8]['ledger.json']);
      assert.equal(new Set(ledger.signatures.map(signature => signature.r)).size, ledger.signatures.length);
      const eight = decodeSignatures(ledger, JSON.parse(a[8]['sealed-letter.json']));
      assert.equal(eight.code, codes[7]);
      assert.equal(eight.receipt, answers.shares[2]);
      const nine = await decodeWasm(a[9]['glass.wasm'], JSON.parse(a[9]['sealed-receipt.json']));
      assert.equal(nine.code, codes[8]);
      assert.equal(nine.receipt, answers.shares[3]);
      const shares = [six.receipt, seven.receipt, eight.receipt, nine.receipt];
      const seal = JSON.parse(a[26]['last-letter.json']);
      assert.equal(openSeal(seal, reconstruct(shares)).code, codes[25]);
      assert.equal(openSeal(seal, reconstruct(shares.toReversed())).code, codes[25]);
      assert.throws(() => reconstruct(shares.slice(0, 3)));
      assert.throws(() => reconstruct([shares[0], shares[0], shares[2], shares[3]]));
      assert.throws(() => openSeal(seal, Buffer.alloc(16)));
      const { instance } = await WebAssembly.instantiate(a[9]['glass.wasm']);
      const memory = new Uint8Array(instance.exports.memory.buffer);
      memory.set(Buffer.from(codes[8], 'ascii'));
      assert.equal(instance.exports.verify(0, 20), 1);
      memory[0] ^= 1;
      assert.equal(instance.exports.verify(0, 20), 0);
      assert.equal(instance.exports.verify(0, 19), 0);
      assert.equal(instance.exports.verify(65535, 20), 0);
      assert.equal(instance.exports.verify(-1, 20), 0);
    });
  }
});

test('a stable seed preserves both codes and artifacts across rebuilds', async () => {
  const seed = randomBytes(32);
  const a = await generate(seed);
  const b = await generate(seed);
  assert.deepEqual(a, b);
});
