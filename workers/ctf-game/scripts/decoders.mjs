import { recoverMachineInput } from './expert/vm-decoder.mjs';
import { recoverAffineScalar } from './expert/signature-decoder.mjs';
// Operator-side reference decoders. This module is never shipped to players.
// Deliberately decode the actual artifacts rather than importing their generator.
import { createHash, createDecipheriv, createECDH, createPublicKey, verify } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import jsQR from 'jsqr';

const hash = (bytes) => createHash('sha256').update(bytes).digest();
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

function checksum(bytes) {
  let c = -1;
  for (const byte of bytes) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ -1) >>> 0;
}

export function openSeal(seal, material) {
  const decipher = createDecipheriv('aes-256-gcm', hash(material), Buffer.from(seal.nonce, 'base64'));
  decipher.setAAD(Buffer.from(seal.context, 'utf8'));
  decipher.setAuthTag(Buffer.from(seal.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(seal.ciphertext, 'base64')), decipher.final(),
  ]).toString('utf8'));
}

export function decodeTerminal(text) {
  const hex = text.match(/[a-f0-9]{40}/)?.[0];
  requireThat(hex, 'No mirrored hexadecimal letter found');
  return Buffer.from(hex, 'hex').reverse().toString('ascii');
}

export function decodeMidi(bytes) {
  requireThat(bytes.toString('ascii', 0, 4) === 'MThd', 'Not MIDI');
  let cursor = 8 + bytes.readUInt32BE(4);
  const notes = [];
  while (cursor < bytes.length) {
    requireThat(bytes.toString('ascii', cursor, cursor + 4) === 'MTrk', 'Missing MIDI track');
    const end = cursor + 8 + bytes.readUInt32BE(cursor + 4);
    cursor += 8;
    let status = 0;
    let name = '';
    const track = [];
    const vlq = () => {
      let value = 0;
      let byte;
      do { byte = bytes[cursor++]; value = value * 128 + (byte & 127); } while (byte & 128);
      return value;
    };
    while (cursor < end) {
      vlq();
      if (bytes[cursor] & 128) status = bytes[cursor++];
      if (status === 0xff) {
        const type = bytes[cursor++];
        const length = vlq();
        if (type === 3) name = bytes.toString('ascii', cursor, cursor + length);
        cursor += length;
      } else if (status === 0xf0 || status === 0xf7) {
        const length = vlq();
        cursor += length;
      } else {
        const a = bytes[cursor++];
        const b = (status & 0xe0) === 0xc0 ? 0 : bytes[cursor++];
        if ((status & 0xf0) === 0x90 && b > 0 && (status & 15) === 2) track.push(a);
      }
    }
    notes.push(...track);
  }
  requireThat(notes.length === 40, 'Expected forty letter notes');
  const output = [];
  for (let i = 0; i < notes.length; i += 2) {
    const a = notes[i] - 60;
    const b = notes[i + 1] - 60;
    requireThat(a >= 0 && a < 16 && b >= 0 && b < 16, 'Invalid nibble pitch');
    output.push((a << 4) | b);
  }
  return Buffer.from(output).toString('ascii');
}

export function decodePng(bytes) {
  requireThat(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Not PNG');
  let width, height;
  const metadata = {};
  const chunks = [];
  for (let cursor = 8; cursor < bytes.length;) {
    const size = bytes.readUInt32BE(cursor);
    const kind = bytes.toString('ascii', cursor + 4, cursor + 8);
    const data = bytes.subarray(cursor + 8, cursor + 8 + size);
    requireThat(checksum(bytes.subarray(cursor + 4, cursor + 8 + size)) === bytes.readUInt32BE(cursor + 8 + size), 'PNG checksum failed');
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      requireThat(data[8] === 8 && data[9] === 6 && data[12] === 0, 'Expected non-interlaced RGBA8');
    }
    if (kind === 'IDAT') chunks.push(data);
    if (kind === 'tEXt') {
      const split = data.indexOf(0);
      metadata[data.toString('latin1', 0, split)] = data.toString('latin1', split + 1);
    }
    cursor += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const data = new Uint8ClampedArray(width * height * 4);
  const stride = width * 4;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return distances[0] <= distances[1] && distances[0] <= distances[2] ? a : distances[1] <= distances[2] ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= 4 ? data[i - 4] : 0;
      const b = y ? data[i - stride] : 0;
      const c = y && x >= 4 ? data[i - stride - 4] : 0;
      const prediction = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      requireThat(prediction !== undefined, 'Invalid PNG filter');
      data[i] = (raw[y * (stride + 1) + x + 1] + prediction) & 255;
    }
  }
  return { width, height, data, metadata };
}

export function assembleQr(files) {
  let output;
  let width;
  const slots = new Set();
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith('.png')) continue;
    const tile = decodePng(bytes);
    width = tile.width * 3;
    output ??= new Uint8ClampedArray(width * width * 4).fill(255);
    let gray = Number(tile.metadata['Scan-Index']);
    let slot = 0;
    for (; gray; gray >>>= 1) slot ^= gray;
    requireThat(slot >= 0 && slot < 9 && slot !== 4 && !slots.has(slot), 'Invalid QR tile slot');
    slots.add(slot);
    const turns = Number(tile.metadata['Scan-Turn']);
    for (let y = 0; y < tile.height; y++) {
      for (let x = 0; x < tile.width; x++) {
        let tx = x;
        let ty = y;
        for (let turn = 0; turn < turns; turn++) [tx, ty] = [ty, tile.width - 1 - tx];
        const destination = ((Math.floor(slot / 3) * tile.width + ty) * width + (slot % 3) * tile.width + tx) * 4;
        output.set(tile.data.subarray((y * tile.width + x) * 4, (y * tile.width + x) * 4 + 4), destination);
      }
    }
  }
  requireThat(slots.size === 8, 'Expected eight surviving fragments');
  return { width, data: output };
}

export function decodeQr(files) {
  const restored = assembleQr(files);
  const result = jsQR(restored.data, restored.width, restored.width, { inversionAttempts: 'dontInvert' });
  requireThat(result?.data, 'Restored QR does not decode with the missing centre');
  return result.data;
}

function unpackFrame(bytes, magic) {
  requireThat(bytes.subarray(0, 2).toString('hex') === magic, 'Bad frame sync');
  const length = bytes.readUInt16BE(2);
  const data = bytes.subarray(4, 4 + length);
  requireThat(data.length === length && checksum(data) === bytes.readUInt32BE(4 + length), 'Frame checksum failed');
  const [label, code, receipt] = data.toString('utf8').trim().split('\n');
  return { label, code, receipt };
}

export function decodeWave(bytes) {
  let pcm;
  let rate;
  for (let cursor = 12; cursor < bytes.length;) {
    const kind = bytes.toString('ascii', cursor, cursor + 4);
    const size = bytes.readUInt32LE(cursor + 4);
    if (kind === 'fmt ') {
      requireThat(bytes.readUInt16LE(cursor + 8) === 1 && bytes.readUInt16LE(cursor + 10) === 2 && bytes.readUInt16LE(cursor + 22) === 16, 'Expected stereo PCM16');
      rate = bytes.readUInt32LE(cursor + 12);
    }
    if (kind === 'data') pcm = bytes.subarray(cursor + 8, cursor + 8 + size);
    cursor += 8 + size + (size & 1);
  }
  requireThat(pcm && rate, 'Missing WAV data');
  const difference = Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readInt16LE(i * 4) - pcm.readInt16LE(i * 4 + 2));
  const size = rate / 200;
  const start = Math.floor(difference.findIndex((value) => Math.abs(value) > 1000) / size) * size;
  const chips = [];
  for (let i = start; i + size <= difference.length; i += size) {
    const energy = (frequency) => {
      let re = 0;
      let im = 0;
      for (let t = 0; t < size; t++) {
        re += difference[i + t] * Math.cos(2 * Math.PI * frequency * t / rate);
        im += difference[i + t] * Math.sin(2 * Math.PI * frequency * t / rate);
      }
      return re * re + im * im;
    };
    const low = energy(800);
    const high = energy(1600);
    if (low + high < 1e5) break;
    chips.push(high > low ? 1 : 0);
  }
  requireThat(chips.length % 16 === 0, 'Partial Manchester byte');
  const decoded = Buffer.alloc(chips.length / 16);
  for (let bit = 0; bit < chips.length / 2; bit++) {
    requireThat(chips[bit * 2] !== chips[bit * 2 + 1], 'Manchester transition missing');
    decoded[bit >>> 3] |= chips[bit * 2] << (7 - bit % 8);
  }
  const sync = decoded.indexOf(Buffer.from('d391', 'hex'));
  requireThat(sync >= 0, 'WAV frame sync missing');
  return unpackFrame(decoded.subarray(sync), 'd391');
}

export function decodeImages(before, after, previousReceipt) {
  const a = decodePng(before);
  const b = decodePng(after);
  requireThat(a.width === b.width && a.height === b.height, 'Mismatched images');
  let state = hash(Buffer.from(previousReceipt, 'ascii')).readUInt32LE(0) || 0x9e3779b9;
  const positions = Array.from({ length: a.width * a.height }, (_, i) => i);
  for (let i = positions.length - 1; i > 0; i--) {
    state = state ^ (state << 13);
    state = state ^ (state >>> 17);
    state = state ^ (state << 5);
    const j = Math.floor((state >>> 0) * (i + 1) / 4294967296);
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const frame = Buffer.alloc(Math.floor(positions.length / 8));
  for (let bit = 0; bit < frame.length * 8; bit++) {
    const offset = positions[bit] * 4 + 2;
    frame[bit >>> 3] |= ((a.data[offset] ^ b.data[offset]) & 1) << (7 - bit % 8);
  }
  return unpackFrame(frame, 'a707');
}

const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const positive = (value, modulus = n) => (value % modulus + modulus) % modulus;
function power(base, exponent, modulus) {
  let result = 1n;
  for (base = positive(base, modulus); exponent > 0; exponent >>= 1n, base = base * base % modulus) {
    if (exponent & 1n) result = result * base % modulus;
  }
  return result;
}
const inv = (value) => power(value, n - 2n, n);

export const signatureMaterial = recoverAffineScalar;

export function decodeSignatures(ledger, sealed) {
  return openSeal(sealed, signatureMaterial(ledger));
}

export async function decodeWasm(bytes, sealed) {
  return openSeal(sealed, await recoverMachineInput(bytes));
}

function multiply(a, b) {
  let result = 0;
  while (b) {
    if (b & 1) result ^= a;
    a <<= 1;
    if (a & 256) a ^= 0x11b;
    b >>= 1;
  }
  return result;
}
function fieldInverse(a) {
  requireThat(a !== 0, 'Repeated share coordinate');
  let result = 1;
  for (let i = 0; i < 254; i++) result = multiply(result, a);
  return result;
}

export function reconstruct(shares) {
  requireThat(shares.length === 4 && shares.every((s) => /^[0-9a-f]{2}-[0-9a-f]{32}$/.test(s)), 'Four valid stubs are required');
  const points = shares.map((s) => ({ x: parseInt(s.slice(0, 2), 16), y: Buffer.from(s.slice(3), 'hex') }));
  requireThat(new Set(points.map((p) => p.x)).size === 4 && points.every((p) => p.x > 0), 'Four distinct nonzero coordinates are required');
  return Buffer.from(Array.from({ length: 16 }, (_, i) => points.reduce((sum, p) => {
    let term = p.y[i];
    for (const other of points) {
      if (other !== p) term = multiply(term, multiply(other.x, fieldInverse(other.x ^ p.x)));
    }
    return sum ^ term;
  }, 0)));
}
