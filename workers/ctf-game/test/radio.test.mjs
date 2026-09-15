import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { seededRandom } from '../scripts/core.mjs';
import { generate } from '../scripts/build-challenges.mjs';
import { openSeal } from '../scripts/decoders.mjs';
import { radioEvidence, radioConvolution, radioCrc16 } from '../scripts/expert/radio.mjs';
import { radioFft, radioChecksums, radioViterbi, radioDeinterleave, receiveRadio, recoverRadioMaterial, decodeRadioEvidence } from '../scripts/expert/radio-decoder.mjs';

test('unitary receiver FFT agrees with analytic tones and a direct complex DFT oracle', () => {
  const random = seededRandom(Buffer.alloc(32, 0x37), 'fft');
  const input = Float64Array.from({ length: 128 }, () => random(2).readUInt16LE() / 65536 - .5), actual = radioFft(input);
  for (let k = 0; k < 64; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < 64; n++) {
      const angle = 2 * Math.PI * n * k / 64;
      re += (input[2 * n] * Math.cos(angle) + input[2 * n + 1] * Math.sin(angle)) / 8;
      im += (input[2 * n + 1] * Math.cos(angle) - input[2 * n] * Math.sin(angle)) / 8;
    }
    assert.ok(Math.abs(actual[2 * k] - re) < 1e-12); assert.ok(Math.abs(actual[2 * k + 1] - im) < 1e-12);
  }
  radioFft(actual, true).forEach((value, i) => assert.ok(Math.abs(value - input[i]) < 1e-12));
  assert.ok(Math.abs(actual.reduce((sum, n) => sum + n * n, 0) - input.reduce((sum, n) => sum + n * n, 0)) < 1e-12);
  for (const tone of [0, 1, 31, 32, 63]) {
    const samples = Float64Array.from({ length: 128 }, (_, i) => (i % 2 ? Math.sin : Math.cos)(2 * Math.PI * tone * Math.floor(i / 2) / 64) / 8);
    radioFft(samples).forEach((value, i) => assert.ok(Math.abs(value - (i === tone * 2 ? 1 : 0)) < 1e-12));
  }
  assert.throws(() => radioFft(new Float64Array(64)), /64 complex/);
});

// Independent delay-polynomial oracle, rather than importing the transmitter's
// shift-register convention into the reference receiver tests.
const encodeOracle = bits => bits.flatMap((_, t) => [[0, 1, 3, 4, 6], [0, 3, 4, 5, 6]].map(delays => delays.reduce((sum, d) => sum + (bits[t - d] || 0), 0) % 2));
test('convolution convention, CRC check values and soft Viterbi match independent maximum-likelihood enumeration', () => {
  assert.equal(radioCrc16(Buffer.from('123456789')), 0x29b1);
  assert.deepEqual(radioChecksums(Buffer.from('123456789')), { crc16: 0x29b1, crc32: 0xcbf43926 });
  assert.equal(radioConvolution([1, 0, 0, 0, 0, 0, 0]).join(''), '11100011110111');
  const random = seededRandom(Buffer.alloc(32, 0x38), 'viterbi');
  for (let attempt = 0; attempt < 24; attempt++) {
    const llrs = Float64Array.from({ length: 20 }, () => (random(2).readUInt16LE() / 65536 - .5) * 10);
    if (attempt % 2) for (let i = 3; i < llrs.length; i += 3) llrs[i] = 0;
    let best = -Infinity;
    for (let word = 0; word < 16; word++) {
      const bits = [...Array.from({ length: 4 }, (_, i) => word >> i & 1), ...Array(6).fill(0)], encoded = encodeOracle(bits);
      assert.deepEqual(radioConvolution(bits), encoded);
      best = Math.max(best, encoded.reduce((sum, bit, i) => sum + (1 - 2 * bit) * llrs[i], 0));
    }
    const result = radioViterbi(llrs), score = encodeOracle([...result.bits]).reduce((sum, bit, i) => sum + (1 - 2 * bit) * llrs[i], 0);
    assert.ok(Math.abs(score - best) < 1e-10); assert.equal(result.bits.subarray(-6).some(Boolean), false);
  }
  for (const input of [[], [1], [NaN, 1], [Infinity, 0], new Float64Array(100002)]) assert.throws(() => radioViterbi(input), /bounds/);
});

test('interleaver permutations cover every carrier bit with fixed header and QAM mapping anchors', () => {
  const header = radioDeinterleave(Float64Array.from({ length: 48 }, (_, i) => i), 1);
  assert.deepEqual([...header.subarray(0, 18)], [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 1, 4]);
  const data = radioDeinterleave(Float64Array.from({ length: 288 }, (_, i) => i), 6);
  assert.deepEqual([...data.subarray(0, 19)], [0, 20, 37, 54, 74, 91, 108, 128, 145, 162, 182, 199, 216, 236, 253, 270, 1, 18, 38]);
  assert.equal(new Set(data).size, 288); assert.throws(() => radioDeinterleave(new Float64Array(48), 6), /size/);
});

test('unannotated SigMF recovers all bursts, soft errors and authenticated commits across many oscillator/channel seeds', () => {
  const integers = new Set(), orientations = new Set(); let corrections = 0;
  for (let i = 0; i < 32; i++) {
    const seed = i < 24 ? Buffer.alloc(32, i) : randomBytes(32), code = 'synthetic-radio-' + i;
    const files = radioEvidence(code, seededRandom(seed, 'radio-case')), recovered = recoverRadioMaterial(files);
    assert.equal(recovered.bursts, 4); assert.equal(recovered.frames.length, 4); assert.deepEqual(recovered.rejected, []);
    assert.equal(recovered.authenticated, 3); assert.equal(recovered.prepared, 1); assert.equal(recovered.forged, 1);
    assert.equal(Number(recovered.epoch), Number(recovered.epoch - 1n), 'Number loses the current/old epoch distinction');
    assert.deepEqual(openSeal(JSON.parse(files['capsule.json']), recovered.material), { code });
    const epochs = recovered.frames.map(frame => frame.packet.readBigUInt64LE(4));
    assert.deepEqual(epochs, [recovered.epoch + 1n, recovered.epoch - 1n, recovered.epoch + 2n, recovered.epoch]);
    recovered.frames.forEach(frame => {
      integers.add(frame.integerBins); orientations.add(frame.conjugated); corrections += frame.hardErrors;
      assert.ok(frame.concentration > .90); assert.ok(Math.abs(frame.frequencyBins) < 3.5);
      assert.ok(frame.scramblerState >= 1 && frame.scramblerState <= 127);
    });
    for (const content of Object.values(files)) assert.equal(Buffer.from(content).includes(Buffer.from(code)), false);
    assert.equal(Buffer.from(files['receiver.sigmf-data']).includes(recovered.material), false);
    assert.deepEqual(JSON.parse(files['receiver.sigmf-meta']).annotations, []);
  }
  assert.deepEqual([...integers].sort((a, b) => a - b), [-3, -2, -1, 0, 1, 2, 3]); assert.equal(orientations.size, 2);
  assert.ok(corrections > 1000, 'soft decoding must actually correct hard decision errors, not merely parse clean bits');
});

test('missing current acquisition, invalid authority and corrupted payload cannot silently fall back to stale material', () => {
  const files = radioEvidence('radio-negative', seededRandom(Buffer.alloc(32, 0x66), 'radio-case')), recovered = recoverRadioMaterial(files);
  const missing = { ...files, 'receiver.sigmf-data': files['receiver.sigmf-data'].subarray(0, (recovered.frames[3].sampleStart - 96) * 8) };
  assert.equal(recoverRadioMaterial(missing).epoch, recovered.epoch - 1n);
  assert.throws(() => decodeRadioEvidence(missing));
  const other = radioEvidence('other', seededRandom(Buffer.alloc(32, 0x67), 'radio-case'));
  assert.throws(() => recoverRadioMaterial({ ...files, 'attestor.pub.der': other['attestor.pub.der'] }), /No authenticated/);
  const waveform = Buffer.from(files['receiver.sigmf-data']);
  for (const frame of recovered.frames) waveform.fill(0, (frame.sampleStart + 128 + 240 + 16) * 8, Math.min(waveform.length, (frame.sampleStart + 1448) * 8));
  const corrupted = receiveRadio({ ...files, 'receiver.sigmf-data': waveform });
  assert.equal(corrupted.frames.length, 0); assert.equal(corrupted.rejected.length, 4);
  const capsule = JSON.parse(files['capsule.json']); capsule.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => decodeRadioEvidence({ ...files, 'capsule.json': JSON.stringify(capsule) }));
});

test('capture parser rejects truncation, non-finite IQ, false metadata and malformed training before decoding', () => {
  const files = radioEvidence('radio-schema', seededRandom(Buffer.alloc(32, 0x45), 'radio-case'));
  for (const length of [0, 8, 1023, files['receiver.sigmf-data'].length - 1]) {
    assert.throws(() => receiveRadio({ ...files, 'receiver.sigmf-data': files['receiver.sigmf-data'].subarray(0, length) }), /SigMF length/);
  }
  for (const value of [NaN, Infinity, -Infinity, 1e9]) {
    const data = Buffer.from(files['receiver.sigmf-data']); data.writeFloatLE(value, 0);
    assert.throws(() => receiveRadio({ ...files, 'receiver.sigmf-data': data }), /sample/);
  }
  assert.throws(() => receiveRadio({ ...files, 'receiver.sigmf-meta': JSON.stringify({ global: { 'core:datatype': 'rf32_le', 'core:sample_rate': 2000000 } }) }), /datatype/);
  const profile = JSON.parse(files['modem.json']); profile.prefix = 32;
  assert.throws(() => receiveRadio({ ...files, 'modem.json': JSON.stringify(profile) }), /profile/);
  assert.throws(() => receiveRadio({ ...files, 'training.i8': Buffer.alloc(127) }), /training length/);
  assert.throws(() => receiveRadio({ ...files, 'training.i8': Buffer.alloc(128) }), /training bins/);
  assert.throws(() => recoverRadioMaterial({ ...files, 'receiver.sigmf-data': Buffer.alloc(8192) }), /No authenticated/);
});

test('radio extension preserves the 33-case golden evidence and declares the preceding edition compatible', async () => {
  const { artifacts, answers, manifest } = await generate(Buffer.alloc(32, 0x42)), hash = createHash('sha256');
  for (const [stage, files] of Object.entries(artifacts)) if (Number(stage) <= 33) for (const [name, content] of Object.entries(files)) hash.update(stage + '/' + name + '\0').update(content);
  assert.equal(hash.digest('hex'), 'bad8a72051f9d7e5ec306235248e7155fae9e776ae006bd6ec87937e6cc7fa67');
  assert.equal(createHash('sha256').update(JSON.stringify(answers.codes.slice(0, 33))).digest('hex'), 'd4824cae4386a8f6b66e14d0d338c919b81c6ade915377d547511b2328b9e89d');
  assert.deepEqual(manifest.compatibleEditions.find(item => item.cases === 33), { version: '086220e972fcaa5c', cases: 33 });
  assert.deepEqual(decodeRadioEvidence(artifacts[34]), { code: answers.codes[33] });
});
