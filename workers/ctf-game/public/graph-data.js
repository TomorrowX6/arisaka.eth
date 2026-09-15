// Offline graph algorithms. IDs and weights never become executable code.
// Integer weights use BigInt internally and decimal strings in every export.
export const GRAPH_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, nodes: 4096, edges: 16384, work: 8000000 });
const integer = /^[+-]?\d+$/;
const fields = (row, allowed) => { const unknown = Object.keys(row).find(name => !allowed.includes(name)); if (unknown !== undefined) throw Error('不支持的图字段：' + unknown + '；未静默丢弃扩展属性'); };
const textId = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw Error('节点 / 边 ID 须为 1–128 字符文本（无控制字符）或安全整数');
  return value;
};
function weight(value = 1) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('边权必须为精确整数；大整数请使用十进制字符串');
  if (!['number', 'string'].includes(typeof value) || !integer.test(String(value)) || String(value).replace(/^[+-]/, '').length > 128) throw Error('边权须为最多 128 位的十进制整数；不接受小数或表达式');
  return BigInt(value).toString();
}

function csvRows(source) {
  const rows = []; let row = [], cell = '', quoted = false, closed = false, began = false;
  function field() { row.push(cell); cell = ''; closed = false; began = false; if (row.length > 4) throw Error('边列表 CSV 最多四列'); }
  function line() { field(); if (row.some(s => s.length)) rows.push(row); row = []; if (rows.length > GRAPH_LIMITS.edges + 1) throw Error('边列表 CSV 超过 16384 条边'); }
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (c === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; }
    else if (c === '"') { if (began || closed) throw Error('CSV 引号必须从字段开头开始'); quoted = true; began = true; }
    else if (c === ',') field();
    else if (c === '\n' || c === '\r') { if (c === '\r' && source[i + 1] === '\n') i++; line(); }
    else { if (closed) throw Error('CSV 结束引号后必须为分隔符或换行'); cell += c; began = true; }
    if (cell.length > 512) throw Error('CSV 单元格超过 512 字符');
  }
  if (quoted) throw Error('CSV 引号未闭合');
  if (began || closed || cell.length || row.length) line();
  if (!rows.length) throw Error('CSV 缺少 source,target 表头');
  return rows;
}

export function parseGraph(input, options = {}) {
  let bytes;
  if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else if (input instanceof Uint8Array) bytes = input;
  else throw Error('图输入应为 UTF-8 文本 / 字节');
  if (!bytes.length || bytes.length > GRAPH_LIMITS.bytes) throw Error('图文件须为 1 B–4 MiB');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  const format = options.format ?? (/^\s*\{/.test(source) ? 'json' : 'csv');
  let raw;
  if (format === 'json') {
    try { raw = JSON.parse(source); } catch { throw Error('图 JSON 无效'); }
  } else if (format === 'csv') {
    if (options.directed !== undefined && typeof options.directed !== 'boolean') throw Error('CSV directed 必须为布尔值');
    const [head, ...rows] = csvRows(source), header = head.map(s => s.trim().toLowerCase());
    if (new Set(header).size !== header.length || header.some(s => !['source', 'target', 'weight', 'id'].includes(s)) || !header.includes('source') || !header.includes('target')) throw Error('CSV 表头为 source,target，可加 weight,id；不接受未知或重复列');
    raw = { directed: options.directed ?? true, edges: rows.map((row, i) => {
      if (row.length !== header.length) throw Error('CSV 第 ' + (i + 2) + ' 行列数不一致');
      return Object.fromEntries(header.map((name, j) => [name, row[j]]));
    }) };
  } else throw Error('图格式应为 json 或 csv');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.edges)) throw Error('图 JSON 需要 edges 数组');
  fields(raw, ['directed', 'nodes', 'edges']);
  if (raw.directed !== undefined && typeof raw.directed !== 'boolean') throw Error('directed 必须为布尔值');
  if (raw.edges.length > GRAPH_LIMITS.edges || raw.nodes !== undefined && (!Array.isArray(raw.nodes) || raw.nodes.length > GRAPH_LIMITS.nodes)) throw Error('图最多 4096 个节点、16384 条边');
  const nodes = [], ids = new Set(), explicit = raw.nodes !== undefined;
  function add(value) {
    const row = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { id: value };
    fields(row, ['id', 'label']);
    const id = textId(row.id), label = row.label ?? id;
    if (typeof label !== 'string' || label.length > 512) throw Error('节点 label 须为最多 512 字符的文本');
    if (ids.has(id)) throw Error('重复节点 ID：' + id);
    if (nodes.length >= GRAPH_LIMITS.nodes) throw Error('图最多 4096 个节点');
    ids.add(id); nodes.push({ id, label });
  }
  if (explicit) raw.nodes.forEach(add);
  const edgeIds = new Set(), edges = raw.edges.map((value, i) => {
    if (Array.isArray(value) && (value.length < 2 || value.length > 3)) throw Error('数组边格式为 [source,target,weight?]');
    const row = Array.isArray(value) ? { source: value[0], target: value[1], weight: value[2] } : value;
    if (!row || typeof row !== 'object') throw Error('边应为对象或二 / 三元组');
    fields(row, ['id', 'source', 'target', 'weight']);
    const source = textId(row.source), target = textId(row.target), id = textId(row.id ?? 'e' + i);
    for (const endpoint of [source, target]) if (!ids.has(endpoint)) {
      if (explicit) throw Error('边引用未声明节点：' + endpoint); add(endpoint);
    }
    if (edgeIds.has(id)) throw Error('重复边 ID：' + id); edgeIds.add(id);
    return { id, source, target, weight: weight(row.weight) };
  });
  return { directed: raw.directed ?? true, nodes, edges };
}

function indexed(graph) {
  const ids = new Map(graph.nodes.map((node, i) => [node.id, i])), forward = graph.nodes.map(() => []), reverse = graph.nodes.map(() => []), arcs = [];
  const append = (from, to, edge) => { const arc = { from, to, edge, weight: BigInt(graph.edges[edge].weight) }; forward[from].push(arc); reverse[to].push(arc); arcs.push(arc); };
  graph.edges.forEach((edge, i) => { const from = ids.get(edge.source), to = ids.get(edge.target); append(from, to, i); if (!graph.directed) append(to, from, i); });
  return { ids, forward, reverse, arcs };
}

class Heap {
  constructor(less) { this.items = []; this.less = less; }
  push(value) {
    const a = this.items; a.push(value); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >>> 1; if (!this.less(value, a[p])) break; a[i] = a[p]; i = p; } a[i] = value;
  }
  pop() {
    const a = this.items, first = a[0], value = a.pop(); if (!a.length) return first;
    let i = 0;
    while (i * 2 + 1 < a.length) { let child = i * 2 + 1; if (child + 1 < a.length && this.less(a[child + 1], a[child])) child++; if (!this.less(a[child], value)) break; a[i] = a[child]; i = child; } a[i] = value; return first;
  }
  get length() { return this.items.length; }
}

function topo(adjacency) {
  const degrees = new Uint32Array(adjacency.length), queue = new Heap((a, b) => a < b), order = [];
  adjacency.forEach(row => row.forEach(to => degrees[to]++));
  degrees.forEach((n, i) => { if (!n) queue.push(i); });
  while (queue.length) { const node = queue.pop(); order.push(node); for (const to of adjacency[node]) if (!--degrees[to]) queue.push(to); }
  return order.length === adjacency.length ? order : null;
}

function reach(index, source, direction = 'forward') {
  if (!['forward', 'reverse', 'both'].includes(direction)) throw Error('遍历方向应为 forward / reverse / both');
  const distance = new Int32Array(index.forward.length).fill(-1), previous = new Int32Array(distance.length).fill(-1), edges = new Int32Array(distance.length).fill(-1), order = [source];
  distance[source] = 0;
  for (let q = 0; q < order.length; q++) {
    const node = order[q], visit = (next, edge) => { if (distance[next] >= 0) return; distance[next] = distance[node] + 1; previous[next] = node; edges[next] = edge; order.push(next); };
    if (direction !== 'reverse') index.forward[node].forEach(arc => visit(arc.to, arc.edge));
    if (direction !== 'forward') index.reverse[node].forEach(arc => visit(arc.from, arc.edge));
  }
  return { order, distance, previous, edges };
}

function components(graph, index) {
  const visited = new Uint8Array(graph.nodes.length), order = [];
  for (let root = 0; root < visited.length; root++) if (!visited[root]) {
    visited[root] = 1; const stack = [[root, 0]];
    while (stack.length) {
      const frame = stack[stack.length - 1], row = index.forward[frame[0]];
      if (frame[1] < row.length) { const to = row[frame[1]++].to; if (!visited[to]) { visited[to] = 1; stack.push([to, 0]); } }
      else { order.push(frame[0]); stack.pop(); }
    }
  }
  visited.fill(0); const groups = [];
  for (const root of order.toReversed()) if (!visited[root]) {
    const group = [], stack = [root]; visited[root] = 1;
    while (stack.length) { const node = stack.pop(); group.push(node); for (const { from } of index.reverse[node]) if (!visited[from]) { visited[from] = 1; stack.push(from); } }
    groups.push(group.sort((a, b) => a - b));
  }
  groups.sort((a, b) => a[0] - b[0]); const component = new Int32Array(graph.nodes.length);
  groups.forEach((group, i) => group.forEach(node => component[node] = i));
  const condensation = groups.map(() => new Set());
  for (const arc of index.arcs) if (component[arc.from] !== component[arc.to]) condensation[component[arc.from]].add(component[arc.to]);
  return { groups, component, condensation: condensation.map(row => [...row].sort((a, b) => a - b)) };
}

function cycleWitness(graph, index, component, group) {
  if (!group) return null;
  const color = new Uint8Array(graph.nodes.length), parent = new Int32Array(color.length).fill(-1), parentEdge = new Int32Array(color.length).fill(-1);
  const root = group[0], stack = [[root, 0]]; color[root] = 1;
  while (stack.length) {
    const frame = stack.at(-1), node = frame[0], row = index.forward[node];
    if (frame[1] >= row.length) { color[node] = 2; stack.pop(); continue; }
    const arc = row[frame[1]++]; if (component[arc.to] !== component[root]) continue;
    if (color[arc.to] === 1) {
      const nodes = [node], edges = [arc.edge]; let at = node;
      while (at !== arc.to) { edges.push(parentEdge[at]); at = parent[at]; nodes.push(at); }
      nodes.reverse(); nodes.push(arc.to); edges.reverse();
      return { nodes: nodes.map(i => graph.nodes[i].id), edges: edges.map(i => graph.edges[i].id) };
    }
    if (!color[arc.to]) { color[arc.to] = 1; parent[arc.to] = node; parentEdge[arc.to] = arc.edge; stack.push([arc.to, 0]); }
  }
  return null;
}

function structure(graph, index) {
  const scc = components(graph, index), weak = [], seen = new Uint8Array(graph.nodes.length);
  for (let root = 0; root < seen.length; root++) if (!seen[root]) {
    const members = [root]; seen[root] = 1;
    for (let q = 0; q < members.length; q++) {
      const add = n => { if (!seen[n]) { seen[n] = 1; members.push(n); } };
      index.forward[members[q]].forEach(arc => add(arc.to)); index.reverse[members[q]].forEach(arc => add(arc.from));
    }
    weak.push(members.sort((a, b) => a - b).map(i => graph.nodes[i].id));
  }
  const cyclic = scc.groups.map(group => group.length > 1 || index.forward[group[0]].some(arc => arc.to === group[0]));
  const order = graph.directed ? topo(index.forward.map(row => row.map(arc => arc.to))) : null, condensedOrder = topo(scc.condensation);
  const level = new Int32Array(scc.groups.length);
  condensedOrder.forEach(node => scc.condensation[node].forEach(to => level[to] = Math.max(level[to], level[node] + 1)));
  const columns = new Map();
  scc.groups.forEach((group, i) => { if (!columns.has(level[i])) columns.set(level[i], []); columns.get(level[i]).push(i); });
  const positions = Array(graph.nodes.length); let x = 0;
  for (let layer = 0; layer < columns.size; layer++) {
    let y = 0, width = 0;
    for (const c of columns.get(layer)) {
      const group = scc.groups[c], cols = Math.ceil(Math.sqrt(group.length));
      group.forEach((node, i) => { positions[node] = { id: graph.nodes[node].id, x: x + (i % cols) * 90, y: y + Math.floor(i / cols) * 68, component: c, layer }; });
      y += Math.ceil(group.length / cols) * 68 + 46; width = Math.max(width, cols * 90);
    }
    x += width + 120;
  }
  const pairs = new Set(); let loops = 0, parallelEdges = 0;
  graph.edges.forEach(edge => {
    let a = index.ids.get(edge.source), b = index.ids.get(edge.target); if (a === b) loops++;
    if (!graph.directed && a > b) [a, b] = [b, a]; const key = a + '/' + b; if (pairs.has(key)) parallelEdges++; pairs.add(key);
  });
  return {
    counts: { nodes: graph.nodes.length, edges: graph.edges.length, selfLoops: loops, parallelEdges, weakComponents: weak.length, strongComponents: scc.groups.length },
    degrees: graph.nodes.map((node, i) => ({ id: node.id, in: index.reverse[i].length, out: index.forward[i].length, component: scc.component[i] })),
    weakComponents: weak,
    strongComponents: scc.groups.map((group, i) => ({ id: i, nodes: group.map(n => graph.nodes[n].id), cyclic: graph.directed ? cyclic[i] : null })),
    condensation: { edges: scc.condensation.flatMap((row, source) => row.map(target => ({ source, target }))), order: condensedOrder, levels: [...level] },
    topological: { applicable: graph.directed, order: order?.map(n => graph.nodes[n].id) ?? null, cycle: graph.directed ? cycleWitness(graph, index, scc.component, scc.groups.find((_, i) => cyclic[i])) : null },
    layout: { algorithm: 'SCC condensation layers + deterministic component grids', positions },
  };
}

function requireNode(index, id, label) {
  if (typeof id !== 'string' || !index.ids.has(id)) throw Error(label + '不是图中节点 ID'); return index.ids.get(id);
}
function pathTo(graph, source, target, previous, previousEdge) {
  const nodes = [], edges = []; let at = target;
  while (at !== source) {
    if (at < 0 || nodes.length >= graph.nodes.length) throw Error('路径前驱不一致');
    nodes.push(at); edges.push(previousEdge[at]); at = previous[at];
  }
  nodes.push(source); nodes.reverse(); edges.reverse();
  return { nodes: nodes.map(i => graph.nodes[i].id), edges: edges.map(i => graph.edges[i].id) };
}

function shortest(graph, index, source, target, summary) {
  const count = graph.nodes.length, distance = Array(count).fill(null), previous = new Int32Array(count).fill(-1), previousEdge = new Int32Array(count).fill(-1), affected = new Uint8Array(count);
  distance[source] = 0n; let algorithm, negativeCycle = null;
  const relax = arc => {
    if (distance[arc.from] === null) return false;
    const candidate = distance[arc.from] + arc.weight;
    if (distance[arc.to] !== null && candidate >= distance[arc.to]) return false;
    distance[arc.to] = candidate; previous[arc.to] = arc.from; previousEdge[arc.to] = arc.edge; return true;
  };
  if (summary.topological.order) {
    algorithm = 'DAG'; summary.topological.order.forEach(id => index.forward[index.ids.get(id)].forEach(relax));
  } else if (index.arcs.every(arc => arc.weight >= 0n)) {
    algorithm = 'Dijkstra'; const queue = new Heap((a, b) => a.distance < b.distance || a.distance === b.distance && a.node < b.node); queue.push({ node: source, distance: 0n });
    while (queue.length) {
      const item = queue.pop(); if (item.distance !== distance[item.node]) continue;
      for (const arc of index.forward[item.node]) if (relax(arc)) queue.push({ node: arc.to, distance: distance[arc.to] });
    }
  } else {
    algorithm = 'Bellman–Ford'; const reachable = reach(index, source), arcs = index.arcs.filter(arc => reachable.distance[arc.from] >= 0);
    if (reachable.order.length * arcs.length > GRAPH_LIMITS.work) throw Error('负权循环图超过 800 万次松弛预算；未返回不完整最短路');
    for (let pass = 0; pass < reachable.order.length - 1; pass++) { let changed = false; for (const arc of arcs) if (relax(arc)) changed = true; if (!changed) break; }
    const seeds = [];
    for (const arc of arcs) if (relax(arc)) seeds.push(arc.to);
    if (seeds.length) {
      let node = seeds.at(-1);
      for (let i = 0; i < reachable.order.length; i++) node = previous[node];
      const nodes = [node], edges = []; let current = node;
      do { edges.push(previousEdge[current]); current = previous[current]; nodes.push(current); if (nodes.length > count + 1) throw Error('负环见证超出界限'); } while (current !== node);
      nodes.reverse(); edges.reverse();
      negativeCycle = { nodes: nodes.map(i => graph.nodes[i].id), edges: edges.map(i => graph.edges[i].id), weight: edges.reduce((sum, i) => sum + BigInt(graph.edges[i].weight), 0n).toString() };
      if (BigInt(negativeCycle.weight) >= 0n) throw Error('负环见证校验失败');
      const queue = [];
      for (const seed of seeds) if (!affected[seed]) { affected[seed] = 1; queue.push(seed); }
      for (let q = 0; q < queue.length; q++) for (const { to } of index.forward[queue[q]]) if (!affected[to]) { affected[to] = 1; queue.push(to); }
    }
  }
  const status = i => affected[i] ? 'negative-infinity' : distance[i] === null ? 'unreachable' : 'finite';
  return { kind: 'shortest', algorithm, source: graph.nodes[source].id, target: graph.nodes[target].id,
    status: status(target), distance: status(target) === 'finite' ? distance[target].toString() : null,
    path: status(target) === 'finite' ? pathTo(graph, source, target, previous, previousEdge) : null,
    negativeCycle, affected: graph.nodes.filter((_, i) => affected[i]).map(n => n.id),
    distances: graph.nodes.map((node, i) => ({ id: node.id, status: status(i), distance: status(i) === 'finite' ? distance[i].toString() : null,
      previous: status(i) === 'finite' && previous[i] >= 0 ? graph.nodes[previous[i]].id : null, edge: status(i) === 'finite' && previousEdge[i] >= 0 ? graph.edges[previousEdge[i]].id : null })),
    convention: 'exact integer weights; shortest walks, not restricted simple paths; negative cycles affect only reachable descendants',
  };
}

// Lengauer–Tarjan immediate dominators, including irreducible control flow.
// Iterative DFS and path compression avoid a JavaScript recursion limit.
function dominators(graph, index, root, target, includeFrontier) {
  if (!graph.directed) throw Error('支配树要求有向图');
  const number = new Int32Array(graph.nodes.length), vertex = [-1, root], parent = [0, 0]; number[root] = 1;
  const stack = [[root, 0]];
  while (stack.length) {
    const frame = stack.at(-1), row = index.forward[frame[0]];
    if (frame[1] >= row.length) { stack.pop(); continue; }
    const to = row[frame[1]++].to;
    if (!number[to]) { number[to] = vertex.length; parent.push(number[frame[0]]); vertex.push(to); stack.push([to, 0]); }
  }
  const n = vertex.length, semi = Int32Array.from({ length: n }, (_, i) => i), label = Int32Array.from(semi), ancestor = new Int32Array(n), idom = new Int32Array(n), buckets = Array.from({ length: n }, () => []);
  function evaluate(v) {
    const path = []; let at = v;
    while (ancestor[ancestor[at]]) { path.push(at); at = ancestor[at]; }
    for (const node of path.toReversed()) { const a = ancestor[node]; if (semi[label[a]] < semi[label[node]]) label[node] = label[a]; ancestor[node] = ancestor[a]; }
    return label[v];
  }
  for (let w = n - 1; w >= 2; w--) {
    for (const arc of index.reverse[vertex[w]]) if (number[arc.from]) semi[w] = Math.min(semi[w], semi[evaluate(number[arc.from])]);
    buckets[semi[w]].push(w); ancestor[w] = parent[w];
    for (const v of buckets[parent[w]]) { const u = evaluate(v); idom[v] = semi[u] < semi[v] ? u : parent[w]; }
    buckets[parent[w]] = [];
  }
  for (let w = 2; w < n; w++) if (idom[w] !== semi[w]) idom[w] = idom[idom[w]];
  const immediate = new Int32Array(graph.nodes.length).fill(-1);
  for (let w = 2; w < n; w++) immediate[vertex[w]] = vertex[idom[w]];
  const frontier = includeFrontier ? graph.nodes.map(() => new Set()) : null; let work = 0;
  if (frontier) for (const arc of index.arcs) if (number[arc.from] && number[arc.to]) {
    let runner = arc.from;
    while (runner >= 0 && runner !== immediate[arc.to]) {
      if (++work > GRAPH_LIMITS.work) throw Error('支配边界超过 800 万步预算；请关闭边界计算后重试');
      frontier[runner].add(arc.to); runner = immediate[runner];
    }
  }
  const chain = [];
  if (number[target]) for (let node = target; node >= 0; node = immediate[node]) chain.push(graph.nodes[node].id);
  return { kind: 'dominators', algorithm: 'Lengauer–Tarjan', source: graph.nodes[root].id, target: graph.nodes[target].id,
    reachable: n - 1, chain: number[target] ? chain.reverse() : null,
    rows: graph.nodes.map((node, i) => ({ id: node.id, reachable: Boolean(number[i]), immediate: immediate[i] < 0 ? null : graph.nodes[immediate[i]].id,
      ...(frontier ? { frontier: [...frontier[i]].sort((a, b) => a - b).map(n => graph.nodes[n].id) } : {}) })),
    convention: 'root has no immediate dominator; unreachable vertices excluded; chain includes root and target; optional frontier includes loop headers',
  };
}

export function analyzeGraph(input, options = {}) {
  const graph = parseGraph(input, options), index = indexed(graph), summary = structure(graph, index), kind = options.kind ?? 'structure';
  let analysis = { kind: 'structure' };
  if (kind !== 'structure') {
    const source = requireNode(index, options.source, '起点'), target = requireNode(index, options.target ?? options.source, '终点');
    if (kind === 'shortest') analysis = shortest(graph, index, source, target, summary);
    else if (kind === 'dominators') analysis = dominators(graph, index, source, target, options.frontier === true);
    else if (kind === 'reachability') {
      const found = reach(index, source, options.direction ?? 'forward');
      analysis = { kind, source: graph.nodes[source].id, target: graph.nodes[target].id, direction: options.direction ?? 'forward',
        reachable: found.order.map(i => graph.nodes[i].id), unreachable: graph.nodes.filter((_, i) => found.distance[i] < 0).map(n => n.id),
        hops: [...found.distance].map(n => n < 0 ? null : n), path: found.distance[target] < 0 ? null : pathTo(graph, source, target, found.previous, found.edges) };
    } else throw Error('未知图分析任务');
  }
  return { format: 'arisaka-graph-analysis-v1', graph, summary, analysis };
}

export function graphDot(graph) {
  const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n') + '"';
  const connector = graph.directed ? ' -> ' : ' -- ';
  return (graph.directed ? 'digraph' : 'graph') + ' G {\n' + graph.nodes.map(node => '  ' + quote(node.id) + ' [label=' + quote(node.label) + '];').join('\n') + '\n'
    + graph.edges.map(edge => '  ' + quote(edge.source) + connector + quote(edge.target) + ' [label=' + quote(edge.weight) + ', id=' + quote(edge.id) + '];').join('\n') + '\n}\n';
}
