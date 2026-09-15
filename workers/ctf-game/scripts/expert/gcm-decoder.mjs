const ONE = 1n << 127n;
export function multiply(a, b) {
  let z = 0n, v = a;
  for (let i = 127n; i >= 0n; i--) { if (b >> i & 1n) z ^= v; v = v >> 1n ^ (v & 1n ? 0xe1000000000000000000000000000000n : 0n); }
  return z;
}
function inverse(value) {
  if (!value) throw Error('Zero inverse');
  let result = ONE, power = (1n << 128n) - 2n;
  while (power) { if (power & 1n) result = multiply(result, value); value = multiply(value, value); power >>= 1n; }
  return result;
}
const trim = p => { while (p.length && !p.at(-1)) p.pop(); return p; };
function remainder(a, b) {
  a = [...a]; const factor = inverse(b.at(-1));
  while (a.length >= b.length) { const offset = a.length - b.length, scale = multiply(a.at(-1), factor); b.forEach((c, i) => { a[offset + i] ^= multiply(c, scale); }); trim(a); }
  return a;
}
function gcd(a, b) {
  while (b.length) [a, b] = [b, remainder(a, b)];
  const scale = inverse(a.at(-1)); return a.map(c => multiply(c, scale));
}
const integer = bytes => BigInt('0x' + Buffer.from(bytes).toString('hex'));
const bytes = value => Buffer.from(value.toString(16).padStart(32, '0'), 'hex');
function polynomial(aad, ciphertext) {
  const blocks = [];
  for (const input of [aad, ciphertext]) for (let i = 0; i < input.length; i += 16) { const block = Buffer.alloc(16); input.copy(block, 0, i, i + 16); blocks.push(integer(block)); }
  const sizes = Buffer.alloc(16); sizes.writeBigUInt64BE(BigInt(aad.length * 8)); sizes.writeBigUInt64BE(BigInt(ciphertext.length * 8), 8);
  return [0n, integer(sizes), ...blocks.reverse()];
}
const evaluate = (p, x) => p.reduceRight((value, c) => multiply(value, x) ^ c, 0n);

export function recoverGcmState(capture) {
  const records = capture.records.map(record => ({ ...record, aad: Buffer.from(record.aad, 'hex'), ciphertext: Buffer.from(record.ciphertext, 'hex'), plaintext: Buffer.from(record.plaintext, 'hex'), tag: integer(Buffer.from(record.tag, 'hex')) }));
  if (new Set(records.map(record => record.nonce)).size !== 1 || records.length < 3) throw Error('Insufficient nonce collision');
  const first = polynomial(records[0].aad, records[0].ciphertext); let common;
  for (const record of records.slice(1)) {
    const p = polynomial(record.aad, record.ciphertext), difference = Array.from({length: Math.max(p.length, first.length)}, (_, i) => (p[i] || 0n) ^ (first[i] || 0n));
    difference[0] ^= record.tag ^ records[0].tag; trim(difference);
    common = common ? gcd(common, difference) : difference;
  }
  if (common.length !== 2) throw Error('Authentication subkey is not unique');
  const h = multiply(common[0], inverse(common[1]));
  const mask = records[0].tag ^ evaluate(first, h);
  for (const record of records) if ((record.tag ^ evaluate(polynomial(record.aad, record.ciphertext), h)) !== mask) throw Error('Inconsistent authentication capture');
  const longest = records.reduce((a, b) => a.ciphertext.length > b.ciphertext.length ? a : b);
  const stream = Buffer.from(longest.ciphertext.map((byte, i) => byte ^ longest.plaintext[i]));
  return { h, mask, stream };
}

export function forgeGcmToken(capture, binding) {
  const { h, mask, stream } = recoverGcmState(capture);
  const plaintext = Buffer.from(JSON.stringify({ uid: 0, scope: 'release', binding }));
  if (plaintext.length > stream.length) throw Error('Insufficient keystream');
  const ciphertext = Buffer.from(plaintext.map((byte, i) => byte ^ stream[i]));
  const tag = mask ^ evaluate(polynomial(Buffer.from('archive/access/v3'), ciphertext), h);
  return Buffer.concat([ciphertext, bytes(tag)]).toString('hex');
}
