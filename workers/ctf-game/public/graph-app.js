import { $, askText, menubar, report, shortcut } from '/ui.js';
import { DOCUMENTS, basename, normalize } from '/filesystem.js';
import { pickFile } from '/files.js';
import { createAnalysisTask } from '/analysis-task.js';
import { GRAPH_LIMITS, graphDot } from '/graph-data.js';

export const graphLayout = `<nav id="graph-menubar" class="native-menubar"></nav>
  <div class="native-toolbar"><button id="graph-open" data-icon="document-open">打开图…</button><button id="graph-example">控制流示例</button><button id="graph-reload" disabled>重新载入</button><span id="graph-file" class="tool-file-label">尚未打开</span><span class="toolbar-spacer"></span><button id="graph-save-json" disabled>保存图 JSON…</button><button id="graph-save-dot" disabled>导出 DOT…</button></div>
  <details class="graph-paste"><summary>JSON / CSV 输入与格式说明</summary><textarea id="graph-input" aria-label="图 JSON 或 CSV 输入" spellcheck="false" maxlength="1048576" placeholder='{"nodes":["a","b"],"edges":[["a","b",2]]}'></textarea><button id="graph-load-text">载入文本</button><label><input id="graph-csv-directed" type="checkbox" checked>CSV 有向图</label><p>JSON：directed、nodes（字符串或 {id,label}）、edges（[source,target,weight?] 或 {id,source,target,weight}）。CSV 须含 source,target 表头，可加 weight,id；逗号 / 双引号 / CRLF。整数权重超过安全范围须写成十进制字符串。JSON 可保留孤立节点；不支持的扩展字段会报错而非丢弃。编辑文本后须点载入，才替换当前图。</p></details>
  <div class="native-toolbar graph-analysis-controls"><select id="graph-kind" aria-label="图分析类型"><option value="structure">分量 / 拓扑</option><option value="reachability">可达性 / 跳数</option><option value="shortest">精确整数最短路</option><option value="dominators">支配树 / 边界</option></select><label for="graph-source">起点</label><input id="graph-source" list="graph-node-ids" aria-label="起点节点 ID" autocomplete="off"><label for="graph-target">终点</label><input id="graph-target" list="graph-node-ids" aria-label="终点节点 ID" autocomplete="off"><datalist id="graph-node-ids"></datalist><label id="graph-direction-label" hidden>方向<select id="graph-direction"><option value="forward">正向</option><option value="reverse">反向</option><option value="both">忽略方向</option></select></label><label id="graph-frontier-label" hidden><input id="graph-frontier" type="checkbox">计算支配边界</label><span class="toolbar-spacer"></span><button id="graph-run" class="button primary" disabled>运行分析</button><button id="graph-stop" disabled>停止</button><button id="graph-save-report" disabled>保存完整报告…</button></div>
  <div id="graph-summary" role="status">4 MiB · 4096 节点 · 16384 条边 · 权重精确整数</div>
  <div class="graph-main"><section class="graph-scene"><div class="native-toolbar"><select id="graph-scope" aria-label="图形预览范围"><option value="all">全图预览</option><option value="component">选中节点的分量</option><option value="neighbors">一跳邻域</option></select><button id="graph-fit" disabled>全览</button><button id="graph-zoom-in" disabled aria-label="放大图">＋</button><button id="graph-zoom-out" disabled aria-label="缩小图">−</button><span id="graph-zoom">100%</span><span class="toolbar-spacer"></span><button id="graph-set-source" disabled>设为起点</button><button id="graph-set-target" disabled>设为终点</button></div><canvas id="graph-canvas" tabindex="0" role="img" aria-label="图关系预览" aria-describedby="graph-help graph-preview-note"></canvas><p id="graph-preview-note" class="tool-note">图形是有界预览；分析与导出使用全图。</p><p id="graph-help" class="tool-note">拖动平移，滚轮 / + − 缩放；← → 按输入顺序选择节点，Shift+方向平移，Home 全览。Enter 设起点，Shift+Enter 设终点；Ctrl+Enter 分析。</p></section><aside class="graph-inspector"><output id="graph-selection" aria-live="polite">未选择节点</output><pre id="graph-node-detail" tabindex="0"></pre><h3>分析结果</h3><pre id="graph-result-text" tabindex="0">打开图后显示连通分量与拓扑信息。</pre></aside></div>
  <div class="native-toolbar graph-table-controls"><select id="graph-table-kind" aria-label="图数据表类型"><option value="nodes">节点</option><option value="edges">边</option></select><input id="graph-filter" type="search" placeholder="按 ID / 标签 / 端点筛选" aria-label="筛选图数据"><label><input id="graph-incident" type="checkbox">仅选中节点关联边</label><span class="toolbar-spacer"></span><button id="graph-prev" disabled aria-label="上一页图数据">‹</button><span id="graph-page">0 项</span><button id="graph-next" disabled aria-label="下一页图数据">›</button></div>
  <div class="graph-table-wrap"><table class="data-table" aria-label="完整图数据分页表"><thead id="graph-table-head"></thead><tbody id="graph-table-body"></tbody></table></div>
  <footer class="statusbar"><span id="graph-status" role="status">离线 Worker · 20 秒上限 · 取消不会返回部分结果</span></footer>`;

const example = {
  directed: true, nodes: ['entry', 'decode', 'fast', 'slow', 'join', 'loop', 'guard', 'exit', { id: 'dead', label: 'unreachable block' }],
  edges: [['entry', 'decode', 1], ['decode', 'fast', 1], ['decode', 'slow', 3], ['fast', 'join', 2], ['slow', 'join', 1], ['join', 'loop', 0], ['loop', 'guard', 1], ['guard', 'loop', 0], ['guard', 'exit', 1]],
};
const pretty = value => JSON.stringify(value, null, 2) + '\n';
const shorten = (text, count = 26) => { const chars = [...text]; return chars.length > count ? chars.slice(0, count - 1).join('') + '…' : text; };
const PREVIEW_NODES = 400, PREVIEW_EDGES = 1500, PAGE = 100;

export function createGraphApp(controls) {
  const { fs, windows } = controls, task = createAnalysisTask();
  let epoch = 0, identity = 0, busy = false, source, sourceName = '', format = 'json', data, result, selected = -1, tablePage = 0;
  let ids = new Map(), visibleNodes = [], visibleEdges = [], drawFrame, needsFit = true, camera = { x: 50, y: 50, scale: 1 }, drag;
  const listen = (id, handler, type = 'click') => $('#' + id).addEventListener(type, event => { Promise.resolve().then(() => handler(event)).catch(error => { if (error.name !== 'AbortError') { status(error.message); report(error); } }); });
  const status = text => { $('#graph-status').textContent = text; };
  function buttons() {
    $('#graph-stop').disabled = !busy; $('#graph-run').disabled = !data || busy; $('#graph-reload').disabled = !source || busy;
    $('#graph-save-json').disabled = !data || busy; $('#graph-save-dot').disabled = !data || busy; $('#graph-save-report').disabled = !result || busy;
    for (const id of ['fit', 'zoom-in', 'zoom-out', 'set-source', 'set-target']) $('#graph-' + id).disabled = selected < 0 || busy;
    const structural = $('#graph-kind').value === 'structure';
    for (const id of ['source', 'target']) $('#graph-' + id).disabled = !data || busy || structural;
    $('#graph-direction').disabled = !data || busy; $('#graph-frontier').disabled = !data || busy;
    $('#graph-incident').disabled = $('#graph-table-kind').value !== 'edges';
  }
  function discard(message) {
    epoch++; task.stop(); busy = false; result = undefined; renderResult(); buttons(); updatePreview(); if (message) status(message);
  }
  function clear() {
    data = undefined; result = undefined; selected = -1; ids = new Map(); visibleNodes = []; visibleEdges = []; tablePage = 0; needsFit = true;
    $('#graph-node-ids').replaceChildren(); $('#graph-summary').textContent = '4 MiB · 4096 节点 · 16384 条边 · 权重精确整数';
    $('#graph-selection').textContent = '未选择节点'; $('#graph-node-detail').textContent = ''; renderTable(); renderResult(); buttons(); requestDraw();
  }
  function restoreFocus(previous) {
    if (previous && $('#graph-window').classList.contains('focused') && (document.activeElement === document.body || document.activeElement === previous && previous.disabled)) {
      (previous.isConnected && !previous.disabled ? previous : $('#graph-canvas')).focus({ preventScroll: true });
    }
  }
  async function setSource(bytes, name, defaults = {}) {
    const previous = document.activeElement; discard(); source = undefined; clear(); sourceName = name;
    $('#graph-file').textContent = name + ' · 正在解析…'; windows.setTitle('graph', name + ' — 图分析台');
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > GRAPH_LIMITS.bytes) { $('#graph-file').textContent = name + ' · 载入失败'; throw Error('图文件须为 1 B–4 MiB'); }
    source = bytes;
    format = /\.csv$/i.test(name) ? 'csv' : /\.json$/i.test(name) || /^\s*\{/.test(new TextDecoder().decode(bytes)) ? 'json' : 'csv';
    const token = epoch, options = { format, directed: $('#graph-csv-directed').checked, kind: 'structure' };
    busy = true; buttons(); status('正在解析全图并构建分量布局…');
    try {
      const next = await task.run({ operation: 'graph', bytes: source, options }); if (token !== epoch) return;
      data = next; result = { ...next, sourceName, options }; ids = new Map(data.graph.nodes.map((node, i) => [node.id, i])); selected = data.graph.nodes.length ? 0 : -1;
      $('#graph-kind').value = 'structure'; $('#graph-source').value = defaults.source ?? data.graph.nodes[0]?.id ?? ''; $('#graph-target').value = defaults.target ?? data.graph.nodes.at(-1)?.id ?? '';
      const fragment = document.createDocumentFragment();
      for (const node of data.graph.nodes) { const option = document.createElement('option'); option.value = node.id; option.label = node.label; fragment.append(option); } $('#graph-node-ids').append(fragment);
      $('#graph-file').textContent = name; $('#graph-summary').textContent = summaryText(); tablePage = 0;
      mode(false); updatePreview(); fit(); renderSelection(); renderTable(); renderResult(); status('已载入全图 · ' + (data.graph.directed ? '有向' : '无向') + ' · SHA-256 ' + next.sourceSha256);
    } catch (error) { if (token === epoch && error.name !== 'AbortError') { $('#graph-file').textContent = name + ' · 载入失败'; status(error.message); } }
    finally { if (token === epoch) { busy = false; buttons(); restoreFocus(previous); } }
  }
  async function open(path) {
    discard(); source = undefined; clear(); const token = epoch; windows.open('graph'); $('#graph-file').textContent = '正在打开…';
    try { const bytes = await fs.read(path); if (token === epoch) await setSource(bytes, basename(path)); }
    catch (error) { if (token === epoch) { status(error.message); $('#graph-file').textContent = '打开失败'; } throw error; }
  }
  const choose = () => { const player = identity; pickFile(fs, path => { if (player === identity) void open(path).catch(report); }, DOCUMENTS); };
  async function save(name, bytes) {
    const token = epoch, player = identity, chosen = await askText('保存到 Documents', name);
    if (!chosen || token !== epoch || player !== identity) return;
    const path = await fs.writeFile(normalize(chosen, DOCUMENTS), bytes, false); if (token === epoch && player === identity) controls.toast('已保存：' + path);
  }
  function summaryText() {
    if (!data) return ''; const c = data.summary.counts;
    return (data.graph.directed ? '有向多重图' : '无向多重图') + ' · ' + c.nodes + ' 节点 / ' + c.edges + ' 边 · ' + c.weakComponents + ' 连通分量' + (data.graph.directed ? ' / ' + c.strongComponents + ' SCC' : '') + ' · 自环 ' + c.selfLoops + ' / 额外平行边 ' + c.parallelEdges;
  }
  function mode(invalidate = true) {
    const kind = $('#graph-kind').value;
    $('#graph-direction-label').hidden = kind !== 'reachability'; $('#graph-frontier-label').hidden = kind !== 'dominators';
    if (invalidate) discard('分析参数已改变，请重新运行'); buttons();
  }
  async function analyze() {
    if (!data || busy) return; const previous = document.activeElement;
    discard(); const token = epoch, options = { format, directed: $('#graph-csv-directed').checked, kind: $('#graph-kind').value, source: $('#graph-source').value, target: $('#graph-target').value,
      direction: $('#graph-direction').value, frontier: $('#graph-frontier').checked };
    busy = true; buttons(); status('正在分析全图…');
    try {
      const next = await task.run({ operation: 'graph', bytes: source, options }); if (token !== epoch) return;
      result = { ...next, sourceName, options }; renderResult(); updatePreview(); renderSelection(); status('分析完成 · ' + next.graph.nodes.length + ' 节点 / ' + next.graph.edges.length + ' 边 · 报告保留完整数据与源 SHA-256');
    } catch (error) { if (token === epoch && error.name !== 'AbortError') status(error.message); }
    finally { if (token === epoch) { busy = false; buttons(); restoreFocus(previous); } }
  }
  function renderResult() {
    const output = $('#graph-result-text');
    if (!result) { output.textContent = data ? '参数已改变或任务已停止，请重新运行；旧分析未被保留。' : '打开图后显示连通分量与拓扑信息。'; return; }
    const a = result.analysis, lines = [];
    if (a.kind === 'structure') {
      const top = result.summary.topological;
      lines.push(top.applicable ? top.order ? 'DAG · 拓扑序：\n' + top.order.join(' → ') : '非 DAG · 环见证：\n' + top.cycle.nodes.join(' → ') : '无向图：不报告有向拓扑序或 SCC 环标记。');
      lines.push('分量凝聚图：' + result.summary.condensation.order.length + ' 个节点 / ' + result.summary.condensation.edges.length + ' 条边');
    } else if (a.kind === 'reachability') {
      lines.push(a.direction + ' · 可达 ' + a.reachable.length + ' / 不可达 ' + a.unreachable.length);
      lines.push(a.path ? '最少 ' + a.path.edges.length + ' 跳：\n' + a.path.nodes.join(' → ') : '终点不可达');
    } else if (a.kind === 'shortest') {
      lines.push(a.algorithm + ' · 精确整数');
      lines.push(a.status === 'finite' ? '距离 ' + a.distance + '\n' + a.path.nodes.join(' → ') : a.status === 'unreachable' ? '终点不可达' : '终点受可达负环影响：距离无下界，不存在有限最短路');
      if (a.negativeCycle) lines.push('可达负环：' + a.negativeCycle.nodes.join(' → ') + '\n环权 ' + a.negativeCycle.weight + '；影响 ' + a.affected.length + ' 节点（不连累其他有限路径）');
    } else {
      lines.push(a.algorithm + ' · 可达 ' + a.reachable);
      lines.push(a.chain ? '终点支配链：\n' + a.chain.join(' → ') : '终点不可达；没有支配链');
      lines.push(result.options.frontier ? '完整直接支配者与支配边界见报告 / 节点详情。' : '完整直接支配者见报告；未计算支配边界。');
    }
    const text = lines.join('\n\n'); output.textContent = text.length > 2400 ? text.slice(0, 2400) + '\n…（仅预览；完整报告不截断）' : text;
  }
  function renderSelection() {
    const node = data?.graph.nodes[selected];
    if (!node) { $('#graph-selection').textContent = '未选择节点'; $('#graph-node-detail').textContent = ''; return; }
    const degree = data.summary.degrees[selected], lines = [node.label, data.graph.directed ? '入度 ' + degree.in + ' / 出度 ' + degree.out + ' / SCC ' + degree.component : '度 ' + degree.out + ' / 分量 ' + degree.component];
    $('#graph-selection').textContent = '选中 ' + node.id;
    if (result?.analysis.kind === 'dominators') {
      const row = result.analysis.rows[selected]; lines.push(row.reachable ? '直接支配者：' + (row.immediate ?? '—（起点）') : '起点不可达');
      if (row.frontier) lines.push('支配边界：' + (row.frontier.join(', ') || '∅'));
    } else if (result?.analysis.kind === 'shortest') {
      const row = result.analysis.distances[selected]; lines.push('距离状态：' + row.status + (row.distance === null ? '' : '\n精确距离：' + row.distance));
    }
    const text = lines.join('\n\n'); $('#graph-node-detail').textContent = text.length > 1800 ? text.slice(0, 1800) + '\n…（完整报告不截断）' : text;
    $('#graph-table-body').querySelectorAll('[data-node-row]').forEach(row => { row.classList.toggle('selected', Number(row.dataset.nodeRow) === selected); });
  }
  function selectNode(index, center = false) {
    if (!data || index < 0 || index >= data.graph.nodes.length) return; selected = index; updatePreview(); renderSelection();
    if ($('#graph-incident').checked && $('#graph-table-kind').value === 'edges') { tablePage = 0; renderTable(); }
    if (center) { const p = data.summary.layout.positions[selected], canvas = $('#graph-canvas'); camera.scale = Math.max(.4, camera.scale); camera.x = canvas.clientWidth / 2 - p.x * camera.scale; camera.y = canvas.clientHeight / 2 - p.y * camera.scale; requestDraw(); }
    buttons();
  }
  function setEndpoint(which) { if (selected < 0) return; $('#graph-' + which).value = data.graph.nodes[selected].id; discard((which === 'source' ? '起点' : '终点') + '已更改，请重新分析'); }
  function updatePreview() {
    if (!data) { visibleNodes = []; visibleEdges = []; requestDraw(); return; }
    const scope = $('#graph-scope').value, component = data.summary.degrees[selected]?.component, neighbors = new Set([selected]);
    if (selected >= 0) for (const edge of data.graph.edges) {
      const from = ids.get(edge.source), to = ids.get(edge.target); if (from === selected || to === selected) { neighbors.add(from); neighbors.add(to); }
    }
    const eligible = data.graph.nodes.map((_, i) => i).filter(i => scope === 'all' || scope === 'component' && data.summary.degrees[i].component === component || scope === 'neighbors' && neighbors.has(i));
    const allowed = new Set(eligible), chosen = new Set(), add = i => { if (allowed.has(i) && chosen.size < PREVIEW_NODES) chosen.add(i); };
    add(selected); add(ids.get(result?.analysis.source)); add(ids.get(result?.analysis.target));
    for (const id of result?.analysis.path?.nodes ?? result?.analysis.chain ?? []) add(ids.get(id)); neighbors.forEach(add); eligible.forEach(add); visibleNodes = [...chosen];
    const eligibleEdges = data.graph.edges.map((edge, i) => i).filter(i => chosen.has(ids.get(data.graph.edges[i].source)) && chosen.has(ids.get(data.graph.edges[i].target)));
    const highlights = new Set([...(result?.analysis.path?.edges ?? []), ...(result?.analysis.negativeCycle?.edges ?? [])]);
    visibleEdges = eligibleEdges.toSorted((a, b) => Number(highlights.has(data.graph.edges[b].id)) - Number(highlights.has(data.graph.edges[a].id))).slice(0, PREVIEW_EDGES);
    $('#graph-preview-note').textContent = '预览 ' + visibleNodes.length + ' / ' + eligible.length + ' 节点，' + visibleEdges.length + ' / ' + eligibleEdges.length + ' 条可见端点边。颜色表示' + (data.graph.directed ? ' SCC' : '连通分量') + '；橙色路径，红色负环，紫虚线支配树。分析 / 导出始终为全图。';
    requestDraw();
  }
  function fit() {
    const canvas = $('#graph-canvas'); if (!data || !visibleNodes.length || !canvas.clientWidth) { needsFit = true; return; }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const i of visibleNodes) { const p = data.summary.layout.positions[i]; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const width = canvas.clientWidth, height = canvas.clientHeight; camera.scale = Math.min(2, Math.max(.0001, Math.min((width - 90) / Math.max(90, maxX - minX), (height - 70) / Math.max(68, maxY - minY))));
    camera.x = width / 2 - (minX + maxX) / 2 * camera.scale; camera.y = height / 2 - (minY + maxY) / 2 * camera.scale; needsFit = false; requestDraw();
  }
  function zoom(factor, point) {
    const canvas = $('#graph-canvas'), p = point ?? { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, next = Math.max(.0001, Math.min(8, camera.scale * factor));
    camera.x = p.x - (p.x - camera.x) * next / camera.scale; camera.y = p.y - (p.y - camera.y) * next / camera.scale; camera.scale = next; needsFit = false; requestDraw();
  }
  function requestDraw() { if (!drawFrame) drawFrame = requestAnimationFrame(() => { drawFrame = undefined; draw(); }); }
  function draw() {
    const canvas = $('#graph-canvas'), width = canvas.clientWidth, height = canvas.clientHeight; if (!width || !height) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1, 4096 / width, 2048 / height);
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio); if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const style = getComputedStyle(canvas), color = name => style.getPropertyValue(name).trim(); ctx.fillStyle = color('--bg') || '#232629'; ctx.fillRect(0, 0, width, height);
    $('#graph-zoom').textContent = Number((camera.scale * 100).toPrecision(3)) + '%'; if (!data) return;
    const points = data.summary.layout.positions.map(p => ({ x: p.x * camera.scale + camera.x, y: p.y * camera.scale + camera.y }));
    const path = new Set(result?.analysis.path?.edges ?? []), negative = new Set(result?.analysis.negativeCycle?.edges ?? []), chain = new Set(result?.analysis.chain ?? []), pairs = new Map();
    const radius = Math.max(4, Math.min(18, 12 * camera.scale));
    for (const i of visibleEdges) { const edge = data.graph.edges[i], a = ids.get(edge.source), b = ids.get(edge.target), key = Math.min(a, b) + '/' + Math.max(a, b); if (!pairs.has(key)) pairs.set(key, []); pairs.get(key).push(i); }
    const offsets = new Map(); pairs.forEach(siblings => siblings.forEach((i, rank) => offsets.set(i, Math.max(-90, Math.min(90, (rank - (siblings.length - 1) / 2) * 24)))));
    function arrow(a, b, control, ink, dashed = false) {
      ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = dashed ? 1.4 : 1; ctx.setLineDash(dashed ? [4, 3] : []);
      const targetAngle = Math.atan2(b.y - control.y, b.x - control.x), sourceAngle = Math.atan2(control.y - a.y, control.x - a.x);
      const end = { x: b.x - Math.cos(targetAngle) * (radius + 2), y: b.y - Math.sin(targetAngle) * (radius + 2) };
      ctx.beginPath(); ctx.moveTo(a.x + Math.cos(sourceAngle) * radius, a.y + Math.sin(sourceAngle) * radius); ctx.quadraticCurveTo(control.x, control.y, end.x, end.y); ctx.stroke(); ctx.setLineDash([]);
      if (data.graph.directed || dashed) { ctx.beginPath(); ctx.moveTo(end.x, end.y); ctx.lineTo(end.x - 7 * Math.cos(targetAngle - .45), end.y - 7 * Math.sin(targetAngle - .45)); ctx.lineTo(end.x - 7 * Math.cos(targetAngle + .45), end.y - 7 * Math.sin(targetAngle + .45)); ctx.closePath(); ctx.fill(); }
    }
    for (const i of visibleEdges) {
      const edge = data.graph.edges[i], from = ids.get(edge.source), to = ids.get(edge.target), a = points[from], b = points[to];
      const ink = negative.has(edge.id) ? '#ed6a6a' : path.has(edge.id) ? '#f6a348' : color('--line') || '#66727c';
      if (from === to) {
        ctx.strokeStyle = ink; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(a.x, a.y - radius - 10, 13, 14, 0, .25, Math.PI * 2 - .25); ctx.stroke();
        if (data.graph.directed) { ctx.fillStyle = ink; ctx.beginPath(); ctx.moveTo(a.x + 13, a.y - radius - 6); ctx.lineTo(a.x + 7, a.y - radius - 10); ctx.lineTo(a.x + 15, a.y - radius - 14); ctx.fill(); } continue;
      }
      const offset = offsets.get(i) * (from < to ? 1 : -1);
      const angle = Math.atan2(b.y - a.y, b.x - a.x), control = { x: (a.x + b.x) / 2 - Math.sin(angle) * offset, y: (a.y + b.y) / 2 + Math.cos(angle) * offset };
      arrow(a, b, control, ink);
      if (camera.scale > .6 && visibleEdges.length < 160) { ctx.font = '10px Hack, monospace'; ctx.textAlign = 'center'; ctx.fillStyle = color('--muted') || '#a1a9b1'; ctx.fillText(shorten(edge.weight, 14), (a.x + 2 * control.x + b.x) / 4, (a.y + 2 * control.y + b.y) / 4 - 5); }
    }
    if (result?.analysis.kind === 'dominators') {
      const visible = new Set(visibleNodes);
      for (const row of result.analysis.rows) if (row.immediate !== null) {
        const from = ids.get(row.immediate), to = ids.get(row.id); if (!visible.has(from) || !visible.has(to)) continue;
        arrow(points[from], points[to], { x: (points[from].x + points[to].x) / 2, y: (points[from].y + points[to].y) / 2 - 20 }, '#b58ce6', true);
      }
    }
    for (const i of visibleNodes) {
      const p = points[i], node = data.graph.nodes[i]; if (p.x < -100 || p.x > width + 100 || p.y < -50 || p.y > height + 50) continue;
      ctx.fillStyle = 'hsl(' + data.summary.degrees[i].component * 137.508 % 360 + ' 55% 53%)'; ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
      if (i === selected || chain.has(node.id)) { ctx.strokeStyle = i === selected ? '#f6c655' : '#c7a3f0'; ctx.lineWidth = 2; ctx.stroke(); }
      if (camera.scale >= .25 || i === selected) { ctx.font = '11px Hack, monospace'; ctx.textAlign = 'center'; ctx.fillStyle = color('--ink') || '#eff0f1'; ctx.fillText(shorten(node.id), p.x, p.y + radius + 15); }
    }
  }
  function renderTable() {
    const focused = document.activeElement, focusIndex = focused?.dataset?.selectNode;
    const body = $('#graph-table-body'), head = $('#graph-table-head'), type = $('#graph-table-kind').value, filter = $('#graph-filter').value.toLowerCase(), incident = $('#graph-incident').checked;
    const rows = data ? (type === 'nodes' ? data.graph.nodes : data.graph.edges).map((item, index) => ({ item, index })).filter(({ item }) => {
      if (type === 'edges' && incident && item.source !== data.graph.nodes[selected]?.id && item.target !== data.graph.nodes[selected]?.id) return false;
      return (type === 'nodes' ? item.id + '\n' + item.label : item.id + '\n' + item.source + '\n' + item.target + '\n' + item.weight).toLowerCase().includes(filter);
    }) : [];
    const pages = Math.max(1, Math.ceil(rows.length / PAGE)); tablePage = Math.max(0, Math.min(pages - 1, tablePage));
    head.replaceChildren(); const heading = document.createElement('tr');
    for (const title of type === 'nodes' ? ['ID', '标签', data?.graph.directed ? '入 / 出' : '度', data?.graph.directed ? 'SCC' : '分量'] : ['边 ID', '起点', '终点', '精确权重']) { const th = document.createElement('th'); th.textContent = title; heading.append(th); } head.append(heading);
    const fragment = document.createDocumentFragment();
    for (const { item, index } of rows.slice(tablePage * PAGE, (tablePage + 1) * PAGE)) {
      const row = document.createElement('tr'); if (type === 'nodes') { row.dataset.nodeRow = index; row.classList.toggle('selected', index === selected); }
      const cells = type === 'nodes' ? [item.id, item.label, data.graph.directed ? data.summary.degrees[index].in + ' / ' + data.summary.degrees[index].out : String(data.summary.degrees[index].out), String(data.summary.degrees[index].component)] : [item.id, item.source, item.target, item.weight];
      cells.forEach((value, column) => {
        const cell = document.createElement('td'); cell.title = value;
        if (type === 'nodes' && column === 0 || type === 'edges' && (column === 1 || column === 2)) { const button = document.createElement('button'); button.dataset.selectNode = ids.get(value); button.textContent = value; cell.append(button); }
        else cell.textContent = value; row.append(cell);
      }); fragment.append(row);
    }
    body.replaceChildren(fragment); $('#graph-page').textContent = rows.length + ' 项 · ' + (tablePage + 1) + ' / ' + pages;
    $('#graph-prev').disabled = tablePage === 0; $('#graph-next').disabled = tablePage + 1 === pages; buttons();
    if (focusIndex !== undefined && !focused.isConnected) (body.querySelector('[data-select-node="' + Number(focusIndex) + '"]') ?? $('#graph-canvas')).focus({ preventScroll: true });
    else if (focused === $('#graph-next') && focused.disabled && !$('#graph-prev').disabled) $('#graph-prev').focus({ preventScroll: true });
    else if (focused === $('#graph-prev') && focused.disabled && !$('#graph-next').disabled) $('#graph-next').focus({ preventScroll: true });
  }

  listen('graph-open', choose); listen('graph-example', () => { $('#graph-input').value = pretty(example); return setSource(new TextEncoder().encode($('#graph-input').value), 'control-flow.graph.json', { source: 'entry', target: 'exit' }); });
  listen('graph-load-text', () => setSource(new TextEncoder().encode($('#graph-input').value), /^\s*\{/.test($('#graph-input').value) ? 'input.graph.json' : 'input.edges.csv'));
  listen('graph-reload', () => source && setSource(source, sourceName)); listen('graph-run', analyze); listen('graph-stop', () => discard('已停止'));
  listen('graph-save-json', () => data && save(sourceName.replace(/\.(?:graph\.json|edges\.csv|json|csv)$/i, '') + '.graph.json', pretty(data.graph)));
  listen('graph-save-dot', () => data && save(sourceName + '.dot', graphDot(data.graph)));
  listen('graph-save-report', () => result && save(sourceName + '.analysis.json', pretty(result)));
  listen('graph-kind', () => mode(), 'change');
  for (const id of ['graph-source', 'graph-target']) listen(id, () => discard('分析参数已改变，请重新运行'), 'input');
  for (const id of ['graph-direction', 'graph-frontier']) listen(id, () => discard('分析参数已改变，请重新运行'), 'change');
  listen('graph-csv-directed', () => { if (format === 'csv' && source) return setSource(source, sourceName); }, 'change');
  listen('graph-set-source', () => setEndpoint('source')); listen('graph-set-target', () => setEndpoint('target'));
  listen('graph-fit', fit); listen('graph-zoom-in', () => zoom(1.4)); listen('graph-zoom-out', () => zoom(1 / 1.4));
  listen('graph-scope', () => { updatePreview(); fit(); }, 'change');
  for (const id of ['graph-table-kind', 'graph-incident']) listen(id, () => { tablePage = 0; renderTable(); }, 'change');
  listen('graph-filter', () => { tablePage = 0; renderTable(); }, 'input'); listen('graph-prev', () => { tablePage--; renderTable(); }); listen('graph-next', () => { tablePage++; renderTable(); });
  $('#graph-table-body').addEventListener('click', event => { const button = event.target.closest('[data-select-node]'); if (button) selectNode(Number(button.dataset.selectNode), true); });
  const canvas = $('#graph-canvas'), localPoint = event => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  canvas.addEventListener('pointerdown', event => { if (event.button !== 0 || !data) return; canvas.focus(); canvas.setPointerCapture(event.pointerId); const p = localPoint(event); drag = { id: event.pointerId, start: p, last: p, moved: false }; });
  canvas.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return; const p = localPoint(event);
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4) drag.moved = true;
    if (drag.moved) { camera.x += p.x - drag.last.x; camera.y += p.y - drag.last.y; needsFit = false; requestDraw(); } drag.last = p;
  });
  canvas.addEventListener('pointerup', event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.moved) {
      const p = localPoint(event); let nearest = -1, distance = 22;
      for (const i of visibleNodes) { const point = data.summary.layout.positions[i], d = Math.hypot(point.x * camera.scale + camera.x - p.x, point.y * camera.scale + camera.y - p.y); if (d < distance) { distance = d; nearest = i; } }
      if (nearest >= 0) selectNode(nearest);
    }
    drag = undefined; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointercancel', () => { drag = undefined; }); canvas.addEventListener('lostpointercapture', () => { drag = undefined; });
  canvas.addEventListener('wheel', event => { if (!data) return; event.preventDefault(); zoom(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) / 500), localPoint(event)); }, { passive: false });
  canvas.addEventListener('keydown', event => {
    if (!data || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); camera.x += event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0; camera.y += event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0; requestDraw(); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); if (data.graph.nodes.length) selectNode((selected + (event.key === 'ArrowLeft' ? -1 : 1) + data.graph.nodes.length) % data.graph.nodes.length, true); }
    else if (event.key === 'Home') { event.preventDefault(); fit(); }
    else if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoom(event.key === '-' ? 1 / 1.4 : 1.4); }
    else if (event.key === 'Enter') { event.preventDefault(); setEndpoint(event.shiftKey ? 'target' : 'source'); }
  });
  $('#graph-window').addEventListener('keydown', event => {
    if (event.isComposing || event.target.closest('dialog')) return;
    if (shortcut(event, 'Enter')) { event.preventDefault(); void analyze().catch(report); }
    else if (shortcut(event, 's')) { event.preventDefault(); if (result) void save(sourceName + '.analysis.json', pretty(result)).catch(report); }
  });
  menubar($('#graph-menubar'), { '文件': [{ label: '打开图…', action: choose }, { label: '保存图 JSON…', action: () => $('#graph-save-json').click() }, { label: '导出 DOT…', action: () => $('#graph-save-dot').click() }], '分析': [{ label: '运行全图分析', action: () => void analyze().catch(report) }, { label: '停止', action: () => discard('已停止') }], '视图': [{ label: '全览', action: fit }] });
  const observer = new ResizeObserver(() => { if (needsFit && data) fit(); requestDraw(); }); observer.observe(canvas);
  $('#graph-window').addEventListener('window:open', () => { if (needsFit) fit(); requestDraw(); }); $('#graph-window').addEventListener('window:close', () => { if (busy) discard('已停止'); });
  window.addEventListener('pagehide', () => { task.stop(); observer.disconnect(); if (drawFrame) cancelAnimationFrame(drawFrame); }); mode(false); renderTable();
  return { open, reset() { identity++; discard(); source = undefined; sourceName = ''; clear();
    $('#graph-input').value = ''; $('#graph-source').value = ''; $('#graph-target').value = ''; $('#graph-file').textContent = '尚未打开'; $('#graph-filter').value = '';
    $('#graph-kind').value = 'structure'; $('#graph-scope').value = 'all'; $('#graph-table-kind').value = 'nodes'; $('#graph-incident').checked = false; $('#graph-frontier').checked = false; $('#graph-csv-directed').checked = true;
    mode(false); renderTable(); windows.setTitle('graph', '图分析台'); status('离线 Worker · 20 秒上限 · 取消不会返回部分结果'); } };
}
