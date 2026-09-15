import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../scripts/core.mjs';
import { parseGraph, analyzeGraph, graphDot, GRAPH_LIMITS } from '../public/graph-data.js';

const json = value => JSON.stringify(value);
const cfg = { directed: true, nodes: ['entry', 'a', 'b', 'join', 'loop', 'exit', 'dead'], edges: [['entry', 'a'], ['entry', 'b'], ['a', 'join'], ['b', 'join'], ['join', 'loop'], ['loop', 'join'], ['loop', 'exit']] };

test('graph JSON and RFC4180 CSV preserve exact IDs, parallel edges, self-loops, isolates and large weights', () => {
  const source = { directed: false, nodes: [{ id: 'a,"b', label: 'line\n"two"\\' }, '__proto__', 'isolated', 'constructor'], edges: [
    { id: 'edge"1', source: 'a,"b', target: '__proto__', weight: '-900719925474099312345678901' },
    { source: '__proto__', target: 'a,"b', weight: 0 }, { source: '__proto__', target: '__proto__', weight: '0002' },
  ] };
  const graph = parseGraph(json(source)); assert.equal(graph.edges[0].weight, source.edges[0].weight); assert.equal(graph.edges[2].weight, '2');
  assert.deepEqual(parseGraph(json(graph)), graph); assert.equal(graph.nodes[0].label, source.nodes[0].label);
  const dot = graphDot(graph); assert.match(dot, /^graph G/); assert.ok(dot.includes('"a,\\"b"')); assert.ok(dot.includes('line\\n\\"two\\"\\\\')); assert.ok(dot.includes('"isolated"'));
  const csv = '\ufeffid,source,target,weight\r\n"edge""1","a,""b",__proto__,-900719925474099312345678901\r\n';
  const parsed = parseGraph(csv, { format: 'csv', directed: false });
  assert.deepEqual(parsed.edges[0], graph.edges[0]); assert.equal(parsed.directed, false);
  assert.equal(parseGraph('source,target\na,b\n').edges[0].weight, '1');
  assert.deepEqual(parseGraph('{"nodes":[],"edges":[]}'), { directed: true, nodes: [], edges: [] });
});

test('graph input refuses precision loss, ambiguous schemas, duplicate IDs, invalid UTF-8 and excess resources', () => {
  for (const value of [1.5, 9007199254740992, null, '1e5', '0x20', 'Infinity', '1+2', '9'.repeat(129)]) assert.throws(() => parseGraph(json({ edges: [['a', 'b', value]] })), /边权/);
  for (const raw of [{ nodes: ['a', 'a'], edges: [] }, { nodes: [1, '1'], edges: [] }, { nodes: ['a'], edges: [['a', 'b']] }, { edges: [{ id: 'e', source: 'a', target: 'b' }, { id: 'e', source: 'b', target: 'a' }] }, { directed: 'false', edges: [] }, { edges: [['a']] }, { nodes: [{ id: 'a', label: 2 }], edges: [] }]) assert.throws(() => parseGraph(json(raw)));
  for (const source of ['a,b\n1,2\n', 'source,target,other\na,b,c\n', 'source,target\n"a,b\n', 'source,target\n"a"oops,b', 'source,target\na,b,c', 'source,target,weight\na,b,']) assert.throws(() => parseGraph(source, { format: 'csv' }));
  assert.throws(() => parseGraph(new Uint8Array([0xc0, 0x80])), /encoded|encoding/);
  assert.throws(() => parseGraph(' '.repeat(GRAPH_LIMITS.bytes + 1)), /4 MiB/);
  assert.throws(() => parseGraph(json({ nodes: Array.from({ length: 4097 }, (_, i) => i), edges: [] })), /4096/);
  assert.throws(() => parseGraph(json({ edges: Array.from({ length: 16385 }, () => ['a', 'b']) })), /16384/);
  assert.throws(() => parseGraph(json({ edges: [['a\n', 'b']] })), /控制字符/);
  assert.throws(() => parseGraph(json({ edges: [] }), { format: 'dot' }), /json 或 csv/);
  for (const raw of [{ edges: [], ignored: 1 }, { nodes: [{ id: 'a', metadata: 'preserve-me' }], edges: [] }, { edges: [{ source: 'a', target: 'b', payload: 2 }] }]) assert.throws(() => parseGraph(json(raw)), /未静默丢弃/);
});

test('SCC condensation, cycle witnesses, multigraph degrees and topological orders are explicit and deterministic', () => {
  const { summary } = analyzeGraph(json(cfg));
  assert.deepEqual(summary.counts, { nodes: 7, edges: 7, selfLoops: 0, parallelEdges: 0, weakComponents: 2, strongComponents: 6 });
  assert.deepEqual(summary.strongComponents.find(c => c.cyclic).nodes, ['join', 'loop']); assert.equal(summary.topological.order, null);
  assert.deepEqual(summary.topological.cycle, { nodes: ['join', 'loop', 'join'], edges: ['e4', 'e5'] });
  assert.equal(summary.layout.positions.length, 7); assert.deepEqual(analyzeGraph(json(cfg)).summary, summary);
  const dag = analyzeGraph(json({ edges: [['a', 'b'], ['a', 'b'], ['b', 'c']] })).summary;
  assert.deepEqual(dag.topological.order, ['a', 'b', 'c']); assert.equal(dag.counts.parallelEdges, 1); assert.deepEqual(dag.degrees[1], { id: 'b', in: 2, out: 1, component: 1 });
  const undirected = analyzeGraph(json({ directed: false, nodes: ['a', 'b', 'c'], edges: [['a', 'b'], ['b', 'a'], ['a', 'a']] })).summary;
  assert.deepEqual(undirected.topological, { applicable: false, order: null, cycle: null }); assert.equal(undirected.strongComponents[0].cyclic, null);
  assert.equal(undirected.degrees[0].out, 4, 'an undirected self-loop contributes degree two'); assert.equal(undirected.counts.parallelEdges, 1);
  assert.deepEqual(analyzeGraph('{"edges":[]}').summary.layout.positions, []);
  assert.deepEqual(analyzeGraph('{"edges":[["self","self"]]}').summary.topological.cycle.nodes, ['self', 'self']);
});

test('BFS reachability respects forward, reverse and weak directions and retains edge IDs for hop paths', () => {
  const result = direction => analyzeGraph(json(cfg), { kind: 'reachability', source: 'exit', target: 'entry', direction }).analysis;
  assert.deepEqual(result('forward').reachable, ['exit']); assert.equal(result('forward').path, null);
  assert.deepEqual(result('reverse').path, { nodes: ['exit', 'loop', 'join', 'a', 'entry'], edges: ['e6', 'e4', 'e2', 'e0'] });
  assert.deepEqual(result('both').unreachable, ['dead']);
  assert.throws(() => analyzeGraph(json(cfg), { kind: 'reachability', source: 'missing' }), /起点/);
  assert.throws(() => analyzeGraph(json(cfg), { kind: 'reachability', source: 'entry', direction: 'wrong' }), /遍历方向/);
});

test('exact shortest paths select DAG/Dijkstra/Bellman–Ford and never turn negative cycles into finite paths', () => {
  const big = 900719925474099312345678901n;
  const dag = { edges: [['a', 'b', String(big)], ['b', 'c', String(-big + 2n)], ['a', 'c', '3']] };
  const a = analyzeGraph(json(dag), { kind: 'shortest', source: 'a', target: 'c' }).analysis;
  assert.equal(a.algorithm, 'DAG'); assert.equal(a.distance, '2'); assert.deepEqual(a.path.nodes, ['a', 'b', 'c']);
  const b = analyzeGraph(json(cfg), { kind: 'shortest', source: 'entry', target: 'exit' }).analysis;
  assert.equal(b.algorithm, 'Dijkstra'); assert.equal(b.distance, '4');
  const negative = { edges: [['s', 'a', 0], ['a', 'b', -2], ['b', 'a', 1], ['b', 't', 2], ['s', 'safe', 5], ['x', 'y', -2], ['y', 'x', 1]] };
  const c = analyzeGraph(json(negative), { kind: 'shortest', source: 's', target: 'safe' }).analysis;
  assert.equal(c.algorithm, 'Bellman–Ford'); assert.equal(c.distance, '5'); assert.deepEqual(c.affected, ['a', 'b', 't']); assert.equal(c.negativeCycle.weight, '-1');
  assert.equal(c.distances.find(n => n.id === 'x').status, 'unreachable');
  const d = analyzeGraph(json(negative), { kind: 'shortest', source: 's', target: 't' }).analysis;
  assert.equal(d.status, 'negative-infinity'); assert.equal(d.distance, null); assert.equal(d.path, null);
  const undirected = analyzeGraph('{"directed":false,"edges":[["a","b",-1]]}', { kind: 'shortest', source: 'a', target: 'a' }).analysis;
  assert.equal(undirected.status, 'negative-infinity'); assert.equal(undirected.negativeCycle.weight, '-2');
  const harmless = analyzeGraph('{"edges":[["s","a",2],["a","s",-1]]}', { kind: 'shortest', source: 's', target: 's' }).analysis;
  assert.equal(harmless.status, 'finite'); assert.equal(harmless.distance, '0'); assert.equal(harmless.negativeCycle, null);
});

function closure(n, edges, blocked = -1) {
  const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j && i !== blocked));
  edges.forEach(([a, b]) => { if (a !== blocked && b !== blocked) matrix[a][b] = true; });
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) matrix[i][j] ||= matrix[i][k] && matrix[k][j];
  return matrix;
}

test('SCCs and Lengauer–Tarjan dominators/frontiers agree with independent vertex-deletion oracles on irreducible graphs', () => {
  const random = seededRandom(Buffer.alloc(32, 0x74), 'graph-oracle');
  for (let trial = 0; trial < 80; trial++) {
    const n = 8, edges = [];
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (random(1)[0] < 64) edges.push([a, b]);
    const connected = closure(n, edges), without = Array.from({ length: n }, (_, d) => closure(n, edges, d));
    const result = analyzeGraph(json({ nodes: Array.from({ length: n }, (_, i) => i), edges }), { kind: 'dominators', source: '0', target: '7', frontier: true });
    const dominates = (a, b) => connected[0][b] && (a === b || !without[a][0][b]);
    const doms = Array.from({ length: n }, (_, b) => Array.from({ length: n }, (_, a) => a).filter(a => dominates(a, b)));
    for (let v = 0; v < n; v++) {
      const strict = doms[v].filter(a => a !== v).sort((a, b) => doms[b].length - doms[a].length);
      assert.equal(result.analysis.rows[v].reachable, connected[0][v]);
      assert.equal(result.analysis.rows[v].immediate, strict.length ? String(strict[0]) : null, 'trial ' + trial + ' node ' + v);
      const expectedFrontier = Array.from({ length: n }, (_, i) => i).filter(b => connected[0][b] && (!dominates(v, b) || v === b) && edges.some(([a, to]) => to === b && dominates(v, a))).map(String);
      assert.deepEqual(result.analysis.rows[v].frontier, expectedFrontier);
      const group = result.summary.strongComponents.find(c => c.nodes.includes(String(v))).nodes;
      assert.deepEqual(group, Array.from({ length: n }, (_, i) => i).filter(w => connected[v][w] && connected[w][v]).map(String));
    }
  }
  const self = analyzeGraph('{"edges":[["root","root"]]}', { kind: 'dominators', source: 'root', target: 'root', frontier: true }).analysis;
  assert.deepEqual(self.rows, [{ id: 'root', reachable: true, immediate: null, frontier: ['root'] }]);
  assert.throws(() => analyzeGraph('{"directed":false,"edges":[["a","b"]]}', { kind: 'dominators', source: 'a' }), /有向图/);
});

test('weighted paths and affected negative-cycle regions agree with an independent Floyd–Warshall oracle', () => {
  const random = seededRandom(Buffer.alloc(32, 0x73), 'shortest-oracle');
  for (let trial = 0; trial < 80; trial++) {
    const n = 6, edges = [], distance = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 0n : null));
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (random(1)[0] < 58) {
      const weight = random(1)[0] % 9 - 3; edges.push([a, b, weight]); distance[a][b] = distance[a][b] === null ? BigInt(weight) : distance[a][b] < BigInt(weight) ? distance[a][b] : BigInt(weight);
    }
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (distance[i][k] === null || distance[k][j] === null) continue;
      const candidate = distance[i][k] + distance[k][j]; if (distance[i][j] === null || distance[i][j] > candidate) distance[i][j] = candidate;
    }
    const result = analyzeGraph(json({ nodes: Array.from({ length: n }, (_, i) => i), edges }), { kind: 'shortest', source: '0', target: '5' });
    for (let target = 0; target < n; target++) {
      const affected = distance.some((row, k) => row[k] < 0n && distance[0][k] !== null && distance[k][target] !== null);
      const expected = affected ? 'negative-infinity' : distance[0][target] === null ? 'unreachable' : 'finite', row = result.analysis.distances[target];
      assert.equal(row.status, expected, 'trial ' + trial + ' target ' + target);
      assert.equal(row.distance, expected === 'finite' ? distance[0][target].toString() : null);
    }
    if (result.analysis.negativeCycle) {
      const witness = result.analysis.negativeCycle; assert.equal(witness.nodes[0], witness.nodes.at(-1));
      let sum = 0n;
      witness.edges.forEach((id, i) => { const edge = result.graph.edges.find(edge => edge.id === id); assert.equal(edge.source, witness.nodes[i]); assert.equal(edge.target, witness.nodes[i + 1]); sum += BigInt(edge.weight); });
      assert.ok(sum < 0n); assert.equal(sum.toString(), witness.weight);
    }
  }
});

test('deep graphs are iterative and expensive optional work fails explicitly instead of returning partial answers', () => {
  const nodes = Array.from({ length: 4096 }, (_, i) => String(i)), edges = nodes.slice(1).map((id, i) => [String(i), id]);
  const deep = analyzeGraph(json({ nodes, edges }), { kind: 'dominators', source: '0', target: '4095' });
  assert.equal(deep.analysis.chain.length, 4096); assert.equal(deep.analysis.rows.at(-1).immediate, '4094');
  assert.equal(deep.summary.topological.order.length, 4096);
  const cyclic = { nodes, edges: [...edges, ...nodes.slice(1).map(id => [id, '0', -1])] };
  assert.throws(() => analyzeGraph(json(cyclic), { kind: 'shortest', source: '0', target: '4095' }), /松弛预算/);
  assert.throws(() => analyzeGraph(json(cyclic), { kind: 'dominators', source: '0', target: '4095', frontier: true }), /支配边界/);
  assert.equal(analyzeGraph(json(cyclic), { kind: 'dominators', source: '0', target: '4095' }).analysis.chain.length, 4096);
});
