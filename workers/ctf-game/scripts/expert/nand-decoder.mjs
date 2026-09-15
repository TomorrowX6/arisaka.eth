import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { unpackTar } from './git-decoder.mjs';

const n = 8191, exponential = new Uint16Array(n * 2), logarithm = new Uint16Array(n + 1);
let current = 1;
for (let i = 0; i < n; i++) { exponential[i] = current; logarithm[current] = i; current *= 2; if (current >= 8192) current ^= 0x201b; }
for (let i = n; i < exponential.length; i++) exponential[i] = exponential[i - n];
const mul = (a, b) => a && b ? exponential[logarithm[a] + logarithm[b]] : 0;
const div = (a, b) => { if (!b) throw Error('BCH zero divisor'); return a ? exponential[(logarithm[a] - logarithm[b] + n) % n] : 0; };
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}

export function correctBch(data, parity) {
  const degree = 52, length = data.length * 8 + degree;
  const word = new Uint8Array(length);
  for (let bit = 0; bit < degree; bit++) word[bit] = parity[6 - Math.floor(bit / 8)] >>> bit % 8 & 1;
  for (let bit = degree; bit < length; bit++) { const index = bit - degree; word[bit] = data[data.length - 1 - Math.floor(index / 8)] >>> index % 8 & 1; }
  function syndromes() {
    const result = new Uint16Array(8);
    for (let bit = 0; bit < length; bit++) if (word[bit]) for (let j = 1; j <= 8; j++) result[j - 1] ^= exponential[bit * j % n];
    return result;
  }
  const syndrome = syndromes();
  if (syndrome.some(Boolean)) {
    let locator = [1], previous = [1], order = 0, distance = 1, scale = 1;
    for (let step = 0; step < 8; step++) {
      let discrepancy = syndrome[step];
      for (let i = 1; i <= order; i++) discrepancy ^= mul(locator[i] || 0, syndrome[step - i]);
      if (!discrepancy) { distance++; continue; }
      const old = [...locator], factor = div(discrepancy, scale);
      while (locator.length < previous.length + distance) locator.push(0);
      previous.forEach((coefficient, i) => { locator[i + distance] ^= mul(factor, coefficient); });
      if (2 * order <= step) { order = step + 1 - order; previous = old; scale = discrepancy; distance = 1; }
      else distance++;
    }
    if (order > 4) throw Error('Uncorrectable NAND sector');
    let corrected = 0;
    for (let bit = 0; bit < length; bit++) {
      const x = exponential[(n - bit % n) % n];
      let value = 0; for (let i = locator.length - 1; i >= 0; i--) value = mul(value, x) ^ locator[i];
      if (!value) { word[bit] ^= 1; corrected++; }
    }
    if (corrected !== order || syndromes().some(Boolean)) throw Error('Uncorrectable NAND sector');
  }
  const output = Buffer.alloc(data.length);
  for (let bit = degree; bit < length; bit++) if (word[bit]) { const index = bit - degree; output[data.length - 1 - Math.floor(index / 8)] |= 1 << index % 8; }
  return output;
}

export function decodeNandEvidence(dump) {
  const stride = 544, decoded = new Map(), commits = [];
  for (let block = 0; block < dump.length / stride / 8; block++) {
    if (dump[block * 8 * stride + 512] !== 255 || dump[(block * 8 + 1) * stride + 512] !== 255) continue;
    for (let i = 0; i < 8; i++) {
      const physical = block * 8 + i, spare = dump.subarray(physical * stride + 512, (physical + 1) * stride);
      if (![1, 2].includes(spare[1])) continue;
      const logical = spare.readUInt16LE(2), sequence = spare.readUInt32LE(4);
      if ((logical ^ spare.readUInt16LE(16)) !== 0xffff || (sequence ^ spare.readUInt32LE(18)) !== -1) continue;
      if (crc(Buffer.concat([spare.subarray(0, 8), spare.subarray(16, 24)])) !== spare.readUInt32LE(24)) continue;
      let data;
      try { data = correctBch(dump.subarray(physical * stride, physical * stride + 512), spare.subarray(8, 15)); }
      catch { continue; }
      let state = sequence ^ logical << 16 ^ 0x9e3779b9;
      for (let j = 0; j < data.length; j++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; data[j] ^= state >>> 24; }
      decoded.set(physical, { data, sequence, logical });
      if (spare[1] === 2 && data.toString('ascii', 0, 4) === 'FTLC' && data.readUInt32LE(4) === sequence && crc(data.subarray(0, 508)) === data.readUInt32LE(508)) commits.push({ data, sequence });
    }
  }
  let volume;
  for (const commit of commits.sort((a, b) => b.sequence - a.sequence)) {
    const count = commit.data.readUInt16LE(8), chunks = [];
    if (count > 200) continue;
    for (let logical = 0; logical < count; logical++) {
      const item = decoded.get(commit.data.readUInt16LE(10 + logical * 2));
      if (!item || item.logical !== logical || item.sequence !== commit.sequence) break;
      chunks.push(item.data);
    }
    if (chunks.length !== count) continue;
    const bytes = Buffer.concat(chunks), expected = commit.data.subarray(10 + count * 2, 42 + count * 2);
    if (createHash('sha256').update(bytes).digest().equals(expected)) { volume = bytes; break; }
  }
  if (!volume) throw Error('No committed translation map');
  if (volume.readUInt16LE(510) !== 0xaa55 || volume.readUInt16LE(11) !== 512) throw Error('Invalid FAT boot sector');
  const reserved = volume.readUInt16LE(14), copies = volume[16], sectorsPerFat = volume.readUInt16LE(22), clusterSize = volume[13] * 512;
  const rootStart = (reserved + copies * sectorsPerFat) * 512, rootSize = Math.ceil(volume.readUInt16LE(17) * 32 / 512) * 512;
  const fat = volume.subarray(reserved * 512, (reserved + sectorsPerFat) * 512);
  for (let at = rootStart; at < rootStart + rootSize; at += 32) {
    const entry = volume.subarray(at, at + 32);
    if (entry.toString('ascii', 0, 11) !== 'MAIL    TGZ') continue;
    let cluster = entry.readUInt16LE(26); const parts = [], seen = new Set();
    while (cluster >= 2 && cluster < 0xff8) {
      if (seen.has(cluster)) throw Error('FAT loop'); seen.add(cluster);
      const offset = rootStart + rootSize + (cluster - 2) * clusterSize;
      parts.push(volume.subarray(offset, offset + clusterSize));
      const value = fat.readUInt16LE(cluster + Math.floor(cluster / 2)); cluster = cluster & 1 ? value >>> 4 : value & 0xfff;
    }
    const archive = gunzipSync(Buffer.concat(parts).subarray(0, entry.readUInt32LE(28)));
    return JSON.parse(unpackTar(archive).get('release.json').bytes);
  }
  throw Error('Mail object absent');
}
