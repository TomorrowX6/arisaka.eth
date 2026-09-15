import { $, askText, formatSize, menubar, report, shortcut } from '/ui.js';
import { DOCUMENTS, basename, normalize } from '/filesystem.js';
import { pickFile } from '/files.js';
import { createAnalysisTask } from '/analysis-task.js';
import { SIGNAL_FILE_LIMIT, signalEnvelope, signalCsv } from '/signal-data.js';

export const signalLayout = `<nav id="signal-menubar" class="native-menubar"></nav>
  <div class="native-toolbar"><button id="signal-open" data-icon="document-open">打开 CSV / TRS…</button><button id="signal-example">双音示例</button><button id="signal-reload" disabled>重新载入</button><span id="signal-source" class="tool-file-label">尚未打开</span><span class="toolbar-spacer"></span><button id="signal-save-csv" disabled>保存选区 CSV…</button></div>
  <details class="signal-paste"><summary>从 CSV 文本载入 / 格式说明</summary><textarea id="signal-input" aria-label="信号 CSV 输入" spellcheck="false" maxlength="1048576" placeholder="A,B&#10;0.0,1.0&#10;1.0,0.0"></textarea><button id="signal-load-text">载入 CSV 文本</button><p>逗号、Tab 或分号；可有表头。缺失 / 非有限数值会报错，不补零。文本编辑后按载入才替换源。TRS 支持四种标准采样编码、完整 trace 数据与标度；不会猜测错误的可选标签。</p></details>
  <div class="native-toolbar signal-channels"><label for="signal-a">A</label><select id="signal-a" aria-label="信号 A" disabled></select><label for="signal-b">B</label><select id="signal-b" aria-label="信号 B" disabled></select><label for="signal-time">时间列（秒）</label><select id="signal-time" disabled><option value="-1">样本编号</option></select><label for="signal-rate">Hz</label><input id="signal-rate" type="number" min="1e-15" max="1e15" step="any" placeholder="可选" aria-label="采样率 Hz" disabled><button id="signal-use-rate" disabled>采用 TRS 标度</button></div>
  <div id="signal-warning" role="status" hidden></div>
  <div class="native-toolbar signal-range"><label for="signal-from">开始样本</label><input id="signal-from" value="0" inputmode="numeric" disabled><label for="signal-to">末尾（不含）</label><input id="signal-to" value="0" inputmode="numeric" disabled><button id="signal-apply-range" disabled>应用</button><button id="signal-fit" disabled>全览</button><button id="signal-zoom-in" disabled aria-label="放大信号">＋</button><button id="signal-zoom-out" disabled aria-label="缩小信号">−</button></div>
  <canvas id="signal-wave" tabindex="0" role="img" aria-label="模拟信号波形" aria-describedby="signal-wave-help"></canvas><output id="signal-cursor" aria-live="polite">点击设游标；Shift 点击设置第二游标</output><p id="signal-wave-help" class="tool-note">左右移动游标；Shift+左右移动第二游标；Ctrl+左右平移；+ / − 缩放；Home 全览。每个绘图桶保留极值，不跳过窄脉冲。</p>
  <div class="native-toolbar signal-analysis-controls"><select id="signal-kind" aria-label="信号分析类型"><option value="histogram">统计 / 直方图</option><option value="spectrum">FFT 幅度谱</option><option value="correlation">延迟互相关</option></select><label id="signal-bins-label">箱数<select id="signal-bins"><option>16</option><option selected>64</option><option>128</option><option>256</option></select></label><label id="signal-window-label" hidden>窗<select id="signal-taper"><option value="hann">Hann</option><option value="rectangular">Rectangular</option><option value="blackman">Blackman</option></select></label><label id="signal-mean-label" hidden><input id="signal-mean" type="checkbox" checked>去均值</label><label id="signal-db-label" hidden><input id="signal-db" type="checkbox">dB re 1</label><label id="signal-lag-label" hidden>±lag<input id="signal-lag" value="128" inputmode="numeric" aria-label="最大互相关 lag"></label><span class="toolbar-spacer"></span><button id="signal-run" class="button primary" disabled>分析选区</button><button id="signal-stop" disabled>停止</button><button id="signal-save-report" disabled>保存完整报告…</button></div>
  <div class="signal-results"><section class="signal-plot-panel"><canvas id="signal-result-plot" role="img" aria-label="信号分析图"></canvas><p id="signal-result-note" class="tool-note">结果包含整个样本选区；绘图仅作有界可视化。</p></section><section class="signal-stat-panel"><table class="data-table" aria-label="信号统计"><thead><tr><th>选区统计</th><th>A</th><th>B</th></tr></thead><tbody id="signal-statistics"></tbody></table><details><summary>源文件 / 采样元数据</summary><pre id="signal-metadata" tabindex="0"></pre></details></section></div>
  <footer class="statusbar"><span id="signal-status" role="status">16 MiB · 262144 样本 / 通道 · 有界、可取消 Worker</span></footer>`;

const number = value => value === null || value === undefined ? '—' : Math.abs(value) >= 1e6 || Math.abs(value) > 0 && Math.abs(value) < 1e-4 ? value.toExponential(5) : Number(value.toPrecision(8)).toString();
const tick = value => { const short = Number(value.toPrecision(3)).toString().replace('e+', 'e'); return short.length <= 8 ? short : value.toExponential(0).replace('e+', 'e'); };
const pretty = value => JSON.stringify(value, (_, item) => ArrayBuffer.isView(item) ? Array.from(item) : item, 2) + '\n';
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join(' ');
const index = value => { if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) throw Error('样本 / lag 必须为非负整数'); return Number(value); };

export function createSignalApp(controls) {
  const { fs, windows } = controls, task = createAnalysisTask();
  let epoch = 0, identity = 0, source, sourceName = '', format = 'csv', data, result, busy = false, range = [0, 0], cursors = [0, 0], listedLabels = [], listedFormat;
  const listen = (id, handler, type = 'click') => $('#' + id).addEventListener(type, event => { Promise.resolve().then(() => handler(event)).catch(error => { if (error.name !== 'AbortError') { status(error.message); report(error); } }); });
  const status = text => { $('#signal-status').textContent = text; };
  function restoreFocus(previous) {
    if (previous && $('#signal-window').classList.contains('focused') && (document.activeElement === document.body || document.activeElement === previous && previous.disabled)) {
      (previous.isConnected && !previous.disabled ? previous : $('#signal-wave')).focus({ preventScroll: true });
    }
  }
  function buttons() {
    $('#signal-stop').disabled = !busy; $('#signal-reload').disabled = !source || busy;
    $('#signal-run').disabled = !data || busy; $('#signal-save-report').disabled = !result || busy; $('#signal-save-csv').disabled = !data || busy;
    for (const id of ['a', 'b', 'from', 'to', 'apply-range', 'fit', 'zoom-in', 'zoom-out']) $('#signal-' + id).disabled = !data || busy;
    $('#signal-time').disabled = !data || busy || format === 'trs'; $('#signal-rate').disabled = !data || busy || Number($('#signal-time').value) >= 0;
    $('#signal-use-rate').disabled = busy || !data?.info.suggestedRate || Number($('#signal-time').value) >= 0;
  }
  function discardResult() {
    result = undefined; $('#signal-statistics').replaceChildren(); $('#signal-result-note').textContent = '选区或参数已改变，请重新分析。'; drawResult();
  }
  function invalidate(message) { epoch++; task.stop(); busy = false; discardResult(); buttons(); if (message) status(message); }
  function loadOptions() {
    return { format, a: Number($('#signal-a').value || 0), b: Number($('#signal-b').value || -1), time: Number($('#signal-time').value || -1), rate: $('#signal-rate').value };
  }
  function fillSelectors(next) {
    const same = format === listedFormat && listedLabels.length === next.info.labels.length && listedLabels.every((name, i) => name === next.info.labels[i]);
    for (const key of same ? [] : ['a', 'b', 'time']) {
      const node = $('#signal-' + key); node.replaceChildren();
      if (key !== 'a') { const option = document.createElement('option'); option.value = '-1'; option.textContent = key === 'b' ? '无' : '样本编号'; node.append(option); }
      if (key !== 'time' || format === 'csv') {
        const fragment = document.createDocumentFragment();
        next.info.labels.forEach((label, i) => { const option = document.createElement('option'); option.value = i; option.textContent = label; fragment.append(option); }); node.append(fragment);
      }
    }
    listedLabels = next.info.labels; listedFormat = format;
    $('#signal-a').value = next.a.index; $('#signal-b').value = next.b?.index ?? -1; $('#signal-time').value = next.axis.timeColumn;
  }
  async function refresh(initial = false, defaults = {}) {
    if (!source) return; const previous = document.activeElement, options = initial ? { format, ...defaults, rate: $('#signal-rate').value } : loadOptions();
    invalidate(); const token = epoch; data = undefined; busy = true; buttons(); drawWave(); status('正在解析信号…');
    try {
      const next = await task.run({ operation: 'signalLoad', bytes: source, options }); if (token !== epoch) return;
      data = next; fillSelectors(next);
      if (initial) { range = [0, data.info.samples]; cursors = [0, Math.min(1, data.info.samples - 1)]; }
      else { range = [Math.min(range[0], data.info.samples - 1), Math.min(Math.max(range[1], range[0] + 1), data.info.samples)]; }
      $('#signal-from').value = range[0]; $('#signal-to').value = range[1];
      $('#signal-source').textContent = sourceName + ' · ' + data.info.channels + ' 路 × ' + data.info.samples + ' 样本';
      const warnings = [...data.info.warnings, ...(!data.axis.uniform ? ['时间轴不等间隔，FFT / lag 互相关不可用；不自动重采样。'] : [])];
      $('#signal-warning').textContent = warnings.join('；'); $('#signal-warning').hidden = !warnings.length;
      const metadata = [sourceName + ' · ' + formatSize(source.length), 'SHA-256 ' + data.sourceSha256,
        'A: ' + data.a.title + '\n原始 trace 数据 (' + data.a.data.length + ' B): ' + hex(data.a.data.subarray(0, 256)) + (data.a.data.length > 256 ? ' …（预览；报告完整）' : ''),
        data.b ? 'B: ' + data.b.title + '\n原始 trace 数据 (' + data.b.data.length + ' B): ' + hex(data.b.data.subarray(0, 256)) + (data.b.data.length > 256 ? ' …（预览；报告完整）' : '') : '',
        pretty(data.info.metadata), data.info.suggestedRate ? 'TRS X scale 建议采样率 ' + number(data.info.suggestedRate) + ' Hz；仅在 X 单位为秒时采用。' : '没有可信采样率；空白 Hz 使用 sample / cycles per sample。'];
      $('#signal-metadata').textContent = metadata.filter(Boolean).join('\n\n');
      status(data.info.format + ' · ' + data.info.samples + ' 样本 / 通道 · ' + (data.axis.rate === null ? '样本轴，无 Hz 假设' : number(data.axis.rate) + ' Hz') + (warnings.length ? ' · 请查看元数据警告' : ''));
      drawWave();
    } catch (error) { if (token === epoch && error.name !== 'AbortError') status(error.message); }
    finally { if (token === epoch) { busy = false; buttons(); restoreFocus(previous); } }
  }
  async function setSource(bytes, name, kind, defaults = {}) {
    invalidate(); data = undefined; source = undefined; $('#signal-warning').hidden = true; $('#signal-metadata').textContent = ''; buttons(); drawWave();
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > SIGNAL_FILE_LIMIT) throw Error('文件须为 1 B–16 MiB');
    source = bytes; sourceName = name; format = kind; $('#signal-rate').value = defaults.rate ?? '';
    $('#signal-source').textContent = name + ' · 正在解析…'; windows.setTitle('signal', name + ' — 信号分析台'); await refresh(true, defaults);
  }
  async function open(path) {
    invalidate(); const token = epoch; data = undefined; source = undefined; $('#signal-source').textContent = '正在打开…'; buttons(); drawWave(); windows.open('signal');
    try { const bytes = await fs.read(path); if (token === epoch) await setSource(bytes, basename(path), /\.trs$/i.test(path) ? 'trs' : 'csv'); }
    catch (error) { if (token === epoch) { status(error.message); $('#signal-source').textContent = '打开失败'; } throw error; }
  }
  const choose = () => { const token = identity; pickFile(fs, path => { if (token === identity) void open(path).catch(report); }, DOCUMENTS); };
  async function save(name, value, token = epoch) {
    const player = identity, chosen = await askText('保存到 Documents', name);
    if (!chosen || token !== epoch || player !== identity) return;
    const path = await fs.writeFile(normalize(chosen, DOCUMENTS), value, false); if (token === epoch && player === identity) controls.toast('已保存：' + path);
  }
  function applyRange(start = index($('#signal-from').value), end = index($('#signal-to').value)) {
    if (!data) return; if (start < 0 || end > data.info.samples || start >= end) throw Error('选区须满足 0 ≤ 开始 < 末尾 ≤ 样本数');
    if (start !== range[0] || end !== range[1]) invalidate('选区已改变，请重新分析'); range = [start, end]; $('#signal-from').value = start; $('#signal-to').value = end;
    cursors = cursors.map(value => Math.max(start, Math.min(end - 1, value))); drawWave();
  }
  function zoom(factor) {
    if (!data) return; const length = Math.max(1, Math.min(data.info.samples, Math.round((range[1] - range[0]) * factor))), middle = cursors[0];
    const start = Math.max(0, Math.min(data.info.samples - length, middle - Math.floor(length / 2))); applyRange(start, start + length);
  }
  function pan(direction) {
    if (!data) return; const length = range[1] - range[0], start = Math.max(0, Math.min(data.info.samples - length, range[0] + direction * Math.max(1, Math.round(length / 5)))); applyRange(start, start + length);
  }
  async function analyze() {
    if (!data || busy) return; const previous = document.activeElement; applyRange(); invalidate(); const token = epoch, options = { ...loadOptions(), start: range[0], end: range[1], kind: $('#signal-kind').value, bins: Number($('#signal-bins').value),
      window: $('#signal-taper').value, removeMean: $('#signal-mean').checked, maxLag: $('#signal-kind').value === 'correlation' ? index($('#signal-lag').value) : 0 };
    busy = true; buttons(); status('正在分析完整选区…');
    try {
      const next = await task.run({ operation: 'signalAnalyze', bytes: source, options }); if (token !== epoch) return;
      result = { ...next, sourceName, options }; renderStatistics(); drawResult(); status('分析完成 · ' + (range[1] - range[0]) + ' 个样本 · 报告保留完整数值与源 SHA-256');
    } catch (error) { if (token === epoch && error.name !== 'AbortError') status(error.message); }
    finally { if (token === epoch) { busy = false; buttons(); restoreFocus(previous); } }
  }
  function renderStatistics() {
    const rows = $('#signal-statistics'); rows.replaceChildren(); if (!result) return;
    for (const [key, label] of [['count', 'N'], ['min', '最小'], ['max', '最大'], ['mean', '均值'], ['standardDeviation', '总体 σ'], ['rms', 'RMS'], ['median', '中位数']]) {
      const row = document.createElement('tr'); for (const value of [label, number(result.statistics.a[key]), number(result.statistics.b?.[key])]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } rows.append(row);
    }
  }
  function frame(canvas, x0 = 0, x1 = 1, y0 = -1, y1 = 1, xLabel = '', yLabel = '') {
    const width = Math.max(120, canvas.clientWidth), height = Math.max(90, canvas.clientHeight), ratio = Math.min(2, window.devicePixelRatio || 1, 4096 / width);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
    const style = getComputedStyle(canvas), color = name => style.getPropertyValue(name).trim();
    ctx.fillStyle = color('--bg') || '#232629'; ctx.fillRect(0, 0, width, height);
    if (x0 === x1) { x0 -= .5; x1 += .5; } if (y0 === y1) { const pad = Math.max(1, Math.abs(y0) * Number.EPSILON * 16); y0 -= pad; y1 += pad; }
    const left = 54, right = width - 16, top = 20, bottom = height - 28, sx = value => left + (value - x0) / (x1 - x0) * (right - left), sy = value => bottom - (value - y0) / (y1 - y0) * (bottom - top);
    ctx.font = '10px Hack, monospace'; ctx.strokeStyle = color('--line') || '#4d5257'; ctx.fillStyle = color('--muted') || '#a1a9b1'; ctx.lineWidth = .5;
    for (let i = 0; i <= 4; i++) {
      const y = top + i * (bottom - top) / 4; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(tick(y1 - (y1 - y0) * i / 4), left - 5, y + 3);
    }
    ctx.textAlign = 'left'; ctx.fillText(tick(x0), left, height - 12); ctx.textAlign = 'right'; ctx.fillText(tick(x1), right, height - 12);
    ctx.textAlign = 'center'; ctx.fillText(xLabel, (left + right) / 2, height - 12); ctx.textAlign = 'left'; ctx.fillText(yLabel, left, 12);
    return { ctx, sx, sy, left, right, top, bottom, color };
  }
  function line(f, x, values, start, end, color) {
    const { ctx, sx, sy } = f; ctx.save(); ctx.beginPath(); ctx.rect(f.left, f.top, f.right - f.left, f.bottom - f.top); ctx.clip(); ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
    let moved = false;
    for (const bucket of signalEnvelope(values, start, end, Math.max(1, Math.min(4096, Math.floor(f.right - f.left))))) {
      const firstX = sx(x[bucket.from]), lastX = sx(x[bucket.to - 1]), centerX = (firstX + lastX) / 2;
      if (moved) ctx.lineTo(firstX, sy(bucket.first)); else { ctx.moveTo(firstX, sy(bucket.first)); moved = true; }
      ctx.lineTo(centerX, sy(bucket.min)); ctx.lineTo(centerX, sy(bucket.max)); ctx.lineTo(lastX, sy(bucket.last));
    }
    ctx.stroke(); ctx.restore();
  }
  function drawWave() {
    const canvas = $('#signal-wave'); if (!data) { frame(canvas); $('#signal-cursor').textContent = '点击设游标；Shift 点击设置第二游标'; return; }
    const [start, end] = range; let low = Infinity, high = -Infinity;
    for (const values of [data.a.values, ...(data.b ? [data.b.values] : [])]) for (let i = start; i < end; i++) { low = Math.min(low, values[i]); high = Math.max(high, values[i]); }
    const margin = (high - low) * .06, f = frame(canvas, data.x[start], data.x[end - 1], low - margin, high + margin, data.axis.unit, 'A — ' + data.a.name + (data.b ? '   B — ' + data.b.name : ''));
    line(f, data.x, data.a.values, start, end, f.color('--accent') || '#3daee9'); if (data.b) line(f, data.x, data.b.values, start, end, '#f6a348');
    f.ctx.setLineDash([3, 3]); f.ctx.strokeStyle = f.color('--ink') || '#eff0f1'; f.ctx.lineWidth = 1;
    const closeCursors = Math.abs(f.sx(data.x[cursors[0]]) - f.sx(data.x[cursors[1]])) < 28;
    cursors.forEach((position, i) => { if (position < start || position >= end) return; const x = f.sx(data.x[position]); f.ctx.beginPath(); f.ctx.moveTo(x, f.top); f.ctx.lineTo(x, f.bottom); f.ctx.stroke(); f.ctx.fillStyle = f.color('--ink') || '#eff0f1'; if (!closeCursors || !i) f.ctx.fillText(closeCursors ? 'C1/C2' : 'C' + (i + 1), Math.min(x + 3, f.right - (closeCursors ? 32 : 18)), f.top + 10); });
    f.ctx.setLineDash([]);
    $('#signal-cursor').textContent = cursors.map((at, i) => 'C' + (i + 1) + ' #' + at + ' · x=' + number(data.x[at]) + ' ' + data.axis.unit + ' · A=' + number(data.a.values[at]) + (data.b ? ' B=' + number(data.b.values[at]) : '')).join(' | ')
      + ' | Δx=' + number(data.x[cursors[1]] - data.x[cursors[0]]) + ' ' + data.axis.unit;
  }
  function drawResult() {
    const canvas = $('#signal-result-plot'); if (!result) { frame(canvas); return; }
    if (result.histogram) {
      const { edges, counts } = result.histogram, top = Math.max(...counts, 1), f = frame(canvas, edges[0], edges.at(-1), 0, top * 1.1, data?.info.unit || 'value', 'A · histogram');
      f.ctx.fillStyle = f.color('--accent') || '#3daee9'; counts.forEach((count, i) => f.ctx.fillRect(f.sx(edges[i]), f.sy(count), Math.max(1, f.sx(edges[i + 1]) - f.sx(edges[i]) - 1), f.sy(0) - f.sy(count)));
      $('#signal-result-note').textContent = '总体标准差；方差 / 样本方差及四分位数在完整报告中。箱区间左闭右开，最后一箱包含最大值。';
    } else if (result.spectrum) {
      const s = result.spectrum, values = $('#signal-db').checked ? s.db : s.amplitude; let low = Infinity, high = -Infinity;
      for (const value of values) { low = Math.min(low, value); high = Math.max(high, value); }
      if (!$('#signal-db').checked) low = 0;
      const f = frame(canvas, 0, s.frequency.at(-1), low, high + (high - low) * .06, s.frequencyUnit, $('#signal-db').checked ? 'dB re 1 unit' : 'one-sided amplitude'); line(f, s.frequency, values, 0, values.length, f.color('--accent') || '#3daee9');
      $('#signal-result-note').textContent = s.inputSamples + ' 样本 → FFT ' + s.fftSize + ' · ' + s.window + ' · 峰 ' + number(s.peak.frequency) + ' ' + s.frequencyUnit + ' / ' + number(s.peak.amplitude) + ' · 已补偿窗增益；不是 PSD / dBFS，补零不提升真实分辨率。';
    } else {
      const c = result.correlation, f = frame(canvas, c.lags[0], c.lags.at(-1), -1.05, 1.05, 'lag (samples)', 'overlap-centered Pearson r'); f.ctx.strokeStyle = f.color('--accent') || '#3daee9'; f.ctx.lineWidth = 1.2; f.ctx.beginPath();
      let drawing = false; const count = Math.min(c.lags.length, 4096, Math.max(1, Math.floor(f.right - f.left)));
      for (let bucket = 0; bucket < count; bucket++) {
        const start = Math.floor(bucket * c.lags.length / count), end = Math.floor((bucket + 1) * c.lags.length / count); let low = Infinity, high = -Infinity, first, last;
        for (let i = start; i < end; i++) { const value = c.coefficients[i]; if (value === null) continue; first ??= i; last = i; low = Math.min(low, value); high = Math.max(high, value); }
        if (first === undefined) { drawing = false; continue; }
        const x = f.sx((c.lags[first] + c.lags[last]) / 2);
        drawing ? f.ctx.lineTo(f.sx(c.lags[first]), f.sy(c.coefficients[first])) : f.ctx.moveTo(f.sx(c.lags[first]), f.sy(c.coefficients[first]));
        f.ctx.lineTo(x, f.sy(low)); f.ctx.lineTo(x, f.sy(high)); f.ctx.lineTo(f.sx(c.lags[last]), f.sy(c.coefficients[last])); drawing = true;
      }
      f.ctx.stroke();
      $('#signal-result-note').textContent = (c.peak ? '|r| 峰：lag ' + c.peak.lag + ' / r=' + number(c.peak.coefficient) + ' / 重叠 ' + c.peak.overlap : '无定义的相关系数：零方差 / 数值退化') + '。正 lag 表示 B 相对 A 延迟；每个重叠区单独去均值。';
    }
  }
  function mode() {
    const kind = $('#signal-kind').value;
    for (const key of ['window', 'mean', 'db']) $('#signal-' + key + '-label').hidden = kind !== 'spectrum';
    $('#signal-bins-label').hidden = kind !== 'histogram'; $('#signal-lag-label').hidden = kind !== 'correlation'; invalidate('分析参数已改变');
  }
  listen('signal-open', choose); listen('signal-reload', () => refresh());
  listen('signal-example', () => {
    const a = Array.from({ length: 1024 }, (_, i) => Math.sin(2 * Math.PI * 64 * i / 1024) + .35 * Math.cos(2 * Math.PI * 9 * i / 1024));
    $('#signal-input').value = 'A,B\n' + a.map((value, i) => value + ',' + a[(i + 1017) % 1024]).join('\n');
    return setSource(new TextEncoder().encode($('#signal-input').value), 'two-tone.signal.csv', 'csv', { rate: 1024 });
  });
  listen('signal-load-text', () => setSource(new TextEncoder().encode($('#signal-input').value), 'input.signal.csv', 'csv'));
  for (const key of ['a', 'b', 'time', 'rate']) listen('signal-' + key, () => refresh(), 'change');
  listen('signal-use-rate', () => { if (data?.info.suggestedRate) { $('#signal-rate').value = data.info.suggestedRate; return refresh(); } });
  listen('signal-apply-range', () => applyRange()); for (const key of ['from', 'to']) listen('signal-' + key, () => invalidate('选区尚未应用；分析前会验证新边界'), 'input');
  listen('signal-fit', () => data && applyRange(0, data.info.samples)); listen('signal-zoom-in', () => zoom(.5)); listen('signal-zoom-out', () => zoom(2));
  listen('signal-kind', mode, 'change'); for (const key of ['bins', 'taper', 'mean']) listen('signal-' + key, () => invalidate('分析参数已改变'), 'change'); listen('signal-lag', () => invalidate('lag 已改变'), 'input'); listen('signal-db', drawResult, 'change');
  listen('signal-run', analyze); listen('signal-stop', () => { const previous = document.activeElement; invalidate('已停止'); restoreFocus(previous); });
  listen('signal-save-csv', () => { if (data) { applyRange(); return save(sourceName.replace(/\.[^.]+$/, '') + '.selection.signal.csv', signalCsv(data, ...range)); } });
  listen('signal-save-report', () => { if (result) return save(sourceName.replace(/\.[^.]+$/, '') + '.analysis.json', pretty(result)); });
  listen('signal-wave', event => {
    if (!data) return; const rect = event.currentTarget.getBoundingClientRect(), ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - 54) / Math.max(1, rect.width - 70)));
    const target = data.x[range[0]] + ratio * (data.x[range[1] - 1] - data.x[range[0]]); let lo = range[0], hi = range[1] - 1;
    while (lo < hi) { const middle = Math.floor((lo + hi) / 2); if (data.x[middle] < target) lo = middle + 1; else hi = middle; }
    if (lo > range[0] && target - data.x[lo - 1] < data.x[lo] - target) lo--; cursors[event.shiftKey ? 1 : 0] = lo; $('#signal-wave').focus(); drawWave();
  });
  listen('signal-wave', event => {
    if (!data) return;
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const direction = event.key === 'ArrowLeft' ? -1 : 1; if (event.ctrlKey || event.metaKey) pan(direction); else { const which = event.shiftKey ? 1 : 0; cursors[which] = Math.max(range[0], Math.min(range[1] - 1, cursors[which] + direction)); drawWave(); } }
    else if (['+', '=', '-', 'Home'].includes(event.key)) { event.preventDefault(); event.key === 'Home' ? applyRange(0, data.info.samples) : zoom(event.key === '-' ? 2 : .5); }
  }, 'keydown');
  $('#signal-window').addEventListener('keydown', event => {
    if (event.isComposing || event.target.closest('dialog')) return;
    if (shortcut(event, 'Enter')) { event.preventDefault(); void analyze().catch(report); }
    else if (shortcut(event, 's')) { event.preventDefault(); if (result) void save(sourceName + '.analysis.json', pretty(result)).catch(report); }
  });
  menubar($('#signal-menubar'), { '文件': [{ label: '打开 CSV / TRS…', action: choose }, { label: '保存选区 CSV…', action: () => $('#signal-save-csv').click() }], '分析': [{ label: '分析选区', action: () => void analyze().catch(report) }, { label: '停止', action: () => invalidate('已停止') }] });
  const observer = new ResizeObserver(() => { drawWave(); drawResult(); }); observer.observe($('#signal-wave')); observer.observe($('#signal-result-plot'));
  $('#signal-window').addEventListener('window:open', () => { drawWave(); drawResult(); });
  $('#signal-window').addEventListener('window:close', () => { if (busy) invalidate('已停止'); });
  window.addEventListener('pagehide', () => { task.stop(); observer.disconnect(); });
  mode(); drawWave();
  return { open, reset() { identity++; invalidate(); source = undefined; sourceName = ''; data = undefined; range = [0, 0]; cursors = [0, 0];
    $('#signal-input').value = ''; $('#signal-rate').value = ''; $('#signal-source').textContent = '尚未打开'; $('#signal-metadata').textContent = ''; $('#signal-warning').hidden = true;
    listedLabels = []; listedFormat = undefined;
    for (const key of ['a', 'b']) $('#signal-' + key).replaceChildren(); $('#signal-time').innerHTML = '<option value="-1">样本编号</option>'; $('#signal-from').value = '0'; $('#signal-to').value = '0';
    buttons(); drawWave(); status('16 MiB · 262144 样本 / 通道 · 有界、可取消 Worker'); windows.setTitle('signal', '信号分析台'); } };
}
