import { inflateRawSync } from 'node:zlib';
import { unpackTar } from './git-decoder.mjs';

// Independent Berlekamp-Welch decoder for polynomial evaluation codes.
const exp = new Uint8Array(512), log = new Uint8Array(256);
let primitive = 1;
for (let i = 0; i < 255; i++) { exp[i] = primitive; log[primitive] = i; primitive <<= 1; if (primitive & 256) primitive ^= 0x11d; }
for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
const mul = (a, b) => a && b ? exp[log[a] + log[b]] : 0;
const inv = a => { if (!a) throw Error('Zero inverse'); return exp[255 - log[a]]; };

function crc(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = c >>> 1 ^ (c & 1 ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}

export function repairPolynomial(points, values, dimension) {
  const errors = Math.floor((points.length - dimension) / 2), qSize = dimension + errors;
  if (errors < 0 || new Set(points).size !== points.length) throw Error('Insufficient distinct symbols');
  const unknowns = qSize + errors;
  const rows = points.map((x, index) => {
    const powers = [1]; for (let i = 1; i < qSize; i++) powers.push(mul(powers.at(-1), x));
    const row = new Uint8Array(unknowns + 1); row.set(powers);
    for (let i = 0; i < errors; i++) row[qSize + i] = mul(values[index], powers[i]);
    row[unknowns] = mul(values[index], powers[errors]); return row;
  });
  const pivots = []; let rank = 0;
  for (let column = 0; column < unknowns; column++) {
    let pivot = rank; while (pivot < rows.length && !rows[pivot][column]) pivot++;
    if (pivot === rows.length) continue;
    [rows[rank], rows[pivot]] = [rows[pivot], rows[rank]];
    const factor = inv(rows[rank][column]);
    for (let j = column; j <= unknowns; j++) rows[rank][j] = mul(rows[rank][j], factor);
    for (let i = 0; i < rows.length; i++) {
      if (i === rank || !rows[i][column]) continue;
      const scale = rows[i][column];
      for (let j = column; j <= unknowns; j++) rows[i][j] ^= mul(scale, rows[rank][j]);
    }
    pivots.push(column); rank++;
  }
  for (let i = rank; i < rows.length; i++) if (rows[i][unknowns]) throw Error('Uncorrectable symbols');
  const solution = new Uint8Array(unknowns);
  pivots.forEach((column, i) => { solution[column] = rows[i][unknowns]; });
  const q = solution.slice(0, qSize), e = [...solution.slice(qSize), 1], output = Buffer.alloc(dimension);
  for (let degree = qSize - 1; degree >= errors; degree--) {
    const value = q[degree]; output[degree - errors] = value;
    for (let j = 0; j <= errors; j++) q[degree - errors + j] ^= mul(value, e[j]);
  }
  if (q.some(Boolean)) throw Error('Non-polynomial reconstruction');
  let mismatches = 0;
  points.forEach((point, i) => {
    let value = 0; for (let degree = dimension - 1; degree >= 0; degree--) value = mul(value, point) ^ output[degree];
    if (value !== values[i]) mismatches++;
  });
  if (mismatches > errors) throw Error('Correction radius exceeded');
  return output;
}

export function decodeStorageEvidence(archive) {
  const entries = unpackTar(archive), commit = entries.get('journal/commit').bytes;
  if (commit.toString('ascii', 0, 4) !== 'TXC3' || crc(commit.subarray(0, 12)) !== commit.readUInt32LE(12)) throw Error('Invalid commit record');
  const epoch = commit.readUInt32LE(4);
  const shards = [...entries.values()].map(item => item.bytes).filter(bytes => bytes.toString('ascii', 0, 4) === 'RSV3' && bytes.readUInt32LE(4) === epoch);
  if (!shards.length) throw Error('Missing committed stripe set');
  for (const shard of shards) if (crc(shard.subarray(16)) !== shard.readUInt32LE(12)) throw Error('Shard transport checksum');
  const dimension = shards[0][10], stripes = shards[0][11], data = Buffer.alloc(dimension * stripes);
  for (let stripe = 0; stripe < stripes; stripe++) {
    const points = shards.map(shard => shard[9]);
    const values = shards.map(shard => shard[16 + (stripe * 37 + shard[8] * 19) % stripes]);
    repairPolynomial(points, values, dimension).copy(data, stripe * dimension);
  }
  const packed = data.subarray(8, 8 + data.readUInt32LE(0));
  if (crc(packed) !== data.readUInt32LE(4)) throw Error('Recovered object checksum');
  return JSON.parse(inflateRawSync(packed));
}
