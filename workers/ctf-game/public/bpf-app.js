import { $, askText, formatSize, menubar, report, shortcut } from '/ui.js';
import { DOCUMENTS, basename, normalize } from '/filesystem.js';
import { pickFile } from '/files.js';
import { hexBytes } from '/data-pipeline.js';
import { BPF_ELF_LIMIT } from '/bpf-elf.js';
import { BPF_INPUT_LIMIT } from '/bpf-core.js';
import { createBpfSession } from '/bpf-session.js';

export const bpfLayout = `<nav id="bpf-menubar" class="native-menubar"></nav>
  <div class="native-toolbar"><button id="bpf-open" data-icon="document-open">打开程序…</button><button id="bpf-example">校验和示例</button><span id="bpf-source" class="tool-file-label">尚未打开</span><span class="toolbar-spacer"></span><button id="bpf-save-disassembly" disabled>保存反汇编…</button></div>
  <details class="bpf-input-panel"><summary>程序 / 包输入与执行边界</summary><div class="bpf-input-columns"><section><label for="bpf-code-hex">原始指令 Hex（LE，最多 128 KiB）</label><textarea id="bpf-code-hex" spellcheck="false" maxlength="393216" placeholder="b7 00 00 00 2a 00 00 00 95 00 00 00 00 00 00 00"></textarea><button id="bpf-load-hex">载入指令</button></section><section><label for="bpf-packet">XDP 包 Hex（最多 1 MiB）</label><textarea id="bpf-packet" spellcheck="false" maxlength="3145728" placeholder="00 01 02 03"></textarea><button id="bpf-open-packet">从文件载入包…</button><span id="bpf-packet-label"></span></section></div><p>离线解释器，不是 Linux verifier / JIT。没有内核 helpers、网络或宿主内存；r1 指向模拟 xdp_md。原子指令、map FD、CO-RE 与外部符号不执行。包 / 入口修改后必须重置；指令 Hex 点击载入才替换程序。</p></details>
  <div class="native-toolbar bpf-execution"><label for="bpf-entry">入口 PC</label><input id="bpf-entry" value="0" list="bpf-entries" inputmode="numeric" spellcheck="false"><datalist id="bpf-entries"></datalist><button id="bpf-reset" disabled>重置</button><button id="bpf-step" disabled>单步 F10</button><button id="bpf-run" disabled>继续 F8</button><button id="bpf-stop" disabled>停止</button><label for="bpf-budget">单次上限</label><select id="bpf-budget"><option value="1000">1000</option><option value="10000">10000</option><option value="50000" selected>50000</option></select></div>
  <div class="bpf-workspace"><section class="bpf-code-pane"><div class="native-toolbar"><input id="bpf-filter" type="search" aria-label="筛选 BPF 指令" placeholder="符号 / 指令 / section…"><label for="bpf-goto">PC</label><input id="bpf-goto" inputmode="numeric" spellcheck="false"><button id="bpf-goto-button">转到</button><button id="bpf-follow" disabled>跟随分支</button><button id="bpf-breakpoint" disabled>断点 F9</button></div><div class="bpf-code-scroll"><table class="data-table" id="bpf-code" role="grid" aria-label="BPF 反汇编"><thead><tr><th>断点</th><th>PC</th><th>Section + 字节偏移</th><th>指令（已重定位）</th></tr></thead><tbody id="bpf-instructions"></tbody></table></div><pre id="bpf-instruction-detail" tabindex="0" aria-label="BPF 指令详情">选择指令查看原始编码与分支</pre><div class="native-toolbar bpf-pagination"><span id="bpf-breakpoint-count">0 个断点</span><button id="bpf-clear-breakpoints">清空断点</button><span class="toolbar-spacer"></span><button id="bpf-prev" disabled aria-label="上一页指令">‹</button><span id="bpf-page">0 / 0</span><button id="bpf-next" disabled aria-label="下一页指令">›</button></div></section>
  <section class="bpf-state-pane"><h2>寄存器 <span id="bpf-state-label">尚未执行</span></h2><div class="bpf-register-scroll"><table class="data-table" aria-label="BPF 寄存器"><thead><tr><th>寄存器</th><th>uint64 / Hex</th><th>int64 / Decimal</th></tr></thead><tbody id="bpf-registers"></tbody></table></div><div class="native-toolbar"><select id="bpf-memory-region" aria-label="BPF 内存区域"></select><label for="bpf-memory-offset">偏移</label><input id="bpf-memory-offset" value="0" inputmode="numeric" spellcheck="false"><button id="bpf-memory-read" disabled>读取</button><button id="bpf-memory-save" disabled>保存片段…</button></div><pre id="bpf-memory" tabindex="0" aria-label="BPF 内存">未初始化栈字节显示 ??，不会当作零。</pre><details class="bpf-metadata"><summary>ELF 符号 / 重定位 / 支持范围</summary><pre id="bpf-metadata" tabindex="0"></pre></details><div class="native-toolbar"><span class="tool-note">内存每次预览 256 B；报告含全部指令与符号。</span><button id="bpf-save-report" disabled>保存报告…</button></div></section></div>
  <footer class="statusbar"><span id="bpf-status" role="status">ELF64 BPF / 原始指令 · 独立 Worker · 每次最多 50000 条指令</span></footer>`;

const pretty = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? '0x' + item.toString(16) : item, 2) + '\n';
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join(' ');
const parseIndex = text => {
  if (!/^(?:0x[\da-f]+|\d+)$/i.test(text.trim())) throw Error('PC / 偏移必须为十进制或 0x 十六进制非负整数');
  const value = Number(text); if (!Number.isSafeInteger(value)) throw Error('PC / 偏移超出安全范围'); return value;
};

export function createBpfApp(controls) {
  const { fs, windows } = controls;
  let epoch = 0, identity = 0, session, source, sourceName = '', program, snapshot, memory, busy = false, page = 0, selected, rows = [], memoryRequest = 0;
  let symbolNames = new Map(), instructionPcs = new Set(), renderedRows = [];
  const pageSize = 100, breakpoints = new Set();
  const listen = (id, handler, type = 'click') => $('#' + id).addEventListener(type, event => { Promise.resolve().then(() => handler(event)).catch(error => { if (error.name !== 'AbortError') report(error); }); });
  const status = value => { $('#bpf-status').textContent = value; };
  const choose = action => { const token = identity; pickFile(fs, path => { if (token === identity) void action(path).catch(error => { if (error.name !== 'AbortError') report(error); }); }, DOCUMENTS); };
  function restoreFocus(previous) {
    if (previous && $('#bpf-window').classList.contains('focused') && (document.activeElement === document.body || document.activeElement === previous && previous.disabled)) {
      const target = previous.isConnected && !previous.disabled ? previous : $('#bpf-instructions [tabindex="0"]');
      target?.focus({ preventScroll: true });
    }
  }
  function buttons() {
    $('#bpf-reset').disabled = !source || busy; $('#bpf-stop').disabled = !busy;
    $('#bpf-step').disabled = $('#bpf-run').disabled = busy || snapshot?.status !== 'paused';
    $('#bpf-memory-read').disabled = busy || !snapshot;
    $('#bpf-save-report').disabled = !program || busy; $('#bpf-save-disassembly').disabled = !program;
    $('#bpf-memory-save').disabled = busy || !memory?.bytes.length || !memory.initialized.every(n => n === 1);
  }
  function discardExecution(message) {
    epoch++; memoryRequest++; session?.stop(); session = undefined; snapshot = undefined; memory = undefined; busy = false;
    $('#bpf-registers').replaceChildren(); $('#bpf-memory-region').replaceChildren(); $('#bpf-memory').textContent = '未初始化栈字节显示 ??，不会当作零。';
    $('#bpf-state-label').textContent = '待重置'; buttons(); render(); if (message) status(message);
  }
  function discardProgram() {
    discardExecution(); program = undefined; rows = []; selected = undefined; page = 0; breakpoints.clear(); symbolNames.clear(); instructionPcs.clear();
    $('#bpf-instructions').replaceChildren(); $('#bpf-instruction-detail').textContent = '尚未载入程序'; $('#bpf-metadata').textContent = ''; $('#bpf-entries').replaceChildren();
    render(); buttons();
  }
  function select(pc, focus = false, reveal = false) {
    if (reveal) $('#bpf-filter').value = '';
    selected = pc; const index = filtered().findIndex(ins => ins.pc === pc); if (index >= 0) page = Math.floor(index / pageSize); render(focus);
  }
  function filtered() {
    const query = $('#bpf-filter').value.toLowerCase().trim();
    return (program?.instructions || []).filter(ins => !query || [ins.pc, ins.mnemonic, ins.operands, ins.section, symbolNames.get(ins.pc)].join(' ').toLowerCase().includes(query));
  }
  function render(focus = false) {
    rows = filtered(); page = Math.max(0, Math.min(page, Math.ceil(rows.length / pageSize) - 1));
    if (!rows.some(ins => ins.pc === selected)) selected = rows[page * pageSize]?.pc;
    const body = $('#bpf-instructions'), visible = rows.slice(page * pageSize, (page + 1) * pageSize);
    const reuse = body.children.length === visible.length && renderedRows.length === visible.length && visible.every((ins, i) => ins === renderedRows[i]);
    if (!reuse) body.replaceChildren();
    for (const [index, ins] of visible.entries()) {
      const row = reuse ? body.children[index] : document.createElement('tr'); row.dataset.pc = ins.pc; row.tabIndex = ins.pc === selected ? 0 : -1;
      row.setAttribute('role', 'row'); row.setAttribute('aria-selected', String(ins.pc === selected));
      row.classList.toggle('bpf-current', snapshot?.pc === ins.pc); row.classList.toggle('bpf-invalid', Boolean(ins.error));
      if (snapshot?.pc === ins.pc) row.setAttribute('aria-current', 'step'); else row.removeAttribute('aria-current');
      const cell = reuse ? row.firstElementChild : document.createElement('td'), button = reuse ? cell.firstElementChild : document.createElement('button');
      button.type = 'button'; button.tabIndex = -1; button.textContent = breakpoints.has(ins.pc) ? '●' : '○'; button.setAttribute('aria-label', 'PC ' + ins.pc + ' 断点'); button.setAttribute('aria-pressed', String(breakpoints.has(ins.pc)));
      if (reuse) continue;
      button.onclick = event => { event.stopPropagation(); selected = ins.pc; toggleBreakpoint(); }; cell.append(button); row.append(cell);
      for (const text of [String(ins.pc), (ins.section || 'raw') + '+0x' + (ins.sectionOffset ?? ins.offset).toString(16), ins.mnemonic + ' ' + ins.operands]) {
        const cell = document.createElement('td'); cell.setAttribute('role', 'gridcell'); cell.textContent = text; row.append(cell);
      }
      row.onclick = () => select(ins.pc, true); row.ondblclick = () => { if (instructionPcs.has(ins.target)) select(ins.target, true, true); }; body.append(row);
    }
    renderedRows = visible;
    const ins = program?.instructions.find(ins => ins.pc === selected);
    $('#bpf-breakpoint').disabled = !ins; $('#bpf-follow').disabled = !instructionPcs.has(ins?.target);
    $('#bpf-breakpoint').setAttribute('aria-pressed', String(breakpoints.has(selected)));
    $('#bpf-breakpoint-count').textContent = breakpoints.size + ' 个断点';
    $('#bpf-prev').disabled = page === 0; $('#bpf-next').disabled = (page + 1) * pageSize >= rows.length;
    $('#bpf-page').textContent = (rows.length ? page + 1 : 0) + ' / ' + Math.ceil(rows.length / pageSize);
    if (ins) {
      const at = ins.fileOffset ?? ins.offset, labels = (program.symbols || []).filter(symbol => symbol.pc === ins.pc).map(symbol => symbol.name || symbol.sectionName);
      $('#bpf-instruction-detail').textContent = 'PC ' + ins.pc + ' · 文件 0x' + at.toString(16) + ' · ' + ins.size + ' slot(s)' + (labels.length ? '\n' + labels.join(' / ') : '')
        + '\n原始编码：' + hex(source.subarray(at, at + ins.size * 8)) + '\n' + ins.mnemonic + ' ' + ins.operands + (ins.error ? '\n不能执行：' + ins.error : '');
    } else $('#bpf-instruction-detail').textContent = '没有匹配指令';
    if (focus) body.querySelector('[data-pc="' + selected + '"]')?.focus();
  }
  function toggleBreakpoint() { if (selected === undefined) return; breakpoints.has(selected) ? breakpoints.delete(selected) : breakpoints.add(selected); render(true); }
  function showSnapshot(next, follow = true) {
    const old = snapshot, focused = $('#bpf-code').contains(document.activeElement);
    snapshot = next; const body = $('#bpf-registers'); body.replaceChildren();
    if (!next) { buttons(); return; }
    next.registers.forEach((register, index) => {
      const row = document.createElement('tr'); row.dataset.register = index;
      if (old && old.registers[index]?.hex !== register?.hex) row.classList.add('bpf-changed');
      for (const value of ['r' + index, register?.hex ?? '未初始化', register?.signed ?? '—']) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
      body.append(row);
    });
    $('#bpf-state-label').textContent = next.status + ' · PC ' + next.pc + ' · ' + next.steps + ' 步 · ' + next.depth + ' 帧';
    const region = $('#bpf-memory-region').value; $('#bpf-memory-region').replaceChildren();
    for (const item of next.regions) { const option = document.createElement('option'); option.value = item.name; option.textContent = item.name + ' · ' + item.address + ' · ' + item.size + ' B' + (item.writable ? '' : ' RO'); $('#bpf-memory-region').append(option); }
    if (next.regions.some(item => item.name === region)) $('#bpf-memory-region').value = region;
    else { $('#bpf-memory-region').value = next.regions.at(-1).name; $('#bpf-memory-offset').value = next.regions.at(-1).name.startsWith('stack/') ? '256' : '0'; }
    status(next.reason + ' · ' + next.steps + ' instructions');
    if (follow && program.instructions.some(ins => ins.pc === next.pc)) select(next.pc, focused, true); else render(focused); buttons();
  }
  async function readMemory() {
    if (!snapshot || busy || !session) return; const token = epoch, request = ++memoryRequest;
    memory = undefined; buttons();
    try {
      const offset = parseIndex($('#bpf-memory-offset').value), result = await session.send('memory', { name: $('#bpf-memory-region').value, offset, length: 256 });
      if (token !== epoch || request !== memoryRequest) return; memory = result;
      const lines = [];
      for (let i = 0; i < result.bytes.length; i += 16) {
        const slice = result.bytes.subarray(i, i + 16), known = result.initialized.subarray(i, i + 16);
        lines.push((BigInt(result.address) + BigInt(i)).toString(16).padStart(8, '0') + '  ' + Array.from(slice, (n, j) => known[j] ? n.toString(16).padStart(2, '0') : '??').join(' ').padEnd(47)
          + '  ' + Array.from(slice, (n, j) => known[j] && n >= 32 && n < 127 ? String.fromCharCode(n) : known[j] ? '.' : '?').join(''));
      }
      $('#bpf-memory').textContent = lines.join('\n') || '区域末尾 · 0 B'; buttons();
    } catch (error) { if (token === epoch && request === memoryRequest) { $('#bpf-memory').textContent = error.message; buttons(); } }
  }
  async function reset(chooseDefault = false) {
    if (!source) return; const focusOrigin = document.activeElement; discardExecution(); const token = epoch; busy = true; buttons(); status('正在载入离线程序…');
    $('#bpf-source').textContent = sourceName + ' · 正在解析…';
    try {
      const packet = hexBytes($('#bpf-packet').value); if (packet.length > BPF_INPUT_LIMIT) throw Error('包输入超过 1 MiB');
      session = createBpfSession(); const result = await session.send('load', { bytes: source, packet, entry: chooseDefault ? undefined : parseIndex($('#bpf-entry').value) });
      if (token !== epoch) return; program = result.program;
      symbolNames = new Map(); instructionPcs = new Set(program.instructions.map(ins => ins.pc));
      for (const symbol of program.symbols) if (symbol.pc !== undefined) symbolNames.set(symbol.pc, [symbolNames.get(symbol.pc), symbol.name, symbol.sectionName].filter(Boolean).join(' / '));
      if (chooseDefault) $('#bpf-entry').value = String(program.entry);
      $('#bpf-entries').replaceChildren();
      for (const entry of program.entries.slice(0, 512)) { const option = document.createElement('option'); option.value = entry.pc; option.label = entry.name; $('#bpf-entries').append(option); }
      $('#bpf-source').textContent = sourceName + ' · ' + formatSize(source.length) + ' · ' + program.format;
      $('#bpf-packet-label').textContent = formatSize(packet.length);
      $('#bpf-metadata').textContent = program.warnings.join('\n') + '\n\n仅预览前 128 个符号 / 重定位；报告保留全量。入口建议最多 512 项，也可手动指定 PC。\n'
        + pretty({ sections: program.sections, symbols: program.symbols.slice(0, 128), relocations: program.relocations.slice(0, 128) });
      selected = result.snapshot?.pc ?? program.entry; page = Math.max(0, Math.floor(program.instructions.findIndex(ins => ins.pc === selected) / pageSize));
      showSnapshot(result.snapshot); render(); if (result.executionError) status('仅反汇编：' + result.executionError);
    } catch (error) { if (token === epoch) { session?.stop(); session = undefined; $('#bpf-source').textContent = sourceName + ' · 无法载入'; status(error.message); } }
    finally { if (token === epoch) { busy = false; buttons(); restoreFocus(focusOrigin); await readMemory(); } }
  }
  async function execute(operation) {
    if (busy || !session || snapshot?.status !== 'paused') return;
    const token = epoch, focusOrigin = document.activeElement; busy = true; memoryRequest++; memory = undefined; buttons(); status(operation === 'run' ? '执行中…' : '单步…');
    try {
      const result = await session.send(operation, { limit: Number($('#bpf-budget').value), breakpoints: [...breakpoints], skipCurrent: snapshot.reason !== 'ready' });
      if (token !== epoch) return; showSnapshot(result);
    } catch (error) { if (token === epoch) { discardExecution(); status(error.message); } }
    finally { if (token === epoch) { busy = false; buttons(); restoreFocus(focusOrigin); await readMemory(); } }
  }
  async function open(path) {
    discardProgram(); source = undefined; $('#bpf-source').textContent = '正在打开…'; buttons(); windows.open('bpf'); const token = epoch;
    try {
      const bytes = await fs.read(path);
      if (token !== epoch) return; if (bytes.length > BPF_ELF_LIMIT) throw Error('BPF 文件超过 8 MiB');
      source = bytes; sourceName = basename(path); $('#bpf-filter').value = ''; windows.setTitle('bpf', sourceName + ' — eBPF 调试器'); await reset(true);
    } catch (error) {
      if (token === epoch) { $('#bpf-source').textContent = '打开失败'; status(error.message); }
      throw error;
    }
  }
  async function save(name, value) {
    const token = epoch, player = identity, chosen = await askText('保存到 Documents', name);
    if (!chosen || token !== epoch || player !== identity) return;
    const path = await fs.writeFile(normalize(chosen, DOCUMENTS), value, false); if (token === epoch && player === identity) controls.toast('已保存：' + path);
  }
  function example() {
    discardProgram();
    source = hexBytes('61 12 00 00 00 00 00 00 61 13 04 00 00 00 00 00 b4 00 00 00 00 00 00 00 3d 32 04 00 00 00 00 00 71 24 00 00 00 00 00 00 0c 40 00 00 00 00 00 00 07 02 00 00 01 00 00 00 05 00 fb ff 00 00 00 00 95 00 00 00 00 00 00 00');
    sourceName = 'packet-checksum.bpf'; $('#bpf-code-hex').value = hex(source); $('#bpf-packet').value = '01 02 03 04'; $('#bpf-filter').value = '';
    windows.setTitle('bpf', sourceName + ' — eBPF 调试器'); return reset(true);
  }
  listen('bpf-open', () => choose(open)); listen('bpf-example', example);
  listen('bpf-load-hex', async () => {
    discardProgram(); source = undefined; buttons(); source = hexBytes($('#bpf-code-hex').value); sourceName = 'raw.bpf'; $('#bpf-filter').value = '';
    windows.setTitle('bpf', 'raw.bpf — eBPF 调试器'); await reset(true);
  });
  listen('bpf-open-packet', () => choose(async path => {
    discardExecution(); const token = epoch, bytes = await fs.read(path); if (token !== epoch) return;
    if (bytes.length > BPF_INPUT_LIMIT) throw Error('包输入超过 1 MiB'); $('#bpf-packet').value = hex(bytes); $('#bpf-packet-label').textContent = basename(path) + ' · ' + formatSize(bytes.length); status('包输入已载入，请重置');
  }));
  listen('bpf-packet', () => { discardExecution('包输入已改变，请重置'); $('#bpf-packet-label').textContent = ''; }, 'input');
  listen('bpf-entry', () => discardExecution('入口已改变，请重置'), 'input');
  listen('bpf-reset', () => reset()); listen('bpf-step', () => execute('step')); listen('bpf-run', () => execute('run'));
  const stop = () => discardExecution('已停止；保留反汇编与断点，重置后重新执行'); listen('bpf-stop', stop);
  listen('bpf-breakpoint', toggleBreakpoint); listen('bpf-clear-breakpoints', () => { breakpoints.clear(); render(); });
  listen('bpf-follow', () => { const ins = program?.instructions.find(ins => ins.pc === selected); if (ins?.target !== undefined) select(ins.target, true, true); });
  listen('bpf-goto-button', () => { const pc = parseIndex($('#bpf-goto').value); if (!program?.instructions.some(ins => ins.pc === pc)) throw Error('PC 不在指令边界'); select(pc, true, true); });
  listen('bpf-goto', event => { if (event.key === 'Enter') $('#bpf-goto-button').click(); }, 'keydown');
  listen('bpf-filter', () => { page = 0; render(); }, 'input');
  listen('bpf-prev', () => { page--; selected = rows[page * pageSize]?.pc; render(); }); listen('bpf-next', () => { page++; selected = rows[page * pageSize]?.pc; render(); });
  listen('bpf-memory-read', readMemory); listen('bpf-memory-region', () => { memory = undefined; $('#bpf-memory-offset').value = $('#bpf-memory-region').value.startsWith('stack/') ? '256' : '0'; return readMemory(); }, 'change');
  listen('bpf-memory-offset', () => { memoryRequest++; memory = undefined; $('#bpf-memory').textContent = '偏移已改变，请读取'; buttons(); }, 'input');
  listen('bpf-memory-save', () => { if (memory?.bytes.length && memory.initialized.every(n => n === 1)) return save('memory-' + memory.address.slice(2) + '.bin', memory.bytes); });
  listen('bpf-save-disassembly', () => program && save('disassembly.txt', '# ' + sourceName + ' / linked virtual addresses\n' + program.instructions.map(ins => String(ins.pc).padStart(6) + '  ' + (ins.section || 'raw') + '+0x' + (ins.sectionOffset ?? ins.offset).toString(16) + '  ' + ins.mnemonic + ' ' + ins.operands + (ins.error ? '  ! ' + ins.error : '')).join('\n') + '\n'));
  listen('bpf-save-report', () => program && save('bpf-report.json', pretty({ format: 'arisaka-bpf-report-v1', source: sourceName, entry: $('#bpf-entry').value, packetHex: $('#bpf-packet').value, breakpoints: [...breakpoints].sort((a, b) => a - b), snapshot, program })));
  $('#bpf-code').addEventListener('keydown', event => {
    const index = rows.findIndex(ins => ins.pc === Number(event.target.closest('[data-pc]')?.dataset.pc)); if (index < 0) return;
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key)) return; event.preventDefault();
    if (event.key === 'ArrowUp') select(rows[Math.max(0, index - 1)].pc, true);
    if (event.key === 'ArrowDown') select(rows[Math.min(rows.length - 1, index + 1)].pc, true);
    if (event.key === 'Home') select(rows[0].pc, true); if (event.key === 'End') select(rows.at(-1).pc, true);
    if (event.key === ' ') toggleBreakpoint(); if (event.key === 'Enter') $('#bpf-follow').click();
  });
  $('#bpf-window').addEventListener('keydown', event => {
    if (['F8', 'F9', 'F10'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); $('#bpf-' + ({ F8: 'run', F9: 'breakpoint', F10: 'step' }[event.key])).click(); }
    else if (shortcut(event, 'o')) { event.preventDefault(); choose(open); }
  });
  $('#bpf-window').addEventListener('window:close', () => { if (session || busy) stop(); else epoch++; }); window.addEventListener('pagehide', stop);
  menubar($('#bpf-menubar'), { '文件': [{ label: '打开程序…', shortcut: 'Ctrl+O', action: () => choose(open) }, { label: '保存反汇编…', disabled: () => !program, action: () => $('#bpf-save-disassembly').click() }, { label: '保存报告…', disabled: () => !program, action: () => $('#bpf-save-report').click() }, null, { label: '关闭', action: () => windows.close('bpf') }], '调试': [{ label: '单步', shortcut: 'F10', action: () => $('#bpf-step').click() }, { label: '继续', shortcut: 'F8', action: () => $('#bpf-run').click() }, { label: '切换断点', shortcut: 'F9', action: () => $('#bpf-breakpoint').click() }, { label: '重置', action: () => $('#bpf-reset').click() }] });
  buttons(); return { open, reset() { identity++; discardProgram(); source = undefined; sourceName = ''; $('#bpf-source').textContent = '尚未打开'; $('#bpf-code-hex').value = ''; $('#bpf-packet').value = ''; $('#bpf-packet-label').textContent = ''; $('#bpf-entry').value = '0'; $('#bpf-filter').value = ''; $('#bpf-goto').value = ''; buttons(); windows.setTitle('bpf', 'eBPF 调试器'); status('已清空当前玩家的调试会话'); } };
}
