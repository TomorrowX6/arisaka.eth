import { gzipSync } from 'node:zlib';
import { crc32, sha256 } from '../core.mjs';
import { tar } from './formats.mjs';

const fieldOrder = 8191;
const powers = new Uint16Array(fieldOrder * 2), logs = new Uint16Array(fieldOrder + 1);
let element = 1;
for (let i = 0; i < fieldOrder; i++) {
  powers[i] = element; logs[element] = i;
  element <<= 1; if (element & 8192) element ^= 0x201b;
}
if (element !== 1 || new Set(powers.subarray(0, fieldOrder)).size !== fieldOrder) throw Error('Non-primitive BCH field');
for (let i = fieldOrder; i < powers.length; i++) powers[i] = powers[i - fieldOrder];
const multiply = (a, b) => a && b ? powers[logs[a] + logs[b]] : 0;
const conjugates = new Set();
for (let root = 1; root <= 8; root++) {
  let exponent = root;
  do { conjugates.add(exponent); exponent = exponent * 2 % fieldOrder; } while (exponent !== root);
}
let polynomial = [1];
for (const exponent of conjugates) {
  const next = Array(polynomial.length + 1).fill(0);
  polynomial.forEach((coefficient, i) => { next[i] ^= multiply(coefficient, powers[exponent]); next[i + 1] ^= coefficient; });
  polynomial = next;
}
if (polynomial.some(coefficient => coefficient > 1)) throw Error('BCH polynomial is not binary');
const degree = polynomial.length - 1;
const generator = polynomial.reduce((value, bit, i) => value | BigInt(bit) << BigInt(i), 0n);

function ecc(data) {
  let remainder = BigInt('0x' + data.toString('hex')) << BigInt(degree);
  for (let i = data.length * 8 + degree - 1; i >= degree; i--) {
    if (remainder >> BigInt(i) & 1n) remainder ^= generator << BigInt(i - degree);
  }
  return Buffer.from(remainder.toString(16).padStart(14, '0'), 'hex');
}
function transform(bytes, sequence, logical) {
  let state = (sequence ^ logical << 16 ^ 0x9e3779b9) >>> 0;
  return Buffer.from(bytes, 0, bytes.length).map(byte => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return byte ^ state >>> 24;
  });
}
function shuffled(values, random) {
  for (let i = values.length - 1; i; i--) { const j = random(2).readUInt16LE() % (i + 1); [values[i], values[j]] = [values[j], values[i]]; }
  return values;
}

function fatVolume(message, random) {
  const sectors = 48, bytes = random(sectors * 512), boot = bytes.subarray(0, 512);
  boot.fill(0); boot.set([0xeb, 0x3c, 0x90]); boot.write('MSDOS5.0', 3);
  boot.writeUInt16LE(512, 11); boot[13] = 1; boot.writeUInt16LE(1, 14); boot[16] = 1;
  boot.writeUInt16LE(16, 17); boot.writeUInt16LE(sectors, 19); boot[21] = 0xf8;
  boot.writeUInt16LE(1, 22); boot.writeUInt16LE(16, 24); boot.writeUInt16LE(2, 26);
  boot[36] = 0x80; boot[38] = 0x29; boot.writeUInt32LE(random(4).readUInt32LE(), 39);
  boot.write('VAULT      ', 43); boot.write('FAT12   ', 54); boot.writeUInt16LE(0xaa55, 510);
  const fat = bytes.subarray(512, 1024); fat.fill(0); fat.set([0xf8, 0xff, 0xff]);
  const root = bytes.subarray(1024, 1536); root.fill(0);
  const free = shuffled(Array.from({ length: sectors - 3 }, (_, i) => i + 2), random);
  const setCluster = (index, value) => {
    const offset = index + Math.floor(index / 2), previous = fat.readUInt16LE(offset);
    fat.writeUInt16LE(index & 1 ? previous & 15 | value << 4 : previous & 0xf000 | value, offset);
  };
  const files = [
    ['MAIL    TGZ', gzipSync(tar({ 'release.json': JSON.stringify(message), 'journal.bin': random(2600) }))],
    ['CACHE   BIN', random(4200)],
    ['OLD     TGZ', gzipSync(tar({ 'release.json': JSON.stringify({ sequence: random(4).readUInt32LE() }) }))],
  ];
  files.forEach(([name, content], index) => {
    const chain = free.splice(0, Math.ceil(content.length / 512));
    chain.forEach((cluster, i) => { setCluster(cluster, chain[i + 1] || 0xfff); content.copy(bytes, (cluster + 1) * 512, i * 512, (i + 1) * 512); });
    const entry = root.subarray(index * 32, (index + 1) * 32);
    entry.write(name); entry[11] = 0x20; entry.writeUInt16LE(chain[0], 26); entry.writeUInt32LE(content.length, 28);
    if (index === 2) entry[0] = 0xe5;
  });
  return bytes;
}

export function nandEvidence(code, receipt, random) {
  const pageSize = 512, spareSize = 32, pages = 128, stride = pageSize + spareSize;
  const dump = Buffer.alloc(pages * stride, 0xff), badBlock = random(1)[0] % 16;
  const available = shuffled(Array.from({ length: pages }, (_, i) => i).filter(i => Math.floor(i / 8) !== badBlock), random);
  const sequence = 100 + random(2).readUInt16LE();
  function writePage(data, logical, transaction, kind, errors = 1 + random(1)[0] % 4, fixedPage) {
    const physical = fixedPage ?? available.pop();
    if (physical === undefined) throw Error('NAND full');
    const offset = physical * stride;
    const raw = transform(data, transaction, logical), spare = Buffer.alloc(spareSize, 0xff);
    spare[1] = kind; spare.writeUInt16LE(logical, 2); spare.writeUInt32LE(transaction, 4);
    ecc(raw).copy(spare, 8);
    spare.writeUInt16LE(logical ^ 0xffff, 16); spare.writeUInt32LE((transaction ^ 0xffffffff) >>> 0, 18);
    spare.writeUInt32LE(crc32(Buffer.concat([spare.subarray(0, 8), spare.subarray(16, 24)])), 24);
    const flipped = new Set();
    while (flipped.size < errors) flipped.add(random(2).readUInt16LE() % (4096 + degree));
    for (const bit of flipped) {
      if (bit < degree) spare[14 - Math.floor(bit / 8)] ^= 1 << bit % 8;
      else { const b = bit - degree; raw[511 - Math.floor(b / 8)] ^= 1 << b % 8; }
    }
    raw.copy(dump, offset); spare.copy(dump, offset + pageSize);
    return physical;
  }
  function commit(volume, transaction) {
    const map = [];
    for (let logical = 0; logical < 48; logical++) map.push(writePage(volume.subarray(logical * 512, (logical + 1) * 512), logical, transaction, 1));
    const record = random(512); record.write('FTLC'); record.writeUInt32LE(transaction, 4); record.writeUInt16LE(map.length, 8);
    map.forEach((physical, i) => record.writeUInt16LE(physical, 10 + i * 2));
    sha256(volume).copy(record, 10 + map.length * 2);
    record.writeUInt32LE(crc32(record.subarray(0, 508)), 508);
    writePage(record, 0xffff, transaction, 2);
    return record;
  }
  commit(fatVolume({ sequence: sequence - 1 }, random), sequence - 1);
  const last = commit(fatVolume({ code, receipt }, random), sequence);
  for (let i = 0; i < 12; i++) writePage(random(512), i, sequence + 1, 1);
  const torn = Buffer.from(last); torn.writeUInt32LE(sequence + 1, 4);
  writePage(torn, 0xffff, sequence + 1, 2, 9);
  // A valid-looking stale page in a factory-marked bad block must be ignored.
  writePage(last, 0xffff, sequence + 99, 2, 0, badBlock * 8 + 3);
  dump[badBlock * 8 * stride + pageSize] = 0;
  dump[(badBlock * 8 + 1) * stride + pageSize] = 0;
  return {
    'nand.bin': dump,
    'controller.h': [
      '#include <stdint.h>', '#define NAND_PAGE_SIZE 512', '#define NAND_SPARE_SIZE 32', '#define NAND_PAGES_PER_BLOCK 8',
      '#define ECC_GF_POLYNOMIAL 0x201b', '#define ECC_STRENGTH 4', '#define ECC_PARITY_BITS ' + degree,
      '#pragma pack(push, 1)',
      'struct spare { uint8_t bad, kind; uint16_t logical; uint32_t transaction; uint8_t ecc[7], reserved; uint16_t logical_inverse; uint32_t transaction_inverse; uint8_t reserved2[2]; uint32_t crc; uint8_t reserved3[4]; };',
      '#pragma pack(pop)',
      'void transform(uint8_t *p, uint32_t transaction, uint16_t logical) {',
      '  uint32_t x = transaction ^ ((uint32_t)logical << 16) ^ 0x9e3779b9;',
      '  for (int i = 0; i < NAND_PAGE_SIZE; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; p[i] ^= x >> 24; }',
      '}', '',
    ].join('\n'),
  };
}
