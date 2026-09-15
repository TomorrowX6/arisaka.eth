import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../core.mjs';
import { tar, u32le } from './formats.mjs';

function multiply(a, b) {
  let value = 0;
  while (b) { if (b & 1) value ^= a; a = a << 1 ^ (a & 128 ? 0x11d : 0); b >>>= 1; }
  return value;
}
function shuffle(values, random) {
  for (let i = values.length - 1; i; i--) { const j = random(2).readUInt16LE() % (i + 1); [values[i], values[j]] = [values[j], values[i]]; }
  return values;
}

export function storageEvidence(code, receipt, random) {
  const dataSymbols = 31, units = 63, stripes = 128, entries = {};
  const generation = 4000 + random(2).readUInt16LE();
  let x = 1;
  const points = Array.from({ length: units }, () => { const point = x; x = multiply(x, 2); return point; });
  for (let epoch = generation - 1; epoch <= generation + 1; epoch++) {
    const message = Buffer.from(JSON.stringify(epoch === generation ? { code, receipt } : { sequence: epoch, digest: random(32).toString('hex') }));
    const packed = deflateRawSync(message);
    const data = Buffer.concat([u32le(packed.length), u32le(crc32(packed)), packed, random(dataSymbols * stripes - packed.length - 8)]);
    const columns = points.map(() => Buffer.alloc(stripes));
    const erased = new Set(shuffle(Array.from({ length: units }, (_, i) => i), random).slice(0, epoch > generation ? 40 : 8));
    const present = Array.from({ length: units }, (_, i) => i).filter(i => !erased.has(i));
    for (let stripe = 0; stripe < stripes; stripe++) {
      for (let unit = 0; unit < units; unit++) {
        let value = 0;
        for (let degree = dataSymbols - 1; degree >= 0; degree--) value = multiply(value, points[unit]) ^ data[stripe * dataSymbols + degree];
        columns[unit][(stripe * 37 + unit * 19) % stripes] = value;
      }
      for (const unit of shuffle([...present], random).slice(0, Math.min(12, present.length))) {
        columns[unit][(stripe * 37 + unit * 19) % stripes] ^= (random(1)[0] % 255) + 1;
      }
    }
    for (const unit of present) {
      const header = Buffer.alloc(16);
      header.write('RSV3'); header.writeUInt32LE(epoch, 4);
      header[8] = unit; header[9] = points[unit]; header[10] = dataSymbols; header[11] = stripes;
      header.writeUInt32LE(crc32(columns[unit]), 12);
      entries['blocks/' + random(10).toString('hex') + '.bin'] = Buffer.concat([header, columns[unit]]);
    }
  }
  const committed = Buffer.concat([Buffer.from('TXC3'), u32le(generation), u32le(generation - 1)]);
  entries['journal/commit'] = Buffer.concat([committed, u32le(crc32(committed))]);
  const controller = [
    '#include <stdint.h>',
    '#define DATA_SYMBOLS 31', '#define DEVICES 63', '#define STRIPES 128',
    'static uint8_t gf_mul(uint8_t a, uint8_t b) {',
    '  uint8_t r = 0; while (b) { if (b & 1) r ^= a; a = (a << 1) ^ ((a & 128) ? 0x1d : 0); b >>= 1; } return r;',
    '}',
    'void encode(const uint8_t *data, uint8_t out[DEVICES][STRIPES]) {',
    '  uint8_t x = 1;',
    '  for (int unit = 0; unit < DEVICES; unit++, x = gf_mul(x, 2))',
    '    for (int stripe = 0; stripe < STRIPES; stripe++) {',
    '      uint8_t v = 0;',
    '      for (int degree = DATA_SYMBOLS - 1; degree >= 0; degree--) v = gf_mul(v, x) ^ data[stripe * DATA_SYMBOLS + degree];',
    '      out[unit][(stripe * 37 + unit * 19) % STRIPES] = v;',
    '    }',
    '}', '',
  ].join('\n');
  return { 'fragments.tar': tar(entries), 'controller.c': controller };
}
