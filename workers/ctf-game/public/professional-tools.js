import { $, $$, askText, formatSize, menubar, report, shortcut } from '/ui.js';
import { DOCUMENTS, basename, normalize } from '/filesystem.js';
import { pickFile } from '/files.js';
import { pipelineOperations, validateRecipe, hexBytes, base64Bytes, bytesBase64, PIPELINE_LIMIT } from '/data-pipeline.js';
import { valueAt } from '/logic-data.js';
import { createAnalysisTask as workerTask } from '/analysis-task.js';

export const professionalLayouts = {
  pipeline: `<nav id="pipeline-menubar" class="native-menubar"></nav>
    <div class="native-toolbar"><button id="pipeline-new" data-icon="document-new">文本输入</button><button id="pipeline-open" data-icon="document-open">打开数据…</button><button id="pipeline-load-recipe">载入配方…</button><button id="pipeline-save-recipe" data-icon="document-save">保存配方…</button><span class="toolbar-spacer"></span><button id="pipeline-run" class="button primary">运行</button><button id="pipeline-stop" disabled>停止</button></div>
    <div class="pipeline-workspace"><aside class="pipeline-recipe"><h2>配方</h2><ol id="pipeline-steps"></ol><button id="pipeline-add" data-icon="list-add">添加步骤</button><p class="tool-note">按顺序处理字节；不会自动识别编码或猜测密钥。最多 32 步，每步输出上限 8 MiB。</p></aside>
    <div class="pipeline-panes"><section><div class="native-toolbar"><label for="pipeline-input-format">输入</label><select id="pipeline-input-format"><option>UTF-8</option><option>Hex</option><option>Base64</option></select><span id="pipeline-source" class="tool-file-label">文本</span></div><textarea id="pipeline-input" aria-label="原始数据" spellcheck="false" maxlength="1048576"></textarea></section>
    <section><div class="native-toolbar"><label for="pipeline-output-format">输出显示</label><select id="pipeline-output-format"><option>Hex</option><option>UTF-8</option><option>Base64</option></select><span class="toolbar-spacer"></span><button id="pipeline-save-output" data-icon="document-save-as" disabled>保存完整结果…</button></div><textarea id="pipeline-output" aria-label="处理结果" spellcheck="false" readonly></textarea><div id="pipeline-history" class="tool-note"></div></section></div></div>
    <footer class="statusbar"><span id="pipeline-status" role="status">尚未运行</span></footer>`,
  logic: `<nav id="logic-menubar" class="native-menubar"></nav><div class="native-toolbar"><button id="logic-open" data-icon="document-open">打开 VCD…</button><button id="logic-stop" disabled>停止</button><span class="toolbar-separator"></span><button id="logic-zoom-in" aria-label="放大时间轴">＋</button><button id="logic-zoom-out" aria-label="缩小时间轴">−</button><button id="logic-fit">适合全部</button><label for="logic-start">起点</label><input id="logic-start" value="0" inputmode="numeric" aria-label="时间轴起点"><label for="logic-span">跨度</label><input id="logic-span" value="1" inputmode="numeric" aria-label="时间轴跨度"><button id="logic-go">定位</button></div>
    <div class="logic-workspace"><aside><h2>信号</h2><div id="logic-signals"></div><p class="tool-note">勾选最多 8 路波形。时间字段使用文件的原始 tick，64 位时间戳保持精确。</p></aside><section class="logic-wave-panel"><canvas id="logic-wave" tabindex="0" role="img" aria-label="数字波形；左右方向键平移，加减号缩放，点击设置游标"></canvas><div id="logic-cursor" class="tool-note">打开 VCD 查看波形</div></section></div>
    <form id="logic-spi-form" class="native-toolbar logic-spi"><label>SCLK<select id="logic-clock" aria-label="SPI 时钟"></select></label><label>CS#<select id="logic-select" aria-label="SPI 片选"></select></label><label>MOSI<select id="logic-mosi" aria-label="SPI MOSI"></select></label><label>MISO<select id="logic-miso" aria-label="SPI MISO"></select></label><label>模式<select id="logic-mode" aria-label="SPI 模式"><option>0</option><option>1</option><option>2</option><option>3</option></select></label><label>位序<select id="logic-order" aria-label="SPI 位序"><option value="msb">MSB</option><option value="lsb">LSB</option></select></label><button id="logic-decode" type="submit" disabled>解码 SPI</button><button id="logic-save" type="button" disabled>保存解码…</button></form>
    <div class="logic-results utility-scroll"><table class="data-table"><thead><tr><th>#</th><th>开始 / tick</th><th>位数</th><th>MOSI</th><th>MISO</th><th>状态</th></tr></thead><tbody id="logic-transfers"></tbody></table></div><pre id="logic-detail" tabindex="0" aria-label="选中传输详情"></pre>
    <footer class="statusbar"><span id="logic-status" role="status">尚未载入</span><span class="toolbar-spacer"></span><button id="logic-prev" disabled aria-label="上一页传输">‹</button><span id="logic-page">0 / 0</span><button id="logic-next" disabled aria-label="下一页传输">›</button></footer>`,
};

export function createProfessionalTools(controls) {
  const { fs, windows } = controls;
  const listen = (id, handler, event = 'click') => $('#' + id).addEventListener(event, e => {
    Promise.resolve().then(() => handler(e)).catch(error => { if (error.name !== 'AbortError') report(error); });
  });
  // Close the chooser before a potentially expensive task so Stop and window
  // controls remain reachable. Async errors are shown by the application.
  const choose = action => pickFile(fs, path => { void Promise.resolve(action(path)).catch(error => { if (error.name !== 'AbortError') report(error); }); }, DOCUMENTS);
  async function save(name, bytes) {
    const selected = await askText('保存到 Documents', name);
    if (!selected) return;
    const path = await fs.writeFile(normalize(selected, DOCUMENTS), bytes, false);
    controls.toast('已保存：' + path); return path;
  }

  function pipeline() {
    const task = workerTask(); let epoch = 0, fileBytes, output, history = [], steps = [{ op: 'fromHex', arg: '' }];
    const recipe = () => validateRecipe({ format: 'arisaka-data-recipe-v1', steps });
    function busy(value) { $('#pipeline-run').disabled = value; $('#pipeline-stop').disabled = !value; }
    function invalidate() { epoch++; task.stop(); busy(false); output = undefined; history = []; $('#pipeline-output').value = ''; $('#pipeline-history').textContent = ''; $('#pipeline-save-output').disabled = true; $('#pipeline-status').textContent = '数据或配方已改变，请运行'; }
    function renderSteps() {
      const list = $('#pipeline-steps'); list.replaceChildren();
      for (const [index, step] of steps.entries()) {
        const row = document.createElement('li'), select = document.createElement('select'), arg = document.createElement('input');
        select.setAttribute('aria-label', '第 ' + (index + 1) + ' 步操作');
        for (const [op, label] of pipelineOperations) { const option = new Option(label, op); select.append(option); }
        select.value = step.op;
        const configure = () => { const hint = pipelineOperations.find(([op]) => op === step.op)[2]; arg.placeholder = hint; arg.disabled = !hint; arg.setAttribute('aria-label', '第 ' + (index + 1) + ' 步参数'); };
        select.onchange = () => { step.op = select.value; step.arg = ''; arg.value = ''; configure(); invalidate(); };
        arg.value = step.arg; arg.maxLength = 4096; arg.spellcheck = false; arg.oninput = () => { step.arg = arg.value; invalidate(); }; configure();
        const actions = document.createElement('div'); actions.className = 'pipeline-step-actions';
        for (const [label, title, disabled, action] of [
          ['↑', '上移第 ' + (index + 1) + ' 步', index === 0, () => { [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]]; }],
          ['↓', '下移第 ' + (index + 1) + ' 步', index === steps.length - 1, () => { [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]]; }],
          ['×', '删除第 ' + (index + 1) + ' 步', false, () => steps.splice(index, 1)],
        ]) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.setAttribute('aria-label', title); button.disabled = disabled;
          button.onclick = () => { action(); invalidate(); renderSteps(); $('#pipeline-add').focus(); }; actions.append(button);
        }
        row.append(select, arg, actions); list.append(row);
      }
      $('#pipeline-add').disabled = steps.length >= 32;
    }
    function renderOutput() {
      if (!output) return;
      const format = $('#pipeline-output-format').value, sample = output.subarray(0, 65536);
      $('#pipeline-output').value = format === 'Hex' ? Array.from(sample, byte => byte.toString(16).padStart(2, '0')).join(' ')
        : format === 'Base64' ? bytesBase64(sample) : new TextDecoder().decode(sample);
      $('#pipeline-status').textContent = formatSize(output.length) + ' · ' + history.length + ' 步' + (output.length > sample.length ? ' · 仅预览前 64 KiB，保存包含完整数据' : '') + (format === 'UTF-8' ? ' · 显示模式允许替换无效 UTF-8；保存不改变字节' : '');
    }
    function textInput() { invalidate(); fileBytes = undefined; $('#pipeline-input').readOnly = false; $('#pipeline-input').value = ''; $('#pipeline-input-format').disabled = false; $('#pipeline-source').textContent = '文本'; $('#pipeline-input').focus(); }
    async function open(path) {
      invalidate(); windows.open('pipeline'); const token = epoch, bytes = await fs.read(path); if (token !== epoch) return;
      if (bytes.length > PIPELINE_LIMIT) throw Error('数据超过 8 MiB 限制');
      fileBytes = bytes; $('#pipeline-input').readOnly = true; $('#pipeline-input-format').disabled = true; $('#pipeline-input-format').value = 'Hex';
      $('#pipeline-input').value = Array.from(bytes.subarray(0, 4096), byte => byte.toString(16).padStart(2, '0')).join(' ');
      $('#pipeline-source').textContent = basename(path) + ' · ' + formatSize(bytes.length) + '（只读预览；运算使用完整文件）';
      windows.open('pipeline'); windows.setTitle('pipeline', basename(path) + ' — 数据工坊');
    }
    async function run() {
      const token = ++epoch; task.stop(); busy(true); output = undefined; $('#pipeline-save-output').disabled = true; $('#pipeline-output').value = ''; $('#pipeline-history').textContent = ''; $('#pipeline-status').textContent = '正在处理…';
      try {
        const format = $('#pipeline-input-format').value, text = $('#pipeline-input').value;
        const bytes = fileBytes || (format === 'Hex' ? hexBytes(text) : format === 'Base64' ? base64Bytes(text) : new TextEncoder().encode(text));
        const result = await task.run({ operation: 'pipeline', bytes, recipe: recipe() }); if (token !== epoch) return;
        output = result.bytes; history = result.history; $('#pipeline-save-output').disabled = false;
        $('#pipeline-history').textContent = history.map((step, index) => (index + 1) + '. ' + step.operation + ': ' + step.inputBytes + ' → ' + step.outputBytes + ' B').join('\n'); renderOutput();
      } catch (error) { if (token === epoch) $('#pipeline-status').textContent = error.message; }
      finally { if (token === epoch) busy(false); }
    }
    listen('pipeline-new', textInput); listen('pipeline-open', () => choose(open)); listen('pipeline-add', () => { if (steps.length >= 32) return; steps.push({ op: 'toHex', arg: '' }); invalidate(); renderSteps(); $('#pipeline-steps li:last-child select').focus(); });
    listen('pipeline-load-recipe', () => choose(async path => { invalidate(); const token = epoch; const text = await fs.readText(path); if (token !== epoch) return; if (text.length > 200000) throw Error('配方文件过大'); const next = validateRecipe(JSON.parse(text)); steps = next.steps; invalidate(); renderSteps(); }));
    listen('pipeline-save-recipe', () => save('recipe.json', JSON.stringify(recipe(), null, 2) + '\n'));
    listen('pipeline-save-output', () => output && save('transformed.bin', output));
    listen('pipeline-input', invalidate, 'input'); listen('pipeline-input-format', invalidate, 'change'); listen('pipeline-output-format', renderOutput, 'change'); listen('pipeline-run', run);
    listen('pipeline-stop', () => { epoch++; task.stop(); busy(false); $('#pipeline-status').textContent = '已停止'; });
    $('#pipeline-window').addEventListener('window:close', () => { const working = !$('#pipeline-stop').disabled; epoch++; task.stop(); busy(false); if (working) $('#pipeline-status').textContent = '已停止'; });
    window.addEventListener('pagehide', () => { epoch++; task.stop(); });
    $('#pipeline-window').addEventListener('keydown', event => { if (shortcut(event, 'Enter')) { event.preventDefault(); void run(); } });
    menubar($('#pipeline-menubar'), { '文件': [{ label: '打开数据…', action: () => choose(open) }, { label: '保存配方…', action: () => $('#pipeline-save-recipe').click() }, { label: '保存完整结果…', disabled: () => !output, action: () => $('#pipeline-save-output').click() }, null, { label: '关闭', action: () => windows.close('pipeline') }], '操作': [{ label: '运行', shortcut: 'Ctrl+Enter', action: run }, { label: '停止', action: () => $('#pipeline-stop').click() }] });
    renderSteps();
    return { open, reset() { textInput(); steps = [{ op: 'fromHex', arg: '' }]; renderSteps(); windows.setTitle('pipeline', '数据工坊'); } };
  }

  function logic() {
    const task = workerTask(); let epoch = 0, source = '', path = '', capture, chosen = new Set(), start = 0n, span = 1n, cursor, transfers = [], page = 0, selected = -1, decodedOptions;
    const pageSize = 80;
    function busy(value) { $('#logic-stop').disabled = !value; $('#logic-decode').disabled = value || !capture; }
    function range() {
      const end = capture?.end || 1n; span = span < 1n ? 1n : span > end ? end : span;
      start = start < 0n ? 0n : start + span > end ? end - span : start;
      $('#logic-start').value = String(start); $('#logic-span').value = String(span); draw();
    }
    const signalValue = value => /^[01]+$/.test(value) && value.length > 1 ? '0x' + BigInt('0b' + value).toString(16) : value;
    function draw() {
      const canvas = $('#logic-wave'), width = Math.floor(canvas.getBoundingClientRect().width);
      if (!width) return;
      const signals = capture?.signals.filter(signal => chosen.has(signal.id)) || [], height = Math.max(140, 26 + signals.length * 37), scale = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.min(4096, width * scale); canvas.height = height * scale; canvas.style.height = height + 'px';
      const context = canvas.getContext('2d'); context.scale(canvas.width / width, scale);
      const style = getComputedStyle(document.documentElement), accent = style.getPropertyValue('--accent').trim() || '#3daee9', ink = style.getPropertyValue('--ink').trim() || '#eff0f1';
      const left = Math.min(142, width / 3), area = Math.max(1, width - left - 12); context.font = '11px Hack, monospace'; context.fillStyle = ink;
      for (let i = 0; i <= 4; i++) { const x = left + area * i / 4; context.globalAlpha = 0.5; context.fillText(String(start + span * BigInt(i) / 4n), Math.min(x, width - 50), 13); context.beginPath(); context.moveTo(x, 20); context.lineTo(x, height); context.strokeStyle = ink; context.lineWidth = 0.3; context.stroke(); }
      context.globalAlpha = 1;
      for (const [row, signal] of signals.entries()) {
        const top = 28 + row * 37, high = top + 3, low = top + 23;
        context.fillStyle = ink; context.fillText(signal.name.length > 18 ? '…' + signal.name.slice(-17) : signal.name, 5, top + 14);
        const initial = valueAt(signal, start); let value = initial.value, at = start, index = initial.index + 1;
        const visibleChanges = valueAt(signal, start + span).index - initial.index;
        if (visibleChanges > area * 3) {
          // Aggregate *every* visible transition into pixel buckets. Truncating
          // to the first N edges would misleadingly leave a quiet-looking tail.
          const columns = Math.max(1, Math.ceil(area));
          context.globalAlpha = 0.7;
          for (let pixel = 0; pixel < columns; pixel++) {
            const end = start + span * BigInt(pixel + 1) / BigInt(columns);
            let zero = value.includes('0'), one = value.includes('1'), unknown = /[xz]/.test(value), moved = false;
            while (signal.changes[index]?.time <= end) { value = signal.changes[index++].value; zero ||= value.includes('0'); one ||= value.includes('1'); unknown ||= /[xz]/.test(value); moved = true; }
            const x = left + pixel * area / columns; context.strokeStyle = unknown ? '#fdbc4b' : accent; context.lineWidth = 1; context.beginPath();
            if (zero && one || signal.width > 1 && moved) { context.moveTo(x, high); context.lineTo(x, low); }
            else { const y = unknown ? (high + low) / 2 : one ? high : low; context.moveTo(x, y); context.lineTo(x + area / columns, y); }
            context.stroke();
          }
          context.globalAlpha = 1; context.fillStyle = style.getPropertyValue('--bg').trim() || '#232629'; context.fillRect(left + 3, top + 2, 145, 16); context.fillStyle = ink; context.fillText('密集变化 · 按像素聚合', left + 6, top + 14);
          continue;
        }
        while (at < start + span) {
          const change = signal.changes[index], end = change && change.time < start + span ? change.time : start + span;
          const x = left + Number(at - start) / Number(span) * area, next = left + Number(end - start) / Number(span) * area;
          context.strokeStyle = /^[01]+$/.test(value) ? accent : '#fdbc4b'; context.lineWidth = 1.2; context.beginPath();
          if (signal.width === 1) { const y = value === '1' ? high : value === '0' ? low : (low + high) / 2; context.moveTo(x, y); context.lineTo(next, y); if (change) context.lineTo(next, change.value === '1' ? high : low); }
          else { context.rect(x, high, Math.max(0, next - x), low - high); if (next - x > 40) { context.fillStyle = ink; context.fillText(signalValue(value).slice(0, 24), x + 3, top + 16); } }
          context.stroke(); at = end; if (!change) break; value = change.value; index++;
        }
      }
      if (cursor !== undefined && cursor >= start && cursor <= start + span) { const x = left + Number(cursor - start) / Number(span) * area; context.strokeStyle = '#fdbc4b'; context.lineWidth = 1; context.beginPath(); context.moveTo(x, 18); context.lineTo(x, height); context.stroke(); }
      $('#logic-cursor').textContent = capture ? '单位：' + capture.timescale.magnitude + ' ' + capture.timescale.unit + ' / tick' + (cursor === undefined ? ' · 点击设置游标' : ' · 游标 ' + cursor + '：' + signals.map(signal => signal.name + '=' + signalValue(valueAt(signal, cursor).value)).join('  ')) : '打开 VCD 查看波形';
    }
    function signals() {
      $('#logic-signals').replaceChildren();
      for (const signal of capture?.signals || []) {
        const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span'); label.className = 'setting-check'; input.type = 'checkbox'; input.checked = chosen.has(signal.id); text.textContent = signal.name + ' [' + signal.width + ']'; label.title = [signal.name, ...signal.aliases].join('\n');
        input.onchange = () => { if (input.checked && chosen.size >= 8) { input.checked = false; controls.toast('最多显示 8 路波形'); return; } input.checked ? chosen.add(signal.id) : chosen.delete(signal.id); draw(); }; label.append(input, text); $('#logic-signals').append(label);
      }
      ['clock', 'select', 'mosi', 'miso'].forEach((pin, index) => {
        const select = $('#logic-' + pin); select.replaceChildren();
        for (const signal of capture?.signals.filter(signal => signal.width === 1) || []) select.append(new Option(signal.name, signal.id));
        select.selectedIndex = Math.min(index, select.options.length - 1);
      });
    }
    const hex = bytes => bytes.map(byte => byte === null ? '??' : byte.toString(16).padStart(2, '0')).join(' ');
    function inspect(index) {
      selected = index; const transfer = transfers[index];
      $$('#logic-transfers tr').forEach(row => { row.classList.toggle('selected', Number(row.dataset.index) === index); row.setAttribute('aria-selected', String(Number(row.dataset.index) === index)); });
      $('#logic-detail').textContent = transfer ? '#' + (index + 1) + '  ' + transfer.start + ' → ' + transfer.end + ' tick\nMOSI: ' + hex(transfer.tx.slice(0, 4096)) + '\nMISO: ' + hex(transfer.rx.slice(0, 4096)) + '\n' + (transfer.complete ? '完整传输' : transfer.issues.join('；')) + (transfer.tx.length > 4096 ? '\n详情仅预览前 4096 字节；保存包含全部传输。' : '') : '';
    }
    function rows() {
      const list = $('#logic-transfers'); list.replaceChildren();
      for (let index = page * pageSize; index < Math.min(transfers.length, (page + 1) * pageSize); index++) {
        const value = transfers[index], row = document.createElement('tr'); row.tabIndex = 0; row.dataset.index = String(index);
        for (const text of [index + 1, value.start, value.bits, hex(value.tx.slice(0, 10)), hex(value.rx.slice(0, 10)), value.complete ? '完整' : value.issues.join('；')]) row.insertCell().textContent = String(text);
        row.onclick = () => inspect(index); row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(index); } }; list.append(row);
      }
      $('#logic-page').textContent = transfers.length ? page + 1 + ' / ' + Math.ceil(transfers.length / pageSize) : '0 / 0';
      $('#logic-prev').disabled = page === 0; $('#logic-next').disabled = (page + 1) * pageSize >= transfers.length; inspect(selected);
    }
    function clearDecoded() { transfers = []; decodedOptions = undefined; selected = -1; page = 0; rows(); $('#logic-save').disabled = true; }
    async function open(name) {
      const token = ++epoch; task.stop(); busy(true); windows.open('logic'); $('#logic-status').textContent = '读取 VCD…';
      try {
        const bytes = await fs.read(name); if (token !== epoch) return;
        if (bytes.length > 16 * 1024 * 1024) throw Error('VCD 超过 16 MiB 限制');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), result = await task.run({ operation: 'vcd', source: text }); if (token !== epoch) return;
        path = name; source = text; capture = result; chosen = new Set(result.signals.slice(0, 8).map(signal => signal.id)); start = 0n; span = result.end || 1n; cursor = undefined;
        clearDecoded(); signals(); range(); $('#logic-status').textContent = result.signals.length + ' 路 · ' + result.changes + ' 次变化 · ' + formatSize(bytes.length);
        windows.open('logic'); windows.setTitle('logic', basename(path) + ' — 逻辑分析仪'); requestAnimationFrame(draw);
      } catch (error) { if (token === epoch) $('#logic-status').textContent = error.message; }
      finally { if (token === epoch) busy(false); }
    }
    async function decode(event) {
      event?.preventDefault(); if (!capture) return;
      const token = ++epoch; task.stop(); busy(true); clearDecoded(); $('#logic-status').textContent = '解码 SPI…';
      const options = Object.fromEntries(['clock', 'select', 'mosi', 'miso'].map(pin => [pin, $('#logic-' + pin).value])); options.mode = Number($('#logic-mode').value); options.lsb = $('#logic-order').value === 'lsb';
      try {
        const result = await task.run({ operation: 'spi', source, options }); if (token !== epoch) return;
        transfers = result; decodedOptions = options; $('#logic-save').disabled = !result.length; rows();
        $('#logic-status').textContent = result.length + ' 段 SPI · ' + result.filter(value => !value.complete).length + ' 段不完整/不确定 · 未知数据不会补零';
      } catch (error) { if (token === epoch) $('#logic-status').textContent = error.message; }
      finally { if (token === epoch) busy(false); }
    }
    const zoom = factor => { const center = start + span / 2n; span = factor < 1 ? span / 2n || 1n : span * 2n; start = center - span / 2n; range(); };
    listen('logic-open', () => choose(open)); listen('logic-stop', () => { epoch++; task.stop(); busy(false); $('#logic-status').textContent = '已停止'; });
    listen('logic-fit', () => { start = 0n; span = capture?.end || 1n; range(); }); listen('logic-zoom-in', () => zoom(0.5)); listen('logic-zoom-out', () => zoom(2));
    listen('logic-go', () => { const values = [$('#logic-start').value, $('#logic-span').value]; if (values.some(value => !/^(?:\d{1,19}|0x[\da-f]{1,16})$/i.test(value))) throw Error('请输入非负整数 tick'); start = BigInt(values[0]); span = BigInt(values[1]); range(); });
    listen('logic-prev', () => { page--; rows(); }); listen('logic-next', () => { page++; rows(); }); listen('logic-spi-form', decode, 'submit');
    listen('logic-save', () => decodedOptions && save('spi-capture.json', JSON.stringify({ format: 'arisaka-spi-capture-v1', source: basename(path), timescale: capture.timescale, options: decodedOptions, transfers }, (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n'));
    $$('#logic-spi-form select').forEach(select => select.addEventListener('change', () => { epoch++; task.stop(); busy(false); clearDecoded(); $('#logic-status').textContent = 'SPI 参数已改变，请重新解码'; }));
    $('#logic-wave').addEventListener('click', event => { const bounds = event.currentTarget.getBoundingClientRect(), left = Math.min(142, bounds.width / 3), area = Math.max(1, bounds.width - left - 12); cursor = start + span * BigInt(Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left - left) / area)) * 1000000)) / 1000000n; draw(); });
    $('#logic-wave').addEventListener('keydown', event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); start += (span / 4n || 1n) * (event.key === 'ArrowLeft' ? -1n : 1n); range(); } else if (event.key === '+' || event.key === '-' || event.key === '=') { event.preventDefault(); zoom(event.key === '-' ? 2 : 0.5); } });
    $('#logic-window').addEventListener('window:close', () => { const working = !$('#logic-stop').disabled; epoch++; task.stop(); busy(false); if (working) $('#logic-status').textContent = '已停止'; }); $('#logic-window').addEventListener('window:open', () => requestAnimationFrame(draw));
    const resize = new ResizeObserver(draw); resize.observe($('#logic-wave').parentElement); window.addEventListener('pagehide', () => { resize.disconnect(); task.stop(); });
    menubar($('#logic-menubar'), { '文件': [{ label: '打开 VCD…', action: () => choose(open) }, { label: '保存解码…', disabled: () => !decodedOptions, action: () => $('#logic-save').click() }, null, { label: '关闭', action: () => windows.close('logic') }], '视图': [{ label: '放大时间轴', action: () => zoom(0.5) }, { label: '缩小时间轴', action: () => zoom(2) }, { label: '适合全部', action: () => $('#logic-fit').click() }] });
    return { open, reset() { epoch++; task.stop(); source = ''; path = ''; capture = undefined; chosen.clear(); start = 0n; span = 1n; cursor = undefined; clearDecoded(); signals(); range(); busy(false); $('#logic-status').textContent = '尚未载入'; windows.setTitle('logic', '逻辑分析仪'); } };
  }
  return { pipeline: pipeline(), logic: logic() };
}
