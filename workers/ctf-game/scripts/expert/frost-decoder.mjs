// Maintenance-only recovery. No generator imports and no private fixture reads.
import { createHash } from 'node:crypto';
import { openSeal } from '../decoders.mjs';

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const Q = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n, 1n];
const ZERO = [0n, 1n, 0n], mod = (a, p = P) => (a % p + p) % p;
const bytes = n => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const integer = b => BigInt('0x' + Buffer.from(b).toString('hex'));
const digest = (...values) => { const hash = createHash('sha256'); for (const v of values) hash.update(v); return hash.digest(); };
function inverse(a, p) {
  let b = p, x = 1n, y = 0n; a = mod(a, p);
  while (b) { const k = a / b; [a, b] = [b, a - k * b]; [x, y] = [y, x - k * y]; }
  if (a !== 1n) throw Error('Singular FROST equations'); return mod(x, p);
}
function pow(a, n) { let result = 1n; for (; n; n >>= 1n, a = a * a % P) if (n & 1n) result = result * a % P; return result; }
function double([x, y, z]) {
  if (!z || !y) return ZERO;
  const yy = y * y % P, s = 4n * x * yy % P, m = 3n * x * x % P, nx = mod(m * m - 2n * s);
  return [nx, mod(m * (s - nx) - 8n * yy * yy), 2n * y * z % P];
}
function add(a, b) {
  if (!a[2]) return b; if (!b[2]) return a;
  const za = a[2] * a[2] % P, zb = b[2] * b[2] % P;
  const u = a[0] * zb % P, v = b[0] * za % P, s = a[1] * b[2] % P * zb % P, t = b[1] * a[2] % P * za % P;
  const h = mod(v - u), r = mod(t - s); if (!h) return r ? ZERO : double(a);
  const hh = h * h % P, hhh = h * hh % P, uh = u * hh % P, x = mod(r * r - hhh - 2n * uh);
  return [x, mod(r * (uh - x) - s * hhh), h * a[2] % P * b[2] % P];
}
function multiply(point, scalar) {
  let result = ZERO; scalar = mod(scalar, Q);
  for (; scalar; scalar >>= 1n, point = double(point)) if (scalar & 1n) result = add(result, point);
  return result;
}
function encode(point) {
  if (!point[2]) throw Error('FROST identity element');
  const z = inverse(point[2], P), x = point[0] * z % P * z % P, y = point[1] * z % P * z % P * z % P;
  return Buffer.concat([Buffer.from([2 + Number(y & 1n)]), bytes(x)]);
}
function decode(value) {
  const b = typeof value === 'string' ? Buffer.from(value, 'hex') : Buffer.from(value);
  if (b.length !== 33 || ![2, 3].includes(b[0])) throw Error('Invalid SEC1 point');
  const x = integer(b.subarray(1)); if (x >= P) throw Error('Invalid SEC1 coordinate');
  const rhs = (x * x % P * x + 7n) % P; let y = pow(rhs, (P + 1n) / 4n);
  if (y * y % P !== rhs) throw Error('SEC1 point is not on secp256k1');
  if (Number(y & 1n) !== b[0] - 2) y = P - y; return [x, y, 1n];
}
function equal(a, b) {
  if (!a[2] || !b[2]) return a[2] === b[2];
  const za = a[2] * a[2] % P, zb = b[2] * b[2] % P;
  return a[0] * zb % P === b[0] * za % P && a[1] * zb % P * b[2] % P === b[1] * za % P * a[2] % P;
}
function readScalar(value) { const b = Buffer.from(value); if (b.length !== 32 || integer(b) >= Q) throw Error('Invalid FROST scalar'); return integer(b); }

export function frostScalarHash(label, message) {
  const domain = Buffer.from('FROST-secp256k1-SHA256-v1' + label), dst = Buffer.concat([domain, Buffer.from([domain.length])]);
  const zero = digest(Buffer.alloc(64), message, Buffer.from('003000', 'hex'), dst);
  const first = digest(zero, Buffer.from([1]), dst), xor = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) xor[i] = zero[i] ^ first[i];
  return integer(Buffer.concat([first, digest(xor, Buffer.from([2]), dst)]).subarray(0, 48)) % Q;
}
const lagrange = (id, ids) => ids.filter(other => other !== id).reduce((v, other) => mod(v * BigInt(other) * inverse(BigInt(other - id), Q), Q), 1n);

export function inspectFrostTranscript(publicKey, commitments, message, signature) {
  const PK = decode(publicKey), group = encode(PK), ordered = commitments.map(([id, d, e]) => ({ id, D: decode(d), E: decode(e) })).sort((a, b) => a.id - b.id);
  if (ordered.length < 2 || ordered.length > 16 || new Set(ordered.map(item => item.id)).size !== ordered.length
    || ordered.some(item => !Number.isInteger(item.id) || item.id < 1 || item.id > 65535)) throw Error('Invalid FROST roster');
  const msgHash = digest(Buffer.from('FROST-secp256k1-SHA256-v1msg'), message);
  const comHash = digest(Buffer.from('FROST-secp256k1-SHA256-v1com'), ...ordered.flatMap(item => [bytes(BigInt(item.id)), encode(item.D), encode(item.E)]));
  const rho = new Map(ordered.map(item => [item.id, frostScalarHash('rho', Buffer.concat([group, msgHash, comHash, bytes(BigInt(item.id))]))]));
  const R = ordered.reduce((r, item) => add(r, add(item.D, multiply(item.E, rho.get(item.id)))), ZERO);
  const encodedR = encode(R), challenge = frostScalarHash('chal', Buffer.concat([encodedR, group, message]));
  if (signature) {
    if (signature.length !== 65 || !Buffer.from(signature.subarray(0, 33)).equals(encodedR)
      || !equal(multiply(G, readScalar(signature.subarray(33))), add(R, multiply(PK, challenge)))) throw Error('Invalid aggregate FROST signature');
  }
  return { ordered, rho, challenge, groupCommitment: encodedR };
}

export function readFrostCbor(input) {
  const data = Buffer.from(input); let at = 0, nodes = 0;
  if (data.length > 1024 * 1024) throw Error('CBOR size');
  const take = n => { if (at + n > data.length) throw Error('Truncated CBOR'); const b = data.subarray(at, at + n); at += n; return b; };
  function item(depth = 0) {
    if (depth > 16 || ++nodes > 10000) throw Error('CBOR complexity');
    const tag = take(1)[0], major = tag >> 5, info = tag & 31;
    let n = info;
    if (info === 24) { n = take(1)[0]; if (n < 24) throw Error('Nonminimal CBOR'); }
    else if (info === 25) { n = take(2).readUInt16BE(); if (n < 256) throw Error('Nonminimal CBOR'); }
    else if (info >= 26) throw Error('Unsupported CBOR length');
    if (major === 0) return n;
    if (major === 2) return take(n);
    if (major === 3) return new TextDecoder('utf-8', { fatal: true }).decode(take(n));
    if (major === 4) return Array.from({ length: n }, () => item(depth + 1));
    if (major === 5) {
      const object = Object.create(null);
      for (let i = 0; i < n; i++) { const key = item(depth + 1); if (typeof key !== 'string' || Object.hasOwn(object, key)) throw Error('CBOR map key'); object[key] = item(depth + 1); }
      return object;
    }
    throw Error('Unsupported CBOR item');
  }
  const result = item(); if (at !== data.length) throw Error('CBOR trailing bytes'); return result;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function solve3(rows) {
  const matrix = rows.map(row => [1n, row.rho, row.coefficient, row.z]); let pivot = 0;
  for (let column = 0; column < 3; column++) {
    const index = matrix.findIndex((row, i) => i >= pivot && row[column]); if (index < 0) return;
    [matrix[pivot], matrix[index]] = [matrix[index], matrix[pivot]];
    const inv = inverse(matrix[pivot][column], Q); matrix[pivot] = matrix[pivot].map(v => v * inv % Q);
    for (let i = 0; i < matrix.length; i++) if (i !== pivot) { const k = matrix[i][column]; matrix[i] = matrix[i].map((v, j) => mod(v - k * matrix[pivot][j], Q)); }
    pivot++;
  }
  if (matrix.slice(3).some(row => row[3])) throw Error('Inconsistent FROST equations'); return matrix.slice(0, 3).map(row => row[3]);
}

export function recoverFrostMaterial(files) {
  const key = JSON.parse(files['key-package.json']), decoded = readFrostCbor(files['sessions.cbor']);
  if (key.format !== 'frost-custody-v1' || key.ciphersuite !== 'FROST-secp256k1-SHA256-v1'
    || key.threshold !== 3 || key.participants !== 5 || decoded.format !== 'frost-rounds-v1') throw Error('FROST export format');
  const PK = decode(key.groupPublicKey), epochs = new Map();
  for (const epoch of key.epochs) {
    const coefficients = epoch.coefficientCommitments.map(decode), shares = new Map();
    if (epochs.has(epoch.epoch) || coefficients.length !== key.threshold || !equal(coefficients[0], PK)) throw Error('FROST epoch commitments');
    for (const entry of epoch.verificationShares) {
      if (!Number.isInteger(entry.id) || entry.id < 1 || entry.id > key.participants || shares.has(entry.id)) throw Error('FROST verification identifier');
      const Y = decode(entry.point), expected = coefficients.reduceRight((acc, C) => add(multiply(acc, BigInt(entry.id)), C), ZERO);
      if (!equal(Y, expected)) throw Error('Feldman verification share mismatch'); shares.set(entry.id, Y);
    }
    if (shares.size !== key.participants) throw Error('Missing FROST verification shares'); epochs.set(epoch.epoch, shares);
  }
  const sessions = new Map();
  for (const session of decoded.sessions) {
    const id = session.id.toString('hex');
    if (session.id.length !== 16 || sessions.has(id) || !epochs.has(session.epoch)) throw Error('FROST session identity');
    const transcript = inspectFrostTranscript(key.groupPublicKey, session.commitments, session.message, session.signature);
    if (transcript.ordered.length < key.threshold || transcript.ordered.some(item => !epochs.get(session.epoch).has(item.id))) throw Error('FROST signing set');
    sessions.set(id, { ...session, ...transcript });
  }
  const journal = Buffer.from(files['responses.journal']);
  if (journal.length < 16 || journal.toString('ascii', 0, 4) !== 'FJ30' || journal.readUInt16BE(4) !== 1 || journal.readUInt16BE(6) !== 64
    || journal.length !== 16 + 64 * journal.readUInt32BE(8) || crc32(journal.subarray(0, 12)) !== journal.readUInt32LE(12)) throw Error('FROST journal header');
  const groups = new Map(), seen = new Set(); let authenticated = 0;
  for (let at = 16; at < journal.length; at += 64) {
    const frame = journal.subarray(at, at + 64); if (crc32(frame.subarray(0, 60)) !== frame.readUInt32LE(60)) continue;
    const session = sessions.get(frame.subarray(0, 16).toString('hex')), epoch = frame.readUInt32BE(16), id = frame.readUInt16BE(20);
    if (!session || session.epoch !== epoch || epoch !== key.currentEpoch) continue;
    const commitment = session.ordered.find(item => item.id === id); if (!commitment) continue;
    const scalarBytes = frame.subarray(24, 56); if (integer(scalarBytes) >= Q) continue;
    const z = readScalar(scalarBytes), rho = session.rho.get(id), coefficient = session.challenge * lagrange(id, session.ordered.map(item => item.id)) % Q;
    const Y = epochs.get(epoch).get(id), expected = add(add(commitment.D, multiply(commitment.E, rho)), multiply(Y, coefficient));
    if (!equal(multiply(G, z), expected)) continue;
    const unique = session.id.toString('hex') + '/' + id; if (seen.has(unique)) continue; seen.add(unique); authenticated++;
    const groupId = epoch + '/' + id + '/' + encode(commitment.D).toString('hex') + encode(commitment.E).toString('hex');
    if (!groups.has(groupId)) groups.set(groupId, { id, Y, ...commitment, rows: [] });
    groups.get(groupId).rows.push({ z, rho, coefficient });
  }
  const recovered = new Map();
  for (const group of groups.values()) {
    if (group.rows.length < 3) continue; const result = solve3(group.rows); if (!result) continue;
    const [d, e, share] = result;
    if (equal(multiply(G, d), group.D) && equal(multiply(G, e), group.E) && equal(multiply(G, share), group.Y)) recovered.set(group.id, share);
  }
  if (recovered.size < key.threshold) throw Error('Insufficient independent same-epoch FROST equations');
  const ids = [...recovered.keys()].sort((a, b) => a - b).slice(0, key.threshold);
  const secret = ids.reduce((sum, id) => mod(sum + lagrange(id, ids) * recovered.get(id), Q), 0n);
  if (!equal(multiply(G, secret), PK)) throw Error('FROST reconstructed group key mismatch');
  return { material: bytes(secret), recovered: ids, authenticated };
}

export function decodeFrostEvidence(files) {
  return openSeal(JSON.parse(files['capsule.json']), recoverFrostMaterial(files).material);
}
