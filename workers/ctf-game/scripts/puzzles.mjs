import { virtualMachine } from './expert/vm.mjs';
import { affineArchive } from './expert/signatures.mjs';
import { createECDH } from 'node:crypto';
import QRCode from 'qrcode';
import initWabt from 'wabt';
import { curveOrder, inverse, mod, packet, pixelOrder, randomScalar, seal, sha256, toBytes, toInteger } from './core.mjs';
import { png, zip } from './formats.mjs';

export function imagePair(code, previousReceipt, receipt) {
  const width = 384;
  const height = 256;
  const original = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const radius = Math.hypot(x - 208, y - 116);
      const ring = Math.abs(radius % 32 - 16) < 0.7;
      const grid = x % 32 === 0 || y % 32 === 0;
      const star = (x * 37 + y * 71) % 997 === 0;
      original[offset] = 20 + (grid ? 14 : 0) + (ring ? 30 : 0) + (star ? 145 : 0);
      original[offset + 1] = 22 + (grid ? 10 : 0) + (ring ? 24 : 0) + (star ? 140 : 0);
      original[offset + 2] = (38 + (grid ? 20 : 0) + (ring ? 46 : 0) + (star ? 150 : 0)) & 254;
      original[offset + 3] = 255;
    }
  }
  const modified = Buffer.from(original);
  const order = pixelOrder(width * height, previousReceipt);
  const frame = packet('a707', 'ARSK7\n' + code + '\n' + receipt + '\n');
  let position = 0;
  for (const byte of frame) {
    for (let bit = 7; bit >= 0; bit--) {
      modified[order[position++] * 4 + 2] ^= (byte >>> bit) & 1;
    }
  }
  const calibration = {
    scanner: 'AFTERIMAGE/7', width, height,
    seed: 'first 4 bytes of SHA-256(case 06 receipt as ASCII), uint32 little-endian; zero -> 0x9e3779b9',
    stream: 'xorshift32: x ^= x << 13; x ^= x >>> 17; x ^= x << 5; retain uint32',
    traversal: 'Fisher-Yates on [0..width*height-1], descending i; j=floor(next_uint32/2^32*(i+1))',
    frame: 'A707 | length:u16be | UTF-8 | CRC32/IEEE:u32be; bits MSB first',
  };
  return {
    'before.png': png(width, height, original),
    'after.png': png(width, height, modified),
    'calibration.json': JSON.stringify(calibration, null, 2),
  };
}

function rotateSquare(pixels, side, turns) {
  let source = Buffer.from(pixels);
  for (let turn = 0; turn < turns; turn++) {
    const target = Buffer.alloc(source.length);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        source.copy(target, (x * side + side - 1 - y) * 4, (y * side + x) * 4, (y * side + x) * 4 + 4);
      }
    }
    source = target;
  }
  return source;
}

export function qrFragments(code, random) {
  const modules = QRCode.create(code, { errorCorrectionLevel: 'H', version: 5 }).modules;
  const scale = 8;
  const side = (modules.size + 8) * scale;
  const tileSide = side / 3;
  const full = Buffer.alloc(side * side * 4, 255);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const row = Math.floor(y / scale) - 4;
      const column = Math.floor(x / scale) - 4;
      const black = row >= 0 && column >= 0 && row < modules.size && column < modules.size && modules.get(row, column);
      if (black) full.fill(18, (y * side + x) * 4, (y * side + x) * 4 + 3);
    }
  }
  const pieces = {};
  for (let index = 0; index < 9; index++) {
    if (index === 4) continue;
    const pixels = Buffer.alloc(tileSide * tileSide * 4);
    for (let y = 0; y < tileSide; y++) {
      const source = ((Math.floor(index / 3) * tileSide + y) * side + (index % 3) * tileSide) * 4;
      full.copy(pixels, y * tileSide * 4, source, source + tileSide * 4);
    }
    const turns = random(1)[0] % 4;
    const name = 'scan-' + random(5).toString('hex') + '.png';
    pieces[name] = png(tileSide, tileSide, rotateSquare(pixels, tileSide, turns), {
      'Scan-Index': String(index ^ (index >>> 1)),
      'Scan-Turn': String(turns),
    });
  }
  const filenames = Object.keys(pieces).sort();
  const manifest = { grid: 3, missing: 1, missingIndex: 4, tileSize: tileSide, files: filenames };
  return {
    ...Object.fromEntries(filenames.map((name) => [name, pieces[name]])),
    'fragments.json': JSON.stringify(manifest, null, 2),
    'fragments.zip': zip({
      ...Object.fromEntries(filenames.map((name) => [name, pieces[name]])),
      'fragments.json': JSON.stringify(manifest),
    }),
  };
}

export const signedArchive = affineArchive;

export const glassMachine = virtualMachine;
