import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { seededRandom } from '../scripts/core.mjs';
import { generate } from '../scripts/build-challenges.mjs';
import { quicEvidence, quicInitialKeys, quicInteger } from '../scripts/expert/quic.mjs';
import { decodeQuicEvidence, initialSecrets } from '../scripts/expert/quic-decoder.mjs';
import { dnssecEvidence } from '../scripts/expert/dnssec.mjs';
import { decodeDnssecEvidence } from '../scripts/expert/dnssec-decoder.mjs';
import { logicEvidence } from '../scripts/expert/logic.mjs';
import { decodeLogicEvidence } from '../scripts/expert/logic-decoder.mjs';

test('the additive release preserves the original 26-case edition byte for byte', async () => {
  // Recorded on PR #13 / 0ddfdb8 before changing the generator. This is a public
  // test-only seed; no production answers or production seeds are fixtures.
  const { artifacts, answers, manifest } = await generate(Buffer.alloc(32, 0x42));
  const hash = createHash('sha256');
  for (const [stage, files] of Object.entries(artifacts)) if (Number(stage) <= 26) {
    for (const [name, content] of Object.entries(files)) hash.update(stage + '/' + name + '\0').update(content);
  }
  assert.equal(hash.digest('hex'), '3f9466a1ce3c1d20ae7a4f4de7903b68563265090991e4a5222cdfe4a898666e');
  assert.equal(createHash('sha256').update(JSON.stringify(answers.codes.slice(0, 26))).digest('hex'), '721cdd738142afbf5528bfdfe2e210fde6cc36bc4b295b69c5f7410102282d2f');
  assert.deepEqual(manifest.compatibleEditions, [{ version: '6f2237319eb66605', cases: 26 }]);
  for (const [stage, decode] of [[27, decodeQuicEvidence], [28, decodeDnssecEvidence], [29, decodeLogicEvidence]]) {
    assert.equal(decode(artifacts[stage]).code, answers.codes[stage - 1]);
  }
});

test('QUIC key schedules match RFC 9001 Appendix A, independently of the generator', () => {
  const cid = Buffer.from('8394c8f03e515708', 'hex');
  for (const derive of [quicInitialKeys, initialSecrets]) {
    const client = derive(cid, 'client'), server = derive(cid, 'server');
    assert.equal(client.key.toString('hex'), '1f369613dd76d5467730efcbe3b1a22d');
    assert.equal(client.iv.toString('hex'), 'fa044b2f42a3fd3b46fb255c');
    assert.equal(client.hp.toString('hex'), '9f50449e04a0e810283a1e9933adedd2');
    assert.equal(server.key.toString('hex'), 'cf3a5331653c364c88f0f379b6067e37');
    assert.equal(server.iv.toString('hex'), '0ac1493ca1905853b0bba03e');
    assert.equal(server.hp.toString('hex'), 'c206b8d9b9f0f37644430b490eeaa314');
  }
  assert.equal(quicInteger(37).toString('hex'), '25');
  assert.equal(quicInteger(15293).toString('hex'), '7bbd');
  assert.equal(quicInteger(494878333).toString('hex'), '9d7f3e7d');
  assert.throws(() => quicInteger(-1));
  assert.throws(() => quicInteger(1n << 62n));
});

test('QUIC recovery validates Retry, removes header protection and reassembles reordered CRYPTO across packet-number wrap', () => {
  for (let edition = 0; edition < 8; edition++) {
    const files = quicEvidence('quic-professional', seededRandom(randomBytes(32), 'test/quic'));
    assert.deepEqual(decodeQuicEvidence(files), { code: 'quic-professional' });
    assert.throws(() => decodeQuicEvidence({ ...files, 'initial-flight.pcapng': files['initial-flight.pcapng'].subarray(0, -1) }), /PCAPNG/);
    const capsule = JSON.parse(files['capsule.json']); capsule.tag = Buffer.alloc(16).toString('base64');
    assert.throws(() => decodeQuicEvidence({ ...files, 'capsule.json': JSON.stringify(capsule) }));
    const custody = JSON.parse(files['collector.json']); custody.originalDestinationConnectionId = '00'.repeat(8);
    assert.throws(() => decodeQuicEvidence({ ...files, 'collector.json': JSON.stringify(custody) }), /Retry/);
  }
});

test('DNSSEC custody authenticates delegation, rollover, wildcard labels and original TTL instead of trusting AD', () => {
  for (let edition = 0; edition < 8; edition++) {
    const files = dnssecEvidence('dnssec-professional', seededRandom(randomBytes(32), 'test/dnssec'));
    assert.deepEqual(decodeDnssecEvidence(files), { code: 'dnssec-professional' });
    const anchor = JSON.parse(files['trust-anchor.json']); anchor.dnskey = Buffer.alloc(36).toString('base64');
    assert.throws(() => decodeDnssecEvidence({ ...files, 'trust-anchor.json': JSON.stringify(anchor) }), /authenticated DNSSEC/);
    const expired = JSON.parse(files['trust-anchor.json']); expired.observedAt += 86400;
    assert.throws(() => decodeDnssecEvidence({ ...files, 'trust-anchor.json': JSON.stringify(expired) }), /authenticated DNSSEC/);
    assert.throws(() => decodeDnssecEvidence({ ...files, 'resolver.pcapng': files['resolver.pcapng'].subarray(0, -2) }), /PCAPNG/);
  }
});

test('SPI acquisition reconstructs address-mode changes and majority samples before authenticating boot policy', () => {
  for (let edition = 0; edition < 4; edition++) {
    const files = logicEvidence('logic-professional', seededRandom(randomBytes(32), 'test/logic'));
    assert.deepEqual(decodeLogicEvidence(files), { code: 'logic-professional' });
    assert.throws(() => decodeLogicEvidence({ ...files, 'bus.vcd': files['bus.vcd'].slice(0, files['bus.vcd'].indexOf('$enddefinitions')) }), /declarations/);
    const board = JSON.parse(files['board.json']); board.minimumGeneration = 48;
    assert.throws(() => decodeLogicEvidence({ ...files, 'board.json': JSON.stringify(board) }), /authenticated boot/);
  }
});
