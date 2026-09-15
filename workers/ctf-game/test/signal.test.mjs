import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { seededRandom } from '../scripts/core.mjs';
import { powerEvidence } from '../scripts/expert/power.mjs';
import { loadSignals, analyzeSignals, signalStatistics, signalHistogram, signalSpectrum, signalCorrelation, signalEnvelope, signalCsv, SIGNAL_FILE_LIMIT } from '../public/signal-data.js';

const text = value => new TextEncoder().encode(value);
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≠ ${b}`);
const tlv = (tag, value) => Buffer.concat([value.length < 128 ? Buffer.from([tag, value.length]) : Buffer.from([tag, 0x82, value.length & 255, value.length >> 8]), value]);
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const f32 = value => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; };
function trs(coding = 2, optional = []) {
  const values = [[-4, 0, 3, 12], [5, 4, 3, 2]], width = coding === 1 ? 1 : coding === 2 ? 2 : 4;
  const records = values.map((row, i) => {
    const b = Buffer.alloc(6 + width * row.length); b.write('t' + i); b.set([1 + i, 2 + i, 3 + i], 3);
    for (let j = 0; j < row.length; j++) coding === 20 ? b.writeFloatLE(row[j] / 2, 6 + j * width) : b.writeIntLE(row[j], 6 + j * width, width); return b;
  });
  return Buffer.concat([tlv(0x41, u32(2)), tlv(0x42, u32(4)), tlv(0x43, Buffer.from([coding])), tlv(0x44, Buffer.from([3, 0])), tlv(0x45, Buffer.from([3])), ...optional, Buffer.from([0x5f, 0]), ...records]);
}

test('numeric CSV handles quoting, delimiter choice, exact indices and lossless selected-sample export', () => {
  const source = text('\uFEFF"time_s";"A; volts";"B ""quoted"""\r\n0;1.25;2\r\n0.001;-2.5;3\r\n0.002;4.125;5\r\n');
  const data = loadSignals(source, { a: 1, b: 2, time: 0 });
  assert.deepEqual(data.info.labels, ['time_s', 'A; volts', 'B "quoted"']);
  assert.deepEqual([...data.a.values], [1.25, -2.5, 4.125]); assert.equal(data.axis.rate, 1000); assert.equal(data.axis.unit, 's'); assert.equal(data.axis.uniform, true);
  const saved = signalCsv(data, 1, 3), again = loadSignals(text(saved), { a: 2, b: 3, time: 1 });
  assert.deepEqual([...again.a.values], [-2.5, 4.125]); assert.deepEqual([...again.b.values], [3, 5]);
  assert.deepEqual([...again.x], [.001, .002]);
  assert.deepEqual([...loadSignals(text('1\t2\n3\t4\n'), { a: 1 }).a.values], [2, 4]);
  assert.deepEqual([...loadSignals(text('\n\n1\t2\n3\t4\n'), { a: 1 }).a.values], [2, 4]);
  const signedZero = loadSignals(text('A\n-0\n1\n'), { b: -1 });
  assert.equal(Object.is(loadSignals(text(signalCsv(signedZero)), { a: 2, b: -1 }).a.values[0], -0), true);
  assert.deepEqual(loadSignals(text('"line\nbreak",B\n1,2\n')).info.labels, ['line\nbreak', 'B']);
});

test('signal import never treats missing, malformed or unsafe integer samples as zero', () => {
  for (const source of ['x,y\n1,\n', 'x,y\n1\n', 'x,x\n1,2\n', 'x\nNaN\n', 'x\nInfinity\n', 'NaN,0\n1,2', '1\n""\n2', 'x\n0x10\n', 'x\n9007199254740993\n', '"x\n1,2', '"x"oops\n1', 'x\n1e101\n', '']) assert.throws(() => loadSignals(text(source)));
  assert.throws(() => loadSignals(new Uint8Array(SIGNAL_FILE_LIMIT + 1)), /16 MiB/);
  assert.throws(() => loadSignals(Uint8Array.of(255)), /encoded|encoding/i);
  assert.throws(() => loadSignals(text('x\n1'), { rate: 0 }), /采样率/);
  assert.throws(() => loadSignals(text('x\n1'), { a: 1 }), /信号 A/);
  assert.throws(() => loadSignals(text('x\n1'), { format: 'eval' }), /未知/);
  assert.throws(() => signalStatistics([1, NaN]), /非有限/);
});

test('irregular or duplicate timestamps are not silently resampled for FFT or lag correlation', () => {
  const source = text('time,A,B\n0,1,2\n0.1,3,5\n0.21,2,8\n');
  const options = { a: 1, b: 2, time: 0 };
  assert.equal(loadSignals(source, options).axis.uniform, false);
  assert.equal(analyzeSignals(source, { ...options, kind: 'histogram' }).statistics.a.count, 3);
  for (const kind of ['spectrum', 'correlation']) assert.throws(() => analyzeSignals(source, { ...options, kind }), /不等间隔/);
  assert.throws(() => loadSignals(text('t,a\n0,1\n0,2'), { time: 0 }), /递增/);
  assert.throws(() => analyzeSignals(source, { kind: 'histogram', start: 2, end: 2 }), /末尾/);
});

test('TRS supports every standard sample coding, title/data bytes, scaling and long TLV lengths', () => {
  for (const coding of [1, 2, 4, 20]) {
    const data = loadSignals(trs(coding, [tlv(0x4b, f32(.0005)), tlv(0x4c, f32(2)), tlv(0x46, Buffer.from('T'.repeat(130))), tlv(0x4a, Buffer.from('V'))]), { format: 'trs' });
    assert.equal(data.info.samples, 4); assert.equal(data.info.channels, 2); assert.equal(data.info.unit, 'V');
    close(data.info.suggestedRate, 2000, .0002); assert.equal(data.axis.rate, null, 'metadata only suggests a rate; user confirms its units');
    assert.deepEqual([...data.a.values], coding === 20 ? [-4, 0, 3, 12] : [-8, 0, 6, 24]);
    assert.deepEqual([...data.a.data], [1, 2, 3]); assert.deepEqual([...data.b.data], [2, 3, 4]); assert.equal(data.a.title, 't0');
  }
  const badScale = loadSignals(trs(2, [tlv(0x4b, Buffer.from('nonstandard title')), tlv(0x4d, f32(.00001))]), { format: 'trs' });
  assert.equal(badScale.info.suggestedRate, null); assert.match(badScale.info.warnings[0], /0x4b/);
  assert.deepEqual([...badScale.a.values], [-4, 0, 3, 12], 'bad optional metadata does not change actual samples');
});

test('TRS bounds, required fields, duplicate headers and NaN samples are checked before plotting', () => {
  const source = trs();
  for (const bytes of [source.subarray(0, -1), Buffer.concat([source, Buffer.from([0])]), source.subarray(0, 12), trs(3), trs(2, [tlv(0x41, u32(2))])]) assert.throws(() => loadSignals(bytes, { format: 'trs' }), /TRS/);
  const nan = trs(20); nan.writeFloatLE(NaN, nan.length - 4);
  assert.throws(() => loadSignals(nan, { format: 'trs', a: 1 }), /非有限/);
  const huge = Buffer.concat([tlv(0x41, u32(8193)), tlv(0x42, u32(4)), tlv(0x43, Buffer.from([2])), Buffer.from([0x5f, 0])]);
  assert.throws(() => loadSignals(huge, { format: 'trs' }), /范围/);
});

test('the parser agrees with an unmodified external Riscure/Keysight float32 TRS fixture', async () => {
  const bytes = await readFile(new URL('./fixtures/trs/90x500xfloat.trs', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'cac66f8dc669f77056d7aba37ad0c2d2339237f445afbb518721c917b5b0ca00');
  const data = loadSignals(bytes, { format: 'trs', a: 0, b: 89 });
  assert.equal(data.info.channels, 90); assert.equal(data.info.samples, 500); assert.deepEqual(data.info.warnings, []);
  assert.deepEqual([...data.a.values.subarray(0, 5)], [64.36563110351562, 246.33212280273438, 97.83283996582031, 249.1954345703125, 195.1588592529297]);
  assert.deepEqual([...data.b.values.subarray(-5)], [185.54087829589844, 188.9058074951172, -155.6476287841797, 87.6873550415039, 137.24685668945312]);
});

test('the original full power acquisition remains byte-compatible and can be inspected without a leakage solver', () => {
  const files = powerEvidence('signal-public-test', undefined, seededRandom(Buffer.alloc(32, 0x55), 'signal-trs'));
  const data = loadSignals(files['acquisition.trs'], { format: 'trs', a: 0, b: 4095, rate: 24000000 });
  assert.equal(data.info.channels, 4096); assert.equal(data.info.samples, 272); assert.equal(data.a.data.length, 32); assert.equal(data.b.data.length, 32);
  assert.equal(Math.min(...data.a.values), -25000); assert.equal(data.axis.unit, 's');
  // Historical optional tag 0x4b is malformed; do not rewrite old evidence or
  // silently reinterpret 0x4d (TRACE_OFFSET) as the sampling interval.
  assert.equal(data.info.suggestedRate, null); assert.match(data.info.warnings[0], /0x4b/);
  const result = analyzeSignals(files['acquisition.trs'], { format: 'trs', a: 4095, b: -1, kind: 'histogram' });
  assert.equal(result.statistics.a.count, 272); assert.equal(result.histogram.counts.reduce((a, b) => a + b), 272);
  assert.equal(JSON.stringify(result).includes('signal-public-test'), false);
});

test('statistics distinguish population/sample variance and histogram counts preserve every endpoint', () => {
  const stats = signalStatistics([1, 2, 3, 4]);
  assert.equal(stats.mean, 2.5); assert.equal(stats.variance, 1.25); close(stats.sampleVariance, 5 / 3);
  assert.equal(stats.median, 2.5); assert.equal(stats.q1, 1.75); assert.equal(stats.q3, 3.25); close(stats.rms, Math.sqrt(7.5));
  assert.deepEqual([...signalHistogram([1, 2, 3, 4], 3).counts], [1, 1, 2]);
  const constant = signalHistogram([7, 7, 7], 8); assert.equal(constant.counts.reduce((a, b) => a + b), 3); assert.ok(constant.edges[0] < 7 && constant.edges.at(-1) > 7);
  assert.equal(signalStatistics([9]).sampleVariance, null);
});

test('FFT has calibrated single-sided amplitude, correct Nyquist/DC and explicit zero-padding/window metadata', () => {
  const values = Float64Array.from({ length: 1024 }, (_, i) => 2 * Math.cos(2 * Math.PI * 64 * i / 1024) + 4);
  for (const window of ['rectangular', 'hann', 'blackman']) {
    const spectrum = signalSpectrum(values, { rate: 1024, window });
    close(spectrum.peak.frequency, 64); close(spectrum.amplitude[64], 2, 1e-11); close(spectrum.phase[64], 0, 1e-11);
    close(spectrum.db[64], 20 * Math.log10(2)); assert.equal(spectrum.fftSize, 1024);
  }
  const dc = signalSpectrum(new Float64Array(16).fill(3), { window: 'rectangular', removeMean: false });
  assert.equal(dc.amplitude[0], 3); assert.equal(dc.peak.bin, 0);
  const nyquist = signalSpectrum(Float64Array.from({ length: 16 }, (_, i) => i % 2 ? -2 : 2), { window: 'rectangular' });
  close(nyquist.amplitude[8], 2); close(nyquist.peak.frequency, .5);
  const padded = signalSpectrum([1, 2, 3], { window: 'rectangular' }); assert.equal(padded.inputSamples, 3); assert.equal(padded.fftSize, 4);
  assert.throws(() => signalSpectrum([1]), /两个/); assert.throws(() => signalSpectrum([1, 2], { window: 'unknown' }), /参数/);
});

function pearson(a, b, lag) {
  const pairs = [];
  for (let i = 0; i < a.length; i++) if (i + lag >= 0 && i + lag < b.length) pairs.push([a[i], b[i + lag]]);
  const means = [0, 1].map(j => pairs.reduce((sum, pair) => sum + pair[j], 0) / pairs.length);
  let xx = 0, yy = 0, xy = 0;
  for (const [a, b] of pairs) { const x = a - means[0], y = b - means[1]; xx += x * x; yy += y * y; xy += x * y; }
  return xx && yy ? xy / Math.sqrt(xx * yy) : null;
}
test('FFT correlation matches a direct overlap-centered oracle, including delay sign, offsets and undefined constants', () => {
  const random = seededRandom(Buffer.alloc(32, 0x61), 'signal-correlation');
  const a = Float64Array.from({ length: 128 }, () => random(2).readUInt16LE() / 1000 - 32), b = Float64Array.from(a, (_, i) => i >= 7 ? a[i - 7] * -2 + 8 : i);
  const result = signalCorrelation(a, b, 32);
  result.lags.forEach((lag, i) => close(result.coefficients[i], pearson(a, b, lag), 1e-12));
  assert.equal(result.peak.lag, 7); close(result.peak.coefficient, -1); assert.equal(result.peak.overlap, 121);
  const offset = signalCorrelation(a.map(x => x + 1e9), b.map(x => x + 3e9), 32); close(offset.peak.coefficient, -1, 1e-10); assert.equal(offset.peak.lag, 7);
  const constant = signalCorrelation(new Float64Array(10).fill(3), new Float64Array(10).fill(2), 5);
  assert.equal(constant.peak, null); assert.ok(constant.coefficients.every(x => x === null));
  assert.throws(() => signalCorrelation([1, 2], [1, 2]), /三个/);
});

test('min/max plot envelopes retain narrow impulses beyond the displayed resolution', () => {
  const values = new Float64Array(20000); values[9437] = 900; values[9438] = -700;
  const result = signalEnvelope(values, 0, values.length, 600);
  assert.equal(result.length, 600); assert.equal(Math.max(...result.map(x => x.max)), 900); assert.equal(Math.min(...result.map(x => x.min)), -700);
  assert.equal(result[0].from, 0); assert.equal(result.at(-1).to, values.length);
  assert.throws(() => signalEnvelope(values, 0, 0, 20), /末尾/);
});
