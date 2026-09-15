// Generic numerical signal tools. No device-specific leakage model, keys or
// campaign solver is present here. All sample arithmetic is IEEE-754 binary64.
export const SIGNAL_FILE_LIMIT = 16 * 1024 * 1024;
export const SIGNAL_SAMPLE_LIMIT = 262144;
const TOTAL_LIMIT = 2097152, CHANNEL_LIMIT = 8192;
const finite = value => Number.isFinite(value) && Math.abs(value) <= 1e100;
const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(label + '超出范围'); return value;
};
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function csvRows(source) {
  source = source.replace(/^\uFEFF/, '').replace(/^(?:[ \t]*(?:\r\n|\r|\n))+/, '');
  let quote = false, first = '';
  for (let i = 0; i < Math.min(source.length, 65536); i++) {
    const c = source[i]; if (c === '"') { if (quote && source[i + 1] === '"') { i++; continue; } quote = !quote; }
    if (!quote && /[\r\n]/.test(c)) break; if (!quote) first += c;
  }
  const delimiters = [',', '\t', ';'].map(value => ({ value, count: first.split(value).length - 1 })).sort((a, b) => b.count - a.count);
  const delimiter = delimiters[0].value, rows = []; let row = [], cell = '', quoted = false, closed = false, started = false, cells = 0;
  const field = () => { row.push(cell.trim()); cell = ''; closed = false; if (row.length > 64) throw Error('CSV 最多 64 列'); if (++cells > TOTAL_LIMIT + 64) throw Error('CSV 超过 2097152 个数值'); };
  const record = () => {
    field(); if (started || row.length !== 1 || row[0] !== '') rows.push(row); row = []; started = false;
    if (rows.length > SIGNAL_SAMPLE_LIMIT + 1) throw Error('CSV 样本超过 262144 行');
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === '"') {
      if (cell.length || closed) throw Error('CSV 引号必须从字段开头开始'); quoted = true; started = true;
    } else if (c === delimiter) { started = true; field(); }
    else if (c === '\r' || c === '\n') { record(); if (c === '\r' && source[i + 1] === '\n') i++; }
    else if (closed) { if (!/\s/.test(c)) throw Error('CSV 结束引号后有非法内容'); }
    else { cell += c; if (!/\s/.test(c)) started = true; }
    if (cell.length > 1024) throw Error('CSV 单元格超过 1024 字符');
  }
  if (quoted) throw Error('CSV 引号未闭合');
  if (cell || row.length || closed) record();
  if (!rows.length) throw Error('CSV 没有样本'); return { rows, delimiter };
}

function parseCsv(bytes) {
  const { rows, delimiter } = csvRows(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (rows[0].some(value => /^[+-]?(?:nan|inf(?:inity)?)$/i.test(value))) throw Error('CSV 首行包含非有限数值，不能当作表头');
  const header = !rows[0].every(value => numberPattern.test(value));
  const labels = header ? rows.shift() : rows[0].map((_, i) => '列 ' + (i + 1));
  if (!rows.length || labels.some(value => !value || value.length > 128) || new Set(labels).size !== labels.length) throw Error('CSV 表头为空、过长、重复或没有数据');
  if (rows.length * labels.length > TOTAL_LIMIT) throw Error('CSV 超过 2097152 个数值');
  const columns = labels.map(() => new Float64Array(rows.length));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]; if (row.length !== labels.length) throw Error('CSV 第 ' + (i + 1 + Number(header)) + ' 行列数不一致');
    for (let j = 0; j < row.length; j++) {
      const value = Number(row[j]);
      if (!numberPattern.test(row[j]) || !finite(value)) throw Error('CSV 第 ' + (i + 1 + Number(header)) + ' 行第 ' + (j + 1) + ' 列不是有限数值');
      if (/^[+-]?\d+$/.test(row[j]) && !Number.isSafeInteger(value)) throw Error('CSV 整数字面量超出精确范围；请先减去时间原点或转换单位');
      columns[j][i] = value;
    }
  }
  return { format: 'CSV', labels, samples: rows.length, suggestedRate: null, unit: 'value', warnings: [], metadata: { delimiter: delimiter === '\t' ? 'tab' : delimiter, header },
    series: index => ({ values: columns[index], data: new Uint8Array(), title: labels[index] }) };
}

function parseTrs(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tags = new Map(), warnings = []; let at = 0, terminated = false;
  while (at + 2 <= bytes.length && at < 1048576) {
    const tag = bytes[at++]; let length = bytes[at++];
    if (length & 128) {
      const width = length & 127;
      if (!width || width > 4 || at + width > bytes.length) throw Error('TRS 长度编码无效');
      length = 0; for (let i = 0; i < width; i++) length += bytes[at++] * 2 ** (8 * i);
    }
    if (tag === 0x5f) { if (length) throw Error('TRS 终止标记长度不是零'); terminated = true; break; }
    if (tags.has(tag) || at + length > bytes.length) throw Error('TRS 重复或截断的 TLV');
    tags.set(tag, { at, length }); at += length;
  }
  if (!terminated) throw Error('TRS 缺少 TRACE_BLOCK');
  const unsigned = (tag, size, fallback) => {
    const field = tags.get(tag); if (!field && fallback !== undefined) return fallback;
    if (!field || field.length !== size) throw Error('TRS 必要字段 0x' + tag.toString(16) + ' 长度无效');
    return size === 1 ? bytes[field.at] : size === 2 ? view.getUint16(field.at, true) : view.getUint32(field.at, true);
  };
  const optionalFloat = (tag, fallback, positive = false) => {
    const field = tags.get(tag); if (!field) return fallback;
    const value = field.length === 4 ? view.getFloat32(field.at, true) : NaN;
    if (!finite(value) || positive && value <= 0) { warnings.push('TRS 可选字段 0x' + tag.toString(16) + ' 无效，已忽略；未重解释为其他标签'); return fallback; }
    return value;
  };
  const text = (tag, fallback) => {
    const field = tags.get(tag); if (!field) return fallback;
    if (field.length > 4096) { warnings.push('TRS 文本元数据过长，仅显示前 4096 字节'); }
    return new TextDecoder().decode(bytes.subarray(field.at, field.at + Math.min(field.length, 4096))).replace(/\0+$/, '');
  };
  const count = integer(unsigned(0x41, 4), 1, CHANNEL_LIMIT, 'TRS trace 数'), samples = integer(unsigned(0x42, 4), 1, SIGNAL_SAMPLE_LIMIT, 'TRS 每条样本数');
  if (count * samples > TOTAL_LIMIT) throw Error('TRS 超过 2097152 个样本');
  const coding = unsigned(0x43, 1), widths = { 1: 1, 2: 2, 4: 4, 20: 4 }, width = widths[coding];
  if (!width) throw Error('TRS 仅支持 int8 / int16 / int32 / float32 样本');
  const dataLength = unsigned(0x44, 2, 0), titleSpace = unsigned(0x45, 1, 255), stride = titleSpace + dataLength + samples * width;
  if (at + stride * count !== bytes.length) throw Error('TRS 记录截断、尾随数据或 DS / TS 与长度不符');
  const xScale = optionalFloat(0x4b, null, true), yScale = optionalFloat(0x4c, 1), label = text(0x46, 'Trace');
  const labels = Array.from({ length: count }, (_, i) => label.slice(0, 40) + ' ' + i);
  const metadata = { sampleCoding: ({ 1: 'int8', 2: 'int16le', 4: 'int32le', 20: 'float32le' })[coding], dataLength, titleSpace, xScale, yScale,
    xLabel: text(0x49, ''), yLabel: text(0x4a, ''), description: text(0x47, ''),
    header: [...tags].map(([tag, field]) => ({ tag: '0x' + tag.toString(16), length: field.length })) };
  return { format: 'TRS', labels, samples, suggestedRate: xScale && finite(1 / xScale) ? 1 / xScale : null, unit: metadata.yLabel || 'ADC', warnings, metadata,
    series: index => {
      const start = at + index * stride, origin = start + titleSpace + dataLength, values = new Float64Array(samples);
      for (let i = 0; i < samples; i++) {
        const pos = origin + i * width, value = (coding === 1 ? view.getInt8(pos) : coding === 2 ? view.getInt16(pos, true) : coding === 4 ? view.getInt32(pos, true) : view.getFloat32(pos, true)) * yScale;
        if (!finite(value)) throw Error('TRS 样本包含非有限或过大的数值'); values[i] = value;
      }
      return { values, data: bytes.slice(start + titleSpace, origin), title: new TextDecoder().decode(bytes.subarray(start, start + titleSpace)).replace(/\0+$/, '') || labels[index] };
    } };
}

export function loadSignals(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > SIGNAL_FILE_LIMIT) throw Error('信号文件须为 1 B–16 MiB');
  if (options.format !== undefined && !['csv', 'trs'].includes(options.format)) throw Error('未知信号格式');
  const model = options.format === 'trs' ? parseTrs(bytes) : parseCsv(bytes);
  const aIndex = integer(options.a ?? 0, 0, model.labels.length - 1, '信号 A'), bIndex = integer(options.b ?? (model.labels.length > 1 ? 1 : -1), -1, model.labels.length - 1, '信号 B');
  const time = integer(options.time ?? -1, -1, model.format === 'CSV' ? model.labels.length - 1 : -1, '时间列');
  const suppliedRate = options.rate === undefined || options.rate === null || options.rate === '' ? null : Number(options.rate);
  if (suppliedRate !== null && (!Number.isFinite(suppliedRate) || suppliedRate < 1e-15 || suppliedRate > 1e15)) throw Error('采样率须在 1e-15–1e15 Hz 内');
  let rate = suppliedRate, uniform = true, x;
  if (time >= 0) {
    x = model.series(time).values;
    if (x.length > 1) {
      const step = (x.at(-1) - x[0]) / (x.length - 1);
      if (step <= 0 || !finite(step)) throw Error('时间列须严格递增');
      for (let i = 1; i < x.length; i++) {
        const delta = x[i] - x[i - 1]; if (delta <= 0) throw Error('时间列须严格递增，不得重复');
        if (Math.abs(delta - step) > Math.max(step * 1e-6, Math.max(Math.abs(x[i]), Math.abs(x[i - 1])) * Number.EPSILON * 8)) uniform = false;
      }
      rate = 1 / step;
      if (!Number.isFinite(rate) || rate < 1e-15 || rate > 1e15) throw Error('时间列间隔超出可分析范围');
    } else rate = null;
  } else x = Float64Array.from({ length: model.samples }, (_, i) => rate === null ? i : i / rate);
  const a = model.series(aIndex), b = bIndex < 0 ? null : model.series(bIndex);
  return { info: { format: model.format, labels: model.labels, samples: model.samples, channels: model.labels.length, unit: model.unit,
    suggestedRate: model.suggestedRate, warnings: model.warnings, metadata: model.metadata },
    a: { ...a, index: aIndex, name: model.labels[aIndex] }, b: b && { ...b, index: bIndex, name: model.labels[bIndex] },
    x, axis: { timeColumn: time, uniform, rate, unit: time >= 0 || rate !== null ? 's' : 'sample' } };
}

export function signalStatistics(values) {
  if (!(values instanceof Float64Array) && !Array.isArray(values) || !values.length || values.length > SIGNAL_SAMPLE_LIMIT) throw Error('统计样本范围无效');
  let mean = 0, m2 = 0, square = 0, correction = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]; if (!finite(value)) throw Error('非有限样本');
    const delta = value - mean; mean += delta / (i + 1); m2 += delta * (value - mean); min = Math.min(min, value); max = Math.max(max, value);
    const y = value * value - correction, sum = square + y; correction = (sum - square) - y; square = sum;
  }
  const sorted = Float64Array.from(values).sort(), quantile = p => { const at = (sorted.length - 1) * p, low = Math.floor(at); return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low); };
  const variance = Math.max(0, m2 / values.length);
  return { count: values.length, min, max, mean, rms: Math.sqrt(square / values.length), variance, standardDeviation: Math.sqrt(variance), sampleVariance: values.length > 1 ? m2 / (values.length - 1) : null,
    q1: quantile(.25), median: quantile(.5), q3: quantile(.75) };
}

export function signalHistogram(values, bins = 64) {
  integer(bins, 2, 256, '直方图箱数'); const stats = signalStatistics(values);
  const padding = stats.min === stats.max ? Math.max(1, Math.abs(stats.min) * Number.EPSILON * 16) : 0;
  const low = stats.min - padding, high = stats.max + padding, step = (high - low) / bins, counts = new Uint32Array(bins);
  for (const value of values) counts[Math.min(bins - 1, Math.max(0, Math.floor((value - low) / step)))]++;
  return { edges: Float64Array.from({ length: bins + 1 }, (_, i) => low + i * step), counts };
}

function fft(real, imag, inverse = false) {
  const n = real.length;
  if (n !== imag.length || n < 2 || n & n - 1 || n > 2 ** 19) throw Error('FFT 长度无效');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let width = 2; width <= n; width *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / width, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let start = 0; start < n; start += width) {
      let r = 1, s = 0;
      for (let j = 0; j < width / 2; j++) {
        const a = start + j, b = a + width / 2, tr = r * real[b] - s * imag[b], ti = r * imag[b] + s * real[b];
        real[b] = real[a] - tr; imag[b] = imag[a] - ti; real[a] += tr; imag[a] += ti;
        const next = r * wr - s * wi; s = r * wi + s * wr; r = next;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n; }
}
const nextPower = n => 2 ** Math.ceil(Math.log2(n));

export function signalSpectrum(values, { rate = 1, window = 'hann', removeMean = true } = {}) {
  if (!['rectangular', 'hann', 'blackman'].includes(window) || !Number.isFinite(rate) || rate <= 0 || typeof removeMean !== 'boolean') throw Error('FFT 参数无效');
  const stats = signalStatistics(values); if (values.length < 2) throw Error('FFT 至少需要两个样本');
  const n = nextPower(values.length), re = new Float64Array(n), im = new Float64Array(n); let coherent = 0;
  for (let i = 0; i < values.length; i++) {
    const angle = 2 * Math.PI * i / values.length, weight = window === 'rectangular' ? 1 : window === 'hann' ? .5 - .5 * Math.cos(angle) : .42 - .5 * Math.cos(angle) + .08 * Math.cos(2 * angle);
    re[i] = (values[i] - (removeMean ? stats.mean : 0)) * weight; coherent += weight;
  }
  if (coherent <= 0) throw Error('FFT 窗函数增益为零'); fft(re, im);
  const count = n / 2 + 1, frequency = new Float64Array(count), amplitude = new Float64Array(count), phase = new Float64Array(count), db = new Float64Array(count);
  let peak = 0;
  for (let i = 0; i < count; i++) {
    frequency[i] = rate * i / n; amplitude[i] = Math.hypot(re[i], im[i]) / coherent * (i && i !== n / 2 ? 2 : 1);
    phase[i] = Math.atan2(im[i], re[i]); db[i] = 20 * Math.log10(Math.max(1e-12, amplitude[i])); if (amplitude[i] > amplitude[peak]) peak = i;
  }
  return { frequency, amplitude, phase, db, fftSize: n, inputSamples: values.length, coherentGain: coherent / values.length, window, removeMean,
    peak: { bin: peak, frequency: frequency[peak], amplitude: amplitude[peak] }, dbReference: '20 log10(amplitude / 1 unit), floor -240 dB; not dBFS or PSD' };
}

// Pearson correlation at each lag, using only that lag's overlap and means.
// Positive lag means B[i + lag] matches A[i] (B is delayed relative to A).
export function signalCorrelation(a, b, maxLag = 128) {
  if (a.length !== b.length || a.length < 3) throw Error('互相关需要两路等长信号，至少三个样本');
  integer(maxLag, 0, Math.min(a.length - 3, 65536), '最大 lag');
  const sa = signalStatistics(a), sb = signalStatistics(b), n = a.length, size = nextPower(n * 2 - 1);
  const scaleA = Math.max(Math.abs(sa.min - sa.mean), Math.abs(sa.max - sa.mean)) || 1, scaleB = Math.max(Math.abs(sb.min - sb.mean), Math.abs(sb.max - sb.mean)) || 1;
  const ra = new Float64Array(size), ia = new Float64Array(size), rb = new Float64Array(size), ib = new Float64Array(size);
  const sumA = new Float64Array(n + 1), sumB = new Float64Array(n + 1), sqA = new Float64Array(n + 1), sqB = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const x = (a[i] - sa.mean) / scaleA, y = (b[i] - sb.mean) / scaleB; ra[n - 1 - i] = x; rb[i] = y;
    sumA[i + 1] = sumA[i] + x; sumB[i + 1] = sumB[i] + y; sqA[i + 1] = sqA[i] + x * x; sqB[i + 1] = sqB[i] + y * y;
  }
  fft(ra, ia); fft(rb, ib);
  for (let i = 0; i < size; i++) { const r = ra[i] * rb[i] - ia[i] * ib[i]; ia[i] = ra[i] * ib[i] + ia[i] * rb[i]; ra[i] = r; }
  fft(ra, ia, true);
  const lags = new Int32Array(maxLag * 2 + 1), coefficients = [], overlap = new Uint32Array(lags.length); let peak = null;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const index = lag + maxLag, a0 = Math.max(0, -lag), b0 = Math.max(0, lag), count = n - Math.abs(lag), a1 = a0 + count, b1 = b0 + count;
    const sx = sumA[a1] - sumA[a0], sy = sumB[b1] - sumB[b0], ex = sqA[a1] - sqA[a0], ey = sqB[b1] - sqB[b0];
    const vx = ex - sx * sx / count, vy = ey - sy * sy / count;
    const coefficient = vx <= Number.EPSILON * Math.max(1, ex) * 16 || vy <= Number.EPSILON * Math.max(1, ey) * 16 ? null : Math.max(-1, Math.min(1, (ra[n - 1 + lag] - sx * sy / count) / Math.sqrt(vx * vy)));
    lags[index] = lag; overlap[index] = count; coefficients.push(coefficient);
    if (coefficient !== null && (!peak || Math.abs(coefficient) > Math.abs(peak.coefficient))) peak = { lag, coefficient, overlap: count };
  }
  return { lags, coefficients, overlap, peak, definition: 'corr(A[i], B[i + lag]) over the overlap; each overlap is centered separately. Peak maximizes |r|. Zero variance -> null, never zero.' };
}

export function analyzeSignals(bytes, options = {}) {
  const data = loadSignals(bytes, options), start = integer(options.start ?? 0, 0, data.info.samples - 1, '开始样本'), end = integer(options.end ?? data.info.samples, start + 1, data.info.samples, '末尾样本');
  const a = data.a.values.subarray(start, end), b = data.b?.values.subarray(start, end), kind = options.kind ?? 'histogram';
  if (!['histogram', 'spectrum', 'correlation'].includes(kind)) throw Error('未知信号分析');
  if (kind !== 'histogram' && !data.axis.uniform) throw Error('时间列不等间隔；FFT / lag 互相关要求均匀采样，不会自动重采样');
  const result = { format: 'arisaka-signal-analysis-v1', kind, source: data.info, axis: data.axis,
    selection: { start, end, a: data.a.index, b: data.b?.index ?? -1, aName: data.a.name, bName: data.b?.name ?? null },
    metadata: { a: data.a.data, b: data.b?.data ?? null }, statistics: { a: signalStatistics(a), b: b ? signalStatistics(b) : null } };
  if (kind === 'histogram') result.histogram = signalHistogram(a, options.bins ?? 64);
  if (kind === 'spectrum') { result.spectrum = signalSpectrum(a, { rate: data.axis.rate ?? 1, window: options.window ?? 'hann', removeMean: options.removeMean ?? true }); result.spectrum.frequencyUnit = data.axis.rate === null ? 'cycles/sample' : 'Hz'; }
  if (kind === 'correlation') { if (!b) throw Error('互相关需要选择信号 B'); result.correlation = signalCorrelation(a, b, options.maxLag ?? Math.min(128, a.length - 3)); }
  return result;
}

// Min/max buckets, rather than stride skipping, preserve short impulses at
// every zoom level. The UI draws these extrema and the first/last connection.
export function signalEnvelope(values, start, end, pixels) {
  integer(start, 0, values.length - 1, '视图开始'); integer(end, start + 1, values.length, '视图末尾'); integer(pixels, 1, 4096, '绘图宽度');
  const count = Math.min(pixels, end - start), result = [];
  for (let i = 0; i < count; i++) {
    const from = start + Math.floor(i * (end - start) / count), to = start + Math.floor((i + 1) * (end - start) / count);
    let min = Infinity, max = -Infinity; for (let j = from; j < to; j++) { min = Math.min(min, values[j]); max = Math.max(max, values[j]); }
    result.push({ from, to, min, max, first: values[from], last: values[to - 1] });
  }
  return result;
}

export function signalCsv(data, start = 0, end = data.info.samples) {
  integer(start, 0, data.info.samples - 1, '导出开始'); integer(end, start + 1, data.info.samples, '导出末尾');
  const quote = value => '"' + (Object.is(value, -0) ? '-0' : String(value)).replaceAll('"', '""') + '"';
  // Fixed headers cannot be interpreted as spreadsheet formulas. Source labels
  // and complete acquisition metadata remain in the analysis JSON instead.
  const lines = ['sample,x_' + data.axis.unit + ',A' + (data.b ? ',B' : '')];
  for (let i = start; i < end; i++) lines.push([i, data.x[i], data.a.values[i], ...(data.b ? [data.b.values[i]] : [])].map(value => quote(value)).join(','));
  const out = lines.join('\n') + '\n'; if (out.length > SIGNAL_FILE_LIMIT) throw Error('CSV 导出超过 16 MiB；请缩小选区'); return out;
}
