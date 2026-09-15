import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../scripts/core.mjs';
import { encodeFrostCbor, frostEvidence } from '../scripts/expert/frost.mjs';
import { inspectStructure, structureRows, STRUCTURE_LIMIT } from '../public/binary-structure.js';
import { exactInteger, modularElimination, generalizedCrt, reduceLattice, binaryPolynomial, runDiscreteMath } from '../public/discrete-math.js';

const unhex = hex => Buffer.from(hex, 'hex');
const root = (hex, format = 'der') => inspectStructure(unhex(hex), format).roots[0];

test('DER inspection preserves exact offsets, signed values, long OIDs and nested syntax', () => {
  const tree = inspectStructure(unhex('300d0201ff06082a864886f70d0101'));
  assert.equal(tree.nodeCount, 3); assert.equal(tree.roots[0].length, 15);
  assert.equal(tree.roots[0].children[0].value, '-1');
  assert.equal(tree.roots[0].children[1].value, '1.2.840.113549.1.1');
  assert.equal(tree.roots[0].children[1].payloadOffset, 7);
  assert.equal(root('06028837').value, '2.999');
  assert.equal(root('020900ffffffffffffffff').value, '18446744073709551615');
  assert.equal(root('03020780').value, 'unused=7 · 80');
  assert.equal(root('0c06e99baae5b1b1').value, '雪山');
  assert.equal(root('9f200100').tag, 32);
  assert.equal(structureRows(tree).length, 3); assert.equal(structureRows(tree, new Set([1])).length, 1);
});

test('DER rejects nonminimal and malformed TLVs without reading through parent boundaries', () => {
  for (const hex of ['30800000', '02810101', '02020001', '0202ffff', '010101', '050100', '03020101', '060180', '06028000', '3002020101', '1000', '2400', '0c01ff', '1e02d800', '9f1e00']) {
    assert.throws(() => inspectStructure(unhex(hex)), /DER/);
  }
  let deep = Buffer.from([5, 0]); for (let i = 0; i < 50; i++) deep = Buffer.concat([Buffer.from([0x30, deep.length]), deep]);
  assert.throws(() => inspectStructure(deep), /48/);
});

test('CBOR handles 64-bit integers, tags, indefinite containers, float edges and duplicate keys losslessly', () => {
  assert.equal(root('1bffffffffffffffff', 'cbor').value, '18446744073709551615');
  assert.equal(root('3bffffffffffffffff', 'cbor').value, '-18446744073709551616');
  assert.equal(root('f98000', 'cbor').value, '-0'); assert.equal(root('f97e00', 'cbor').value, 'NaN');
  assert.equal(root('fa7f800000', 'cbor').value, 'Infinity');
  const array = root('9f01a161616168ff', 'cbor'); assert.equal(array.children.length, 2); assert.equal(array.length, 8);
  const chunks = root('5f42010243030405ff', 'cbor'); assert.equal(chunks.contentBytes, 5); assert.equal(chunks.children.length, 2);
  const map = root('a201010102', 'cbor'); assert.equal(map.children.length, 4); assert.match(map.warnings[0], /重复/);
  const bignum = root('c249010000000000000000', 'cbor'); assert.equal(bignum.label, 'tag 2'); assert.equal(bignum.children[0].payloadLength, 9);
  assert.equal(root('1817', 'cbor').warnings.length, 1);
  for (const hex of ['ff', '1c', '9f01', 'bf01ff', '5f6161ff', '7f61c361a9ff', '9bffffffffffffffff', 'f818', '63ffff01']) assert.throws(() => inspectStructure(unhex(hex), 'cbor'), /CBOR/);
});

test('structure previews are bounded while exported spans and full FROST evidence remain intact', () => {
  const data = Buffer.alloc(1048576, 0xaa), header = unhex('5a00100000'), input = Buffer.concat([header, data]);
  const node = inspectStructure(input, 'cbor').roots[0];
  assert.equal(node.valueTruncated, true); assert.ok(node.value.length < 1024);
  assert.deepEqual(input.subarray(node.payloadOffset, node.payloadOffset + node.payloadLength), data);
  assert.throws(() => inspectStructure(Buffer.alloc(STRUCTURE_LIMIT + 1)), /8 MiB/);
  const encoded = frostEvidence('private-test-code', seededRandom(Buffer.alloc(32, 12), 'structure'))['sessions.cbor'];
  const tree = inspectStructure(encoded, 'cbor'); assert.ok(tree.nodeCount > 100);
  for (const { node } of structureRows(tree)) assert.ok(node.offset >= 0 && node.offset + node.length <= encoded.length);
  assert.equal(JSON.stringify(tree).includes('private-test-code'), false);
  const bytes = encodeFrostCbor({ x: [1, 2, Buffer.from([3, 4])], y: 'notes' });
  for (let end = 1; end < bytes.length; end++) assert.throws(() => inspectStructure(bytes.subarray(0, end), 'cbor'));
});

test('bounded structure fuzzing either produces in-range nodes or rejects input, never silently truncates', () => {
  const random = seededRandom(Buffer.alloc(32, 22), 'syntax-fuzz');
  for (const format of ['der', 'cbor']) for (let i = 0; i < 150; i++) {
    const input = random(1 + i % 64); let tree;
    try { tree = inspectStructure(input, format); } catch (error) { assert.match(error.message, /DER|CBOR/); continue; }
    assert.equal(tree.roots.reduce((sum, node) => sum + node.length, 0), input.length);
    for (const { node } of structureRows(tree)) {
      assert.ok(node.offset >= 0 && node.length > 0 && node.offset + node.length <= input.length);
      assert.ok(node.payloadOffset + node.payloadLength <= node.offset + node.length);
    }
  }
});

const multiply = (a, b) => a.map(row => b[0].map((_, column) => row.reduce((sum, value, k) => sum + BigInt(value) * BigInt(b[k][column]), 0n)));
test('modular elimination provides verifiable row transforms, a particular solution and the whole nullspace', () => {
  const matrix = [[2, 1, 5], [1, -1, 1]], result = modularElimination({ modulus: '101', matrix, augmented: true });
  assert.deepEqual(result.particular, ['2', '1']); assert.deepEqual(result.nullspace, []);
  assert.deepEqual(multiply(result.rowTransform, matrix).map(row => row.map(n => String((n % 101n + 101n) % 101n))), result.matrix);
  const free = modularElimination({ modulus: 7, matrix: [[1, 2, 3, 4], [2, 4, 6, 1]], augmented: true });
  assert.deepEqual(free.freeColumns, [1, 2]); assert.equal(free.consistent, true);
  assert.equal(modularElimination({ modulus: 7, matrix: [[1, 1], [1, 2]], augmented: true }).consistent, false);
  assert.throws(() => modularElimination({ modulus: 6, matrix: [[2, 1]] }), /单位主元/);
  const prime = '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
  assert.deepEqual(modularElimination({ modulus: prime, matrix, augmented: true }).particular, ['2', '1']);
});

test('generalized CRT handles compatible non-coprime moduli, negatives and contradictions', () => {
  assert.deepEqual(generalizedCrt({ congruences: [[2, 6], [5, 9]] }).steps.at(-1), { value: '14', modulus: '18' });
  assert.equal(generalizedCrt({ congruences: [[-1, 4], [7, 8], [100, 1]] }).value, '7');
  assert.equal(generalizedCrt({ congruences: [[1, 4], [2, 6]] }).consistent, false);
  assert.throws(() => generalizedCrt({ congruences: [[1, 0]] }), /模数/);
});

function determinant(matrix) {
  const a = matrix.map(row => row.map(BigInt)); let sign = 1n, previous = 1n;
  for (let k = 0; k < a.length - 1; k++) {
    if (!a[k][k]) { const other = a.findIndex((row, i) => i > k && row[k]); if (other < 0) return 0n; [a[k], a[other]] = [a[other], a[k]]; sign = -sign; }
    for (let i = k + 1; i < a.length; i++) for (let j = k + 1; j < a.length; j++) a[i][j] = (a[i][j] * a[k][k] - a[i][k] * a[k][j]) / previous;
    previous = a[k][k];
  }
  return sign * a.at(-1).at(-1);
}
const fraction = text => { const [a, b = '1'] = text.split('/'); return [BigInt(a), BigInt(b)]; };
test('exact LLL preserves the integer lattice, size reduction and Lovasz inequalities beyond Number precision', () => {
  const random = seededRandom(Buffer.alloc(32, 33), 'lll');
  const bases = [[[1, 1, 1], [-1, 0, 2], [3, 5, 6]], [['18446744073709551617', 1], ['18446744073709551616', 1]]];
  for (let size = 3; size <= 6; size++) bases.push(Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => j > i ? 0 : j === i ? 1 : random(1)[0] - 128)));
  for (const basis of bases) {
    const result = reduceLattice({ basis }); assert.deepEqual(multiply(result.transform, basis).map(row => row.map(String)), result.basis);
    const det = determinant(result.transform); assert.ok(det === 1n || det === -1n);
    const norms = result.squaredGramSchmidtNorms.map(fraction), mu = result.mu.map(row => row.map(fraction));
    for (let i = 1; i < basis.length; i++) {
      for (const [n, d] of mu[i]) assert.ok((n < 0n ? -n : n) * 2n <= d);
      const [a, b] = norms[i], [c, d] = norms[i - 1], [n, m] = mu[i][i - 1];
      assert.ok(4n * m * m * a * d >= (3n * m * m - 4n * n * n) * c * b);
    }
  }
  assert.throws(() => reduceLattice({ basis: [[1, 2], [2, 4]] }), /线性独立/);
});

test('binary polynomials implement GF(2) products, Euclidean division and inverses without assuming irreducibility', () => {
  assert.equal(binaryPolynomial({ action: 'multiply', a: '0x57', b: '0x83', modulus: '0x11b' }).value, '0xc1');
  assert.equal(binaryPolynomial({ action: 'inverse', a: '0x53', modulus: '0x11b' }).value, '0xca');
  const inv = binaryPolynomial({ action: 'inverse', a: '0x1234', modulus: '0x1100b' }).value;
  assert.equal(binaryPolynomial({ action: 'multiply', a: '0x1234', b: inv, modulus: '0x1100b' }).value, '0x1');
  assert.deepEqual(binaryPolynomial({ action: 'divide', a: '0xb', b: '0x3' }), { operation: 'polynomial', action: 'divide', quotient: '0x6', remainder: '0x1' });
  assert.equal(binaryPolynomial({ action: 'gcd', a: '0x15', b: '0x7' }).value, '0x7');
  assert.throws(() => binaryPolynomial({ action: 'inverse', a: '0x3', modulus: '0x5' }), /不可逆/);
  for (const value of ['1.5', '1e9', '1+2', 'alert(1)', Number.MAX_SAFE_INTEGER + 1, '9'.repeat(1400)]) assert.throws(() => exactInteger(value));
  for (const operation of ['eval', '__proto__', 'toString']) assert.throws(() => runDiscreteMath(operation, {}), /未知/);
});
