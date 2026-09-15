import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { seededRandom } from '../scripts/core.mjs';
import { parseSigMFMetadata, sigmfDatasetName, parseSigMF, loadRF, rfFFT, rfPeriodograms, rfStatistics, analyzeRF, rfLowpass, transformRF, rfCsv, rfEnvelope, RF_LIMITS } from '../public/rf-data.js';
import reference from './fixtures/sigmf-reference.json' with { type: 'json' };

const encode = new TextEncoder(), meta = value => encode.encode(JSON.stringify(value));
function fixture(count = 1024, sample = n => [Math.cos(2 * Math.PI * n / 8), Math.sin(2 * Math.PI * n / 8)], global = {}, captures = [{ 'core:sample_start': 0 }]) {
  const bytes = new Uint8Array(count * 16), view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) { const [re, im] = sample(i); view.setFloat64(i * 16, re, true); view.setFloat64(i * 16 + 8, im, true); }
  const metadata = meta({ global: { 'core:version': '1.2.6', 'core:datatype': 'cf64_le', 'core:sample_rate': 1024, ...global }, captures, annotations: [] });
  return { bytes, metadata };
}
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test('official SigMF SDK NCD reads and NumPy complex128 DFT independently anchor byte mapping and numeric output', async () => {
  const model = await loadRF(meta(reference.metadata), Buffer.from(reference.datasetBase64, 'base64'));
  assert.equal(reference.provenance.sdk, 'sigmf 1.2.6'); assert.equal(model.hashes.sha512Verified, true); assert.deepEqual([...model.samples], reference.samples);
  assert.deepEqual(model.captures.map(capture => [capture.byteStart, capture.byteStart + (capture.end - capture.start) * model.info.stride]), reference.captureByteRanges);
  rfFFT(model.samples).forEach((value, i) => close(value, reference.dft[i], 1e-9));
});

test('SigMF complex encodings preserve endian, signedness and raw ADC units without implicit centering', () => {
  for (const [name, bits, values] of [['ci8', 8, [-128, 127, -1, 0]], ['cu8', 8, [0, 255, 128, 1]], ['ci16', 16, [-32768, 32767, -1, 2]], ['cu16', 16, [0, 65535, 32768, 2]], ['ci32', 32, [-2147483648, 2147483647, -1, 3]], ['cu32', 32, [0, 4294967295, 2147483648, 3]], ['cf32', 32, [-.125, .5, 3.25, -8]], ['cf64', 64, [-.125, .5, 1e-30, 1e30]]]) {
    for (const endian of bits === 8 ? [''] : ['_le', '_be']) {
      const data = new Uint8Array(values.length * bits / 8), view = new DataView(data.buffer);
      values.forEach((value, i) => view[(name[1] === 'f' ? 'setFloat' : name[1] === 'i' ? 'setInt' : 'setUint') + bits](i * bits / 8, value, endian === '_le'));
      const metadata = meta({ global: { 'core:version': '1.2.6', 'core:datatype': name + endian }, captures: [], annotations: [] });
      const parsed = parseSigMF(metadata, data); assert.deepEqual([...parsed.samples], values); assert.equal(parsed.info.count, 2); assert.equal(parsed.info.rate, null);
      assert.deepEqual(parsed.captures.map(item => [item.start, item.end, item.byteStart]), [[0, 2, 0]]);
      if (name[1] !== 'f') assert.match(parsed.info.warnings.join(''), /原始 ADC/);
    }
  }
});

test('nonconforming SigMF maps per-capture headers, trailers, absolute offsets and scoped capture metadata exactly', () => {
  const global = { 'core:version': '1.2.6', 'core:datatype': 'ci16_be', 'core:dataset': 'capture.dat', 'core:offset': 1000, 'core:trailing_bytes': 2 };
  const captures = [{ 'core:sample_start': 1000, 'core:header_bytes': 3, 'core:frequency': 915e6, 'core:global_index': 4000 }, { 'core:sample_start': 1004, 'core:header_bytes': 5, 'core:global_index': 4010 }];
  const metadata = meta({ global, captures, annotations: [{ 'core:sample_start': 1005, 'core:label': '<script>not HTML</script>' }] }), data = new Uint8Array(42).fill(255), view = new DataView(data.buffer);
  for (let i = 0; i < 8; i++) { const at = i < 4 ? 3 + i * 4 : 24 + (i - 4) * 4; view.setInt16(at, i * 7, false); view.setInt16(at + 2, -i * 11, false); }
  const result = parseSigMF(metadata, data);
  assert.equal(result.info.count, 8); assert.equal(result.info.headers, 8); assert.equal(result.info.trailing, 2);
  assert.deepEqual(result.captures.map(item => [item.start, item.end, item.byteStart]), [[0, 4, 3], [4, 8, 24]]);
  assert.equal(result.captures[1].metadata['core:frequency'], undefined); assert.deepEqual([result.annotations[0].start, result.annotations[0].end], [5, 8]);
  for (let i = 0; i < 8; i++) { assert.equal(result.samples[i * 2], i * 7); close(result.samples[i * 2 + 1], -i * 11); }
  assert.equal(sigmfDatasetName(metadata, 'capture.sigmf-meta'), 'capture.dat');
  const implicit = fixture(8, n => [n, -n], {}, [{ 'core:sample_start': 3 }]);
  assert.equal(parseSigMF(implicit.metadata, implicit.bytes).captures[0].implicit, true);
  assert.deepEqual([...parseSigMF(implicit.metadata, implicit.bytes).samples].slice(0, 6), [0, -0, 1, -1, 2, -2]);
});

test('metadata and I/Q reject precision loss, unsupported mandatory semantics, paths, malformed bounds and non-finite samples', async () => {
  const valid = fixture(16), base = JSON.parse(new TextDecoder().decode(valid.metadata));
  for (const change of [{ 'core:datatype': 'rf32_le' }, { 'core:datatype': 'cf32' }, { 'core:datatype': 'ci8_le' }, { 'core:num_channels': 2 }, { 'core:offset': 9007199254740992 }, { 'core:sample_rate': 0 }, { 'core:sample_rate': Number.MIN_VALUE }, { 'core:sample_rate': 1e13 }, { 'core:dataset': '../elsewhere.bin' }, { 'core:dataset': 'https://external.invalid/a.bin' }, { 'core:metadata_only': true }, { 'core:extensions': [{ name: 'unknown', version: '1.0.0', optional: false }] }]) {
    assert.throws(() => parseSigMF(meta({ ...base, global: { ...base.global, ...change } }), valid.bytes));
  }
  assert.throws(() => parseSigMF(valid.metadata, valid.bytes.subarray(0, -1)), /样本数/);
  assert.throws(() => parseSigMF(valid.metadata, new Uint8Array(RF_LIMITS.dataBytes + 1)), /16 MiB/);
  assert.throws(() => parseSigMFMetadata(' '.repeat(RF_LIMITS.metadataBytes + 1)), /1 MiB/);
  for (const captures of [[{ 'core:sample_start': 0 }, { 'core:sample_start': 0 }], [{ 'core:sample_start': 17 }], [{ 'core:sample_start': 0, 'core:header_bytes': 8 }]]) assert.throws(() => parseSigMF(meta({ ...base, captures }), valid.bytes));
  assert.throws(() => parseSigMF(meta({ ...base, annotations: [{ 'core:sample_start': 0, 'core:sample_count': 17 }] }), valid.bytes));
  assert.throws(() => parseSigMF(meta({ ...base, annotations: [{ 'core:sample_start': 1, 'core:freq_lower_edge': 10 }] }), valid.bytes));
  for (const value of [NaN, Infinity, -Infinity, 1e101]) { const bytes = valid.bytes.slice(); new DataView(bytes.buffer).setFloat64(8, value, true); assert.throws(() => parseSigMF(valid.metadata, bytes), /采样/); }
  const sha512 = createHash('sha512').update(valid.bytes).digest('hex'), metadata = meta({ ...base, global: { ...base.global, 'core:sha512': sha512 } });
  assert.equal((await loadRF(metadata, valid.bytes)).hashes.sha512Verified, true);
  assert.equal((await loadRF(metadata, valid.bytes)).hashes.datasetSha256, createHash('sha256').update(valid.bytes).digest('hex'));
  const damaged = valid.bytes.slice(); damaged[0] ^= 1; await assert.rejects(loadRF(metadata, damaged), /SHA-512/);
  assert.equal(sigmfDatasetName(valid.metadata, 'safe.sigmf-meta'), 'safe.sigmf-data');
  assert.throws(() => parseSigMFMetadata('{"global":{},"\\u0067lobal":{}}'), /重复 JSON/);
  const text = new TextDecoder().decode(valid.metadata);
  for (const token of ['9007199254740991.1', '9007199254740992', '1e10000', '-1', '.1']) {
    assert.throws(() => parseSigMFMetadata(text.replace('"core:sample_start":0', '"core:sample_start":' + token)));
  }
  assert.equal(parseSigMFMetadata(text.replace('"core:sample_start":0', '"core:sample_start":1.024e3')).captures[0]['core:sample_start'], 1024);
});

test('complex FFT agrees with an independent direct DFT, not just an inverse using the same butterflies', () => {
  const random = seededRandom(Buffer.alloc(32, 0x76), 'rf-transform-oracle');
  for (const n of [2, 4, 8, 16, 32, 64]) {
    const input = Float64Array.from({ length: n * 2 }, () => random(1)[0] / 127.5 - 1), actual = rfFFT(input);
    for (let k = 0; k < n; k++) {
      let re = 0, im = 0;
      for (let j = 0; j < n; j++) { const angle = -2 * Math.PI * j * k / n; re += input[2 * j] * Math.cos(angle) - input[2 * j + 1] * Math.sin(angle); im += input[2 * j] * Math.sin(angle) + input[2 * j + 1] * Math.cos(angle); }
      close(actual[2 * k], re, 1e-11); close(actual[2 * k + 1], im, 1e-11);
    }
  }
  assert.throws(() => rfFFT(new Float64Array(14)), /二次幂/);
  assert.throws(() => rfFFT(Float64Array.of(NaN, 0, 0, 0)), /有限/);
});

test('two-sided Welch PSD preserves signed frequencies, window power calibration and Parseval energy', () => {
  const source = fixture(1024, n => [.2 + Math.cos(2 * Math.PI * n / 8) + .5 * Math.cos(-2 * Math.PI * n / 16), Math.sin(2 * Math.PI * n / 8) + .5 * Math.sin(-2 * Math.PI * n / 16)]), data = parseSigMF(source.metadata, source.bytes);
  for (const window of ['rectangular', 'hann', 'blackman']) {
    const result = rfPeriodograms(data, { fftSize: 256, window }); assert.equal(result.peak.frequency, 128); assert.equal(result.frequency[0], -512); assert.equal(result.frequency.at(-1), 508);
    close(result.mean.reduce((a, b) => a + b, 0) * result.binWidth, 1.29); assert.equal(result.frames.length, 7); assert.equal(result.coveredSamples, 1024); assert.equal(result.omittedSamples, 0);
    const negative = result.frequency.findIndex(value => value === -64), positive = result.frequency.findIndex(value => value === 128); close(result.mean[negative] / result.mean[positive], .25);
    if (window === 'rectangular') close(result.mean[positive] * result.binWidth, 1);
    if (window === 'hann') { close(result.enbw, 1.5 * result.binWidth); close(result.mean[positive] * result.enbw, 1); }
  }
  const raw = fixture(1024, undefined, { 'core:sample_rate': undefined }), uncalibrated = rfPeriodograms(parseSigMF(raw.metadata, raw.bytes), { fftSize: 64, window: 'rectangular' });
  assert.equal(uncalibrated.frequencyUnit, 'cycles/sample'); close(uncalibrated.peak.frequency, .125);
});

test('spectrograms never combine capture discontinuities and report every omitted tail sample', async () => {
  const source = fixture(96, n => n < 33 ? [1, 0] : [0, 1], {}, [{ 'core:sample_start': 0 }, { 'core:sample_start': 33 }]);
  const result = await analyzeRF(source.metadata, source.bytes, { kind: 'spectrogram', fftSize: 32, hop: 16, window: 'rectangular' });
  assert.deepEqual(result.spectrum.frames, [0, 33, 49]); assert.equal(result.spectrum.power.length, 96); assert.equal(result.spectrum.coveredSamples, 80); assert.equal(result.spectrum.omittedSamples, 16);
  assert.deepEqual(result.spectrum.intervals, [{ start: 0, end: 32, frames: 1 }, { start: 33, end: 81, frames: 2 }]);
  for (let frame = 0; frame < 3; frame++) close(result.spectrum.power.subarray(frame * 32, (frame + 1) * 32).reduce((a, b) => a + b, 0) * 32, 1);
  assert.throws(() => rfPeriodograms(parseSigMF(source.metadata, source.bytes), { fftSize: 128 }), /不足/);
  const big = fixture(32768); assert.throws(() => rfPeriodograms(parseSigMF(big.metadata, big.bytes), { fftSize: 16384, hop: 1 }), /超限/);
});

test('manual constellation sampling retains every selected point without pretending to synchronize a modem', async () => {
  const source = fixture(1000, n => [n % 7 - 3, n % 5 - 2]), result = await analyzeRF(source.metadata, source.bytes, { kind: 'constellation', start: 5, end: 997, stride: 9, phase: 2 });
  assert.equal(result.constellation.indices[0], 7); assert.equal(result.constellation.indices.at(-1), 988); assert.equal(result.constellation.indices.length, 110);
  result.constellation.indices.forEach((index, i) => { assert.equal(result.constellation.points[2 * i], index % 7 - 3); assert.equal(result.constellation.points[2 * i + 1], index % 5 - 2); });
  assert.match(result.constellation.note, /no timing recovery/); await assert.rejects(analyzeRF(source.metadata, source.bytes, { kind: 'constellation', stride: 2, phase: 2 }), /相位/);
});

test('frequency translation, conjugation and optional centering follow the documented phase origin and preserve provenance', async () => {
  const source = fixture(1024, undefined, {}, [{ 'core:sample_start': 0, 'core:frequency': 915e6, 'core:datetime': '2025-01-01T00:00:00.000000123Z' }]);
  const result = await transformRF(source.metadata, source.bytes, { start: 64, end: 512, shift: 128 });
  assert.equal(result.model.info.datatype, 'cf64_le'); assert.equal(result.model.info.rate, 1024); assert.equal(result.model.info.count, 448);
  for (let i = 0; i < result.model.info.count; i++) { close(result.model.samples[2 * i], 1, 1e-12); close(result.model.samples[2 * i + 1], 0, 1e-12); }
  assert.equal(result.operation.phaseReferenceLocalSample, 64); assert.equal(result.model.metadata.captures[0]['core:frequency'], 915000128);
  assert.equal(result.model.metadata.captures[0]['core:datetime'], undefined); assert.deepEqual(result.model.metadata.annotations, []);
  const provenance = result.model.metadata.global['arisaka-rf:provenance']; assert.equal(provenance.datasetSha256, createHash('sha256').update(source.bytes).digest('hex')); assert.equal(provenance.parentMetadata.captures[0]['core:datetime'], '2025-01-01T00:00:00.000000123Z');
  const conjugated = await transformRF(source.metadata, source.bytes, { conjugate: true }); assert.equal(rfPeriodograms(conjugated.model, { fftSize: 256 }).peak.frequency, -128);
  assert.equal(conjugated.model.metadata.captures[0]['core:frequency'], undefined);
  const constant = fixture(100, () => [3, -7]), centered = await transformRF(constant.metadata, constant.bytes, { removeMean: true }); assert.ok(centered.model.samples.every(value => value === 0)); assert.deepEqual(centered.operation.removedMean, [3, -7]);
  await assert.rejects(transformRF(source.metadata, source.bytes, { shift: 513 }), /频移/);
});

test('FIR decimation is DC-normalized, anti-alias filtered, valid-support only and independently checked against a direct convolution', async () => {
  for (const factor of [2, 4, 8, 16, 32]) {
    const taps = rfLowpass(factor); assert.equal(taps.length, factor * 32 + 1); close(taps.reduce((a, b) => a + b, 0), 1);
    taps.forEach((value, i) => close(value, taps[taps.length - 1 - i], 1e-15));
  }
  const source = fixture(1024, n => [Math.cos(2 * Math.PI * n / 64) + .5 * Math.cos(2 * Math.PI * n * .375), Math.sin(2 * Math.PI * n / 64)]), result = await transformRF(source.metadata, source.bytes, { decimation: 4 });
  const input = parseSigMF(source.metadata, source.bytes).samples, taps = result.operation.filter.taps;
  assert.equal(result.model.info.count, 224); assert.equal(result.model.info.rate, 256); assert.equal(result.operation.firstOutputSourceLocalSample, 64); assert.equal(result.operation.droppedAtEnd, 67);
  for (let i = 0; i < result.model.info.count; i++) {
    let re = 0, im = 0; for (let k = 0; k < taps.length; k++) { re += input[2 * (i * 4 + k)] * taps[taps.length - 1 - k]; im += input[2 * (i * 4 + k) + 1] * taps[taps.length - 1 - k]; }
    close(result.model.samples[i * 2], re, 1e-13); close(result.model.samples[i * 2 + 1], im, 1e-13);
  }
  const high = fixture(2048, n => [Math.cos(2 * Math.PI * n * .375), Math.sin(2 * Math.PI * n * .375)]), rejected = await transformRF(high.metadata, high.bytes, { decimation: 4 });
  assert.ok(rfStatistics(rejected.model.samples).rmsMagnitude < .001, 'stopband must be filtered before downsampling');
  const constant = fixture(1024, () => [1, -2]), dc = await transformRF(constant.metadata, constant.bytes, { decimation: 8 });
  for (let i = 0; i < dc.model.info.count; i++) { close(dc.model.samples[2 * i], 1); close(dc.model.samples[2 * i + 1], -2); }
  const short = fixture(16); await assert.rejects(transformRF(short.metadata, short.bytes, { decimation: 4 }), /FIR 长度/);
  const split = fixture(1024, undefined, {}, [{ 'core:sample_start': 0 }, { 'core:sample_start': 512 }]); await assert.rejects(transformRF(split.metadata, split.bytes, { decimation: 2 }), /跨越捕获段/);
});

test('full CSV and extrema envelopes preserve exact sample indices and narrow I/Q excursions', () => {
  const source = fixture(1000, n => [n === 513 ? 99 : 0, n === 514 ? -77 : 0], { 'core:offset': 1000000 }, [{ 'core:sample_start': 1000000 }]), data = parseSigMF(source.metadata, source.bytes);
  const envelope = rfEnvelope(data.samples, 0, 1000, 10); assert.equal(envelope.length, 10); assert.equal(Math.max(...envelope.map(item => item.maxI)), 99); assert.equal(Math.min(...envelope.map(item => item.minQ)), -77);
  const rows = new TextDecoder().decode(rfCsv(data)).trim().split('\n'); assert.equal(rows.length, 1001); assert.equal(rows[514].split(',').slice(0, 4).join(','), '513,1000513,99,0');
  assert.equal(new TextDecoder().decode(rfCsv(data, 513, 515)).trim().split('\n').length, 3);
  assert.throws(() => rfEnvelope(data.samples, 0, 1000, 4097), /整数/); assert.throws(() => rfCsv(data, 999, 1001), /整数/);
});
