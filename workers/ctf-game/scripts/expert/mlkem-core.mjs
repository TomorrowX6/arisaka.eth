import { createHash, timingSafeEqual } from 'node:crypto';

// Independent, deliberately readable FIPS 203 ML-KEM-768 reference for fixture
// recovery/tests. This is not constant-time production cryptography, and is
// never included in the browser or Worker assets.
export const KEM_Q = 3329, KEM_N = 256, KEM_K = 3;
export const kemMod = x => ((x % KEM_Q) + KEM_Q) % KEM_Q;
const hash = (name, bytes, length) => createHash(name, length ? { outputLength: length } : undefined).update(bytes).digest();
const h = bytes => hash('sha3-256', bytes), g = bytes => hash('sha3-512', bytes);
const shake = (bits, bytes, length) => hash('shake' + bits, bytes, length);
const checked = (value, length, name) => {
  if (!(value instanceof Uint8Array) || value.length !== length) throw Error('ML-KEM ' + name + ' must contain ' + length + ' bytes');
  return Buffer.from(value);
};
function power(value, exponent) {
  let result = 1;
  for (; exponent; exponent >>>= 1, value = kemMod(value * value)) if (exponent & 1) result = kemMod(result * value);
  return result;
}
const inverse = value => { if (!kemMod(value)) throw Error('ML-KEM singular field equation'); return power(kemMod(value), KEM_Q - 2); };
const reverse7 = value => { let result = 0; for (let i = 0; i < 7; i++, value >>>= 1) result = result * 2 + (value & 1); return result; };
const roots = Array.from({ length: 128 }, (_, i) => power(17, reverse7(i)));

export function kemNtt(poly, backwards = false) {
  if ((!Array.isArray(poly) && !ArrayBuffer.isView(poly)) || poly.length !== KEM_N || Array.from(poly).some(x => !Number.isSafeInteger(x) || Math.abs(x) > 65536)) throw Error('ML-KEM polynomial requires 256 bounded integers');
  const out = Int32Array.from(poly, kemMod);
  let root = backwards ? 127 : 1;
  for (let width = backwards ? 2 : 128; backwards ? width <= 128 : width >= 2; width = backwards ? width * 2 : width / 2) {
    for (let start = 0; start < KEM_N; start += width * 2) {
      const zeta = roots[root]; root += backwards ? -1 : 1;
      for (let j = start; j < start + width; j++) {
        const a = out[j], b = out[j + width];
        out[j] = kemMod(backwards ? a + b : a + zeta * b);
        out[j + width] = kemMod(backwards ? zeta * (b - a) : a - zeta * b);
      }
    }
  }
  if (backwards) for (let i = 0; i < KEM_N; i++) out[i] = kemMod(out[i] * 3303); // 128^-1 mod q, not 256^-1
  return out;
}

export function kemNttProduct(a, b) {
  if (a.length !== KEM_N || b.length !== KEM_N) throw Error('ML-KEM NTT product width');
  const out = new Int32Array(KEM_N);
  for (let i = 0; i < 128; i++) {
    const at = i * 2, gamma = power(17, 2 * reverse7(i) + 1);
    out[at] = kemMod(a[at] * b[at] + gamma * a[at + 1] * b[at + 1]);
    out[at + 1] = kemMod(a[at] * b[at + 1] + a[at + 1] * b[at]);
  }
  return out;
}

export function kemDecode(bytes, count, bits, canonical = false) {
  if (![1, 4, 10, 12].includes(bits) || !Number.isInteger(count) || count < 1 || count > 3) throw Error('ML-KEM codec dimensions');
  bytes = checked(bytes, count * KEM_N * bits / 8, 'polynomial encoding');
  const polys = Array.from({ length: count }, () => new Int32Array(KEM_N)); let acc = 0, available = 0, cursor = 0;
  for (const poly of polys) for (let i = 0; i < KEM_N; i++) {
    while (available < bits) { acc |= bytes[cursor++] << available; available += 8; }
    const value = acc & ((1 << bits) - 1); acc >>>= bits; available -= bits;
    if (canonical && value >= KEM_Q) throw Error('ML-KEM non-canonical coefficient'); poly[i] = value;
  }
  return polys;
}

export function kemEncode(polys, bits = 12) {
  if (![1, 4, 10, 12].includes(bits) || !Array.isArray(polys) || !polys.length || polys.length > 3) throw Error('ML-KEM codec dimensions');
  const out = Buffer.alloc(polys.length * KEM_N * bits / 8); let acc = 0, available = 0, cursor = 0;
  for (const poly of polys) {
    if (poly.length !== KEM_N) throw Error('ML-KEM polynomial encoding width');
    for (const value of poly) {
      if (!Number.isInteger(value) || value < 0 || value >= 1 << bits) throw Error('ML-KEM encoding coefficient out of range');
      acc |= value << available; available += bits;
      while (available >= 8) { out[cursor++] = acc & 255; acc >>>= 8; available -= 8; }
    }
  }
  return out;
}

const compress = (poly, bits) => Int32Array.from(poly, x => Math.floor((kemMod(x) * (1 << bits) + KEM_Q / 2) / KEM_Q) % (1 << bits));
const decompress = (poly, bits) => Int32Array.from(poly, x => Math.floor((x * KEM_Q + (1 << bits - 1)) / (1 << bits)));
function publicParts(key) {
  key = checked(key, 1184, 'encapsulation key');
  return { t: kemDecode(key.subarray(0, 1152), 3, 12, true), rho: key.subarray(1152) };
}
function sampleNtt(rho, row, column) {
  const seed = Buffer.concat([rho, Buffer.from([column, row])]);
  let length = 512, bytes = shake(128, seed, length), cursor = 0, written = 0;
  const poly = new Int32Array(KEM_N);
  while (written < KEM_N) {
    if (cursor + 3 > bytes.length) {
      length *= 2; if (length > 262144) throw Error('ML-KEM rejection sampler budget'); bytes = shake(128, seed, length);
    }
    const a = bytes[cursor] | (bytes[cursor + 1] & 15) << 8, b = bytes[cursor + 1] >> 4 | bytes[cursor + 2] << 4; cursor += 3;
    if (a < KEM_Q) poly[written++] = a;
    if (b < KEM_Q && written < KEM_N) poly[written++] = b;
  }
  return poly;
}
const matrix = rho => Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, column) => sampleNtt(rho, row, column)));
function sampleCbd(seed, nonce) {
  const bytes = shake(256, Buffer.concat([seed, Buffer.from([nonce])]), 128), out = new Int32Array(KEM_N);
  for (let i = 0; i < KEM_N; i++) {
    const nibble = bytes[i >> 1] >> (i % 2 * 4) & 15;
    out[i] = kemMod((nibble & 1) + (nibble >> 1 & 1) - (nibble >> 2 & 1) - (nibble >> 3 & 1));
  }
  return out;
}
function dot(a, b) {
  const out = new Int32Array(KEM_N);
  for (let i = 0; i < 3; i++) {
    const product = kemNttProduct(a[i], b[i]);
    for (let j = 0; j < KEM_N; j++) out[j] = kemMod(out[j] + product[j]);
  }
  return out;
}

export function kemPkeEncrypt(publicKey, message, randomness) {
  message = checked(message, 32, 'message'); randomness = checked(randomness, 32, 'encryption randomness');
  const { t, rho } = publicParts(publicKey), a = matrix(rho);
  const y = Array.from({ length: 3 }, (_, i) => kemNtt(sampleCbd(randomness, i)));
  const error = Array.from({ length: 3 }, (_, i) => sampleCbd(randomness, i + 3)), finalError = sampleCbd(randomness, 6);
  const u = Array.from({ length: 3 }, (_, i) => {
    const poly = kemNtt(dot(a.map(row => row[i]), y), true);
    return compress(poly.map((value, j) => kemMod(value + error[i][j])), 10);
  });
  const v = kemNtt(dot(t, y), true), m = decompress(kemDecode(message, 1, 1)[0], 1);
  for (let j = 0; j < KEM_N; j++) v[j] = kemMod(v[j] + finalError[j] + m[j]);
  return Buffer.concat([kemEncode(u, 10), kemEncode([compress(v, 4)], 4)]);
}

export function kemPkeDecrypt(secretPolys, ciphertext) {
  ciphertext = checked(ciphertext, 1088, 'ciphertext');
  if (secretPolys.length !== 3) throw Error('ML-KEM secret vector width');
  const u = kemDecode(ciphertext.subarray(0, 960), 3, 10).map(poly => kemNtt(decompress(poly, 10)));
  const v = decompress(kemDecode(ciphertext.subarray(960), 1, 4)[0], 4), product = kemNtt(dot(secretPolys, u), true);
  return kemEncode([compress(v.map((value, i) => kemMod(value - product[i])), 1)], 1);
}

export function kemEncapsulate(publicKey, message) {
  publicParts(publicKey); message = checked(message, 32, 'encapsulation entropy');
  const kr = g(Buffer.concat([message, h(publicKey)]));
  return { ciphertext: kemPkeEncrypt(publicKey, message, kr.subarray(32)), sharedSecret: kr.subarray(0, 32) };
}

export function kemAssembleSecret(secretPolys, publicKey, rejectionSecret) {
  publicParts(publicKey); rejectionSecret = checked(rejectionSecret, 32, 'implicit rejection secret');
  return Buffer.concat([kemEncode(secretPolys), publicKey, h(publicKey), rejectionSecret]);
}

export function kemDecapsulate(ciphertext, secretKey) {
  ciphertext = checked(ciphertext, 1088, 'ciphertext'); secretKey = checked(secretKey, 2400, 'decapsulation key');
  const publicKey = secretKey.subarray(1152, 2336), keyHash = secretKey.subarray(2336, 2368), z = secretKey.subarray(2368);
  if (!timingSafeEqual(h(publicKey), keyHash)) throw Error('ML-KEM decapsulation key hash check failed');
  const secret = kemDecode(secretKey.subarray(0, 1152), 3, 12, true), message = kemPkeDecrypt(secret, ciphertext);
  const kr = g(Buffer.concat([message, keyHash])), comparison = kemPkeEncrypt(publicKey, message, kr.subarray(32));
  const accepted = timingSafeEqual(ciphertext, comparison);
  return { sharedSecret: accepted ? kr.subarray(0, 32) : shake(256, Buffer.concat([z, ciphertext]), 32), accepted, message };
}

const small = value => kemMod(value) <= 2 || kemMod(value) >= KEM_Q - 2;
export function kemCheckSecret(secret, publicKey) {
  const { t, rho } = publicParts(publicKey), a = matrix(rho);
  if (secret.length !== 3 || secret.some(poly => !Array.from(kemNtt(poly, true)).every(small))) return false;
  return a.every((row, i) => {
    const product = dot(row, secret), error = t[i].map((value, j) => kemMod(value - product[j]));
    return Array.from(kemNtt(error, true)).every(small);
  });
}

function invertMatrix(matrix) {
  const n = matrix.length, rows = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => Number(i === j))]);
  for (let column = 0; column < n; column++) {
    const pivot = rows.findIndex((row, i) => i >= column && row[column]); if (pivot < 0) throw Error('ML-KEM singular recovery basis');
    [rows[pivot], rows[column]] = [rows[column], rows[pivot]];
    const scale = inverse(rows[column][column]); rows[column] = rows[column].map(value => kemMod(value * scale));
    for (let i = 0; i < n; i++) if (i !== column) {
      const coefficient = rows[i][column]; rows[i] = rows[i].map((value, j) => kemMod(value - coefficient * rows[column][j]));
    }
  }
  return rows.map(row => row.slice(n));
}

// Missing NTT words are not guessed across q^4 possibilities. Four independent
// coefficient-domain constraints leave 5^4 small-noise candidates, each checked
// against the entire polynomial; the public-key relation is verified separately.
export function kemRecoverPolynomial(input) {
  if (!Array.isArray(input) || input.length !== KEM_N || input.some(x => x !== null && (!Number.isInteger(x) || x < 0 || x >= KEM_Q))) throw Error('ML-KEM recovery coefficients must be canonical words or null');
  const missing = input.flatMap((x, i) => x === null ? [i] : []), width = missing.length;
  if (width > 4) throw Error('ML-KEM recovery supports at most four erased words per polynomial');
  const base = kemNtt(input.map(x => x ?? 0), true);
  if (!width) { if (!Array.from(base).every(small)) throw Error('ML-KEM secret is not CBD eta=2'); return { polynomial: Int32Array.from(input), candidates: 1, erasures: 0 }; }
  const basis = missing.map(index => { const poly = new Int32Array(KEM_N); poly[index] = 1; return kemNtt(poly, true); });
  const indices = [], echelon = [];
  for (let i = 0; i < KEM_N && indices.length < width; i++) {
    let row = basis.map(poly => poly[i]);
    for (const { pivot, values } of echelon) { const factor = row[pivot]; row = row.map((value, j) => kemMod(value - factor * values[j])); }
    const pivot = row.findIndex(Boolean); if (pivot < 0) continue;
    const scale = inverse(row[pivot]); echelon.push({ pivot, values: row.map(value => kemMod(value * scale)) }); indices.push(i);
  }
  if (indices.length !== width) throw Error('ML-KEM recovery rank deficiency');
  const transform = invertMatrix(indices.map(i => basis.map(poly => poly[i]))), candidates = 5 ** width;
  let answer;
  for (let attempt = 0; attempt < candidates; attempt++) {
    let value = attempt;
    const rhs = indices.map(index => { const digit = value % 5 - 2; value = Math.floor(value / 5); return kemMod(digit - base[index]); });
    const erased = transform.map(row => kemMod(row.reduce((sum, coefficient, i) => sum + coefficient * rhs[i], 0)));
    let valid = true;
    for (let i = 0; i < KEM_N && valid; i++) valid = small(base[i] + erased.reduce((sum, coefficient, j) => sum + coefficient * basis[j][i], 0));
    if (valid) {
      if (answer) throw Error('ML-KEM ambiguous small-secret recovery');
      answer = Int32Array.from(input, x => x ?? 0); missing.forEach((index, i) => answer[index] = erased[i]);
    }
  }
  if (!answer) throw Error('ML-KEM no consistent CBD eta=2 secret');
  return { polynomial: answer, candidates, erasures: width };
}
