import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { seal } from '../core.mjs';

// The producer uses the pinned noble implementation. Recovery has its own
// FIPS 203 arithmetic and never imports this module or noble.
const Q = 3329, R = 2285;
const digest = bytes => createHash('sha256').update(bytes).digest();
const h = bytes => createHash('sha3-256').update(bytes).digest();
const mod = value => (value % Q + Q) % Q;
const reverse8 = value => { let out = 0; for (let i = 0; i < 8; i++, value >>>= 1) out = out * 2 + (value & 1); return out; };
export function mlkemCrc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0x82f63b78 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

// Definite, deterministic CBOR with uint64 epochs. Signature input is the raw
// payload bstr, not an implementation-specific JSON or re-encoding of its map.
export function encodeMlkemCbor(value) {
  const head = (major, number) => {
    const n = BigInt(number), tag = major << 5;
    if (n < 0n || n > 0xffffffffffffffffn) throw Error('Checkpoint CBOR uint64');
    if (n < 24n) return Buffer.from([tag | Number(n)]);
    const size = n < 256n ? 1 : n < 65536n ? 2 : n < 4294967296n ? 4 : 8;
    const bytes = Buffer.alloc(size + 1); bytes[0] = tag | ({ 1: 24, 2: 25, 4: 26, 8: 27 })[size];
    if (size === 8) bytes.writeBigUInt64BE(n, 1); else bytes.writeUIntBE(Number(n), 1, size); return bytes;
  };
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (typeof value === 'bigint' || Number.isSafeInteger(value)) return head(0, value);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeMlkemCbor)]);
  const entries = Object.entries(value).map(([key, item]) => [encodeMlkemCbor(key), encodeMlkemCbor(item)]);
  entries.sort((a, b) => a[0].length - b[0].length || Buffer.compare(a[0], b[0]));
  return Buffer.concat([head(5, entries.length), ...entries.flat()]);
}

function secretWords(bytes) {
  // Standard ByteDecode_12, independent of the maintenance reference codec.
  const words = [];
  for (let at = 0; at < 1152; at += 3) words.push(bytes[at] | (bytes[at + 1] & 15) << 8, bytes[at + 1] >> 4 | bytes[at + 2] << 4);
  return [words.slice(0, 256), words.slice(256, 512), words.slice(512)];
}

export function mlkemEvidence(code, random) {
  const fieldWord = () => { let value; do { value = random(2).readUInt16LE(); } while (value >= 63251); return value % Q; };
  const wiring = random(6), authority = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), random(32)]), format: 'der', type: 'pkcs8' });
  const firstEpoch = 9007199254740992n + BigInt(random(2).readUInt16LE()) * 4n;
  const snapshots = Array.from({ length: 3 }, (_, index) => {
    const { publicKey, secretKey } = ml_kem768.keygen(random(64)), epoch = firstEpoch + BigInt(index);
    const provider = Buffer.alloc(1264); provider.write('MLKEM768'); provider.writeBigUInt64LE(epoch, 8);
    provider.set(publicKey, 16); provider.set(h(publicKey), 1200); provider.set(secretKey.subarray(2368), 1232);
    return { epoch, publicKey, secretKey, provider, index };
  });
  const current = snapshots[1], { cipherText, sharedSecret } = ml_kem768.encapsulate(current.publicKey, random(32));
  const a = Buffer.from(cipherText), b = Buffer.from(a); b[0] ^= 1;
  const rejectedSecret = Buffer.from(ml_kem768.decapsulate(b, current.secretKey));
  const expectedRejection = createHash('shake256', { outputLength: 32 }).update(current.secretKey.subarray(2368)).update(b).digest();
  if (!rejectedSecret.equals(expectedRejection)) throw Error('ML-KEM fixture must exercise implicit rejection');
  const material = Buffer.concat([Buffer.from('archive/mlkem/combine\0'), digest(current.provider), digest(a), sharedSecret, digest(b), rejectedSecret]);
  const statements = snapshots.map((snapshot, index) => {
    const payload = encodeMlkemCbor({ protocol: 'mlkem-dma-v1', epoch: snapshot.epoch, phase: index === 2 ? 'prepare' : 'commit', provider: digest(snapshot.provider), wiring: digest(wiring) });
    return [payload, sign(null, Buffer.concat([Buffer.from('archive/mlkem/checkpoint\0'), payload]), authority)];
  });
  const forged = encodeMlkemCbor({ protocol: 'mlkem-dma-v1', epoch: firstEpoch + 3n, phase: 'commit', provider: digest(snapshots[2].provider), wiring: digest(wiring) });
  const invalid = sign(null, Buffer.concat([Buffer.from('archive/mlkem/checkpoint\0'), forged]), authority); invalid[21] ^= 1;
  statements.push([forged, invalid], statements[1].map(value => Buffer.from(value)));
  const records = []; let sequence = 0xffffffc0;
  for (const snapshot of snapshots) {
    const secret = secretWords(snapshot.secretKey);
    for (let polynomial = 0; polynomial < 3; polynomial++) {
      const masks = Array.from({ length: 256 }, fieldWord), missing = new Set();
      if (snapshot.index === 1) while (missing.size < 4) missing.add(random(1)[0]);
      for (let bank = 0; bank < 2; bank++) for (let block = 0; block < 16; block++) {
        const record = Buffer.alloc(64); record.write('MD'); record[2] = 1; record[3] = bank; record.writeBigUInt64LE(snapshot.epoch, 4);
        record.writeUInt32LE(sequence++ >>> 0, 12); record[16] = polynomial; record[17] = block; let valid = 0xffff;
        record.writeBigUInt64LE(18014398509481985n + BigInt(sequence >>> 0) * 4099n, 20);
        for (let word = 0; word < 16; word++) {
          const physical = block * 16 + word, index = (17 * reverse8(physical) + wiring[polynomial * 2 + bank]) & 255;
          let value = mod((bank ? masks[index] : secret[polynomial][index] + masks[index]) * R);
          if (value > Q / 2) value -= Q;
          if (bank === 1 && missing.has(index)) { valid &= ~(1 << word); value = 32767; }
          record.writeInt16LE(value, 28 + word * 2);
        }
        record.writeUInt16LE(valid, 18); record.writeUInt32LE(mlkemCrc32c(record.subarray(0, 60)), 60); records.push(record);
      }
    }
  }
  records.push(Buffer.from(records[115]), Buffer.from(records[177]));
  const badCrc = Buffer.from(records[109]); badCrc[31] ^= 1; records.push(badCrc);
  const shuffle = rows => { for (let i = rows.length - 1; i; i--) { const j = random(2).readUInt16LE() % (i + 1); [rows[i], rows[j]] = [rows[j], rows[i]]; } return rows; };
  const header = Buffer.alloc(24); header.write('MLKDMA01'); header.writeUInt16LE(64, 8); header.writeUInt16LE(records.length, 10);
  header.writeUInt16LE(Q, 12); header.writeUInt16LE(256, 14); header.writeUInt32LE(mlkemCrc32c(header.subarray(0, 20)), 20);
  const cache = Buffer.alloc(16); cache.write('MKCACHE1'); cache.writeUInt16LE(1264, 8); cache.writeUInt16LE(3, 10); cache.writeUInt32LE(mlkemCrc32c(cache.subarray(0, 12)), 12);
  return {
    'dma.capture.bin': Buffer.concat([header, ...shuffle(records)]),
    'provider-cache.bin': Buffer.concat([cache, ...shuffle(snapshots.map(item => item.provider))]),
    'checkpoints.cbor': encodeMlkemCbor(shuffle(statements)),
    'attestor.pub.der': createPublicKey(authority).export({ format: 'der', type: 'spki' }),
    'wiring.rom': wiring,
    'session-a.ct': a,
    'session-b.ct': b,
    'format.json': JSON.stringify({
      format: 'mlkem-masked-dma-v1', standard: 'FIPS 203 ML-KEM-768 (final, not round-3 Kyber)', q: Q, n: 256, k: 3, eta1: 2, eta2: 2, du: 10, dv: 4,
      ring: 'Z_3329[X]/(X^256+1); incomplete NTT uses zeta=17 and 7-bit reversal. Multiply pairs modulo X^2-zeta^(2*BitRev7(i)+1). Inverse scaling is 128^-1, not 256^-1.',
      hashes: 'H=SHA3-256; G=SHA3-512; J=SHAKE256 with 32-byte output. SampleNTT uses SHAKE128(rho || octet(j) || octet(i)) for A_hat[i][j].',
      checkpoint: 'CBOR array of [payload:bstr, signature:bstr]. Ed25519 over UTF8("archive/mlkem/checkpoint") || 00 || raw payload. Payload map: protocol, epoch:uint64, phase, provider:SHA256(provider record), wiring:SHA256(wiring.rom). Choose the greatest authenticated COMMITTED epoch; prepare is not a commit. Same-epoch conflicting commitments are invalid.',
      memory: 'Per polynomial: bank 0 = s_hat + mask mod q, bank 1 = mask. Independent additive masks at every epoch. DMA stores centered signed Montgomery residues R*x mod q, R=2^16. Invalid words have no numerical meaning. At most four mask words per current polynomial are absent. Unpack the FIPS 203 incomplete NTT, not a 256-point cyclic DFT.',
      secret: 's_hat is the NTT of a CBD eta1 secret. The public-key equation is t_hat = A_hat*s_hat + e_hat, with e also CBD eta1. A_hat sampling, quadratic base multiplication and packing are FIPS 203. No key-generation seed was captured.',
      decapsulation: 'Assemble dk = ByteEncode_12(s_hat[0..2]) || ek || H(ek) || z. Use FIPS 203 decapsulation including input checks, reencryption comparison and J(z || c) implicit rejection. Do not substitute K-PKE decryption for ML-KEM.',
      capsuleMaterial: 'UTF8("archive/mlkem/combine") || 00 || SHA256(selected provider record) || SHA256(session-a.ct) || Decaps(dk, session-a.ct) || SHA256(session-b.ct) || Decaps(dk, session-b.ct). All hashes/secrets are raw bytes; outer capsule hashes this entire material once with SHA-256.',
    }, null, 2) + '\n',
    'capture.h': [
      '#include <stdint.h>', '#pragma pack(push, 1)',
      '/* All integer fields little-endian. CRC32C/Castagnoli, reflected 0x82f63b78, init/xorout 0xffffffff. */',
      'struct dma_header { char magic[8]; uint16_t stride, count, q, n; uint32_t reserved, crc; }; /* MLKDMA01, 64, count, 3329, 256, 0; CRC(first 20) */',
      'struct dma_record { char magic[2]; uint8_t version, bank; uint64_t epoch; uint32_t sequence;',
      '    uint8_t polynomial, block; uint16_t valid; uint64_t ticks; int16_t words[16]; uint32_t crc; }; /* MD, 1; CRC(first 60) */',
      'struct cache_header { char magic[8]; uint16_t stride, count; uint32_t crc; }; /* MKCACHE1, 1264, count; CRC(first 12) */',
      'struct provider { char magic[8]; uint64_t epoch; uint8_t ek[1184], h_ek[32], z[32]; }; /* MLKEM768; H = SHA3-256 */',
      '#pragma pack(pop)',
      '/* DMA duplicate acquisitions are allowed. Invalid transport CRCs are discarded. A valid CRC is not authentication.',
      ' * valid bit i refers to words[i]; unknown words are not zero. sequence wraps uint32; ticks/epoch require uint64.',
      ' * Never combine polynomial shares across different epochs or banks. Conflicting duplicate words are invalid. */', '',
    ].join('\n'),
    'driver.c': [
      '#include <stdint.h>',
      '/* wiring.rom: uint8_t offsets[3][2], row-major. This maps a captured physical word to an NTT word. */',
      'uint8_t reverse8(uint8_t x) { uint8_t out=0; for(unsigned i=0;i<8;i++){out=(out<<1)|(x&1);x>>=1;} return out; }',
      'uint8_t ntt_index(unsigned block, unsigned word, unsigned poly, unsigned bank, const uint8_t rom[6]) {',
      '    return (uint8_t)(17u*reverse8((uint8_t)(block*16u+word)) + rom[poly*2u+bank]);',
      '}',
      'int16_t store_residue(uint16_t value) {',
      '    uint16_t r=(uint32_t)value*2285u%3329u;',
      '    return r>1664 ? (int16_t)(r-3329) : (int16_t)r;',
      '}', '',
    ].join('\n'),
    'capsule.json': JSON.stringify(seal({ code }, material, 'archive/mlkem/masked-checkpoint', random), null, 2) + '\n',
  };
}
