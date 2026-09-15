import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { seededRandom, crc32 } from '../scripts/core.mjs';
import { generate } from '../scripts/build-challenges.mjs';
import { frostEvidence, frostBindingFactors, frostHashScalar } from '../scripts/expert/frost.mjs';
import { decodeFrostEvidence, recoverFrostMaterial, inspectFrostTranscript, frostScalarHash, readFrostCbor } from '../scripts/expert/frost-decoder.mjs';
import { rs16Evidence, rs16Multiply } from '../scripts/expert/rs16.mjs';
import { decodeRs16Evidence, recoverRs16Material, decodeRs16Polynomial, rs16Field } from '../scripts/expert/rs16-decoder.mjs';

const hex = value => Buffer.from(value, 'hex');

test('the elite release preserves all 29 preceding cases and declares both compatible editions', async () => {
  const { artifacts, answers, manifest } = await generate(Buffer.alloc(32, 0x42)), hash = createHash('sha256');
  for (const [stage, files] of Object.entries(artifacts)) if (Number(stage) <= 29) {
    for (const [name, content] of Object.entries(files)) hash.update(stage + '/' + name + '\0').update(content);
  }
  assert.equal(hash.digest('hex'), 'bdc4a7619bf479907439c39916e9e1189eb3f089b80ccf7fe02a00e96dcb6803');
  assert.equal(createHash('sha256').update(JSON.stringify(answers.codes.slice(0, 29))).digest('hex'), 'e8ade38f1831bf02fffc44b2669c1aefc3ef7913605eada4b5dafa3759aa0c8d');
  assert.deepEqual(manifest.compatibleEditions.filter(edition => edition.cases <= 29), [{ version: '6f2237319eb66605', cases: 26 }, { version: '46d9facbef1ffcbc', cases: 29 }]);
  assert.equal(decodeFrostEvidence(artifacts[30]).code, answers.codes[29]);
  assert.equal(decodeRs16Evidence(artifacts[31]).code, answers.codes[30]);
});

test('independent FROST implementations match RFC 9591 Appendix E.5, not just each other', () => {
  const publicKey = hex('02f37c34b66ced1fb51c34a90bdae006901f10625cc06c4f64663b0eae87d87b4f');
  const commitments = [
    [1, hex('03c699af97d26bb4d3f05232ec5e1938c12f1e6ae97643c8f8f11c9820303f1904'), hex('02fa2aaccd51b948c9dc1a325d77226e98a5a3fe65fe9ba213761a60123040a45e')],
    [3, hex('03077507ba327fc074d2793955ef3410ee3f03b82b4cdc2370f71d865beb926ef6'), hex('02ad53031ddfbbacfc5fbda3d3b0c2445c8e3e99cbc4ca2db2aa283fa68525b135')],
  ];
  const message = Buffer.from('test');
  const signature = hex('0205b6d04d3774c8929413e3c76024d54149c372d57aae62574ed74319b5ea14d0c65dde8492a7471437e6c2fe3da49b90d23f642b5c6dbe7e36089f096dd97324');
  const generated = frostBindingFactors(publicKey, commitments.map(([id, hiding, binding]) => ({ id, hiding, binding })), message);
  const decoded = inspectFrostTranscript(publicKey, commitments.toReversed(), message, signature);
  for (const rho of [generated, decoded.rho]) {
    assert.equal(rho.get(1).toString(16), '3e08fe561e075c653cbfd46908a10e7637c70c74f0a77d5fd45d1a750c739ec6');
    assert.equal(rho.get(3).toString(16), '93f79041bb3fd266105be251adaeb5fd7f8b104fb554a4ba9a0becea48ddbfd7');
  }
  for (const hash of [frostHashScalar, frostScalarHash]) assert.equal(hash('chal', Buffer.concat([signature.subarray(0, 33), publicKey, message])), decoded.challenge);
  assert.throws(() => inspectFrostTranscript(publicKey, commitments, Buffer.from('tampered'), signature), /signature/);
  assert.throws(() => inspectFrostTranscript(Buffer.alloc(33, 2), commitments, message, signature));
});

test('FROST recovery requires three independent nonce-pair equations and three authenticated refreshed shares', () => {
  for (let edition = 0; edition < 8; edition++) {
    const files = frostEvidence('frost-elite-test', seededRandom(randomBytes(32), 'frost-test'));
    const recovered = recoverFrostMaterial(files);
    assert.deepEqual(recovered.recovered, [1, 3, 5]); assert.equal(recovered.authenticated, 18);
    assert.deepEqual(decodeFrostEvidence(files), { code: 'frost-elite-test' });
    for (const value of Object.values(files)) assert.equal(Buffer.from(value).includes(Buffer.from('frost-elite-test')), false);
    assert.throws(() => decodeFrostEvidence({ ...files, 'responses.journal': files['responses.journal'].subarray(0, -1) }), /journal/);
    assert.throws(() => decodeFrostEvidence({ ...files, 'sessions.cbor': files['sessions.cbor'].subarray(0, -1) }), /CBOR/);
    const old = JSON.parse(files['key-package.json']); old.currentEpoch = 9;
    assert.throws(() => decodeFrostEvidence({ ...files, 'key-package.json': JSON.stringify(old) }), /independent same-epoch/);
    const forged = JSON.parse(files['key-package.json']); forged.epochs[1].verificationShares[0].point = forged.epochs[1].verificationShares[1].point;
    assert.throws(() => decodeFrostEvidence({ ...files, 'key-package.json': JSON.stringify(forged) }), /Feldman/);
    const capsule = JSON.parse(files['capsule.json']); capsule.tag = Buffer.alloc(16).toString('base64');
    assert.throws(() => decodeFrostEvidence({ ...files, 'capsule.json': JSON.stringify(capsule) }));
  }
});

test('a missing third current-epoch response cannot be filled with a valid old-epoch share', () => {
  const files = frostEvidence('not-a-shortcut', seededRandom(Buffer.alloc(32, 0x39), 'frost-test'));
  const session = readFrostCbor(files['sessions.cbor']).sessions.find(item => item.epoch === 10 && item.commitments.length === 3 && item.commitments.some(row => row[0] === 1));
  const old = files['responses.journal'], records = [];
  for (let offset = 16; offset < old.length; offset += 64) {
    const record = old.subarray(offset, offset + 64);
    if (!(record.subarray(0, 16).equals(session.id) && record.readUInt16BE(20) === 5)) records.push(record);
  }
  const header = Buffer.from(old.subarray(0, 16)); header.writeUInt32BE(records.length, 8); header.writeUInt32LE(crc32(header.subarray(0, 12)), 12);
  assert.throws(() => decodeFrostEvidence({ ...files, 'responses.journal': Buffer.concat([header, ...records]) }), /independent same-epoch/);
});

test('RS16 polynomial decoding corrects unknown symbol errors at the radius without guessing erasure positions', () => {
  const field = rs16Field(), random = seededRandom(Buffer.alloc(32, 19), 'rs16-vector');
  for (let i = 0; i < 200; i++) {
    const a = random(2).readUInt16LE(), b = random(2).readUInt16LE(); assert.equal(field.multiply(a, b), rs16Multiply(a, b));
    if (a) assert.equal(rs16Multiply(a, field.inverse(a)), 1);
  }
  const polynomial = [0x1122, 0xcafe, 0xffff, 0, 1, 0x8000, 0x0100, 0x0042];
  const points = Array.from({ length: 14 }, (_, i) => [i + 1, polynomial.reduceRight((y, c) => rs16Multiply(y, i + 1) ^ c, 0)]);
  for (const i of [1, 6, 12]) points[i][1] ^= 0x0029 + i;
  const decoded = decodeRs16Polynomial(points.toReversed(), polynomial.length);
  assert.deepEqual([...decoded.polynomial], polynomial); assert.equal(decoded.errors, 3);
  points[4][1] ^= 0x71; assert.throws(() => decodeRs16Polynomial(points, polynomial.length), /RS16/);
  assert.deepEqual([...decodeRs16Polynomial(Array.from({ length: 9 }, (_, i) => [i + 1, 0]), 4).polynomial], [0, 0, 0, 0]);
});

test('RS16 custody independently inverts the wire basis, corrects Byzantine lanes and authenticates the DER envelope', () => {
  for (let edition = 0; edition < 12; edition++) {
    const files = rs16Evidence('rs16-elite-test', seededRandom(randomBytes(32), 'rs16-test'));
    const recovered = recoverRs16Material(files);
    assert.equal(recovered.erasures, 3); assert.deepEqual(recovered.errors, [14, 14, 14, 14]);
    assert.deepEqual(decodeRs16Evidence(files), { code: 'rs16-elite-test' });
    for (const value of Object.values(files)) assert.equal(Buffer.from(value).includes(Buffer.from('rs16-elite-test')), false);
    assert.throws(() => decodeRs16Evidence({ ...files, 'adapter.rom': Buffer.alloc(36) }), /Singular/);
    assert.throws(() => decodeRs16Evidence({ ...files, 'capture.rs16': files['capture.rs16'].subarray(0, -1) }), /header/);
    const key = Buffer.from(files['custody.pub.der']); key[key.length - 1] ^= 1;
    assert.throws(() => decodeRs16Evidence({ ...files, 'custody.pub.der': key }));
    const capsule = JSON.parse(files['capsule.json']); capsule.tag = Buffer.alloc(16).toString('base64');
    assert.throws(() => decodeRs16Evidence({ ...files, 'capsule.json': JSON.stringify(capsule) }));
  }
});
