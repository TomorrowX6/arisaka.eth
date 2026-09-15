import { deflateSync } from 'node:zlib';
import { crc32, packet } from './core.mjs';

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

export function png(width, height, rgba, metadata = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row++) {
    Buffer.from(rgba.subarray(row * width * 4, (row + 1) * width * 4))
      .copy(scanlines, row * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    ...Object.entries(metadata).map(([key, value]) =>
      pngChunk('tEXt', Buffer.from(key + '\0' + value, 'latin1'))),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const file = Buffer.from(content);
    const filename = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x0021, 12);
    header.writeUInt32LE(crc32(file), 14);
    header.writeUInt32LE(file.length, 18);
    header.writeUInt32LE(file.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, file);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + file.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function variableLength(value) {
  const bytes = [value & 127];
  while ((value >>>= 7)) bytes.unshift((value & 127) | 128);
  return Buffer.from(bytes);
}

function midiTrack(events) {
  const data = Buffer.concat([...events, Buffer.from([0, 0xff, 0x2f, 0])]);
  const header = Buffer.alloc(8);
  header.write('MTrk');
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

const meta = (type, value) => Buffer.concat([
  Buffer.from([0, 0xff, type]), variableLength(value.length), value,
]);

export function midi(code) {
  const name = Buffer.from('Track 02', 'ascii');
  const signal = [meta(3, name), Buffer.from([0, 0xc2, 10])];
  for (const byte of Buffer.from(code, 'ascii')) {
    for (const nibble of [byte >>> 4, byte & 15]) {
      signal.push(Buffer.from([0, 0x92, 60 + nibble, 26]));
      signal.push(Buffer.from([60, 0x82, 60 + nibble, 0]));
    }
  }
  const accompaniment = [meta(3, Buffer.from('Track 01'))];
  for (let index = 0; index < 40; index++) {
    const pitch = [48, 55, 60, 64, 67][index % 5];
    accompaniment.push(Buffer.from([0, 0x90, pitch, 100]));
    accompaniment.push(Buffer.from([60, 0x80, pitch, 0]));
  }
  return Buffer.concat([
    Buffer.from('4d546864000000060001000301e0', 'hex'),
    midiTrack([meta(0x51, Buffer.from([7, 0xa1, 0x20]))]),
    midiTrack(accompaniment),
    midiTrack(signal),
  ]);
}

function waveChunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 'ascii');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

export function stereoTransmission(code, receipt) {
  const rate = 8000;
  const chipSamples = 40;
  const prefix = 1600;
  const frame = Buffer.concat([
    Buffer.alloc(8, 0x55),
    packet('d391', 'ARSK6\n' + code + '\n' + receipt + '\n'),
  ]);
  const chips = [];
  for (const byte of frame) {
    for (let bit = 7; bit >= 0; bit--) {
      const one = (byte >>> bit) & 1;
      chips.push(one, one ^ 1);
    }
  }
  const sampleCount = prefix * 2 + chips.length * chipSamples;
  const data = Buffer.alloc(sampleCount * 4);
  for (let index = 0; index < sampleCount; index++) {
    const time = index / rate;
    const common = 0.38 * Math.sin(2 * Math.PI * 220 * time)
      + 0.16 * Math.sin(2 * Math.PI * 330 * time)
      + 0.06 * Math.sin(2 * Math.PI * 440 * time);
    const position = index - prefix;
    const active = position >= 0 && position < chips.length * chipSamples;
    const frequency = active && chips[Math.floor(position / chipSamples)] ? 1600 : 800;
    const side = active ? 0.16 * Math.sin(2 * Math.PI * frequency * position / rate) : 0;
    data.writeInt16LE(Math.round((common + side) * 32760), index * 4);
    data.writeInt16LE(Math.round((common - side) * 32760), index * 4 + 2);
  }
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(2, 2);
  format.writeUInt32LE(rate, 4);
  format.writeUInt32LE(rate * 4, 8);
  format.writeUInt16LE(4, 12);
  format.writeUInt16LE(16, 14);
  const comment = Buffer.from('RX/200cps/800,1600Hz; Manchester: 01=0 10=1; MSB; sync=D391; u16be length; CRC32/IEEE.\0');
  const info = Buffer.concat([Buffer.from('INFO'), waveChunk('ICMT', comment)]);
  const body = Buffer.concat([Buffer.from('WAVE'), waveChunk('fmt ', format), waveChunk('LIST', info), waveChunk('data', data)]);
  const header = Buffer.alloc(8);
  header.write('RIFF');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
