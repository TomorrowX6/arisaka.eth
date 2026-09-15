// Independent maintenance decoder: field tables, binary basis inversion,
// Berlekamp-Welch, polynomial division, then authenticated DER custody.
import { createPublicKey, verify } from 'node:crypto';
import { openSeal } from '../decoders.mjs';

export function rs16Field() {
  const exp = new Uint16Array(131070), log = new Int32Array(65536).fill(-1); let word = 1;
  for (let i = 0; i < 65535; i++) { if (log[word] !== -1) throw Error('RS16 primitive polynomial'); exp[i] = word; log[word] = i; word *= 2; if (word & 65536) word ^= 0x1100b; }
  if (word !== 1) throw Error('RS16 field order'); exp.set(exp.subarray(0, 65535), 65535);
  return { multiply: (a, b) => a && b ? exp[log[a] + log[b]] : 0,
    inverse: a => { if (!a) throw Error('RS16 division by zero'); return exp[65535 - log[a]]; },
    power: (a, n) => !n ? 1 : a ? exp[(log[a] * n) % 65535] : 0 };
}
function crc32(data) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function basisInverse(data) {
  if (data.length !== 36) throw Error('RS16 ROM size');
  const left = Array.from({ length: 16 }, (_, bit) => Array.from({ length: 16 }, (_, j) => (data.readUInt16LE(j * 2) >> bit & 1) << j).reduce((a, b) => a | b, 0));
  const right = Array.from({ length: 16 }, (_, i) => 1 << i);
  for (let column = 0; column < 16; column++) {
    const row = left.findIndex((value, i) => i >= column && value >> column & 1); if (row < 0) throw Error('Singular RS16 adapter basis');
    [left[column], left[row]] = [left[row], left[column]]; [right[column], right[row]] = [right[row], right[column]];
    for (let i = 0; i < 16; i++) if (i !== column && left[i] >> column & 1) { left[i] ^= left[column]; right[i] ^= right[column]; }
  }
  const parity = n => { n ^= n >>> 8; n ^= n >>> 4; return 0x6996 >>> (n & 15) & 1; };
  return word => right.reduce((out, mask, i) => out | parity(word & mask) << i, 0);
}

function eliminate(matrix, width, field) {
  let row = 0; const pivots = [];
  for (let column = 0; column < width && row < matrix.length; column++) {
    const pivot = matrix.findIndex((line, i) => i >= row && line[column]); if (pivot < 0) continue;
    [matrix[row], matrix[pivot]] = [matrix[pivot], matrix[row]]; const inv = field.inverse(matrix[row][column]);
    for (let j = column; j <= width; j++) matrix[row][j] = field.multiply(matrix[row][j], inv);
    for (let i = 0; i < matrix.length; i++) if (i !== row && matrix[i][column]) {
      const factor = matrix[i][column]; for (let j = column; j <= width; j++) matrix[i][j] ^= field.multiply(factor, matrix[row][j]);
    }
    pivots.push(column); row++;
  }
  for (const line of matrix) if (line.slice(0, width).every(n => !n) && line[width]) throw Error('Uncorrectable RS16 symbols');
  const result = new Uint16Array(width); pivots.forEach((column, i) => result[column] = matrix[i][width]); return result;
}

export function decodeRs16Polynomial(points, dimension, field = rs16Field()) {
  if (points.length < dimension || points.length > 255 || dimension < 1) throw Error('Insufficient RS16 evaluations');
  const errors = Math.floor((points.length - dimension) / 2), qLength = dimension + errors, width = dimension + errors * 2;
  const matrix = points.map(([x, y]) => {
    const powers = [1]; for (let i = 1; i < qLength; i++) powers.push(field.multiply(powers.at(-1), x));
    const row = new Uint16Array(width + 1); row.set(powers);
    for (let i = 0; i < errors; i++) row[qLength + i] = field.multiply(y, powers[i]);
    row[width] = field.multiply(y, powers[errors] ?? field.power(x, errors)); return row;
  });
  const solution = eliminate(matrix, width, field), numerator = solution.slice(0, qLength), denominator = [...solution.slice(qLength), 1];
  const polynomial = new Uint16Array(dimension);
  for (let i = numerator.length - 1; i >= errors; i--) {
    const coefficient = numerator[i]; polynomial[i - errors] = coefficient;
    for (let j = 0; j <= errors; j++) numerator[i - errors + j] ^= field.multiply(coefficient, denominator[j]);
  }
  if (numerator.some(n => n)) throw Error('Nondivisible RS16 error locator');
  const mismatches = points.filter(([x, y]) => polynomial.reduceRight((sum, coefficient) => field.multiply(sum, x) ^ coefficient, 0) !== y).length;
  if (mismatches > errors) throw Error('RS16 distance bound exceeded'); return { polynomial, errors: mismatches };
}

export function recoverRs16Material(files) {
  const settings = JSON.parse(files['format.json']);
  if (settings.format !== 'interleaved-rs16-custody-v1' || settings.fieldPolynomial !== '0x1100b' || settings.primitive !== 2
    || settings.n !== 63 || settings.k !== 31 || settings.lanes !== 4 || !Number.isInteger(settings.evaluationStart) || settings.evaluationStart < 0 || settings.evaluationStart >= 65535) throw Error('RS16 code parameters');
  const field = rs16Field(), rom = Buffer.from(files['adapter.rom']), unmap = basisInverse(rom), affine = rom.readUInt16LE(32), whitening = rom.readUInt16LE(34);
  const capture = Buffer.from(files['capture.rs16']);
  if (capture.length < 16 || capture.toString('ascii', 0, 8) !== 'RS16CAP1' || capture.readUInt16LE(8) !== 32
    || capture.length !== 16 + capture.readUInt16LE(10) * 32 || crc32(capture.subarray(0, 12)) !== capture.readUInt32LE(12)) throw Error('RS16 capture header');
  const roster = new Set(Array.from({ length: settings.n }, (_, i) => field.power(2, (settings.evaluationStart + i) % 65535))), points = new Map();
  for (let at = 16; at < capture.length; at += 32) {
    const frame = capture.subarray(at, at + 32);
    if (frame.toString('ascii', 0, 2) !== 'R6' || frame[2] !== 1 || crc32(frame.subarray(0, 28)) !== frame.readUInt32LE(28)) continue;
    const sequence = frame.readUInt32LE(4); let mask = (sequence >>> 16 ^ sequence ^ whitening) & 65535;
    const take = offset => { const value = unmap(frame.readUInt16BE(offset) ^ affine ^ mask); mask = mask >>> 1 ^ (mask & 1 ? 0xb400 : 0); return value; };
    const x = take(8), values = [];
    if (!roster.has(x)) throw Error('RS16 evaluation outside roster');
    for (let lane = 0; lane < 4; lane++) values[(lane + (sequence & 3)) % 4] = take(10 + lane * 2);
    if (points.has(x) && points.get(x).some((value, i) => value !== values[i])) throw Error('Conflicting RS16 duplicate'); points.set(x, values);
  }
  const decoded = Array.from({ length: 4 }, (_, lane) => decodeRs16Polynomial([...points].map(([x, y]) => [x, y[lane]]), settings.k, field));
  const message = Buffer.alloc(settings.k * 8);
  decoded.forEach(({ polynomial }, lane) => polynomial.forEach((value, i) => message.writeUInt16LE(value, (i * 4 + lane) * 2)));
  if (!message.subarray(0, 4).equals(Buffer.from('S16\x01')) || message.readUInt16LE(6) !== 0) throw Error('RS16 message header');
  const length = message.readUInt16LE(4); if (length > message.length - 8) throw Error('RS16 DER length');
  const der = message.subarray(8, 8 + length); let offset = 0;
  const read = tag => {
    const start = offset; if (der[offset++] !== tag) throw Error('RS16 DER tag'); const n = der[offset++];
    if (n >= 128 || offset + n > der.length) throw Error('RS16 DER bounds'); const value = der.subarray(offset, offset + n); offset += n;
    return { value, encoded: der.subarray(start, offset) };
  };
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw Error('RS16 DER sequence'); offset = 2;
  const serial = read(2), material = read(4), signature = read(3);
  if (offset !== der.length || !serial.value.length || serial.value[0] & 128 || serial.value.length > 1 && !serial.value[0] && !(serial.value[1] & 128)
    || material.value.length !== 32 || signature.value.length !== 65 || signature.value[0]) throw Error('RS16 DER custody fields');
  const publicKey = createPublicKey({ key: files['custody.pub.der'], format: 'der', type: 'spki' });
  if (!verify(null, Buffer.concat([Buffer.from('archive/rs16/proof\0'), serial.encoded, material.encoded]), publicKey, signature.value.subarray(1))) throw Error('RS16 custody authentication');
  return { material: material.value, errors: decoded.map(item => item.errors), erasures: settings.n - points.size };
}

export function decodeRs16Evidence(files) { return openSeal(JSON.parse(files['capsule.json']), recoverRs16Material(files).material); }
