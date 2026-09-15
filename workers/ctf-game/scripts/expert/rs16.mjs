import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { crc32, seal } from '../core.mjs';

export function rs16Multiply(a, b) {
  let out = 0;
  for (let bit = 0; bit < 16; bit++) { if (b & 1) out ^= a; b >>>= 1; a <<= 1; if (a & 65536) a ^= 0x1100b; }
  return out;
}
const pow = (a, n) => { let result = 1; for (; n; n >>>= 1, a = rs16Multiply(a, a)) if (n & 1) result = rs16Multiply(result, a); return result; };
const tlv = (tag, data) => { if (data.length >= 128) throw Error('DER fixture size'); return Buffer.concat([Buffer.from([tag, data.length]), data]); };
const u16le = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const step = n => (n >>> 1) ^ (n & 1 ? 0xb400 : 0);

export const rs16CustodyMaterial = random => random(32);

export function rs16Evidence(code, random) {
  const n = 63, k = 31, lanes = 4, material = rs16CustodyMaterial(random), basis = Array.from({ length: 16 }, (_, i) => 1 << i);
  for (let i = 0; i < 128; i++) {
    const a = random(1)[0] % 16, b = (a + 1 + random(1)[0] % 15) % 16;
    basis[a] ^= basis[b]; if (i % 3 === 0) [basis[a], basis[b]] = [basis[b], basis[a]];
  }
  const affine = random(2).readUInt16LE(), whitening = random(2).readUInt16LE();
  const mapped = value => basis.reduce((word, column, bit) => word ^ (value >> bit & 1 ? column : 0), 0);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), random(32)]), format: 'der', type: 'pkcs8' });
  const serialBytes = random(8); let first = 0; while (first < 7 && serialBytes[first] === 0) first++;
  const positive = serialBytes[first] & 128 ? Buffer.concat([Buffer.from([0]), serialBytes.subarray(first)]) : serialBytes.subarray(first);
  const serial = tlv(2, positive), secret = tlv(4, material);
  const signature = sign(null, Buffer.concat([Buffer.from('archive/rs16/proof\0'), serial, secret]), key);
  const der = tlv(0x30, Buffer.concat([serial, secret, tlv(3, Buffer.concat([Buffer.from([0]), signature]))]));
  const message = Buffer.concat([Buffer.from('S16\x01'), u16le(der.length), u16le(0), der, random(k * lanes * 2 - 8 - der.length)]);
  const coefficients = Array.from({ length: lanes }, (_, lane) => Array.from({ length: k }, (_, index) => message.readUInt16LE((index * lanes + lane) * 2)));
  const start = random(2).readUInt16LE() % 65535, indices = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = random(2).readUInt16LE() % (i + 1); [indices[i], indices[j]] = [indices[j], indices[i]]; }
  const absent = new Set(indices.slice(0, 3)), corrupt = new Set(indices.slice(3, 17)), frames = [];
  for (let index = 0; index < n; index++) {
    if (absent.has(index)) continue;
    const x = pow(2, (start + index) % 65535), values = coefficients.map(polynomial => polynomial.reduceRight((value, coefficient) => rs16Multiply(value, x) ^ coefficient, 0));
    if (corrupt.has(index)) for (let lane = 0; lane < lanes; lane++) values[lane] ^= random(2).readUInt16LE() || 1;
    const sequence = (0xfffffff0 + index) >>> 0, frame = Buffer.alloc(32); frame.write('R6'); frame[2] = 1; frame[3] = 1;
    frame.writeUInt32LE(sequence, 4); let mask = (sequence >>> 16 ^ sequence ^ whitening) & 65535;
    frame.writeUInt16BE(mapped(x) ^ affine ^ mask, 8); mask = step(mask);
    for (let lane = 0; lane < lanes; lane++) { frame.writeUInt16BE(mapped(values[(lane + (sequence & 3)) % lanes]) ^ affine ^ mask, 10 + lane * 2); mask = step(mask); }
    frame.writeUInt16LE(index, 18); frame.writeBigUInt64LE(9007199254740993n + BigInt(index) * 4099n, 20);
    frame.writeUInt32LE(crc32(frame.subarray(0, 28)), 28); frames.push(frame);
  }
  frames.push(Buffer.from(frames[2]), Buffer.from(frames[17]));
  const broken = Buffer.from(frames[12]); broken[12] ^= 1; frames.push(broken);
  for (let i = frames.length - 1; i > 0; i--) { const j = random(2).readUInt16LE() % (i + 1); [frames[i], frames[j]] = [frames[j], frames[i]]; }
  const header = Buffer.alloc(16); header.write('RS16CAP1'); header.writeUInt16LE(32, 8); header.writeUInt16LE(frames.length, 10); header.writeUInt32LE(crc32(header.subarray(0, 12)), 12);
  return {
    'capture.rs16': Buffer.concat([header, ...frames]),
    'adapter.rom': Buffer.concat([...basis.map(u16le), u16le(affine), u16le(whitening)]),
    'custody.pub.der': createPublicKey(key).export({ format: 'der', type: 'spki' }),
    'format.json': JSON.stringify({ format: 'interleaved-rs16-custody-v1', fieldPolynomial: '0x1100b', primitive: 2, n, k, lanes,
      evaluationStart: start, evaluation: 'x_i = primitive^((evaluationStart+i) mod 65535), i in [0,n)',
      polynomial: 'y_lane(x) = sum(coeff[j][lane] * x^j), degree < k; no systematic rows',
      coefficientLayout: 'message[(j*lanes+lane)*2 : +2] = coeff[j][lane] as uint16 little-endian',
      message: '248 bytes: S16 01, DER length:u16le, reserved:u16le=0, DER, padding',
      schema: 'SEQUENCE { serial INTEGER, material OCTET STRING (SIZE(32)), signature BIT STRING }',
      signature: 'Ed25519 over UTF8("archive/rs16/proof") || 00 || DER(serial) || DER(material)',
      capsuleMaterial: 'the authenticated material OCTET STRING; timestamps and transport flags are not authentication',
    }, null, 2),
    'capture.h': [
      '#include <stdint.h>',
      '#pragma pack(push, 1)',
      '/* Header: RS16CAP1, stride:u16le, count:u16le, CRC32/IEEE:u32le(first 12 bytes). */',
      'struct record { char magic[2]; uint8_t version, flags; uint32_t sequence_le;',
      '    uint16_t x_be, lane_be[4], slot_le; uint64_t ticks_le; uint32_t crc_le; };',
      '#pragma pack(pop)',
      '/* Record CRC32/IEEE covers bytes [0,28); duplicate acquisitions may be present.',
      ' * The capture is incomplete. A valid transport CRC does not validate the polynomial symbols. */', '',
    ].join('\n'),
    'adapter.c': [
      '#include <stdint.h>',
      '/* ROM: columns[16], affine, whitening -- all uint16 little-endian. */',
      'uint16_t linear(uint16_t value, const uint16_t *columns) {',
      '    uint16_t out = 0; for (unsigned i=0; i<16; i++) if ((value>>i)&1) out ^= columns[i]; return out;',
      '}',
      'uint16_t next(uint16_t s) { return (s>>1) ^ ((s&1) ? 0xb400 : 0); }',
      'void capture(uint32_t sequence, uint16_t x, const uint16_t y[4], const uint16_t rom[18], uint16_t wire[5]) {',
      '    uint16_t mask = (sequence >> 16) ^ sequence ^ rom[17];',
      '    wire[0] = linear(x, rom) ^ rom[16] ^ mask; mask=next(mask);',
      '    for(unsigned i=0;i<4;i++) { wire[i+1] = linear(y[(i+(sequence&3))%4], rom) ^ rom[16] ^ mask; mask=next(mask); }',
      '    /* write wire words most-significant byte first */',
      '}', '',
    ].join('\n'),
    'capsule.json': JSON.stringify(seal({ code }, material, 'archive/rs16/custody', random), null, 2),
  };
}
