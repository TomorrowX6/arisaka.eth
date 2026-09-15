import { createECDH, createHash } from 'node:crypto';
import { curveOrder, inverse, mod, seal, toBytes } from '../core.mjs';

export function latticeEvidence(code, receipt, random) {
  const secret = BigInt('0x' + random(32).toString('hex')) % (curveOrder - 1n) + 1n;
  const publicKey = createECDH('secp256k1'); publicKey.setPrivateKey(toBytes(secret));
  const records = [], traces = [], bias = random(4).readUInt32LE();
  for (let index = 0; index < 14; index++) {
    const message = random(48), nonce = BigInt('0x' + random(32).toString('hex')) % (curveOrder - 1n) + 1n;
    const point = createECDH('secp256k1'); point.setPrivateKey(toBytes(nonce));
    const r = BigInt('0x' + point.getPublicKey().subarray(1, 33).toString('hex')) % curveOrder;
    const digest = createHash('sha256').update(message).digest();
    const s = mod(inverse(nonce, curveOrder) * (BigInt('0x' + digest.toString('hex')) + r * secret), curveOrder);
    records.push({ sequence: index + 4096, message: message.toString('hex'), r: toBytes(r).toString('hex'), s: toBytes(s).toString('hex') });
    const trace = Buffer.alloc(16); trace.writeUInt32LE(index + 4096); trace.writeUInt32LE((Number(nonce >> 224n) ^ bias) >>> 0, 4);
    random(8).copy(trace, 8); traces.push(trace);
  }
  for (let i = traces.length - 1; i; i--) { const j = random(1)[0] % (i + 1); [traces[i], traces[j]] = [traces[j], traces[i]]; }
  const header = Buffer.alloc(16); header.write('DTL3'); header.writeUInt32LE(14, 4); header.writeUInt32LE(bias, 8); header.writeUInt32LE(16, 12);
  return {
    'signatures.json': JSON.stringify({ curve: 'secp256k1', digest: 'SHA-256', publicKey: publicKey.getPublicKey(undefined, 'compressed').toString('hex'), records }, null, 2),
    'trace.bin': Buffer.concat([header, ...traces]),
    'driver.c': [
      '#include <stdint.h>',
      'struct trace_header { char magic[4]; uint32_t count, bias, stride; };',
      'struct trace_record { uint32_t sequence, status; uint64_t cycles; };',
      'void complete(struct trace_record *out, uint32_t sequence, const uint32_t k[8], uint32_t bias, uint64_t cycles) {',
      '    out->sequence = sequence;', '    out->status = k[7] ^ bias;', '    out->cycles = cycles;', '}', '',
    ].join('\n'),
    'capsule.json': JSON.stringify(seal({ code, receipt }, toBytes(secret), 'archive/device/ecdsa', random), null, 2),
  };
}
