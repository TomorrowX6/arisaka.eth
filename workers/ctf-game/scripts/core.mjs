import { createHash, createHmac, createCipheriv, randomBytes } from 'node:crypto';

export const sha256 = (value) => createHash('sha256').update(value).digest();

export function seededRandom(seed, domain) {
  let counter = 0;
  return (length) => {
    const blocks = [];
    for (let size = 0; size < length; size += 32) {
      blocks.push(createHmac('sha256', seed).update(domain + ':' + counter++).digest());
    }
    return Buffer.concat(blocks).subarray(0, length);
  };
}

export function randomPath(random = randomBytes) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let value = '';
  while (value.length < 20) {
    for (const byte of random(32)) {
      if (byte < 252 && value.length < 20) value += alphabet[byte % alphabet.length];
    }
  }
  return value;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function packet(magic, message) {
  const data = Buffer.from(message, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(data));
  return Buffer.concat([Buffer.from(magic, 'hex'), length, data, checksum]);
}

export function seal(message, material, context, random = randomBytes) {
  const nonce = random(12);
  const cipher = createCipheriv('aes-256-gcm', sha256(material), nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
  return {
    format: 'afterglow-seal-v1',
    cipher: 'AES-256-GCM',
    keyDerivation: 'SHA-256(raw key material)',
    context,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function gfMul(a, b) {
  let value = 0;
  for (let bit = 0; bit < 8; bit++) {
    if (b & 1) value ^= a;
    const carry = a & 0x80;
    a = ((a << 1) & 255) ^ (carry ? 0x1b : 0);
    b >>>= 1;
  }
  return value;
}

export function splitSecret(secret, random = randomBytes) {
  const coefficients = Array.from({ length: 3 }, () => random(secret.length));
  return Array.from({ length: 4 }, (_, index) => {
    const x = index + 1;
    const y = Buffer.alloc(secret.length);
    for (let column = 0; column < secret.length; column++) {
      let value = coefficients[2][column];
      value = gfMul(value, x) ^ coefficients[1][column];
      value = gfMul(value, x) ^ coefficients[0][column];
      y[column] = gfMul(value, x) ^ secret[column];
    }
    return x.toString(16).padStart(2, '0') + '-' + y.toString('hex');
  });
}

export function pixelOrder(length, receipt) {
  let state = sha256(Buffer.from(receipt, 'ascii')).readUInt32LE(0) || 0x9e3779b9;
  const order = Uint32Array.from({ length }, (_, index) => index);
  for (let index = length - 1; index > 0; index--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const other = Math.floor(((state >>> 0) / 0x100000000) * (index + 1));
    const old = order[index];
    order[index] = order[other];
    order[other] = old;
  }
  return order;
}

export const curveOrder = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
export const mod = (value, modulus) => ((value % modulus) + modulus) % modulus;

export function inverse(value, modulus) {
  let a = mod(value, modulus);
  let b = modulus;
  let x = 1n;
  let y = 0n;
  while (b) {
    const quotient = a / b;
    [a, b] = [b, a % b];
    [x, y] = [y, x - quotient * y];
  }
  if (a !== 1n) throw new Error('Value is not invertible');
  return mod(x, modulus);
}

export const toInteger = (bytes) => BigInt('0x' + bytes.toString('hex'));
export const toBytes = (value) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
export const randomScalar = (random = randomBytes) => mod(toInteger(random(32)), curveOrder - 1n) + 1n;
