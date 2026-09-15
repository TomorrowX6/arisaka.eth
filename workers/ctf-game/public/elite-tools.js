import { $, askText, formatSize, menubar, report, shortcut } from '/ui.js';
import { DOCUMENTS, basename, normalize } from '/filesystem.js';
import { pickFile } from '/files.js';
import { createAnalysisTask } from '/analysis-task.js';
import { hexBytes } from '/data-pipeline.js';
import { STRUCTURE_LIMIT, structureRows } from '/binary-structure.js';

const examples = {
  modular: { modulus: '101', matrix: [['2', '1', '5'], ['1', '-1', '1']], augmented: true },
  crt: { congruences: [['2', '6'], ['5', '9']] },
  lll: { basis: [['1', '1', '1'], ['-1', '0', '2'], ['3', '5', '6']] },
  polynomial: { action: 'multiply', a: '0x57', b: '0x83', modulus: '0x11b' },
};
const notes = {
  modular: 'matrix 为按行的整数矩阵；augmented=true 时最后一列为常数项。返回行变换、特解与零空间。最多 24 × 32；合数模环遇到非单位主元时拒绝，不假装已求解。',
  crt: 'congruences 为 [余数, 模数] 数组。允许不互素模数；返回规范解和最小公倍周期，或首个矛盾位置。最多 64 个同余式。',
  lll: 'basis 为整数行基，最多 10 × 16、系数最多 256 位。使用精确有理数与 δ=3/4，返回幺模变换。LLL 不保证最短向量；不接受线性相关行。',
  polynomial: 'GF(2)[x]：整数第 i 位是 x^i 的系数。action 可为 multiply / inverse / divide / gcd；modulus 为约简多项式。不会假定用户多项式不可约。',
};
const pretty = value => JSON.stringify(value, null, 2) + '\n';

export const eliteLayouts = {
  structure: `<nav id="structure-menubar" class="native-menubar"></nav>
    <div class="native-toolbar"><button id="structure-open" data-icon="document-open">打开二进制…</button><label for="structure-format">格式</label><select id="structure-format"><option value="der">ASN.1 DER</option><option value="cbor">CBOR / 序列</option></select><button id="structure-run" disabled>重新检查</button><button id="structure-stop" disabled>停止</button><span id="structure-source" class="tool-file-label">尚未打开</span></div>
    <details class="structure-manual"><summary>从 Hex 文本检查</summary><div><textarea id="structure-hex" aria-label="结构 Hex 输入" spellcheck="false" maxlength="1048576" placeholder="30 03 02 01 2a"></textarea><button id="structure-parse-hex">检查 Hex</button></div></details>
    <div class="native-toolbar"><label for="structure-filter">筛选节点</label><input id="structure-filter" type="search" placeholder="类型或值…"><button id="structure-expand">展开全部</button><button id="structure-collapse">折叠全部</button><span class="toolbar-spacer"></span><button id="structure-save-report" disabled>保存结构 JSON…</button></div>
    <div class="structure-workspace"><div class="structure-tree-scroll"><table id="structure-tree" class="data-table" role="treegrid" aria-label="二进制结构树"><thead><tr><th>偏移 / Hex</th><th>长度</th><th>类型</th><th>值预览</th></tr></thead><tbody id="structure-nodes"></tbody></table></div><section class="structure-inspector"><h2>选中节点</h2><pre id="structure-detail" tabindex="0" aria-label="结构节点详情">打开文件以查看结构</pre><div class="native-toolbar"><button id="structure-save-node" disabled>保存编码…</button><button id="structure-save-payload" disabled>保存原始负载…</button></div><p class="tool-note">偏移对应原始字节。JSON 保留全部节点，长值仅预览；另存编码 / 负载使用完整字节。不验证证书信任、签名或 ASN.1 schema。</p></section></div>
    <footer class="statusbar"><span id="structure-status" role="status">DER / CBOR · 8 MiB · 20000 节点 · 48 层</span><span class="toolbar-spacer"></span><button id="structure-prev" disabled aria-label="上一页节点">‹</button><span id="structure-page">0 / 0</span><button id="structure-next" disabled aria-label="下一页节点">›</button></footer>`,
  algebra: `<nav id="algebra-menubar" class="native-menubar"></nav><div class="native-toolbar"><label for="algebra-operation">操作</label><select id="algebra-operation"><option value="modular">模线性代数</option><option value="crt">广义 CRT</option><option value="lll">精确 LLL</option><option value="polynomial">二进制多项式</option></select><button id="algebra-example">载入示例</button><button id="algebra-open" data-icon="document-open">打开任务…</button><button id="algebra-save-job" data-icon="document-save">保存任务…</button><span class="toolbar-spacer"></span><button id="algebra-run" class="button primary">运行</button><button id="algebra-stop" disabled>停止</button></div>
    <p id="algebra-notes" class="tool-note"></p><div class="algebra-workspace"><section><h2>输入 JSON <span>大整数使用字符串，不接受代码表达式</span></h2><textarea id="algebra-input" aria-label="离散数学输入" spellcheck="false" maxlength="262144"></textarea></section><section><div class="native-toolbar"><h2>精确结果</h2><span class="toolbar-spacer"></span><button id="algebra-save-result" disabled>保存结果…</button></div><div id="algebra-summary" role="status"></div><textarea id="algebra-output" aria-label="离散数学结果" spellcheck="false" readonly></textarea></section></div>
    <footer class="statusbar"><span id="algebra-status" role="status">Ctrl+Enter 运行 · 独立 Worker · 20 秒上限</span></footer>`,
};

export function createEliteTools(controls) {
  const { fs, windows } = controls; let identityEpoch = 0;
  const listen = (id, handler, type = 'click') => $('#' + id).addEventListener(type, event => { Promise.resolve().then(() => handler(event)).catch(error => { if (error.name !== 'AbortError') report(error); }); });
  const choose = action => {
    const token = identityEpoch;
    return pickFile(fs, path => { if (token === identityEpoch) void Promise.resolve(action(path)).catch(error => { if (error.name !== 'AbortError') report(error); }); }, DOCUMENTS);
  };
  async function save(name, value, current = () => true) {
    const identity = identityEpoch, chosen = await askText('保存到 Documents', name);
    if (!chosen || identity !== identityEpoch || !current()) return;
    const path = await fs.writeFile(normalize(chosen, DOCUMENTS), value, false);
    if (identity === identityEpoch && current()) controls.toast('已保存：' + path);
  }

  function structure() {
    const task = createAnalysisTask(); let epoch = 0, source, sourceName = '', tree, selected, rows = [], page = 0, collapsed = new Set();
    const pageSize = 100;
    const busy = value => { $('#structure-stop').disabled = !value; $('#structure-run').disabled = value || !source; };
    function resetResult() {
      tree = undefined; selected = undefined; rows = []; page = 0; collapsed.clear();
      $('#structure-nodes').replaceChildren(); $('#structure-detail').textContent = '尚未检查'; $('#structure-page').textContent = '0 / 0';
      for (const id of ['save-report', 'save-node', 'save-payload', 'prev', 'next']) $('#structure-' + id).disabled = true;
    }
    function invalidate() { epoch++; task.stop(); busy(false); resetResult(); $('#structure-status').textContent = '源数据或格式已改变，请重新检查'; }
    function select(id, focus = false) {
      const index = rows.findIndex(row => row.node.id === id); if (index < 0) return;
      selected = id; page = Math.floor(index / pageSize); render(focus);
    }
    function render(focus = false) {
      if (!tree) return;
      const query = $('#structure-filter').value.trim().toLowerCase();
      rows = structureRows(tree, query ? new Set() : collapsed).filter(({ node }) => !query || [node.label, node.value].join(' ').toLowerCase().includes(query));
      page = Math.max(0, Math.min(page, Math.ceil(rows.length / pageSize) - 1));
      if (!rows.some(row => row.node.id === selected)) selected = rows[page * pageSize]?.node.id;
      const list = $('#structure-nodes'); list.replaceChildren();
      for (const { node, depth } of rows.slice(page * pageSize, (page + 1) * pageSize)) {
        const row = document.createElement('tr'); row.dataset.node = node.id; row.tabIndex = node.id === selected ? 0 : -1;
        row.setAttribute('role', 'row'); row.setAttribute('aria-level', depth + 1); row.setAttribute('aria-selected', String(node.id === selected));
        if (node.children.length) row.setAttribute('aria-expanded', String(!collapsed.has(node.id) || Boolean(query)));
        for (const [i, value] of ['0x' + node.offset.toString(16), String(node.length), (node.role ? node.role + ' · ' : '') + node.label, node.value].entries()) {
          const cell = document.createElement('td'); cell.setAttribute('role', 'gridcell'); cell.textContent = value;
          if (i === 2) { cell.style.paddingLeft = Math.min(depth, 12) * 12 + 8 + 'px'; if (node.children.length) cell.prepend(document.createTextNode((collapsed.has(node.id) && !query ? '▸ ' : '▾ '))); }
          row.append(cell);
        }
        row.onclick = () => select(node.id, true);
        row.ondblclick = () => { if (node.children.length) { collapsed.has(node.id) ? collapsed.delete(node.id) : collapsed.add(node.id); render(true); } };
        list.append(row);
      }
      $('#structure-prev').disabled = page === 0; $('#structure-next').disabled = (page + 1) * pageSize >= rows.length;
      $('#structure-page').textContent = (rows.length ? page + 1 : 0) + ' / ' + Math.ceil(rows.length / pageSize);
      const node = rows.find(row => row.node.id === selected)?.node;
      $('#structure-save-node').disabled = !node; $('#structure-save-payload').disabled = !node?.payloadLength;
      if (node) {
        const sample = source.subarray(node.offset, Math.min(node.offset + node.length, node.offset + 256));
        const dump = Array.from({ length: Math.ceil(sample.length / 16) }, (_, i) => (node.offset + i * 16).toString(16).padStart(8, '0') + '  ' + Array.from(sample.subarray(i * 16, i * 16 + 16), n => n.toString(16).padStart(2, '0')).join(' ')).join('\n');
        $('#structure-detail').textContent = node.label + '\n偏移：' + node.offset + ' (0x' + node.offset.toString(16) + ')\n编码：' + node.length + ' B\n头：' + node.headerLength + ' B\n原始负载：[' + node.payloadOffset + ', ' + (node.payloadOffset + node.payloadLength) + ')\n\n' + node.value + (node.valueTruncated ? '\n（值已截断预览）' : '') + '\n' + node.warnings.join('\n') + '\n\n' + dump + (node.length > sample.length ? '\n…（仅预览前 256 B）' : '');
      } else $('#structure-detail').textContent = '没有匹配节点';
      if (focus) list.querySelector('[data-node="' + selected + '"]')?.focus();
    }
    async function run() {
      if (!source) return; const token = ++epoch; task.stop(); resetResult(); busy(true); $('#structure-status').textContent = '正在检查…';
      try {
        const result = await task.run({ operation: 'structure', bytes: source, format: $('#structure-format').value }); if (token !== epoch) return;
        tree = result; selected = tree.roots[0].id; $('#structure-save-report').disabled = false;
        const warnings = structureRows(tree).reduce((sum, { node }) => sum + node.warnings.length, 0);
        $('#structure-status').textContent = formatSize(source.length) + ' · ' + tree.nodeCount + ' 节点 · ' + warnings + ' 条说明'; render();
      } catch (error) { if (token === epoch) $('#structure-status').textContent = error.message; }
      finally { if (token === epoch) busy(false); }
    }
    async function open(path) {
      invalidate(); source = undefined; busy(false); windows.open('structure'); const token = epoch, data = await fs.read(path); if (token !== epoch) return;
      if (data.length > STRUCTURE_LIMIT) throw Error('结构文件超过 8 MiB');
      source = data; sourceName = basename(path); $('#structure-format').value = /\.cbor(?:seq)?$/i.test(path) ? 'cbor' : 'der';
      $('#structure-source').textContent = sourceName; $('#structure-filter').value = ''; windows.setTitle('structure', sourceName + ' — 结构检查器'); await run();
    }
    async function saveSelection(payload) {
      const node = rows.find(row => row.node.id === selected)?.node; if (!node) return;
      const token = epoch, start = payload ? node.payloadOffset : node.offset, size = payload ? node.payloadLength : node.length;
      await save('selection-' + start.toString(16) + '.bin', source.slice(start, start + size), () => token === epoch);
    }
    listen('structure-open', () => choose(open)); listen('structure-run', run);
    listen('structure-format', invalidate, 'change');
    listen('structure-parse-hex', async () => { invalidate(); source = undefined; busy(false); source = hexBytes($('#structure-hex').value); sourceName = 'Hex'; $('#structure-source').textContent = 'Hex · ' + formatSize(source.length); windows.setTitle('structure', 'Hex — 结构检查器'); await run(); });
    listen('structure-filter', () => { page = 0; render(); }, 'input');
    listen('structure-expand', () => { collapsed.clear(); render(); });
    listen('structure-collapse', () => { if (tree) { collapsed = new Set(structureRows(tree).map(row => row.node.id)); page = 0; render(); } });
    listen('structure-prev', () => { page--; selected = rows[page * pageSize]?.node.id; render(); });
    listen('structure-next', () => { page++; selected = rows[page * pageSize]?.node.id; render(); });
    listen('structure-save-report', () => { if (!tree) return; const token = epoch; return save('structure.json', pretty({ format: 'arisaka-structure-report-v1', source: sourceName, tree }), () => token === epoch); });
    listen('structure-save-node', () => saveSelection(false)); listen('structure-save-payload', () => saveSelection(true));
    const stop = () => { epoch++; task.stop(); busy(false); $('#structure-status').textContent = '已停止'; };
    listen('structure-stop', stop);
    $('#structure-window').addEventListener('window:close', () => { if (!$('#structure-stop').disabled) stop(); else { epoch++; task.stop(); } });
    window.addEventListener('pagehide', stop);
    $('#structure-tree').addEventListener('keydown', event => {
      const index = rows.findIndex(row => row.node.id === Number(event.target.closest('[data-node]')?.dataset.node)); if (index < 0) return;
      const { node, parent } = rows[index], filtered = Boolean($('#structure-filter').value.trim());
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return; event.preventDefault();
      if (event.key === 'ArrowDown') select(rows[Math.min(rows.length - 1, index + 1)].node.id, true);
      if (event.key === 'ArrowUp') select(rows[Math.max(0, index - 1)].node.id, true);
      if (event.key === 'Home') select(rows[0].node.id, true);
      if (event.key === 'End') select(rows.at(-1).node.id, true);
      if (event.key === 'ArrowRight' && node.children.length) { if (collapsed.has(node.id) && !filtered) { collapsed.delete(node.id); render(true); } else select(node.children[0].id, true); }
      if (event.key === 'ArrowLeft') { if (node.children.length && !collapsed.has(node.id) && !filtered) { collapsed.add(node.id); render(true); } else if (parent) select(parent, true); }
      if (event.key === 'Enter') select(node.id, true);
    });
    $('#structure-window').addEventListener('keydown', event => { if (shortcut(event, 'Enter')) { event.preventDefault(); void run(); } });
    menubar($('#structure-menubar'), { '文件': [{ label: '打开二进制…', action: () => choose(open) }, { label: '保存结构 JSON…', disabled: () => !tree, action: () => $('#structure-save-report').click() }, null, { label: '关闭', action: () => windows.close('structure') }], '视图': [{ label: '展开全部', action: () => $('#structure-expand').click() }, { label: '折叠全部', action: () => $('#structure-collapse').click() }] });
    return { open, reset() { identityEpoch++; invalidate(); source = undefined; sourceName = ''; busy(false); $('#structure-source').textContent = '尚未打开'; $('#structure-hex').value = ''; $('#structure-filter').value = ''; $('#structure-format').value = 'der'; windows.setTitle('structure', '结构检查器'); } };
  }

  function algebra() {
    const task = createAnalysisTask(); let epoch = 0, result;
    const busy = value => { $('#algebra-run').disabled = value; $('#algebra-stop').disabled = !value; };
    function invalidate() { epoch++; task.stop(); result = undefined; busy(false); $('#algebra-output').value = ''; $('#algebra-summary').textContent = ''; $('#algebra-save-result').disabled = true; $('#algebra-status').textContent = '输入已改变，请运行'; }
    const job = () => ({ format: 'arisaka-discrete-job-v1', operation: $('#algebra-operation').value, input: JSON.parse($('#algebra-input').value) });
    function example() { invalidate(); const kind = $('#algebra-operation').value; $('#algebra-input').value = pretty(examples[kind]); $('#algebra-notes').textContent = notes[kind]; }
    async function run() {
      const token = ++epoch; task.stop(); busy(true); result = undefined; $('#algebra-output').value = ''; $('#algebra-summary').textContent = ''; $('#algebra-save-result').disabled = true; $('#algebra-status').textContent = '正在计算…';
      try {
        if ($('#algebra-input').value.length > 262144) throw Error('任务输入超过 256 KiB');
        const input = job(), computed = await task.run({ operation: 'algebra', kind: input.operation, input: input.input }); if (token !== epoch) return;
        result = { format: 'arisaka-discrete-result-v1', job: input, result: computed }; $('#algebra-output').value = pretty(computed); $('#algebra-save-result').disabled = false;
        $('#algebra-summary').textContent = computed.consistent === false ? '约束不一致：无解' : computed.operation === 'lll' ? '完成 · ' + computed.iterations + ' 次迭代 · ' + computed.swaps + ' 次交换'
          : computed.operation === 'modular' ? computed.pivotCount + ' 个单位主元' + (computed.freeColumns ? ' · ' + computed.freeColumns.length + ' 个自由变量' : '')
            : computed.operation === 'crt' ? 'x ≡ ' + computed.value + ' (mod ' + computed.modulus + ')' : computed.value || '多项式除法完成';
        $('#algebra-status').textContent = '已完成 · 结果和变换均使用精确整数 / 有理数';
      } catch (error) { if (token === epoch) $('#algebra-status').textContent = error.message; }
      finally { if (token === epoch) busy(false); }
    }
    async function open(path) {
      invalidate(); windows.open('algebra'); const token = epoch, data = await fs.read(path); if (token !== epoch) return;
      if (data.length > 262144) throw Error('任务文件超过 256 KiB');
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
      if (input.format !== 'arisaka-discrete-job-v1' || !Object.hasOwn(examples, input.operation) || !input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw Error('无效离散数学任务格式');
      $('#algebra-operation').value = input.operation; $('#algebra-input').value = pretty(input.input); $('#algebra-notes').textContent = notes[input.operation];
      $('#algebra-status').textContent = '已载入 ' + basename(path) + ' · Ctrl+Enter 运行';
    }
    listen('algebra-operation', () => { invalidate(); $('#algebra-notes').textContent = notes[$('#algebra-operation').value] + ' 切换操作不会覆盖输入；可点击“载入示例”。'; }, 'change');
    listen('algebra-input', invalidate, 'input'); listen('algebra-example', example); listen('algebra-run', run); listen('algebra-open', () => choose(open));
    listen('algebra-save-job', () => { const token = epoch; return save('discrete-job.json', pretty(job()), () => token === epoch); });
    listen('algebra-save-result', () => { if (!result) return; const token = epoch; return save('discrete-result.json', pretty(result), () => token === epoch); });
    const stop = () => { epoch++; task.stop(); busy(false); $('#algebra-status').textContent = '已停止'; };
    listen('algebra-stop', stop);
    $('#algebra-window').addEventListener('window:close', () => { if (!$('#algebra-stop').disabled) stop(); else { epoch++; task.stop(); } });
    window.addEventListener('pagehide', stop);
    $('#algebra-window').addEventListener('keydown', event => { if (shortcut(event, 'Enter')) { event.preventDefault(); void run(); } else if (shortcut(event, 's')) { event.preventDefault(); $('#algebra-save-job').click(); } });
    menubar($('#algebra-menubar'), { '文件': [{ label: '打开任务…', action: () => choose(open) }, { label: '保存任务…', shortcut: 'Ctrl+S', action: () => $('#algebra-save-job').click() }, { label: '保存结果…', disabled: () => !result, action: () => $('#algebra-save-result').click() }, null, { label: '关闭', action: () => windows.close('algebra') }], '计算': [{ label: '运行', shortcut: 'Ctrl+Enter', action: run }, { label: '停止', action: () => $('#algebra-stop').click() }] });
    example(); return { open, reset() { identityEpoch++; $('#algebra-operation').value = 'modular'; example(); } };
  }
  return { structure: structure(), algebra: algebra() };
}
