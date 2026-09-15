import { seal } from '../core.mjs';

const vlq = value => {
  const bytes = [value & 127];
  while ((value >>>= 7)) bytes.unshift((value & 127) | 128);
  return Buffer.from(bytes);
};
const meta = (type, data) => Buffer.concat([Buffer.from([255, type]), vlq(data.length), Buffer.from(data)]);
function track(events) {
  events.sort((a, b) => a.tick - b.tick);
  let tick = 0, status = 0;
  const bytes = [];
  for (const event of events) {
    bytes.push(vlq(event.tick - tick)); tick = event.tick;
    const value = event.bytes;
    if (value[0] < 240 && value[0] === status) bytes.push(value.subarray(1));
    else bytes.push(value);
    status = value[0] < 240 ? value[0] : 0;
  }
  bytes.push(Buffer.from([0, 255, 47, 0]));
  const body = Buffer.concat(bytes), header = Buffer.alloc(8);
  header.write('MTrk'); header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
function shuffle(values, random) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = random(2).readUInt16LE() % (i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

export function sequencerEvidence(code, random) {
  const key = random(32), order = shuffle(Array.from({ length: 96 }, (_, i) => i + 1), random);
  const missing = new Set(order.slice(0, 8)), damaged = new Set(order.slice(8, 36));
  const streams = Array.from({ length: 4 }, (_, i) => [{ tick: 0, bytes: meta(3, Buffer.from('Sequence ' + (i + 1))) }]);
  for (let slot = 1; slot <= 96; slot++) {
    if (!missing.has(slot)) {
      let value = 0;
      for (let i = key.length - 1; i >= 0; i--) value = (value * slot + key[i]) % 257;
      if (damaged.has(slot)) value = (value + 1 + random(1)[0]) % 257;
      const pitch = 36 + slot % 60, tick = slot * 960 + 32;
      const stream = streams[random(1)[0] % streams.length];
      stream.push({ tick, bytes: Buffer.from([0x9b, pitch, 32 + random(1)[0] % 64]) });
      stream.push({ tick: tick + 64 + value, bytes: Buffer.from([0x9b, pitch, 0]) });
    }
    for (let channel = 0; channel < 4; channel++) {
      const tick = slot * 960 + channel * 64, pitch = [48, 55, 60, 64, 67][(slot + channel) % 5];
      streams[channel].push({ tick, bytes: Buffer.from([0x90 + channel, pitch, 30 + random(1)[0] % 80]) });
      streams[channel].push({ tick: tick + 100 + random(1)[0], bytes: Buffer.from([0x80 + channel, pitch, 0]) });
    }
  }
  const conductor = [{ tick: 0, bytes: meta(3, Buffer.from('Transport')) }];
  for (let i = 0; i < 12; i++) {
    const tempo = Buffer.alloc(3); tempo.writeUIntBE(300000 + random(2).readUInt16LE() * 4, 0, 3);
    conductor.push({ tick: i * 8 * 960, bytes: meta(0x51, tempo) });
  }
  return {
    'afterimage.mid': Buffer.concat([Buffer.from('4d546864000000060001000503c0', 'hex'), track(conductor), ...shuffle(streams, random).map(track)]),
    'sequencer.c': [
      '#include <stdint.h>',
      'extern void midi_at(uint32_t tick, uint8_t status, uint8_t pitch, uint8_t value);',
      'static uint16_t phase(const uint8_t state[32], uint16_t position) {',
      '    uint32_t acc = 0;',
      '    for (int i = 31; i >= 0; --i) acc = (acc * position + state[i]) % 257;',
      '    return acc;',
      '}',
      'void schedule(const uint8_t state[32], unsigned slot, uint8_t velocity) {',
      '    uint32_t start = slot * 960 + 32;',
      '    uint8_t pitch = 36 + slot % 60;',
      '    midi_at(start, 0x9b, pitch, velocity);',
      '    midi_at(start + 64 + phase(state, slot), 0x9b, pitch, 0);',
      '}', '',
    ].join('\n'),
    'capsule.json': JSON.stringify(seal({ code }, key, 'archive/sequencer/session', random), null, 2),
  };
}
