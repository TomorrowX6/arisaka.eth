// Generic complex-baseband tools. These routines know nothing about a modem,
// synchronization preambles, coding, cryptographic keys or campaign solutions.
export const RF_LIMITS = Object.freeze({ metadataBytes: 1048576, dataBytes: 16777216, samples: 262144, fft: 16384, cells: 1048576, operations: 16000000 });
const check = (condition, message) => { if (!condition) throw Error(message); };
const integer = (value, low, high, name) => { check(Number.isSafeInteger(value) && value >= low && value <= high, name + '须为范围内的精确整数'); return value; };
const finite = (value, bound = 1e100) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= bound;
const bytesOf = value => typeof value === 'string' ? new TextEncoder().encode(value) : value;
const hash = async (bytes, algorithm = 'SHA-256') => Array.from(new Uint8Array(await crypto.subtle.digest(algorithm, bytes)), n => n.toString(16).padStart(2, '0')).join('');

function unambiguousMetadataJSON(source) {
  // JSON.parse has already checked syntax. This bounded lexical pass additionally
  // rejects duplicate (including escaped) keys and examines integer index tokens
  // before IEEE-754 rounding can turn e.g. 9007199254740991.1 into an integer.
  const indices = new Set(['core:offset', 'core:sample_start', 'core:sample_count', 'core:global_index', 'core:header_bytes', 'core:trailing_bytes', 'core:num_channels']);
  let at = 0, count = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(source[at] ?? '\0')) at++; };
  const string = () => { const start = at++; while (source[at] !== '"') { if (source[at] === '\\') at++; at++; } at++; return source.slice(start, at); };
  function exactIndex(token) {
    check(token.length <= 128, 'SigMF 索引字面量过长');
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(token); if (!match) return;
    const shift = Number(match[4] ?? 0) - (match[3]?.length ?? 0); let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
    if (!digits) return;
    check(!match[1] && Number.isSafeInteger(shift) && Math.abs(shift) <= 128, 'SigMF 索引须为非负精确整数');
    if (shift < 0) { check(-shift < digits.length && digits.endsWith('0'.repeat(-shift)), 'SigMF 索引不是精确整数；不舍入小数'); digits = digits.slice(0, digits.length + shift); }
    else { check(digits.length + shift <= 16, 'SigMF 索引超出精确范围'); digits += '0'.repeat(shift); }
    check(digits.length < 16 || digits.length === 16 && digits <= '9007199254740991', 'SigMF 索引超出精确范围');
  }
  function visit(depth, key) {
    check(depth <= 24 && ++count <= 65536, 'SigMF 元数据节点 / 深度超限'); whitespace();
    if (source[at] === '{') {
      at++; whitespace(); const keys = new Set();
      while (source[at] !== '}') { const name = JSON.parse(string()); check(!keys.has(name), 'SigMF 元数据含重复 JSON 字段 ' + name); keys.add(name); whitespace(); at++; visit(depth + 1, name); whitespace(); if (source[at] !== ',') break; at++; whitespace(); } at++;
    } else if (source[at] === '[') { at++; whitespace(); while (source[at] !== ']') { visit(depth + 1); whitespace(); if (source[at] !== ',') break; at++; } at++; }
    else if (source[at] === '"') string();
    else { const start = at; while (at < source.length && !/[\s,}\]]/.test(source[at])) at++; if (indices.has(key)) exactIndex(source.slice(start, at)); }
  }
  visit(0);
}

export function parseSigMFMetadata(input) {
  const bytes = bytesOf(input); check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= RF_LIMITS.metadataBytes, 'SigMF 元数据须为 1 B–1 MiB');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes), metadata = JSON.parse(source); unambiguousMetadataJSON(source);
  const pending = [[metadata, 0]]; let count = 0;
  while (pending.length) {
    const [value, depth] = pending.pop(); check(++count <= 65536 && depth <= 24, 'SigMF 元数据节点 / 深度超限');
    if (typeof value === 'number') check(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)), 'SigMF 数值超出精确范围；不舍入 64 位样本索引');
    else if (value && typeof value === 'object') for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
  check(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && Object.keys(metadata).every(key => ['global', 'captures', 'annotations'].includes(key)), 'SigMF 顶层仅支持 global / captures / annotations');
  const global = metadata.global; check(global && typeof global === 'object' && !Array.isArray(global), 'SigMF 缺少 global 对象');
  check(/^1\.\d+\.\d+$/.test(global['core:version'] ?? ''), '仅支持 SigMF 1.x 元数据');
  check(Array.isArray(metadata.captures) && metadata.captures.length <= 4096 && Array.isArray(metadata.annotations) && metadata.annotations.length <= 8192, 'SigMF captures / annotations 数量或类型无效');
  check(global['core:metadata_only'] === undefined || global['core:metadata_only'] === false, '仅元数据记录没有可分析的数据集');
  check(global['core:num_channels'] === undefined || global['core:num_channels'] === 1, '当前仅支持单通道复数 I/Q；不把多通道交织误作时间序列');
  check(global['core:sample_rate'] === undefined || finite(global['core:sample_rate'], 1e12) && global['core:sample_rate'] >= 1e-15, '采样率须为 1e-15–1e12 Hz');
  integer(global['core:offset'] ?? 0, 0, Number.MAX_SAFE_INTEGER, 'core:offset');
  integer(global['core:trailing_bytes'] ?? 0, 0, RF_LIMITS.dataBytes, '尾随字节数');
  if (global['core:sha512'] !== undefined) check(typeof global['core:sha512'] === 'string' && /^[0-9a-f]{128}$/i.test(global['core:sha512']), 'SigMF SHA-512 格式无效');
  if (global['core:dataset'] !== undefined) check(typeof global['core:dataset'] === 'string' && /^[^/\\:*?"<>|\x00-\x1f]{1,120}$/.test(global['core:dataset']) && !['.', '..'].includes(global['core:dataset']), 'core:dataset 必须是同目录文件名；不访问 URL 或外部路径');
  const extensions = global['core:extensions'] ?? []; check(Array.isArray(extensions) && extensions.length <= 64, 'SigMF 扩展列表无效');
  const namespaces = new Set();
  for (const item of extensions) {
    check(item && typeof item.name === 'string' && !namespaces.has(item.name) && typeof item.version === 'string' && typeof item.optional === 'boolean' && Object.keys(item).length === 3, 'SigMF 扩展声明无效');
    namespaces.add(item.name); check(item.optional, '不支持必需扩展 ' + item.name + '；不会忽略其采样语义');
  }
  return metadata;
}
export function sigmfDatasetName(metadataBytes, metadataName) {
  check(typeof metadataName === 'string' && /\.sigmf-meta$/i.test(metadataName) && !/[\/\\]/.test(metadataName), '须选择 .sigmf-meta 文件');
  return parseSigMFMetadata(metadataBytes).global['core:dataset'] ?? metadataName.replace(/\.sigmf-meta$/i, '.sigmf-data');
}

function sampleType(text) {
  const match = /^c([fiu])(8|16|32|64)(?:_(le|be))?$/.exec(text ?? ''); check(match, '需要复数 SigMF datatype，例如 cf32_le / ci16_le / cu8');
  const kind = match[1], bits = Number(match[2]), endian = match[3];
  check(kind === 'f' ? [32, 64].includes(bits) : [8, 16, 32].includes(bits), '不支持此复数采样编码');
  check(bits === 8 ? !endian : Boolean(endian), '多字节采样必须声明 _le / _be；8 位采样不带字节序');
  return { kind, bits, width: bits / 8, little: endian === 'le' };
}
export function parseSigMF(metadataBytes, dataBytes) {
  check(dataBytes instanceof Uint8Array && dataBytes.length > 0 && dataBytes.length <= RF_LIMITS.dataBytes, 'I/Q 数据须为 1 B–16 MiB');
  const metadata = parseSigMFMetadata(metadataBytes), global = metadata.global, type = sampleType(global['core:datatype']), offset = global['core:offset'] ?? 0, stride = type.width * 2;
  const trailing = global['core:trailing_bytes'] ?? 0, records = metadata.captures.length ? metadata.captures : [{ 'core:sample_start': offset }];
  let headers = 0, previous = -1;
  for (const capture of records) {
    check(capture && typeof capture === 'object' && !Array.isArray(capture), '捕获段须为对象');
    const start = integer(capture['core:sample_start'], offset, Number.MAX_SAFE_INTEGER, '捕获段样本索引'); check(start > previous, '捕获段必须按样本索引严格递增'); previous = start;
    headers += integer(capture['core:header_bytes'] ?? 0, 0, RF_LIMITS.dataBytes, '捕获段头字节');
    if (capture['core:global_index'] !== undefined) integer(capture['core:global_index'], 0, Number.MAX_SAFE_INTEGER, '全局样本索引');
    if (capture['core:frequency'] !== undefined) check(finite(capture['core:frequency'], 1e12), '捕获中心频率无效');
  }
  if (headers || trailing) check(global['core:dataset'] !== undefined, '带头 / 尾字节的非标准数据集须声明 core:dataset');
  const count = integer((dataBytes.length - headers - trailing) / stride, 1, RF_LIMITS.samples, '复数样本数（截断或超过 262144）');
  integer(offset + count, 1, Number.MAX_SAFE_INTEGER, '末尾样本索引');
  const captures = []; let headerBytes = 0;
  if (records[0]['core:sample_start'] > offset) captures.push({ start: 0, end: records[0]['core:sample_start'] - offset, byteStart: 0, metadata: { 'core:sample_start': offset }, implicit: true });
  for (let i = 0; i < records.length; i++) {
    const start = records[i]['core:sample_start'] - offset, end = i + 1 < records.length ? records[i + 1]['core:sample_start'] - offset : count;
    check(start < end && end <= count, '捕获段索引超出数据集'); headerBytes += records[i]['core:header_bytes'] ?? 0;
    captures.push({ start, end, byteStart: start * stride + headerBytes, metadata: records[i] });
  }
  previous = -1;
  const annotations = metadata.annotations.map(item => {
    check(item && typeof item === 'object' && !Array.isArray(item), '注释须为对象');
    const start = integer(item['core:sample_start'], offset, offset + count - 1, '注释起点') - offset; check(start >= previous, '注释必须按样本索引递增'); previous = start;
    const capture = captures.find(c => c.start <= start && start < c.end), length = item['core:sample_count'] ?? capture.end - start;
    integer(length, 0, count - start, '注释长度');
    const low = item['core:freq_lower_edge'], high = item['core:freq_upper_edge'];
    check(low === undefined && high === undefined || finite(low, 1e12) && finite(high, 1e12) && low <= high, '注释频率上下边界须成对且有序');
    return { start, end: start + length, metadata: item };
  });
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength), samples = new Float64Array(count * 2);
  const read = type.kind === 'f' ? (at => type.bits === 32 ? view.getFloat32(at, type.little) : view.getFloat64(at, type.little))
    : type.kind === 'i' ? (at => type.bits === 8 ? view.getInt8(at) : type.bits === 16 ? view.getInt16(at, type.little) : view.getInt32(at, type.little))
      : (at => type.bits === 8 ? view.getUint8(at) : type.bits === 16 ? view.getUint16(at, type.little) : view.getUint32(at, type.little));
  for (const capture of captures) for (let i = capture.start; i < capture.end; i++) for (let component = 0; component < 2; component++) {
    const value = read(capture.byteStart + (i - capture.start) * stride + component * type.width);
    check(finite(value), 'I/Q 包含非有限或过大的采样'); samples[i * 2 + component] = value;
  }
  const warnings = [];
  if (type.kind !== 'f') warnings.push('整数 I/Q 保留原始 ADC 数值，不自动归一化、去均值或按 dBFS 标度。');
  if (captures.length > 1) warnings.push('各捕获段独立；不继承前段频率 / 时间，不让 FFT 或 FIR 跨段拼接。');
  if (!global['core:sample_rate']) warnings.push('没有采样率：频率以 cycles/sample 表示，时间以样本编号表示。');
  if (global['core:extensions']?.length) warnings.push('可选扩展元数据原样保留；未知扩展不参与采样语义。');
  return { metadata, samples, captures, annotations, info: { count, offset, rate: global['core:sample_rate'] ?? null, datatype: global['core:datatype'], stride, headers, trailing, warnings } };
}
export async function loadRF(metadataBytes, dataBytes) {
  const result = parseSigMF(metadataBytes, dataBytes), expected = result.metadata.global['core:sha512'];
  if (expected) check((await hash(dataBytes, 'SHA-512')) === expected.toLowerCase(), 'SigMF 数据集 SHA-512 不匹配');
  result.hashes = { metadataSha256: await hash(bytesOf(metadataBytes)), datasetSha256: await hash(dataBytes), sha512Verified: Boolean(expected) }; return result;
}

export function rfFFT(input) {
  const n = input.length / 2; integer(n, 2, RF_LIMITS.fft, 'FFT 长度'); check((n & (n - 1)) === 0, 'FFT 长度须为二次幂');
  const output = Float64Array.from(input); check(output.every(value => finite(value)), 'FFT 输入不是有限复数');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n / 2; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) for (let part = 0; part < 2; part++) [output[2 * i + part], output[2 * j + part]] = [output[2 * j + part], output[2 * i + part]];
  }
  for (let width = 2; width <= n; width *= 2) for (let start = 0; start < n; start += width) for (let k = 0; k < width / 2; k++) {
    const angle = -2 * Math.PI * k / width, c = Math.cos(angle), s = Math.sin(angle), a = 2 * (start + k), b = a + width;
    const re = output[b] * c - output[b + 1] * s, im = output[b] * s + output[b + 1] * c;
    output[b] = output[a] - re; output[b + 1] = output[a + 1] - im; output[a] += re; output[a + 1] += im;
  }
  return output;
}
function range(data, options) {
  const start = integer(options.start ?? 0, 0, data.info.count - 1, '选区开始'), end = integer(options.end ?? data.info.count, start + 1, data.info.count, '选区末尾'); return { start, end };
}
export function rfStatistics(samples, start = 0, end = samples.length / 2) {
  integer(start, 0, samples.length / 2 - 1, '统计起点'); integer(end, start + 1, samples.length / 2, '统计末尾');
  let meanI = 0, meanQ = 0, power = 0, peak = 0, minI = Infinity, maxI = -Infinity, minQ = Infinity, maxQ = -Infinity;
  for (let i = start; i < end; i++) {
    const re = samples[2 * i], im = samples[2 * i + 1], n = i - start + 1, p = re * re + im * im;
    meanI += (re - meanI) / n; meanQ += (im - meanQ) / n; power += (p - power) / n; peak = Math.max(peak, Math.hypot(re, im));
    minI = Math.min(minI, re); maxI = Math.max(maxI, re); minQ = Math.min(minQ, im); maxQ = Math.max(maxQ, im);
  }
  return { count: end - start, meanI, meanQ, minI, maxI, minQ, maxQ, meanPower: power, rmsMagnitude: Math.sqrt(power), peakMagnitude: peak };
}
export function rfPeriodograms(data, options = {}) {
  const { start, end } = range(data, options), n = integer(options.fftSize ?? 1024, 16, RF_LIMITS.fft, 'FFT 长度'), hop = integer(options.hop ?? n / 2, 1, n, 'FFT hop');
  check((n & (n - 1)) === 0, 'FFT 长度须为二次幂'); const window = options.window ?? 'hann'; check(['hann', 'rectangular', 'blackman'].includes(window), '未知 FFT 窗');
  const frames = [], intervals = []; let covered = 0;
  for (const capture of data.captures) {
    const a = Math.max(start, capture.start), b = Math.min(end, capture.end), count = Math.max(0, Math.floor((b - a - n) / hop) + 1);
    if (!count) continue;
    for (let i = 0; i < count; i++) frames.push(a + i * hop);
    const stop = a + (count - 1) * hop + n; intervals.push({ start: a, end: stop, frames: count }); covered += stop - a;
  }
  check(frames.length > 0, '选区的单个捕获段不足一个完整 FFT 窗；不补零或跨段拼接');
  check(frames.length * n <= RF_LIMITS.cells && frames.length * n * Math.log2(n) <= RF_LIMITS.operations, 'FFT 矩阵 / 运算量超限；增大 hop 或缩小选区');
  const taper = new Float64Array(n); let gain = 0, energy = 0;
  for (let i = 0; i < n; i++) { const angle = 2 * Math.PI * i / n; taper[i] = window === 'rectangular' ? 1 : window === 'hann' ? .5 - .5 * Math.cos(angle) : .42 - .5 * Math.cos(angle) + .08 * Math.cos(2 * angle); gain += taper[i]; energy += taper[i] ** 2; }
  const rate = data.info.rate ?? 1, power = new Float64Array(frames.length * n), mean = new Float64Array(n), input = new Float64Array(2 * n);
  frames.forEach((origin, frame) => {
    for (let i = 0; i < n; i++) { input[2 * i] = data.samples[2 * (origin + i)] * taper[i]; input[2 * i + 1] = data.samples[2 * (origin + i) + 1] * taper[i]; }
    const transformed = rfFFT(input);
    for (let bin = 0; bin < n; bin++) { const k = (bin + n / 2) % n, value = (transformed[2 * k] ** 2 + transformed[2 * k + 1] ** 2) / (rate * energy); power[frame * n + bin] = value; mean[bin] += (value - mean[bin]) / (frame + 1); }
  });
  const frequency = Float64Array.from({ length: n }, (_, i) => (i - n / 2) * rate / n); let peak = 0;
  for (let i = 1; i < n; i++) if (mean[i] > mean[peak]) peak = i;
  return { fftSize: n, hop, window, frames, intervals, coveredSamples: covered, omittedSamples: end - start - covered, frequency, frequencyUnit: data.info.rate ? 'Hz' : 'cycles/sample',
    powerUnit: data.info.rate ? 'sample-unit²/Hz' : 'sample-unit²/(cycles/sample)', binWidth: rate / n, enbw: rate * energy / (gain * gain),
    normalization: 'two-sided |DFT(x*w)|² / (sampleRate * sum(w²)); no factor of two; periodic window; no implicit DC removal',
    mean, power, peak: { frequency: frequency[peak], density: mean[peak] } };
}
export async function analyzeRF(metadataBytes, dataBytes, options = {}) {
  const data = await loadRF(metadataBytes, dataBytes), selection = range(data, options), kind = options.kind ?? 'spectrum';
  check(['spectrum', 'spectrogram', 'constellation'].includes(kind), '未知射频分析类型');
  const result = { format: 'arisaka-rf-analysis-v1', kind, ...data.hashes, info: data.info, metadata: data.metadata, selection, statistics: rfStatistics(data.samples, selection.start, selection.end) };
  if (kind === 'constellation') {
    const stride = integer(options.stride ?? 1, 1, 65536, '星座步进'), phase = integer(options.phase ?? 0, 0, stride - 1, '星座样本相位');
    const count = Math.max(0, Math.ceil((selection.end - selection.start - phase) / stride)); check(count > 0, '选区内没有此相位的采样');
    const indices = Uint32Array.from({ length: count }, (_, i) => selection.start + phase + i * stride), points = new Float64Array(count * 2);
    indices.forEach((index, i) => { points[2 * i] = data.samples[2 * index]; points[2 * i + 1] = data.samples[2 * index + 1]; });
    result.constellation = { stride, phase, indices, points, note: 'Manual sample spacing only; no timing recovery, carrier correction or modulation decision.' };
  } else {
    const periodograms = rfPeriodograms(data, { ...options, ...selection }); if (kind === 'spectrum') delete periodograms.power; result.spectrum = periodograms;
  }
  return result;
}

export function rfLowpass(decimation) {
  integer(decimation, 1, 32, '抽取倍数'); if (decimation === 1) return Float64Array.of(1);
  const half = decimation * 16, cutoff = .4 / decimation, taps = new Float64Array(half * 2 + 1); let sum = 0;
  for (let i = 0; i < taps.length; i++) { const k = i - half; taps[i] = (k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k)) * (.54 - .46 * Math.cos(2 * Math.PI * i / (taps.length - 1))); sum += taps[i]; }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum; return taps;
}
export async function transformRF(metadataBytes, dataBytes, options = {}) {
  const data = await loadRF(metadataBytes, dataBytes), { start, end } = range(data, options), segment = data.captures.find(capture => capture.start <= start && end <= capture.end);
  check(segment, '变换选区跨越捕获段；请先选择单个连续段');
  const rate = data.info.rate ?? 1, shift = options.shift ?? 0, decimation = integer(options.decimation ?? 1, 1, 32, '抽取倍数');
  check(finite(shift, rate / 2), data.info.rate ? '频移须在 ±采样率 / 2 Hz 内' : '频移须在 ±0.5 cycles/sample 内');
  check(options.conjugate === undefined || typeof options.conjugate === 'boolean', '共轭参数须为布尔值'); check(options.removeMean === undefined || typeof options.removeMean === 'boolean', '去均值参数须为布尔值');
  const taps = rfLowpass(decimation), half = (taps.length - 1) / 2, count = Math.floor((end - start - taps.length) / decimation) + 1;
  check(count > 0, '选区不足 FIR 长度 ' + taps.length + '；仅输出完整支撑的样本，不补造边缘'); check(count * taps.length <= RF_LIMITS.operations, 'FIR 运算量超限');
  const statistics = rfStatistics(data.samples, start, end), mixed = new Float64Array((end - start) * 2), meanI = options.removeMean ? statistics.meanI : 0, meanQ = options.removeMean ? statistics.meanQ : 0;
  for (let i = start; i < end; i++) {
    const angle = -2 * Math.PI * shift * (i - start) / rate, c = Math.cos(angle), s = Math.sin(angle), re = data.samples[2 * i] - meanI, im = (data.samples[2 * i + 1] - meanQ) * (options.conjugate ? -1 : 1), at = 2 * (i - start);
    mixed[at] = re * c - im * s; mixed[at + 1] = re * s + im * c;
  }
  const bytes = new Uint8Array(count * 16), view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    let re = 0, im = 0;
    for (let tap = 0; tap < taps.length; tap++) { re += taps[tap] * mixed[2 * (i * decimation + tap)]; im += taps[tap] * mixed[2 * (i * decimation + tap) + 1]; }
    check(finite(re) && finite(im), '变换结果非有限或超出幅度界限'); view.setFloat64(i * 16, re, true); view.setFloat64(i * 16 + 8, im, true);
  }
  const operation = { start, end, shift, shiftUnit: data.info.rate ? 'Hz' : 'cycles/sample', conjugate: Boolean(options.conjugate), removeMean: Boolean(options.removeMean), removedMean: [meanI, meanQ], decimation,
    phaseReferenceLocalSample: start, firstOutputSourceLocalSample: start + half, firstOutputSourceAbsoluteSample: data.info.offset + start + half,
    outputCount: count, sourceStep: decimation, filter: { kind: decimation === 1 ? 'identity' : 'normalized Hamming-windowed sinc, valid centered convolution', cutoffCyclesPerSourceSample: decimation === 1 ? null : .4 / decimation, taps: Array.from(taps) },
    droppedAtStart: half, droppedAtEnd: end - (start + half + (count - 1) * decimation) - 1,
    order: ['subtract selected mean if requested', 'complex conjugation if requested', 'multiply exp(-j*2*pi*shift*(n-start)/rate)', 'symmetric lowpass FIR', 'decimate at fully supported centers'] };
  const capture = { 'core:sample_start': 0 }, center = segment.metadata['core:frequency'];
  if (!options.conjugate && center !== undefined) { check(finite(center + shift, 1e12), '变换后中心频率超限'); capture['core:frequency'] = center + shift; }
  const metadata = { global: { 'core:datatype': 'cf64_le', 'core:version': '1.2.6', ...(data.info.rate ? { 'core:sample_rate': data.info.rate / decimation } : {}),
    'core:description': 'Derived complex baseband. Source metadata and exact sample mapping are retained in arisaka-rf:provenance. No automatic demodulation.',
    'core:extensions': [{ name: 'arisaka-rf', version: '1.0.0', optional: true }],
    'arisaka-rf:provenance': { ...data.hashes, operation, parentMetadata: data.metadata,
      metadataPolicy: 'Rebased to sample 0. Source annotations, timestamps and global indices are preserved only in parentMetadata, not silently reprojected. Absolute RF center omitted after conjugation because the spectrum orientation is inverted.' } }, captures: [capture], annotations: [] };
  const metaBytes = new TextEncoder().encode(JSON.stringify(metadata, null, 2) + '\n'), model = await loadRF(metaBytes, bytes);
  return { bytes, metaBytes, model, operation };
}
export function rfCsv(data, start = 0, end = data.info.count) {
  const selected = range(data, { start, end }), lines = ['local_sample,absolute_sample,I,Q,magnitude,phase_rad'];
  for (let i = selected.start; i < selected.end; i++) { const re = data.samples[2 * i], im = data.samples[2 * i + 1]; lines.push([i, data.info.offset + i, re, im, Math.hypot(re, im), Math.atan2(im, re)].join(',')); }
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n'); check(bytes.length <= 33554432, 'CSV 超过工作区 32 MiB 文件上限'); return bytes;
}
export function rfEnvelope(samples, start, end, pixels) {
  integer(start, 0, samples.length / 2 - 1, '预览起点'); integer(end, start + 1, samples.length / 2, '预览末尾'); integer(pixels, 1, 4096, '绘图桶数');
  const count = Math.min(end - start, pixels), result = [];
  for (let bucket = 0; bucket < count; bucket++) {
    const a = start + Math.floor(bucket * (end - start) / count), b = start + Math.floor((bucket + 1) * (end - start) / count); let minI = Infinity, maxI = -Infinity, minQ = Infinity, maxQ = -Infinity;
    for (let i = a; i < b; i++) { minI = Math.min(minI, samples[2 * i]); maxI = Math.max(maxI, samples[2 * i]); minQ = Math.min(minQ, samples[2 * i + 1]); maxQ = Math.max(maxQ, samples[2 * i + 1]); }
    result.push({ start: a, end: b, minI, maxI, minQ, maxQ });
  }
  return result;
}
