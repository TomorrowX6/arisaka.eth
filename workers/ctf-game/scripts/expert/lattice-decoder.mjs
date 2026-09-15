import { createECDH, createHash } from 'node:crypto';
import { openSeal } from '../decoders.mjs';

// Fixed-point Gram-Schmidt uses a 1024-bit fractional part. This avoids the
// catastrophic cancellation of IEEE-754 on the 512-bit HNP embedding.
export function reduceLattice(input) {
  const basis = input.map(row => [...row]), dimension = basis.length, scale = 1n << 1024n;
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0n);
  const nearest = value => value < 0n ? -((-value + scale / 2n) / scale) : (value + scale / 2n) / scale;
  function gram() {
    const orthogonal = [], norms = [], mu = [];
    for (let i = 0; i < dimension; i++) {
      const vector = basis[i].map(value => value * scale); mu[i] = [];
      for (let j = 0; j < i; j++) {
        const coefficient = dot(vector, orthogonal[j]) * scale / norms[j]; mu[i][j] = coefficient;
        for (let k = 0; k < dimension; k++) vector[k] -= coefficient * orthogonal[j][k] / scale;
      }
      orthogonal.push(vector); norms.push(dot(vector, vector));
      if (!norms[i]) throw Error('Dependent lattice basis');
    }
    return { mu, norms };
  }
  const state = gram(); let index = 1, iterations = 0;
  while (index < dimension) {
    if (++iterations > 20000) throw Error('Lattice reduction exceeded bound');
    for (let j = index - 1; j >= 0; j--) {
      const q = nearest(state.mu[index][j]);
      if (!q) continue;
      basis[index] = basis[index].map((value, k) => value - q * basis[j][k]);
      for (let k = 0; k < j; k++) state.mu[index][k] -= q * state.mu[j][k];
      state.mu[index][j] -= q * scale;
    }
    if (4n * scale * scale * state.norms[index] >= (3n * scale * scale - 4n * state.mu[index][index - 1] ** 2n) * state.norms[index - 1]) index++;
    else {
      const old = state.mu[index][index - 1], previous = state.norms[index - 1], current = state.norms[index];
      const combined = current + old * old * previous / (scale * scale);
      const coefficient = old * previous / combined;
      state.norms[index] = previous * current / combined;
      state.norms[index - 1] = combined;
      state.mu[index][index - 1] = coefficient;
      for (let j = 0; j < index - 1; j++) [state.mu[index][j], state.mu[index - 1][j]] = [state.mu[index - 1][j], state.mu[index][j]];
      for (let i = index + 1; i < dimension; i++) {
        const value = state.mu[i][index];
        state.mu[i][index] = state.mu[i][index - 1] - old * value / scale;
        state.mu[i][index - 1] = value + coefficient * state.mu[i][index] / scale;
      }
      [basis[index], basis[index - 1]] = [basis[index - 1], basis[index]];
      index = Math.max(1, index - 1);
    }
  }
  return basis;
}

export function decodeLatticeEvidence(signatures, traces, capsule) {
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const mod = value => (value % order + order) % order;
  function invert(value) {
    let a = mod(value), b = order, x = 1n, y = 0n;
    while (b) { const q = a / b; [a, b] = [b, a % b]; [x, y] = [y, x - q * y]; }
    if (a !== 1n) throw Error('Invalid signature scalar'); return mod(x);
  }
  traces = Buffer.from(traces);
  if (traces.subarray(0, 4).toString() !== 'DTL3' || traces.readUInt32LE(12) !== 16 || traces.length !== 16 + traces.readUInt32LE(4) * 16) throw Error('Invalid trace image');
  const prefixes = new Map(), bias = traces.readUInt32LE(8);
  for (let offset = 16; offset < traces.length; offset += 16) prefixes.set(traces.readUInt32LE(offset), (traces.readUInt32LE(offset + 4) ^ bias) >>> 0);
  const records = signatures.records, count = records.length, bound = 1n << 224n;
  const basis = Array.from({ length: count + 2 }, () => Array(count + 2).fill(0n));
  records.forEach((record, i) => {
    if (!prefixes.has(record.sequence)) throw Error('Missing acquisition record');
    const inverse = invert(BigInt('0x' + record.s));
    const h = BigInt('0x' + createHash('sha256').update(Buffer.from(record.message, 'hex')).digest('hex'));
    basis[i][i] = order * order;
    basis[count][i] = order * mod(BigInt('0x' + record.r) * inverse);
    basis[count + 1][i] = -order * mod(BigInt(prefixes.get(record.sequence)) * bound + bound / 2n - h * inverse);
  });
  basis[count][count] = bound; basis[count + 1][count + 1] = order * bound;
  const reduced = reduceLattice(basis);
  for (const vector of reduced) {
    if (vector[count + 1] !== order * bound && vector[count + 1] !== -order * bound) continue;
    const scalar = mod(vector[count] / bound * (vector[count + 1] < 0n ? -1n : 1n));
    if (!scalar) continue;
    const key = Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex'), curve = createECDH('secp256k1'); curve.setPrivateKey(key);
    if (curve.getPublicKey(undefined, 'compressed').toString('hex') === signatures.publicKey) return openSeal(capsule, key);
  }
  throw Error('No public-key-consistent lattice solution');
}
