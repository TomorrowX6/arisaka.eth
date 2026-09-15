import { $, askText, menubar, shortcut } from '/ui.js';
import { DOCUMENTS, basename, parent, normalize } from '/filesystem.js';
import { pickFile } from '/files.js';
import { createAnalysisTask } from '/analysis-task.js';
import { RF_LIMITS, sigmfDatasetName, rfEnvelope } from '/rf-data.js';

export const rfLayout = `<nav id="rf-menubar" class="native-menubar"></nav>
  <div class="native-toolbar"><button id="rf-open" data-icon="document-open">打开 SigMF…</button><button id="rf-import">导入本机文件对…</button><input id="rf-local-files" type="file" multiple hidden><button id="rf-example">复数双音示例</button><button id="rf-restore" disabled>恢复原始数据</button><span class="toolbar-spacer"></span><button id="rf-save-pair" disabled>保存 SigMF 文件对…</button><button id="rf-save-csv" disabled>选区 CSV…</button></div>
  <div id="rf-source" class="rf-source" role="status">单通道复数 I/Q · 不自动解调</div>
  <details class="rf-metadata"><summary>元数据、来源与格式边界</summary><p>cf32 / cf64、ci8 / ci16 / ci32、cu8 / cu16 / cu32；多字节须声明 _le 或 _be。整数保留原始 ADC 数值。支持非标准数据集的逐段头字节、尾字节与安全整数 offset；超过精确范围的索引报错。不访问元数据 URL，不猜测多通道或必需扩展。</p><pre id="rf-metadata" tabindex="0"></pre></details>
  <div id="rf-warning" role="status" hidden></div>
  <div class="native-toolbar rf-range"><label for="rf-segment">捕获段</label><select id="rf-segment" disabled><option value="all">全部</option></select><label for="rf-from">本地样本起点</label><input id="rf-from" value="0" inputmode="numeric" disabled><label for="rf-to">末尾（不含）</label><input id="rf-to" value="0" inputmode="numeric" disabled><button id="rf-apply-range" disabled>应用</button><button id="rf-fit" disabled>全览</button><button id="rf-zoom-in" disabled aria-label="放大 I/Q">＋</button><button id="rf-zoom-out" disabled aria-label="缩小 I/Q">−</button></div>
  <canvas id="rf-wave" tabindex="0" role="img" aria-label="复数 I/Q 波形" aria-describedby="rf-help"></canvas><output id="rf-cursor" aria-live="polite">I / Q 分别显示；点击设游标 A，Shift 点击设 B。</output>
  <p id="rf-help" class="tool-note">← → 移动 A，Shift+← → 移动 B；Ctrl+← → 平移，+ / − 缩放，Home 全览。Ctrl+Enter 分析。每个绘图桶保留 I/Q 极值。</p>
  <div class="native-toolbar rf-analysis-controls"><select id="rf-kind" aria-label="射频分析类型"><option value="spectrum">双边 Welch PSD</option><option value="spectrogram">复数频谱瀑布</option><option value="constellation">手动抽样星座</option></select><label id="rf-fft-label">FFT<select id="rf-fft"><option>64</option><option>128</option><option>256</option><option>512</option><option selected>1024</option><option>2048</option><option>4096</option><option>8192</option><option>16384</option></select></label><label id="rf-hop-label">hop<select id="rf-overlap"><option value="1">N</option><option value="2" selected>N/2</option><option value="4">N/4</option></select></label><label id="rf-window-label">窗<select id="rf-taper"><option value="hann">Hann</option><option value="rectangular">Rectangular</option><option value="blackman">Blackman</option></select></label><label id="rf-stride-label" hidden>样本间隔<input id="rf-stride" value="1" inputmode="numeric"></label><label id="rf-phase-label" hidden>相位<input id="rf-phase" value="0" inputmode="numeric"></label><span class="toolbar-spacer"></span><button id="rf-run" class="button primary" disabled>分析选区</button><button id="rf-stop" disabled>停止</button><button id="rf-save-report" disabled>完整报告…</button></div>
  <div class="rf-results"><section><canvas id="rf-result" tabindex="0" role="img" aria-label="射频分析结果" aria-describedby="rf-result-note"></canvas><div id="rf-color-scale" hidden aria-label="瀑布颜色对应 PSD dB"><span id="rf-color-min"></span><span id="rf-color-gradient"></span><span id="rf-color-max"></span></div><p id="rf-result-note" class="tool-note">频率有正负；PSD 不按实信号倍增，不冒充 dBFS。所有 FFT 窗均不跨捕获段。</p><output id="rf-bin" aria-live="polite">点击频谱查看精确频点；← → 导航频点，瀑布 ↑ ↓ 导航时间窗。</output></section><aside><h3>完整选区统计</h3><pre id="rf-statistics" tabindex="0">尚无结果</pre></aside></div>
  <details class="rf-transform"><summary>频率搬移 / 复共轭 / 抗混叠抽取</summary><div class="native-toolbar"><label>频移<input id="rf-shift" type="number" step="any" value="0" aria-label="复数频移"></label><span id="rf-shift-unit">Hz 或 cycles/sample</span><label>抽取<select id="rf-decimation"><option>1</option><option>2</option><option>4</option><option>8</option><option>16</option><option>32</option></select></label><label><input id="rf-conjugate" type="checkbox">复共轭</label><label><input id="rf-center" type="checkbox">减选区均值</label><button id="rf-transform" disabled>变换选区为新数据</button></div><p>正频移乘 exp(−j2πfn/Fs)，相位原点为选区开始。抽取前采用 32D+1 点 Hamming 低通 FIR，仅输出完整支撑的中心样本；不补造边缘，不跨捕获段。输出 cf64_le，保留源 SHA-256、原始元数据、滤波系数与精确样本映射；注释 / UTC 不自动重投影。复共轭后不声称绝对 RF 方向已校准。可随时恢复原始文件对。</p></details>
  <div class="native-toolbar rf-table-controls"><span>精确 I/Q 样本（每页 100 项）</span><span class="toolbar-spacer"></span><button id="rf-prev" disabled aria-label="上一页 I/Q">‹</button><span id="rf-page">0 项</span><button id="rf-next" disabled aria-label="下一页 I/Q">›</button></div>
  <div class="rf-table-wrap"><table class="data-table" aria-label="精确复数样本分页表"><thead><tr><th>本地 / 绝对样本</th><th>文件字节偏移</th><th>I</th><th>Q</th><th>|I+jQ|</th><th>相位 rad</th></tr></thead><tbody id="rf-table"></tbody></table></div>
  <footer class="statusbar"><span id="rf-status" role="status">16 MiB · 262144 复数样本 · 20 秒可取消分析 Worker</span></footer>`;

const pretty = value => JSON.stringify(value, (_, item) => ArrayBuffer.isView(item) ? Array.from(item) : item, 2) + '\n';
const number = value => Number.isFinite(value) ? Number(value.toPrecision(8)).toString() : '—';
const index = value => { if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) throw Error('样本索引须为非负精确整数'); return Number(value); };
const PAGE = 100, POINTS = 4096;

export function createRFApp(controls) {
  const { fs, windows } = controls, task = createAnalysisTask();
  let epoch = 0, identity = 0, busy = false, source, original, data, result, range = [0, 0], cursors = [0, 0], page = 0, selectedBin = 0, selectedFrame = 0, animation;
  const status = text => { $('#rf-status').textContent = text; };
  const listen = (id, handler, type = 'click') => $('#' + id).addEventListener(type, event => { Promise.resolve().then(() => handler(event)).catch(error => { if (error.name !== 'AbortError') status(error.message); }); });
  const stem = name => name.replace(/\.sigmf-(?:meta|data)$/i, '');
  function buttons() {
    for (const id of ['run', 'save-pair', 'save-csv', 'segment', 'from', 'to', 'apply-range', 'fit', 'zoom-in', 'zoom-out', 'transform']) $('#rf-' + id).disabled = !data || busy;
    for (const id of ['kind', 'fft', 'overlap', 'taper', 'stride', 'phase', 'shift', 'decimation', 'conjugate', 'center']) $('#rf-' + id).disabled = busy;
    $('#rf-stop').disabled = !busy; $('#rf-save-report').disabled = !result || busy; $('#rf-restore').disabled = !original || busy || source === original;
    $('#rf-prev').disabled = !data || busy || page === 0; $('#rf-next').disabled = !data || busy || (page + 1) * PAGE >= range[1] - range[0];
  }
  function invalidate(message) { epoch++; task.stop(); busy = false; result = undefined; $('#rf-statistics').textContent = '选区或参数已改变，请重新分析。'; $('#rf-bin').textContent = '尚未选择频点'; buttons(); requestDraw(); if (message) status(message); }
  function restoreFocus(previous) {
    if (previous && $('#rf-window').classList.contains('focused') && (document.activeElement === document.body || document.activeElement === previous && previous.disabled)) (previous.isConnected && !previous.disabled ? previous : $('#rf-wave')).focus({ preventScroll: true });
  }
  function clear() {
    data = undefined; source = undefined; original = undefined; range = [0, 0]; cursors = [0, 0]; page = 0;
    $('#rf-source').textContent = '单通道复数 I/Q · 不自动解调'; $('#rf-metadata').textContent = ''; $('#rf-warning').hidden = true; $('#rf-cursor').textContent = '尚无样本';
    $('#rf-segment').replaceChildren(new Option('全部', 'all')); $('#rf-from').value = '0'; $('#rf-to').value = '0'; renderTable(); buttons(); requestDraw();
  }
  function present(next) {
    data = next; range = [0, data.info.count]; cursors = [0, Math.min(1, data.info.count - 1)]; page = 0; selectedBin = 0; selectedFrame = 0;
    $('#rf-from').value = range[0]; $('#rf-to').value = range[1];
    $('#rf-source').textContent = source.name + ' · ' + data.info.datatype + ' · ' + data.info.count + ' 复数样本 · ' + (data.info.rate ? number(data.info.rate) + ' Hz' : '无采样率') + ' · ' + data.captures.length + ' 个捕获段';
    $('#rf-warning').textContent = data.info.warnings.join('；'); $('#rf-warning').hidden = !data.info.warnings.length; $('#rf-shift-unit').textContent = data.info.rate ? 'Hz' : 'cycles/sample';
    const metadata = pretty(data.metadata); $('#rf-metadata').textContent = 'Metadata SHA-256: ' + data.hashes.metadataSha256 + '\nDataset SHA-256: ' + data.hashes.datasetSha256 + '\nSHA-512: ' + (data.hashes.sha512Verified ? '已验证' : '源未声明') + '\n\n' + metadata.slice(0, 12000) + (metadata.length > 12000 ? '\n…仅预览前 12000 字符；文件对与报告保留完整元数据。' : '');
    $('#rf-segment').replaceChildren(new Option('全部', 'all'), ...data.captures.map((capture, i) => new Option(i + ': [' + capture.start + ', ' + capture.end + ')', String(i))));
    windows.setTitle('rf', source.name + ' — RF / IQ 工坊'); renderTable(); requestDraw();
  }
  async function loadPair(pair, remember = true) {
    const previous = document.activeElement; invalidate(); data = undefined; source = undefined; if (remember) original = undefined; renderTable();
    const token = epoch; busy = true; buttons(); requestDraw(); status('正在验证并读取 SigMF 文件对…');
    try {
      const next = await task.run({ operation: 'rfLoad', metadataBytes: pair.metadata, bytes: pair.bytes }); if (token !== epoch) return;
      source = pair; if (remember) original = pair; present(next); status('已读取 · 数据与元数据 SHA-256 已记录 · 无自动解调 / 同步假设');
    } catch (error) { if (token === epoch && error.name !== 'AbortError') { $('#rf-source').textContent = '打开失败'; status(error.message); } }
    finally { if (token === epoch) { busy = false; buttons(); restoreFocus(previous); } }
  }
  async function open(path) {
    invalidate(); clear(); const token = epoch; windows.open('rf'); status('正在打开文件对…');
    const metaPath = /\.sigmf-data$/i.test(path) ? path.replace(/\.sigmf-data$/i, '.sigmf-meta') : path;
    try {
      const metadata = await fs.read(metaPath), name = basename(metaPath), dataset = sigmfDatasetName(metadata, name), bytes = await fs.read(normalize(dataset, parent(metaPath)));
      if (token === epoch) await loadPair({ metadata, bytes, name });
    } catch (error) { if (token === epoch) { status(error.message); $('#rf-source').textContent = '文件对打开失败'; } }
  }
  const choose = () => { const player = identity; return pickFile(fs, path => { if (player === identity) return open(path); }, DOCUMENTS); };
  async function localFiles(event) {
    const files = [...event.target.files]; event.target.value = ''; const player = identity;
    if (!files.length) return;
    invalidate(); clear(); const token = epoch;
    if (files.length !== 2 || files.filter(file => /\.sigmf-meta$/i.test(file.name)).length !== 1) throw Error('请同时选择一份 .sigmf-meta 与其数据文件');
    const file = files.find(file => /\.sigmf-meta$/i.test(file.name)); if (file.size > RF_LIMITS.metadataBytes) throw Error('元数据超过 1 MiB');
    const metadata = new Uint8Array(await file.arrayBuffer()), name = sigmfDatasetName(metadata, file.name), dataset = files.find(item => item !== file && item.name === name);
    if (!dataset || dataset.size > RF_LIMITS.dataBytes) throw Error('缺少同名数据文件，或数据超过 16 MiB');
    const bytes = new Uint8Array(await dataset.arrayBuffer()); if (player === identity && token === epoch) await loadPair({ metadata, bytes, name: file.name });
  }
  function applyRange(start = index($('#rf-from').value), end = index($('#rf-to').value)) {
    if (!data) return; if (start >= end || end > data.info.count) throw Error('选区须满足 0 ≤ 开始 < 末尾 ≤ 样本数');
    if (start !== range[0] || end !== range[1]) { invalidate('选区已改变，请重新分析'); page = 0; }
    range = [start, end]; cursors = cursors.map(value => Math.max(start, Math.min(end - 1, value))); $('#rf-from').value = start; $('#rf-to').value = end; renderTable(); requestDraw();
  }
  function zoom(factor) {
    if (!data) return; const length = Math.max(1, Math.min(data.info.count, Math.round((range[1] - range[0]) * factor))), start = Math.max(0, Math.min(data.info.count - length, cursors[0] - Math.floor(length / 2))); applyRange(start, start + length);
  }
  function pan(direction) { if (data) { const length = range[1] - range[0], start = Math.max(0, Math.min(data.info.count - length, range[0] + direction * Math.max(1, Math.round(length / 5)))); applyRange(start, start + length); } }
  function mode() {
    const constellation = $('#rf-kind').value === 'constellation'; for (const key of ['fft', 'hop', 'window']) $('#rf-' + key + '-label').hidden = constellation; for (const key of ['stride', 'phase']) $('#rf-' + key + '-label').hidden = !constellation; invalidate('分析参数已改变');
  }
  async function analyze() {
    if (!data || busy) return; applyRange(); const previous = document.activeElement; invalidate(); const token = epoch, fftSize = Number($('#rf-fft').value);
    const options = { start: range[0], end: range[1], kind: $('#rf-kind').value, fftSize, hop: fftSize / Number($('#rf-overlap').value), window: $('#rf-taper').value, stride: index($('#rf-stride').value), phase: index($('#rf-phase').value) };
    busy = true; buttons(); status('正在分析选区…');
    try { const next = await task.run({ operation: 'rfAnalyze', metadataBytes: source.metadata, bytes: source.bytes, options }); if (token !== epoch) return; result = { ...next, sourceName: source.name }; if (result.spectrum) { selectedBin = result.spectrum.frequency.indexOf(result.spectrum.peak.frequency); selectedFrame = 0; } renderStatistics(); requestDraw(); status('分析完成 · 报告包含全量数值；画布仅作有界预览'); }
    catch (error) { if (token === epoch && error.name !== 'AbortError') status(error.message); }
    finally { if (token === epoch) { busy = false; buttons(); restoreFocus(previous); } }
  }
  async function transform() {
    if (!data || busy) return; applyRange(); const previous = document.activeElement; invalidate(); const token = epoch, input = source;
    const shift = $('#rf-shift').value.trim(); if (!shift || !Number.isFinite(Number(shift))) throw Error('频移须为有限数值');
    const options = { start: range[0], end: range[1], shift: Number(shift), decimation: Number($('#rf-decimation').value), conjugate: $('#rf-conjugate').checked, removeMean: $('#rf-center').checked };
    busy = true; buttons(); status('正在频率搬移 / FIR 抽取…');
    try {
      const next = await task.run({ operation: 'rfTransform', metadataBytes: source.metadata, bytes: source.bytes, options }); if (token !== epoch) return;
      source = { name: stem(original.name) + '.derived.sigmf-meta', metadata: next.metaBytes, bytes: next.bytes }; present(next.model);
      result = { format: 'arisaka-rf-transform-v1', kind: 'transform', sourceName: input.name, outputName: source.name, operation: next.operation, provenance: data.metadata.global['arisaka-rf:provenance'], outputHashes: data.hashes };
      $('#rf-statistics').textContent = '输出 ' + data.info.count + ' 个复数样本\n' + '输入首个中心样本 ' + next.operation.firstOutputSourceAbsoluteSample + '\n每输出样本跨 ' + next.operation.sourceStep + ' 个输入样本\nFIR ' + next.operation.filter.taps.length + ' taps\n原始数据未改写'; requestDraw(); status('变换完成 · 当前显示新数据 · 可恢复原始文件对');
    } catch (error) { if (token === epoch && error.name !== 'AbortError') status(error.message); }
    finally { if (token === epoch) { busy = false; buttons(); restoreFocus(previous); } }
  }
  async function savePair() {
    if (!data || busy) return; const token = epoch, player = identity, chosen = await askText('保存文件对到 Documents（不覆盖现有文件）', stem(source.name));
    if (!chosen || token !== epoch || player !== identity) return; const base = normalize(stem(chosen), DOCUMENTS), metadata = structuredClone(data.metadata);
    if (metadata.global['core:dataset'] !== undefined) metadata.global['core:dataset'] = basename(base) + '.sigmf-data';
    const paths = await fs.writeFiles([{ path: base + '.sigmf-meta', value: pretty(metadata) }, { path: base + '.sigmf-data', value: source.bytes }], false);
    if (token === epoch && player === identity) { status('已原子保存文件对；未覆盖原文件'); controls.toast('已保存：' + paths.join(' + ')); }
  }
  async function saveReport() {
    if (!result || busy) return; const token = epoch, player = identity, saved = result, chosen = await askText('保存完整报告到 Documents', stem(source.name) + '.rf-report.json');
    if (!chosen || token !== epoch || player !== identity) return; const text = pretty(saved); if (new TextEncoder().encode(text).length > 33554432) throw Error('报告超过 32 MiB，请缩小选区或增大 hop');
    const path = await fs.writeFile(normalize(chosen, DOCUMENTS), text, false); if (token === epoch && player === identity) controls.toast('已保存：' + path);
  }
  async function saveCsv() {
    if (!data || busy) return; applyRange(); const token = epoch, player = identity, chosen = await askText('保存完整选区 CSV 到 Documents', stem(source.name) + '.iq.csv');
    if (!chosen || token !== epoch || player !== identity) return; const previous = document.activeElement; busy = true; buttons(); status('正在导出完整选区…');
    try {
      const next = await task.run({ operation: 'rfCsv', metadataBytes: source.metadata, bytes: source.bytes, options: { start: range[0], end: range[1] } }); if (token !== epoch || player !== identity) return;
      const path = await fs.writeFile(normalize(chosen, DOCUMENTS), next.bytes, false); if (token === epoch && player === identity) { controls.toast('已保存：' + path); status('已导出完整选区 CSV；不是波形桶或星座预览'); }
    } catch (error) { if (token === epoch && error.name !== 'AbortError') status(error.message); }
    finally { if (token === epoch) { busy = false; buttons(); restoreFocus(previous); } }
  }

  function frame(canvas, xmin = 0, xmax = 1, ymin = -1, ymax = 1, xlabel = '', ylabel = '') {
    const width = Math.max(160, canvas.clientWidth || 640), height = Math.max(120, canvas.clientHeight || 190), dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.min(4096, Math.round(width * dpr)); canvas.height = Math.min(2048, Math.round(height * dpr));
    const ctx = canvas.getContext('2d'); ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    const style = getComputedStyle(canvas), color = name => style.getPropertyValue(name).trim(); ctx.fillStyle = color('--surface') || '#20252a'; ctx.fillRect(0, 0, width, height);
    if (xmin === xmax) { xmin -= .5; xmax += .5; } if (ymin === ymax) { ymin -= 1; ymax += 1; }
    const left = 58, right = width - 15, top = 24, bottom = height - 30, sx = x => left + (x - xmin) / (xmax - xmin) * (right - left), sy = y => bottom - (y - ymin) / (ymax - ymin) * (bottom - top);
    ctx.font = '10px Hack, monospace'; ctx.lineWidth = 1; ctx.fillStyle = color('--muted') || '#a0aab4';
    for (let i = 0; i < 5; i++) {
      const fraction = i / 4, x = left + (right - left) * fraction, y = top + (bottom - top) * fraction; ctx.strokeStyle = color('--line') || '#3d464f'; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      const label = value => Number.isInteger(value) && Math.abs(value) < 1e7 ? String(value) : Number(value.toPrecision(3)).toString().replace('e+', 'e'); ctx.textAlign = 'center'; ctx.fillText(label(xmin + fraction * (xmax - xmin)), x, bottom + 13); ctx.textAlign = 'right'; ctx.fillText(label(ymax - fraction * (ymax - ymin)), left - 5, y + 3);
    }
    ctx.textAlign = 'left'; ctx.fillText(ylabel, left, 13); ctx.textAlign = 'right'; ctx.fillText(xlabel, right, height - 3);
    return { ctx, color, sx, sy, left, right, top, bottom, width, height };
  }
  function requestDraw() { if (!animation) animation = requestAnimationFrame(() => { animation = undefined; if (!$('#rf-window').hidden) { drawWave(); drawResult(); } }); }
  function cursorText() {
    if (!data) return; const [a, b] = cursors, point = i => 'n=' + i + ' / abs=' + (data.info.offset + i) + '  I=' + number(data.samples[2 * i]) + ' Q=' + number(data.samples[2 * i + 1]);
    $('#rf-cursor').textContent = 'A ' + point(a) + '  ·  B ' + point(b) + '  ·  Δn=' + (b - a) + (data.info.rate ? ' / Δt=' + number((b - a) / data.info.rate) + ' s' : '');
    for (const row of $('#rf-table').children) row.classList.toggle('selected', Number(row.dataset.sample) === a);
  }
  function drawWave() {
    const canvas = $('#rf-wave'); if (!data) { frame(canvas, 0, 1, -1, 1, 'local sample', 'I / Q'); return; }
    const envelope = rfEnvelope(data.samples, ...range, Math.max(1, Math.min(4096, Math.floor(canvas.clientWidth - 74)))), low = Math.min(...envelope.map(item => Math.min(item.minI, item.minQ))), high = Math.max(...envelope.map(item => Math.max(item.maxI, item.maxQ))), pad = (high - low) * .08 || 1;
    const f = frame(canvas, range[0], range[1] - 1, low - pad, high + pad, 'local sample', 'I (blue) / Q (orange) · raw sample units');
    for (const [part, ink] of [['I', f.color('--accent') || '#3daee9'], ['Q', '#f6a348']]) {
      f.ctx.strokeStyle = ink; f.ctx.lineWidth = 1.1; f.ctx.beginPath(); let first = true;
      for (const item of envelope) { const x = f.sx((item.start + item.end - 1) / 2), y0 = f.sy(item['min' + part]), y1 = f.sy(item['max' + part]); if (first) { f.ctx.moveTo(x, y0); first = false; } else f.ctx.lineTo(x, y0); f.ctx.lineTo(x, y1); } f.ctx.stroke();
    }
    f.ctx.setLineDash([3, 3]); for (const capture of data.captures) if (capture.start > range[0] && capture.start < range[1]) { f.ctx.strokeStyle = f.color('--muted') || '#929da8'; const x = f.sx(capture.start); f.ctx.beginPath(); f.ctx.moveTo(x, f.top); f.ctx.lineTo(x, f.bottom); f.ctx.stroke(); }
    cursors.forEach((value, i) => { f.ctx.strokeStyle = i ? '#f6a348' : f.color('--accent') || '#3daee9'; const x = f.sx(value); f.ctx.beginPath(); f.ctx.moveTo(x, f.top); f.ctx.lineTo(x, f.bottom); f.ctx.stroke(); }); f.ctx.setLineDash([]); cursorText();
  }
  function renderStatistics() {
    if (!result?.statistics) return; const s = result.statistics;
    $('#rf-statistics').textContent = ['样本数 ' + s.count, 'mean(I) ' + number(s.meanI), 'mean(Q) ' + number(s.meanQ), 'I min/max ' + number(s.minI) + ' / ' + number(s.maxI), 'Q min/max ' + number(s.minQ) + ' / ' + number(s.maxQ), 'RMS |z| ' + number(s.rmsMagnitude), 'peak |z| ' + number(s.peakMagnitude), 'mean |z|² ' + number(s.meanPower)].join('\n');
  }
  function drawResult() {
    const canvas = $('#rf-result'); $('#rf-color-scale').hidden = result?.kind !== 'spectrogram';
    if (!result || result.kind === 'transform') { frame(canvas); $('#rf-result-note').textContent = result ? '变换后的 I/Q 已成为当前数据。原始文件对可恢复；请重新分析频谱或星座。' : '结果未生成。PSD 使用复数双边校准；画布不是完整报告。'; return; }
    if (result.kind === 'constellation') {
      const c = result.constellation; let max = 0; for (const value of c.points) max = Math.max(max, Math.abs(value)); max = max * 1.08 || 1;
      const ratio = Math.max(1, canvas.clientWidth - 73) / Math.max(1, canvas.clientHeight - 54), limitI = max * Math.max(1, ratio), limitQ = max * Math.max(1, 1 / ratio);
      const f = frame(canvas, -limitI, limitI, -limitQ, limitQ, 'I (raw units)', 'Q (raw units) · equal aspect'); f.ctx.fillStyle = f.color('--accent') || '#3daee9'; f.ctx.globalAlpha = .55;
      const count = Math.min(POINTS, c.indices.length); for (let i = 0; i < count; i++) { const at = Math.floor(i * c.indices.length / count); f.ctx.fillRect(f.sx(c.points[2 * at]) - 1, f.sy(c.points[2 * at + 1]) - 1, 2, 2); } f.ctx.globalAlpha = 1;
      $('#rf-result-note').textContent = c.indices.length + ' 个手动抽样点 · 预览 ' + count + ' 点 · step=' + c.stride + ' / phase=' + c.phase + '；等比例 I/Q 坐标，未做载波 / 定时恢复。报告保留所有点及其样本索引。'; return;
    }
    const s = result.spectrum, db = value => value > 0 ? 10 * Math.log10(value) : -300; let maximum = -300; for (const value of result.kind === 'spectrogram' ? s.power : s.mean) maximum = Math.max(maximum, db(value)); const floor = Math.max(-300, maximum - 100);
    if (result.kind === 'spectrum') {
      const f = frame(canvas, s.frequency[0], s.frequency.at(-1) + s.binWidth, floor, maximum + 4, s.frequencyUnit, 'two-sided PSD · dB re 1 ' + s.powerUnit); f.ctx.strokeStyle = f.color('--accent') || '#3daee9'; f.ctx.lineWidth = 1.1; f.ctx.beginPath();
      const count = Math.min(s.fftSize, Math.max(1, Math.floor(f.right - f.left)));
      for (let bucket = 0; bucket < count; bucket++) { const a = Math.floor(bucket * s.fftSize / count), b = Math.floor((bucket + 1) * s.fftSize / count); let peak = a; for (let i = a + 1; i < b; i++) if (s.mean[i] > s.mean[peak]) peak = i; const x = f.sx(s.frequency[peak]), y = f.sy(Math.max(floor, db(s.mean[peak]))); bucket ? f.ctx.lineTo(x, y) : f.ctx.moveTo(x, y); } f.ctx.stroke();
    } else {
      const f = frame(canvas, s.frequency[0], s.frequency.at(-1) + s.binWidth, s.frames.length, 0, s.frequencyUnit, 'FFT frame ordinal (not continuous UTC)'), width = Math.max(1, Math.min(512, Math.floor(f.right - f.left))), height = Math.max(1, Math.min(192, Math.floor(f.bottom - f.top)));
      const levels = new Float64Array(width * height), image = new ImageData(width, height);
      for (let row = 0; row < s.frames.length; row++) for (let bin = 0; bin < s.fftSize; bin++) { const pixel = Math.floor(row * height / s.frames.length) * width + Math.floor(bin * width / s.fftSize); levels[pixel] = Math.max(levels[pixel], s.power[row * s.fftSize + bin]); }
      levels.forEach((power, i) => { const t = Math.max(0, Math.min(1, (db(power) - floor) / Math.max(1, maximum - floor))), at = i * 4; image.data[at] = Math.round(12 + 230 * t ** 2); image.data[at + 1] = Math.round(18 + 220 * t); image.data[at + 2] = Math.round(42 + 145 * Math.sin(Math.PI * t)); image.data[at + 3] = 255; });
      const offscreen = document.createElement('canvas'); offscreen.width = width; offscreen.height = height; offscreen.getContext('2d').putImageData(image, 0, 0); f.ctx.imageSmoothingEnabled = false; f.ctx.drawImage(offscreen, f.left, f.top, f.right - f.left, f.bottom - f.top);
      $('#rf-color-min').textContent = number(floor) + ' dB'; $('#rf-color-max').textContent = number(maximum) + ' dB';
      $('#rf-color-gradient').style.backgroundImage = 'linear-gradient(to right,' + Array.from({ length: 17 }, (_, i) => { const t = i / 16; return 'rgb(' + [Math.round(12 + 230 * t ** 2), Math.round(18 + 220 * t), Math.round(42 + 145 * Math.sin(Math.PI * t))].join(',') + ')'; }).join(',') + ')';
    }
    $('#rf-result-note').textContent = s.frames.length + ' 个完整窗 × ' + s.fftSize + ' bins · ' + s.window + ' · 覆盖 ' + s.coveredSamples + ' 样本，明确略去 ' + s.omittedSamples + ' 个不足窗 / 尾样本 · ENBW=' + number(s.enbw) + ' ' + s.frequencyUnit + ' · 峰 ' + number(s.peak.frequency) + ' ' + s.frequencyUnit + '。绘图桶取峰值，显示动态范围 100 dB；报告保留线性 PSD 和完整矩阵。'; binText();
  }
  function binText() {
    if (!result?.spectrum) return; const s = result.spectrum; selectedBin = Math.max(0, Math.min(s.fftSize - 1, selectedBin)); selectedFrame = Math.max(0, Math.min(s.frames.length - 1, selectedFrame));
    const power = result.kind === 'spectrogram' ? s.power[selectedFrame * s.fftSize + selectedBin] : s.mean[selectedBin];
    $('#rf-bin').textContent = 'bin ' + selectedBin + ': ' + number(s.frequency[selectedBin]) + ' ' + s.frequencyUnit + ' · PSD ' + number(power) + ' ' + s.powerUnit + (result.kind === 'spectrogram' ? ' · frame ' + selectedFrame + ' / 起点 n=' + s.frames[selectedFrame] : ' · Welch 均值');
  }
  function renderTable() {
    const body = $('#rf-table'); body.replaceChildren(); if (!data) { $('#rf-page').textContent = '0 项'; buttons(); return; }
    const count = range[1] - range[0], pages = Math.ceil(count / PAGE); page = Math.max(0, Math.min(pages - 1, page)); const fragment = document.createDocumentFragment();
    for (let i = range[0] + page * PAGE; i < Math.min(range[1], range[0] + (page + 1) * PAGE); i++) {
      const re = data.samples[2 * i], im = data.samples[2 * i + 1], capture = data.captures.find(item => item.start <= i && i < item.end), row = document.createElement('tr'); row.dataset.sample = i;
      [i + ' / ' + (data.info.offset + i), String(capture.byteStart + (i - capture.start) * data.info.stride), String(re), String(im), String(Math.hypot(re, im)), String(Math.atan2(im, re))].forEach((value, column) => { const cell = document.createElement('td'); if (!column) { const button = document.createElement('button'); button.dataset.sample = i; button.textContent = value; cell.append(button); } else cell.textContent = value; row.append(cell); }); fragment.append(row);
    }
    body.append(fragment); $('#rf-page').textContent = count + ' 项 · ' + (page + 1) + ' / ' + pages; buttons(); cursorText();
  }

  listen('rf-open', choose); listen('rf-import', () => $('#rf-local-files').click()); listen('rf-local-files', localFiles, 'change');
  listen('rf-example', () => {
    const bytes = new Uint8Array(4096 * 8), view = new DataView(bytes.buffer); for (let i = 0; i < 4096; i++) { const a = 2 * Math.PI * i * 192 / 4096, b = -2 * Math.PI * i * 384 / 4096; view.setFloat32(i * 8, Math.cos(a) + .35 * Math.cos(b), true); view.setFloat32(i * 8 + 4, Math.sin(a) + .35 * Math.sin(b), true); }
    const metadata = new TextEncoder().encode(pretty({ global: { 'core:datatype': 'cf32_le', 'core:sample_rate': 4096, 'core:version': '1.2.6', 'core:description': 'Two synthetic complex tones at +192 Hz and -384 Hz. Not a campaign fixture.' }, captures: [{ 'core:sample_start': 0, 'core:frequency': 915000000 }], annotations: [] })); return loadPair({ metadata, bytes, name: 'complex-two-tone.sigmf-meta' });
  });
  listen('rf-restore', () => original && loadPair(original, false)); listen('rf-save-pair', savePair); listen('rf-save-report', saveReport); listen('rf-save-csv', saveCsv);
  listen('rf-apply-range', () => applyRange()); listen('rf-fit', () => data && applyRange(0, data.info.count)); listen('rf-zoom-in', () => zoom(.5)); listen('rf-zoom-out', () => zoom(2));
  listen('rf-segment', () => { if (!data) return; const value = $('#rf-segment').value; const capture = value === 'all' ? { start: 0, end: data.info.count } : data.captures[Number(value)]; applyRange(capture.start, capture.end); }, 'change');
  for (const key of ['from', 'to']) listen('rf-' + key, () => invalidate('选区尚未应用；运行前会验证边界'), 'input');
  listen('rf-kind', mode, 'change'); for (const key of ['fft', 'overlap', 'taper', 'stride', 'phase', 'shift', 'decimation', 'conjugate', 'center']) listen('rf-' + key, () => invalidate('参数已改变，请重新运行'), ['stride', 'phase', 'shift'].includes(key) ? 'input' : 'change');
  listen('rf-run', analyze); listen('rf-transform', transform); listen('rf-stop', () => { const previous = document.activeElement; invalidate('已停止；未产生部分数据'); restoreFocus(previous); });
  listen('rf-prev', () => { page--; renderTable(); if ($('#rf-prev').disabled) $('#rf-next').focus(); }); listen('rf-next', () => { page++; renderTable(); if ($('#rf-next').disabled) $('#rf-prev').focus(); });
  $('#rf-table').addEventListener('click', event => { const button = event.target.closest('button[data-sample]'); if (!button || !data) return; cursors[event.shiftKey ? 1 : 0] = Number(button.dataset.sample); requestDraw(); });
  const wave = $('#rf-wave');
  wave.addEventListener('click', event => { if (!data) return; const rect = wave.getBoundingClientRect(), ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - 58) / Math.max(1, rect.width - 73))); cursors[event.shiftKey ? 1 : 0] = Math.round(range[0] + ratio * (range[1] - range[0] - 1)); wave.focus(); requestDraw(); });
  wave.addEventListener('keydown', event => {
    if (!data || busy || event.isComposing) return;
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const direction = event.key === 'ArrowLeft' ? -1 : 1; if (event.ctrlKey || event.metaKey) pan(direction); else { const which = event.shiftKey ? 1 : 0; cursors[which] = Math.max(range[0], Math.min(range[1] - 1, cursors[which] + direction)); requestDraw(); } }
    else if (['+', '=', '-', 'Home'].includes(event.key)) { event.preventDefault(); event.key === 'Home' ? applyRange(0, data.info.count) : zoom(event.key === '-' ? 2 : .5); }
  });
  const plot = $('#rf-result');
  plot.addEventListener('click', event => { if (!result?.spectrum) return; const rect = plot.getBoundingClientRect(), s = result.spectrum; selectedBin = Math.min(s.fftSize - 1, Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left - 58) / Math.max(1, rect.width - 73))) * s.fftSize)); selectedFrame = Math.floor(Math.max(0, Math.min(.9999, (event.clientY - rect.top - 24) / Math.max(1, rect.height - 54))) * s.frames.length); plot.focus(); binText(); });
  plot.addEventListener('keydown', event => { if (!result?.spectrum || event.ctrlKey || event.metaKey) return; if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); selectedBin += event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0; selectedFrame += event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0; binText(); } });
  $('#rf-window').addEventListener('keydown', event => { if (event.isComposing || event.target.closest('dialog')) return; if (shortcut(event, 'Enter')) { event.preventDefault(); void analyze().catch(error => status(error.message)); } else if (shortcut(event, 's')) { event.preventDefault(); void saveReport().catch(error => status(error.message)); } });
  menubar($('#rf-menubar'), { '文件': [{ label: '打开 SigMF…', action: choose }, { label: '保存当前文件对…', action: () => $('#rf-save-pair').click() }, { label: '完整选区 CSV…', action: () => $('#rf-save-csv').click() }], '分析': [{ label: '分析选区', action: () => $('#rf-run').click() }, { label: '停止', action: () => $('#rf-stop').click() }] });
  const observer = new ResizeObserver(requestDraw); observer.observe(wave); observer.observe(plot); $('#rf-window').addEventListener('window:open', requestDraw); $('#rf-window').addEventListener('window:close', () => { if (busy) invalidate('已停止'); });
  window.addEventListener('pagehide', () => { task.stop(); observer.disconnect(); if (animation) cancelAnimationFrame(animation); }); mode(); clear();
  return { open, reset() { identity++; invalidate(); clear(); $('#rf-shift').value = '0'; $('#rf-decimation').value = '1'; $('#rf-conjugate').checked = false; $('#rf-center').checked = false; $('#rf-kind').value = 'spectrum'; $('#rf-fft').value = '1024'; $('#rf-overlap').value = '2'; $('#rf-taper').value = 'hann'; $('#rf-stride').value = '1'; $('#rf-phase').value = '0'; mode(); windows.setTitle('rf', 'RF / IQ 工坊'); status('16 MiB · 262144 复数样本 · 20 秒可取消分析 Worker'); } };
}
