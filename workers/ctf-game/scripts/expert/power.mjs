import { createCipheriv } from 'node:crypto';
import { gfMul, seal } from '../core.mjs';

const rotate = (x, n) => ((x << n) | (x >>> (8 - n))) & 255;
const sbox = Uint8Array.from({ length: 256 }, (_, value) => {
  let reciprocal = value ? 1 : 0;
  for (let i = 0; i < 254; i++) reciprocal = gfMul(reciprocal, value);
  return reciprocal ^ rotate(reciprocal, 1) ^ rotate(reciprocal, 2) ^ rotate(reciprocal, 3) ^ rotate(reciprocal, 4) ^ 0x63;
});
const weight = value => { let n = 0; for (; value; value &= value - 1) n++; return n; };
function tag(id, bytes) { return Buffer.concat([Buffer.from([id, bytes.length]), bytes]); }
function integer(value, length) { const bytes = Buffer.alloc(length); bytes.writeUIntLE(value, 0, length); return bytes; }

export function powerEvidence(code, receipt, random) {
  const key = random(16), order = Array.from({ length: 16 }, (_, i) => i), count = 4096, samples = 272;
  for (let i = order.length - 1; i; i--) { const j = random(1)[0] % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const stream = random(count * (samples + 96)); let entropy = 0;
  const byte = () => stream[entropy++];
  const scale = Buffer.alloc(4); scale.writeFloatLE(1 / 24_000_000);
  const header = Buffer.concat([tag(0x41, integer(count, 4)), tag(0x42, integer(samples, 4)), tag(0x43, integer(2, 1)), tag(0x44, integer(32, 2)), tag(0x45, integer(0, 1)), tag(0x4b, Buffer.from('Acquisition 04')), tag(0x4d, scale), Buffer.from([0x5f, 0])]);
  const records = Buffer.alloc(count * (32 + samples * 2));
  for (let trace = 0; trace < count; trace++) {
    const offset = trace * (32 + samples * 2), plaintext = Buffer.from(Array.from({ length: 16 }, byte));
    const cipher = createCipheriv('aes-128-ecb', key, null); cipher.setAutoPadding(false);
    plaintext.copy(records, offset); Buffer.concat([cipher.update(plaintext), cipher.final()]).copy(records, offset + 16);
    const origin = offset + 32, drift = (byte() - 128) * 3, jitter = byte() % 8;
    for (let i = 0; i < samples; i++) records.writeInt16LE(1100 + drift + (byte() % 65) - 32, origin + i * 2);
    records.writeInt16LE(-25000, origin + (8 + jitter) * 2);
    for (let slot = 0; slot < 16; slot++) {
      const marker = 24 + jitter + slot * 14 + byte() % 3, mask = byte(), input = plaintext[order[slot]] ^ key[order[slot]];
      records.writeInt16LE(-18000, origin + marker * 2);
      records.writeInt16LE(1100 + drift + 128 * (weight(mask) - 4) + byte() % 97 - 48, origin + (marker + 3) * 2);
      records.writeInt16LE(1100 + drift + 128 * (weight(sbox[input] ^ mask) - 4) + byte() % 97 - 48, origin + (marker + 8) * 2);
    }
  }
  if (entropy > stream.length) throw Error('Power acquisition entropy exhausted');
  return {
    'acquisition.trs': Buffer.concat([header, records]),
    'capture.json': JSON.stringify({ container: 'TRS', data: ['input[16]', 'output[16]'], sampleRate: 24000000, probe: 'P2', unit: 'ADC', acquisition: 4 }, null, 2),
    'device.c': [
      '#include <stdint.h>', 'extern const uint8_t sbox[256], schedule[16];',
      'extern uint8_t rng8(void);', 'extern void delay_cycles(unsigned);',
      'extern void write_register(unsigned, uint8_t);',
      'void round_start(uint8_t state[16], const uint8_t key[16]) {',
      '    for (unsigned slot = 0; slot < 16; ++slot) {',
      '        unsigned i = schedule[slot];',
      '        uint8_t r = rng8();',
      '        delay_cycles(rng8() % 3);',
      '        write_register(2, r);',
      '        delay_cycles(5);',
      '        write_register(3, sbox[state[i] ^ key[i]] ^ r);',
      '        state[i] = sbox[state[i] ^ key[i]];',
      '    }', '}', '',
    ].join('\n'),
    'capsule.json': JSON.stringify(seal({ code, receipt }, key, 'archive/device/power', random), null, 2),
  };
}
