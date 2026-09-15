import { createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { openSeal } from '../decoders.mjs';
import { kemAssembleSecret, kemCheckSecret, kemDecapsulate, kemMod, kemRecoverPolynomial } from './mlkem-core.mjs';

// Only fixture recovery/tests import this reference. No noble imports and no
// producer helpers: standard vectors test the arithmetic independently.
const digest = bytes => createHash('sha256').update(bytes).digest();
function crc32c(bytes) {
  let out = -1;
  for (const byte of bytes) {
    out ^= byte;
    for (let bit = 0; bit < 8; bit++) out = (out >>> 1) ^ (-(out & 1) & 0x82f63b78);
  }
  return ~out >>> 0;
}

export function readMlkemCbor(input) {
  const bytes = Buffer.from(input); let at = 0, nodes = 0;
  if (bytes.length > 65536) throw Error('ML-KEM checkpoint CBOR size');
  const take = count => { if (at + count > bytes.length) throw Error('Truncated checkpoint CBOR'); const value = bytes.subarray(at, at + count); at += count; return value; };
  function read(depth = 0) {
    if (++nodes > 1000 || depth > 8) throw Error('ML-KEM checkpoint CBOR complexity');
    const tag = take(1)[0], major = tag >> 5, info = tag & 31;
    let n = BigInt(info);
    if (info >= 24) {
      if (info > 27) throw Error('Indefinite checkpoint CBOR');
      const size = 2 ** (info - 24), b = take(size); n = size === 8 ? b.readBigUInt64BE() : BigInt(b.readUIntBE(0, size));
      if (n < [24n, 256n, 65536n, 4294967296n][info - 24]) throw Error('Nonminimal checkpoint CBOR');
    }
    if (major === 0) return n;
    if (n > 65536n) throw Error('Checkpoint CBOR length');
    const length = Number(n);
    if (major === 2) return take(length);
    if (major === 3) return new TextDecoder('utf8', { fatal: true }).decode(take(length));
    if (major === 4) return Array.from({ length }, () => read(depth + 1));
    if (major === 5) {
      const out = Object.create(null);
      for (let i = 0; i < length; i++) { const key = read(depth + 1); if (typeof key !== 'string' || Object.hasOwn(out, key)) throw Error('Checkpoint CBOR map key'); out[key] = read(depth + 1); }
      return out;
    }
    throw Error('Checkpoint CBOR type');
  }
  const result = read(); if (at !== bytes.length) throw Error('Trailing checkpoint CBOR'); return result;
}

export function selectMlkemCheckpoint(files) {
  const settings = JSON.parse(files['format.json']);
  if (settings.format !== 'mlkem-masked-dma-v1' || settings.q !== 3329 || settings.n !== 256 || settings.k !== 3
    || settings.eta1 !== 2 || settings.eta2 !== 2 || settings.du !== 10 || settings.dv !== 4) throw Error('ML-KEM fixture parameters');
  const authority = createPublicKey({ key: files['attestor.pub.der'], type: 'spki', format: 'der' });
  const journal = readMlkemCbor(files['checkpoints.cbor']), commits = new Map();
  if (!Array.isArray(journal) || journal.length > 16) throw Error('ML-KEM checkpoint journal');
  for (const row of journal) {
    if (!Array.isArray(row) || row.length !== 2 || !Buffer.isBuffer(row[0]) || !Buffer.isBuffer(row[1]) || row[1].length !== 64) throw Error('ML-KEM checkpoint record');
    if (!verify(null, Buffer.concat([Buffer.from('archive/mlkem/checkpoint\0'), row[0]]), authority, row[1])) continue;
    const record = readMlkemCbor(row[0]);
    if (record.protocol !== 'mlkem-dma-v1' || typeof record.epoch !== 'bigint' || !['commit', 'prepare'].includes(record.phase)
      || !Buffer.isBuffer(record.provider) || record.provider.length !== 32 || !Buffer.isBuffer(record.wiring) || record.wiring.length !== 32) throw Error('ML-KEM signed checkpoint schema');
    if (record.phase !== 'commit') continue;
    if (commits.has(record.epoch) && (!commits.get(record.epoch).provider.equals(record.provider) || !commits.get(record.epoch).wiring.equals(record.wiring))) throw Error('Conflicting ML-KEM committed checkpoint');
    commits.set(record.epoch, record);
  }
  const committed = [...commits.values()].sort((a, b) => a.epoch < b.epoch ? 1 : a.epoch > b.epoch ? -1 : 0)[0];
  if (!committed) throw Error('No authenticated ML-KEM commit');
  const wiring = Buffer.from(files['wiring.rom']);
  if (wiring.length !== 6 || !digest(wiring).equals(committed.wiring)) throw Error('ML-KEM wiring authentication');
  const cache = Buffer.from(files['provider-cache.bin']);
  if (cache.length < 16 || cache.toString('ascii', 0, 8) !== 'MKCACHE1' || cache.readUInt16LE(8) !== 1264 || cache.readUInt16LE(10) > 16
    || cache.length !== 16 + cache.readUInt16LE(10) * 1264 || crc32c(cache.subarray(0, 12)) !== cache.readUInt32LE(12)) throw Error('ML-KEM provider cache header');
  let provider;
  for (let at = 16; at < cache.length; at += 1264) {
    const record = cache.subarray(at, at + 1264);
    if (!digest(record).equals(committed.provider)) continue;
    if (record.toString('ascii', 0, 8) !== 'MLKEM768' || record.readBigUInt64LE(8) !== committed.epoch) throw Error('ML-KEM provider epoch');
    provider = record;
  }
  if (!provider) throw Error('Authenticated ML-KEM provider state is missing');
  const publicKey = provider.subarray(16, 1200), keyHash = provider.subarray(1200, 1232);
  if (!timingSafeEqual(createHash('sha3-256').update(publicKey).digest(), keyHash)) throw Error('ML-KEM provider key hash');
  return { epoch: committed.epoch, provider, publicKey, z: provider.subarray(1232), wiring };
}

export function recoverMlkemMaterial(files) {
  const state = selectMlkemCheckpoint(files), capture = Buffer.from(files['dma.capture.bin']);
  if (capture.length < 24 || capture.toString('ascii', 0, 8) !== 'MLKDMA01' || capture.readUInt16LE(8) !== 64 || capture.readUInt16LE(10) > 4096
    || capture.length !== 24 + capture.readUInt16LE(10) * 64 || capture.readUInt16LE(12) !== 3329 || capture.readUInt16LE(14) !== 256
    || capture.readUInt32LE(16) !== 0 || crc32c(capture.subarray(0, 20)) !== capture.readUInt32LE(20)) throw Error('ML-KEM DMA header');
  const banks = Array.from({ length: 3 }, () => Array.from({ length: 2 }, () => Array(256).fill(null))), blocks = new Map();
  let rejectedRecords = 0, duplicateRecords = 0;
  for (let at = 24; at < capture.length; at += 64) {
    const row = capture.subarray(at, at + 64);
    if (crc32c(row.subarray(0, 60)) !== row.readUInt32LE(60)) { rejectedRecords++; continue; }
    if (row.toString('ascii', 0, 2) !== 'MD' || row[2] !== 1 || row[3] > 1 || row[16] > 2 || row[17] > 15) throw Error('ML-KEM DMA record schema');
    if (row.readBigUInt64LE(4) !== state.epoch) continue;
    const bank = row[3], polynomial = row[16], block = row[17], valid = row.readUInt16LE(18), id = polynomial + '/' + bank + '/' + block;
    const data = row.subarray(28, 60);
    if (blocks.has(id)) {
      const previous = blocks.get(id);
      if (previous.valid !== valid || !previous.data.equals(data)) throw Error('Conflicting ML-KEM DMA duplicate');
      duplicateRecords++; continue;
    }
    blocks.set(id, { valid, data });
    for (let word = 0; word < 16; word++) {
      if (!(valid >> word & 1)) continue;
      let bits = block * 16 + word, reversed = 0;
      for (let i = 0; i < 8; i++) { reversed = reversed << 1 | bits & 1; bits >>>= 1; }
      const index = (reversed * 17 + state.wiring[polynomial * 2 + bank]) % 256;
      const value = data.readInt16LE(word * 2);
      if (value < -1664 || value > 1664) throw Error('Non-centered ML-KEM Montgomery word');
      banks[polynomial][bank][index] = kemMod(value * 169); // (2^16)^-1 mod 3329
    }
  }
  const recovery = banks.map(([masked, mask]) => {
    if (masked.some(value => value === null)) throw Error('ML-KEM masked share is incomplete');
    return kemRecoverPolynomial(masked.map((value, index) => mask[index] === null ? null : kemMod(value - mask[index])));
  });
  const secret = recovery.map(item => item.polynomial);
  if (!kemCheckSecret(secret, state.publicKey)) throw Error('ML-KEM recovered secret fails public-key relation');
  const secretKey = kemAssembleSecret(secret, state.publicKey, state.z);
  const a = Buffer.from(files['session-a.ct']), b = Buffer.from(files['session-b.ct']);
  const decapsulations = [kemDecapsulate(a, secretKey), kemDecapsulate(b, secretKey)];
  if (!decapsulations[0].accepted || decapsulations[1].accepted) throw Error('ML-KEM captured session authentication state');
  const material = Buffer.concat([Buffer.from('archive/mlkem/combine\0'), digest(state.provider), digest(a), decapsulations[0].sharedSecret, digest(b), decapsulations[1].sharedSecret]);
  return { material, epoch: state.epoch.toString(), secretKey, sharedSecrets: decapsulations.map(item => item.sharedSecret), messages: decapsulations.map(item => item.message),
    accepted: decapsulations.map(item => item.accepted), erasures: recovery.map(item => item.erasures), candidates: recovery.map(item => item.candidates), rejectedRecords, duplicateRecords };
}

export function decodeMlkemEvidence(files) { return openSeal(JSON.parse(files['capsule.json']), recoverMlkemMaterial(files).material); }
