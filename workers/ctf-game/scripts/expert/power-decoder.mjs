import { createCipheriv } from 'node:crypto';
import { openSeal } from '../decoders.mjs';

const box = Buffer.from('637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b27509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16', 'hex');
const hw = Uint8Array.from(box, value => { let bits = 0; for (; value; value >>>= 1) bits += value & 1; return bits; });

export function readPowerTraces(bytes) {
  let cursor = 0; const tags = new Map();
  while (cursor + 2 <= bytes.length) {
    const type = bytes[cursor++]; let length = bytes[cursor++];
    if (length & 128) {
      const width = length & 127;
      if (!width || width > 4 || cursor + width > bytes.length) throw Error('Invalid TRS length');
      length = bytes.readUIntLE(cursor, width); cursor += width;
    }
    if (type === 0x5f) { if (length) throw Error('Invalid TRS terminator'); break; }
    if (cursor + length > bytes.length || tags.has(type)) throw Error('Truncated or duplicate TRS header');
    tags.set(type, bytes.subarray(cursor, cursor + length)); cursor += length;
  }
  const n = tags.get(0x41)?.readUInt32LE(), samples = tags.get(0x42)?.readUInt32LE();
  const coding = tags.get(0x43)?.[0], dataLength = tags.get(0x44)?.readUInt16LE(), title = tags.get(0x45)?.[0] || 0;
  if (!n || n > 100000 || samples < 256 || samples > 4096 || coding !== 2 || dataLength !== 32) throw Error('Unsupported TRS acquisition');
  const stride = title + dataLength + samples * 2;
  if (cursor + n * stride !== bytes.length) throw Error('Truncated TRS records');
  const plaintext = [], ciphertext = [], shares = Array.from({ length: 16 }, () => [new Float64Array(n), new Float64Array(n)]);
  for (let trace = 0; trace < n; trace++) {
    const at = cursor + trace * stride + title, origin = at + dataLength;
    plaintext.push(bytes.subarray(at, at + 16)); ciphertext.push(bytes.subarray(at + 16, at + 32));
    const sample = index => { if (index < 0 || index >= samples) throw Error('TRS sample bounds'); return bytes.readInt16LE(origin + index * 2); };
    let baseline = 0; for (let i = 0; i < 8; i++) baseline += sample(i) / 8;
    let trigger = 8; while (trigger < 16 && sample(trigger) > -24000) trigger++;
    if (trigger === 16) throw Error('Acquisition trigger not found');
    for (let slot = 0; slot < 16; slot++) {
      let marker = trigger + 16 + slot * 14, end = marker + 3;
      while (marker < end && sample(marker) > -17000) marker++;
      if (marker === end) throw Error('Operation strobe not found');
      shares[slot][0][trace] = sample(marker + 3) - baseline;
      shares[slot][1][trace] = sample(marker + 8) - baseline;
    }
  }
  return { n, plaintext, ciphertext, shares };
}

export function recoverPowerKey(bytes) {
  const { n, plaintext, ciphertext, shares } = readPowerTraces(bytes);
  const products = shares.map(([a, b]) => {
    const ma = a.reduce((sum, v) => sum + v, 0) / n, mb = b.reduce((sum, v) => sum + v, 0) / n;
    const values = Float64Array.from(a, (v, i) => (v - ma) * (b[i] - mb));
    const sum = values.reduce((s, v) => s + v, 0), square = values.reduce((s, v) => s + v * v, 0);
    return { values, sum, variance: square - sum * sum / n };
  });
  const key = Buffer.alloc(16), slots = new Set(), scores = [];
  for (let position = 0; position < 16; position++) {
    const counts = new Uint32Array(256), sums = Array.from({ length: 16 }, () => new Float64Array(256));
    for (let trace = 0; trace < n; trace++) { const value = plaintext[trace][position]; counts[value]++; for (let slot = 0; slot < 16; slot++) sums[slot][value] += products[slot].values[trace]; }
    let best = { score: -Infinity, guess: 0, slot: 0 };
    for (let guess = 0; guess < 256; guess++) {
      let sum = 0, square = 0;
      for (let value = 0; value < 256; value++) { const w = hw[value ^ guess]; sum += w * counts[value]; square += w * w * counts[value]; }
      const variance = square - sum * sum / n;
      for (let slot = 0; slot < 16; slot++) {
        let cross = 0;
        for (let value = 0; value < 256; value++) cross += hw[value ^ guess] * sums[slot][value];
        const score = -(cross - sum * products[slot].sum / n) / Math.sqrt(variance * products[slot].variance);
        if (score > best.score) best = { score, guess, slot };
      }
    }
    if (best.score < .16 || slots.has(best.slot)) throw Error('Acquisition does not uniquely identify the masked state');
    slots.add(best.slot); key[position] = best.guess; scores.push(best.score);
  }
  for (let i = 0; i < Math.min(4, n); i++) {
    const cipher = createCipheriv('aes-128-ecb', key, null); cipher.setAutoPadding(false);
    if (!Buffer.concat([cipher.update(plaintext[i]), cipher.final()]).equals(ciphertext[i])) throw Error('Recovered key fails known-answer validation');
  }
  return { key, scores };
}

export function decodePowerEvidence(files) {
  return openSeal(JSON.parse(files['capsule.json']), recoverPowerKey(files['acquisition.trs']).key);
}
