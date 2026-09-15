import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import vectors from './fixtures/nist-mlkem768.json' with { type: 'json' };
import { seededRandom } from '../scripts/core.mjs';
import { generate } from '../scripts/build-challenges.mjs';
import { openSeal } from '../scripts/decoders.mjs';
import { mlkemEvidence, mlkemCrc32c, encodeMlkemCbor } from '../scripts/expert/mlkem.mjs';
import { decodeMlkemEvidence, recoverMlkemMaterial, readMlkemCbor, selectMlkemCheckpoint } from '../scripts/expert/mlkem-decoder.mjs';
import { kemNtt, kemNttProduct, kemMod, kemEncode, kemDecode, kemEncapsulate, kemDecapsulate, kemRecoverPolynomial, kemCheckSecret } from '../scripts/expert/mlkem-core.mjs';

test('independent ML-KEM and pinned producer match official NIST FIPS 203 accepted/rejected and malformed-key vectors', () => {
  for (const row of vectors.vectors) {
    const bytes = key => Buffer.from(row[key], 'hex');
    if (row.function === 'encapsulation') {
      const reference = kemEncapsulate(bytes('ek'), bytes('m')), producer = ml_kem768.encapsulate(bytes('ek'), bytes('m'));
      assert.deepEqual(reference.ciphertext, bytes('c'), 'tcId ' + row.tcId);
      assert.deepEqual(reference.sharedSecret, bytes('k'));
      assert.deepEqual(Buffer.from(producer.cipherText), bytes('c'));
      assert.deepEqual(Buffer.from(producer.sharedSecret), bytes('k'));
    }
    if (['encapsulation', 'decapsulation'].includes(row.function)) {
      const result = kemDecapsulate(bytes('c'), bytes('dk'));
      assert.deepEqual(result.sharedSecret, bytes('k'), 'tcId ' + row.tcId);
      assert.equal(result.accepted, row.reason !== 'modified ciphertext');
      assert.deepEqual(Buffer.from(ml_kem768.decapsulate(bytes('c'), bytes('dk'))), bytes('k'));
    } else if (row.function === 'decapsulationKeyCheck') {
      assert.equal(row.testPassed, false);
      assert.throws(() => kemDecapsulate(Buffer.alloc(1088), bytes('dk')), /key hash check/);
    } else if (row.function === 'encapsulationKeyCheck') {
      assert.equal(row.testPassed, false);
      assert.throws(() => kemEncapsulate(bytes('ek'), Buffer.alloc(32)), /non-canonical/);
    }
  }
});

test('incomplete NTT quadratic multiplication agrees with an independent negacyclic schoolbook oracle', () => {
  const random = seededRandom(Buffer.alloc(32, 0x75), 'ntt-schoolbook');
  for (let attempt = 0; attempt < 4; attempt++) {
    const a = Int32Array.from({ length: 256 }, () => random(2).readUInt16LE() % 3329), b = Int32Array.from({ length: 256 }, () => random(2).readUInt16LE() % 3329);
    const expected = new Int32Array(256);
    for (let i = 0; i < 256; i++) for (let j = 0; j < 256; j++) expected[(i + j) & 255] = kemMod(expected[(i + j) & 255] + (i + j >= 256 ? -1 : 1) * a[i] * b[j]);
    assert.deepEqual(kemNtt(kemNtt(a), true), a);
    assert.deepEqual(kemNtt(kemNttProduct(kemNtt(a), kemNtt(b)), true), expected);
    assert.deepEqual(kemDecode(kemEncode([a]), 1, 12, true)[0], a);
  }
});

test('erased NTT words are recovered from small coefficient constraints without q^4 enumeration', () => {
  const random = seededRandom(Buffer.alloc(32, 0x26), 'ntt-erasure');
  for (let attempt = 0; attempt < 24; attempt++) {
    const original = kemNtt(Array.from({ length: 256 }, () => random(1)[0] % 5 - 2)), erased = Array.from(original), positions = new Set();
    while (positions.size < attempt % 5) positions.add(random(1)[0]);
    for (const index of positions) erased[index] = null;
    const result = kemRecoverPolynomial(erased);
    assert.deepEqual(result.polynomial, original); assert.equal(result.candidates, 5 ** positions.size);
  }
  const row = vectors.vectors[0], publicKey = Buffer.from(row.ek, 'hex'), secret = kemDecode(Buffer.from(row.dk, 'hex').subarray(0, 1152), 3, 12, true);
  assert.equal(kemCheckSecret(secret, publicKey), true);
  const coefficient = kemNtt(secret[0], true); coefficient[0] = coefficient[0] === 2 ? 1 : 2; secret[0] = kemNtt(coefficient);
  assert.equal(kemCheckSecret(secret, publicKey), false, 'CBD alone must not replace the public matrix relation');
  assert.throws(() => kemRecoverPolynomial(Array(256).fill(null)), /at most four/);
  assert.throws(() => kemRecoverPolynomial(Array(256).fill(3329)), /canonical/);
  assert.throws(() => kemNtt(Array(255).fill(0)), /256/);
  assert.throws(() => kemEncapsulate(publicKey.subarray(1), Buffer.alloc(32)), /1184/);
  assert.throws(() => kemDecapsulate(Buffer.alloc(1087), Buffer.alloc(2400)), /1088/);
});

test('masked checkpoints recover across multiple seeds, authenticate epochs, and exercise true implicit rejection', () => {
  assert.equal(mlkemCrc32c(Buffer.from('123456789')), 0xe3069283);
  for (let i = 0; i < 20; i++) {
    const code = 'synthetic-mlkem-' + i, files = mlkemEvidence(code, seededRandom(randomBytes(32), 'mlkem-case'));
    const result = recoverMlkemMaterial(files), selected = selectMlkemCheckpoint(files);
    assert.equal(Number(selected.epoch), Number(selected.epoch - 1n), 'Number cannot distinguish these epochs');
    assert.deepEqual(result.erasures, [4, 4, 4]); assert.deepEqual(result.candidates, [625, 625, 625]);
    assert.deepEqual(result.accepted, [true, false]); assert.equal(result.rejectedRecords, 1); assert.equal(result.duplicateRecords, 2);
    assert.deepEqual(result.messages[0], result.messages[1], 'the low-u-bit mutation preserves the K-PKE plaintext');
    assert.notDeepEqual(result.sharedSecrets[0], result.sharedSecrets[1], 'FO reencryption must still reject the second session');
    assert.deepEqual(openSeal(JSON.parse(files['capsule.json']), result.material), { code });
    const wrong = Buffer.from(result.material); wrong.set(result.sharedSecrets[0], wrong.length - 32);
    assert.throws(() => openSeal(JSON.parse(files['capsule.json']), wrong));
    for (const content of Object.values(files)) {
      assert.equal(Buffer.from(content).includes(Buffer.from(code)), false);
      assert.equal(Buffer.from(content).includes(result.secretKey.subarray(0, 1152)), false);
    }
  }
});

function alterCapture(files, transform) {
  const capture = files['dma.capture.bin'], rows = [];
  for (let at = 24; at < capture.length; at += 64) rows.push(Buffer.from(capture.subarray(at, at + 64)));
  const changed = transform(rows), header = Buffer.from(capture.subarray(0, 24));
  header.writeUInt16LE(changed.length, 10); header.writeUInt32LE(mlkemCrc32c(header.subarray(0, 20)), 20);
  return { ...files, 'dma.capture.bin': Buffer.concat([header, ...changed]) };
}
const repair = row => { row.writeUInt32LE(mlkemCrc32c(row.subarray(0, 60)), 60); return row; };

test('DMA recovery rejects missing records, wrong epochs and CRC-valid conflicting acquisitions', () => {
  const files = mlkemEvidence('dma-negative', seededRandom(Buffer.alloc(32, 0x51), 'mlkem-case')), epoch = selectMlkemCheckpoint(files).epoch;
  assert.deepEqual(decodeMlkemEvidence(alterCapture(files, rows => rows.toReversed())), { code: 'dma-negative' });
  for (const bank of [0, 1]) {
    const missing = alterCapture(files, rows => rows.filter(row => !(row.readBigUInt64LE(4) === epoch && row[3] === bank && row[16] === 0 && row[17] === 1)));
    assert.throws(() => recoverMlkemMaterial(missing), /incomplete|at most four/);
  }
  const stale = alterCapture(files, rows => rows.filter(row => row.readBigUInt64LE(4) !== epoch));
  assert.throws(() => recoverMlkemMaterial(stale), /masked share is incomplete/);
  const conflict = alterCapture(files, rows => {
    const row = Buffer.from(rows.find(row => row.readBigUInt64LE(4) === epoch && row[3] === 0 && row[16] === 0 && row[17] === 0));
    const previous = row.readInt16LE(28); row.writeInt16LE(previous === 1664 ? 1663 : previous + 1, 28); rows.push(repair(row)); return rows;
  });
  assert.throws(() => recoverMlkemMaterial(conflict), /Conflicting/);
  for (const cut of [0, 20, 24, files['dma.capture.bin'].length - 1]) assert.throws(() => recoverMlkemMaterial({ ...files, 'dma.capture.bin': files['dma.capture.bin'].subarray(0, cut) }), /header/);
});

test('checkpoint signatures, provider hashes, ciphertext binding and CBOR widths cannot be bypassed', () => {
  const files = mlkemEvidence('authentication-negative', seededRandom(Buffer.alloc(32, 0x71), 'mlkem-case'));
  const epoch = selectMlkemCheckpoint(files).epoch;
  const journal = readMlkemCbor(files['checkpoints.cbor']);
  const onlyStale = journal.filter(([payload]) => readMlkemCbor(payload).epoch !== epoch);
  assert.throws(() => recoverMlkemMaterial({ ...files, 'checkpoints.cbor': encodeMlkemCbor(onlyStale) }), /session authentication/);
  const onlyPrepare = journal.filter(([payload]) => readMlkemCbor(payload).phase === 'prepare');
  assert.throws(() => selectMlkemCheckpoint({ ...files, 'checkpoints.cbor': encodeMlkemCbor(onlyPrepare) }), /No authenticated/);
  const cache = Buffer.from(files['provider-cache.bin']);
  for (let at = 16; at < cache.length; at += 1264) if (cache.readBigUInt64LE(at + 8) === epoch) cache[at + 1232] ^= 1;
  assert.throws(() => selectMlkemCheckpoint({ ...files, 'provider-cache.bin': cache }), /state is missing/);
  const wiring = Buffer.from(files['wiring.rom']); wiring[0] ^= 1;
  assert.throws(() => selectMlkemCheckpoint({ ...files, 'wiring.rom': wiring }), /wiring authentication/);
  assert.throws(() => recoverMlkemMaterial({ ...files, 'session-b.ct': files['session-a.ct'] }), /session authentication/);
  const capsule = JSON.parse(files['capsule.json']); capsule.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => decodeMlkemEvidence({ ...files, 'capsule.json': JSON.stringify(capsule) }));
  for (const hex of ['1817', '1900ff', '1a0000ffff', '1b00000000ffffffff', '9f', '81', 'a2616100616101', '00ff']) assert.throws(() => readMlkemCbor(Buffer.from(hex, 'hex')), /CBOR/);
});

test('the post-quantum release preserves every preceding 32-case artifact and compatibility digest', async () => {
  const { artifacts, answers, manifest } = await generate(Buffer.alloc(32, 0x42)), hash = createHash('sha256');
  for (const [stage, files] of Object.entries(artifacts)) if (Number(stage) <= 32) {
    for (const [name, content] of Object.entries(files)) hash.update(stage + '/' + name + '\0').update(content);
  }
  assert.equal(hash.digest('hex'), '36d7eb9feb4b538925a8c4f08ca577d09a74423ee4f813e47815c925232bcbe0');
  assert.equal(createHash('sha256').update(JSON.stringify(answers.codes.slice(0, 32))).digest('hex'), 'dfc627d33d2ffec12cb1edacccb466e8a576c8476eb6823272a014a0d48fcdc7');
  assert.deepEqual(manifest.compatibleEditions.find(item => item.cases === 32), { version: '9c357920b340d3fc', cases: 32 });
  assert.deepEqual(decodeMlkemEvidence(artifacts[33]), { code: answers.codes[32] });
});
