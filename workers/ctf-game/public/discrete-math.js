// Exact, bounded arithmetic for the desktop. No eval and no puzzle-specific API.
const MAX_BITS = 8192;
const abs = n => n < 0n ? -n : n;
const mod = (n, p) => (n % p + p) % p;
export function gcd(a, b) { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a; }
function bounded(n) { if (abs(n).toString(2).length > MAX_BITS) throw Error('中间结果超过 8192 位限制'); return n; }
export function exactInteger(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('大整数必须用带引号的十进制或 0x 字符串');
  const text = String(value).trim();
  if (text.length > 1300 || !/^[+-]?(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) throw Error('无效整数；不接受表达式或浮点数');
  const negative = text.startsWith('-'), magnitude = BigInt(text.replace(/^[+-]/, ''));
  if (magnitude.toString(2).length > 4096) throw Error('输入整数超过 4096 位限制');
  return negative ? -magnitude : magnitude;
}
function egcd(a, b) {
  let x = 1n, y = 0n;
  while (b) { const q = a / b; [a, b] = [b, a - q * b]; [x, y] = [y, x - q * y]; }
  return [a, x];
}
export function inverse(n, p) {
  const [g, x] = egcd(mod(n, p), p); if (g !== 1n) throw Error('元素不可逆'); return mod(x, p);
}
const textMatrix = matrix => matrix.map(row => row.map(String));
function matrixInput(value, maxRows = 24, maxColumns = 32) {
  if (!Array.isArray(value) || !value.length || value.length > maxRows || !Array.isArray(value[0]) || !value[0].length || value[0].length > maxColumns) throw Error('矩阵尺寸超过限制或为空');
  const width = value[0].length;
  if (value.some(row => !Array.isArray(row) || row.length !== width)) throw Error('矩阵每一行必须等宽');
  return value.map(row => row.map(exactInteger));
}

export function modularElimination(input) {
  const p = exactInteger(input.modulus); if (p < 2n) throw Error('模数必须至少为 2');
  const source = matrixInput(input.matrix), a = source.map(row => row.map(value => mod(value, p)));
  const augmented = input.augmented === true, columns = a[0].length - Number(augmented);
  if (!columns) throw Error('增广矩阵至少需要一个未知数');
  const transform = a.map((_, i) => a.map((_, j) => BigInt(i === j))), pivots = []; let row = 0;
  for (let column = 0; column < columns && row < a.length; column++) {
    const pivot = a.findIndex((line, i) => i >= row && gcd(line[column], p) === 1n);
    if (pivot < 0) {
      if (a.slice(row).some(line => line[column] !== 0n)) throw Error('第 ' + (column + 1) + ' 列没有单位主元；不支持该合数模环的消元，未给出解');
      continue;
    }
    [a[row], a[pivot]] = [a[pivot], a[row]]; [transform[row], transform[pivot]] = [transform[pivot], transform[row]];
    const scale = inverse(a[row][column], p);
    a[row] = a[row].map(n => n * scale % p); transform[row] = transform[row].map(n => n * scale % p);
    for (let i = 0; i < a.length; i++) if (i !== row && a[i][column]) {
      const factor = a[i][column];
      a[i] = a[i].map((n, j) => mod(n - factor * a[row][j], p));
      transform[i] = transform[i].map((n, j) => mod(n - factor * transform[row][j], p));
    }
    pivots.push(column); row++;
  }
  const result = { operation: 'modular', modulus: String(p), matrix: textMatrix(a), rowTransform: textMatrix(transform),
    pivots, pivotCount: pivots.length, convention: 'zero-based pivot columns; result = rowTransform × input (mod modulus); only unit pivots' };
  if (augmented) {
    result.consistent = !a.some(line => line.slice(0, columns).every(n => n === 0n) && line[columns] !== 0n);
    if (result.consistent) {
      const particular = Array(columns).fill(0n); pivots.forEach((column, i) => particular[column] = a[i][columns]);
      const free = Array.from({ length: columns }, (_, i) => i).filter(i => !pivots.includes(i));
      const basis = free.map(column => { const v = Array(columns).fill(0n); v[column] = 1n; pivots.forEach((pivot, i) => v[pivot] = mod(-a[i][column], p)); return v; });
      result.particular = particular.map(String); result.nullspace = textMatrix(basis); result.freeColumns = free;
    }
  }
  return result;
}

export function generalizedCrt(input) {
  if (!Array.isArray(input.congruences) || !input.congruences.length || input.congruences.length > 64) throw Error('需要 1–64 个 [余数, 模数]');
  let value = 0n, modulus = 1n; const steps = [];
  for (const pair of input.congruences) {
    if (!Array.isArray(pair) || pair.length !== 2) throw Error('同余式格式为 [余数, 模数]');
    let [r, m] = pair.map(exactInteger); if (m < 1n) throw Error('模数必须为正'); r = mod(r, m);
    const g = gcd(modulus, m), delta = r - value;
    if (delta % g) return { operation: 'crt', consistent: false, conflictAt: steps.length, gcd: String(g) };
    const reduced = m / g, k = reduced === 1n ? 0n : mod(delta / g * inverse(modulus / g, reduced), reduced);
    const nextModulus = bounded(modulus * reduced); value = mod(value + modulus * k, nextModulus); modulus = nextModulus;
    steps.push({ value: String(value), modulus: String(modulus) });
  }
  return { operation: 'crt', consistent: true, value: String(value), modulus: String(modulus), steps };
}

function fraction(n, d = 1n) {
  if (!d) throw Error('除数为零'); if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d); return [bounded(n / g), bounded(d / g)];
}
const fadd = (a, b) => fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const fsub = (a, b) => fraction(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
const fmul = (a, b) => fraction(a[0] * b[0], a[1] * b[1]);
const fdiv = (a, b) => fraction(a[0] * b[1], a[1] * b[0]);
const ftext = a => a[1] === 1n ? String(a[0]) : a[0] + '/' + a[1];
const dot = (a, b) => a.reduce((sum, n, i) => fadd(sum, fmul(n, b[i])), [0n, 1n]);
function gramSchmidt(basis) {
  const orthogonal = [], norms = [], mu = [];
  for (let i = 0; i < basis.length; i++) {
    const vector = basis[i].map(n => [n, 1n]); let projected = vector; mu[i] = [];
    for (let j = 0; j < i; j++) {
      mu[i][j] = fdiv(dot(vector, orthogonal[j]), norms[j]);
      projected = projected.map((n, k) => fsub(n, fmul(mu[i][j], orthogonal[j][k])));
    }
    orthogonal.push(projected); norms.push(dot(projected, projected));
    if (!norms[i][0]) throw Error('LLL 需要线性独立的行向量');
  }
  return { norms, mu };
}

export function reduceLattice(input) {
  const original = matrixInput(input.basis, 10, 16), basis = original.map(row => [...row]);
  if (basis.length > basis[0].length || basis.some(row => row.some(n => abs(n).toString(2).length > 256))) throw Error('LLL 最多 10 × 16，行数不超过列数，输入系数最多 256 位');
  const transform = basis.map((_, i) => basis.map((_, j) => BigInt(i === j)));
  let gs = gramSchmidt(basis), k = 1, iterations = 0, swaps = 0, reductions = 0;
  while (k < basis.length) {
    if (++iterations > 2000) throw Error('LLL 超过 2000 次迭代限制；没有返回未完成的基');
    for (let j = k - 1; j >= 0; j--) {
      const [n, d] = gs.mu[k][j], q = (n < 0n ? -1n : 1n) * ((2n * abs(n) + d) / (2n * d));
      if (q) {
        basis[k] = basis[k].map((v, i) => bounded(v - q * basis[j][i]));
        transform[k] = transform[k].map((v, i) => bounded(v - q * transform[j][i]));
        gs = gramSchmidt(basis); reductions++;
      }
    }
    const right = fmul(fsub([3n, 4n], fmul(gs.mu[k][k - 1], gs.mu[k][k - 1])), gs.norms[k - 1]);
    if (gs.norms[k][0] * right[1] >= right[0] * gs.norms[k][1]) k++;
    else {
      [basis[k], basis[k - 1]] = [basis[k - 1], basis[k]]; [transform[k], transform[k - 1]] = [transform[k - 1], transform[k]];
      gs = gramSchmidt(basis); swaps++; k = Math.max(1, k - 1);
    }
  }
  return { operation: 'lll', delta: '3/4', basis: textMatrix(basis), transform: textMatrix(transform),
    squaredGramSchmidtNorms: gs.norms.map(ftext), mu: gs.mu.map(row => row.map(ftext)), iterations, swaps, reductions,
    convention: 'row basis; reduced = transform × original; exact rational arithmetic; no shortest-vector guarantee' };
}

const degree = value => value === 0n ? -1 : value.toString(2).length - 1;
function polyDivide(a, b) {
  if (!b) throw Error('零多项式不能作为除数'); let quotient = 0n, difference;
  const divisorDegree = degree(b);
  while ((difference = degree(a) - divisorDegree) >= 0) { quotient ^= 1n << BigInt(difference); a ^= b << BigInt(difference); }
  return [quotient, a];
}
function polyMultiply(a, b) { let out = 0n; while (b) { if (b & 1n) out ^= a; a <<= 1n; b >>= 1n; } return bounded(out); }
const polyHex = n => '0x' + n.toString(16);
export function binaryPolynomial(input) {
  const a = exactInteger(input.a); if (a < 0n) throw Error('二进制多项式必须为非负整数');
  const operation = input.action;
  if (operation === 'inverse') {
    const p = exactInteger(input.modulus); if (p < 2n) throw Error('约简多项式次数必须至少为 1');
    let r = p, next = polyDivide(a, p)[1], x = 0n, y = 1n;
    while (next) { const [q, remainder] = polyDivide(r, next); [r, next] = [next, remainder]; [x, y] = [y, x ^ polyMultiply(q, y)]; }
    if (r !== 1n) throw Error('多项式不可逆：与约简多项式不互素');
    return { operation: 'polynomial', action: operation, value: polyHex(polyDivide(x, p)[1]), modulus: polyHex(p), convention: 'GF(2)[x]; bit i is coefficient of x^i' };
  }
  const b = exactInteger(input.b); if (b < 0n) throw Error('二进制多项式必须为非负整数');
  if (operation === 'divide') { const [quotient, remainder] = polyDivide(a, b); return { operation: 'polynomial', action: operation, quotient: polyHex(quotient), remainder: polyHex(remainder) }; }
  if (operation === 'gcd') { let x = a, y = b; while (y) [x, y] = [y, polyDivide(x, y)[1]]; return { operation: 'polynomial', action: operation, value: polyHex(x) }; }
  if (operation !== 'multiply') throw Error('多项式 action 应为 multiply / inverse / divide / gcd');
  let product = polyMultiply(a, b); const raw = product;
  if (input.modulus !== undefined) { const p = exactInteger(input.modulus); if (p < 2n) throw Error('无效约简多项式'); product = polyDivide(product, p)[1]; }
  return { operation: 'polynomial', action: operation, value: polyHex(product), unreduced: polyHex(raw), convention: 'GF(2)[x]; irreducibility of the supplied modulus is not assumed' };
}

export function runDiscreteMath(operation, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('输入应为 JSON 对象');
  const handlers = { modular: modularElimination, crt: generalizedCrt, lll: reduceLattice, polynomial: binaryPolynomial };
  if (!Object.hasOwn(handlers, operation)) throw Error('未知离散数学操作'); return handlers[operation](input);
}
