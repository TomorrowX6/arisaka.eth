import { createHash, verify } from 'node:crypto';
import { openSeal } from '../decoders.mjs';

function transfers(source, board) {
  const ids = new Map(), scopes = [], signals = new Map(), samples = [], output = [];
  let declared = false, selected = false, clock, select, mosi, miso;
  for (const line of source.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (!declared) {
      if (fields[0] === '$scope') scopes.push(fields[2]);
      if (fields[0] === '$upscope') scopes.pop();
      if (fields[0] === '$var') ids.set([...scopes, fields[4]].join('.'), fields[3]);
      if (fields[0] === '$enddefinitions') {
        declared = true; [clock, select, mosi, miso] = ['clock', 'select', 'mosi', 'miso'].map(key => ids.get(board.signals[key]));
        if ([clock, select, mosi, miso].some(id => !id)) throw Error('Missing VCD signal');
      }
      continue;
    }
    if (!/^[01xz]/i.test(line)) continue;
    const id = line.slice(1).trim(), value = line[0].toLowerCase(), previous = signals.get(id); signals.set(id, value);
    if (id === select) {
      if (value === '0') { selected = true; samples.length = 0; }
      else if (selected) {
        selected = false;
        if (samples.length && samples.length % 8 === 0 && samples.every(pair => pair.every(bit => bit === '0' || bit === '1'))) {
          const tx = Buffer.alloc(samples.length / 8), rx = Buffer.alloc(tx.length);
          samples.forEach(([a, b], i) => { tx[i >> 3] = tx[i >> 3] * 2 + Number(a); rx[i >> 3] = rx[i >> 3] * 2 + Number(b); });
          output.push({ tx, rx });
        }
        samples.length = 0;
      }
    }
    if (id === clock && selected && previous === '0' && value === '1') samples.push([signals.get(mosi), signals.get(miso)]);
  }
  if (!declared) throw Error('Missing VCD declarations');
  return output;
}

export function decodeLogicEvidence(files) {
  const board = JSON.parse(files['board.json']), votes = new Map(); let addressBytes = board.addressBytesAtReset;
  for (const { tx, rx } of transfers(String(files['bus.vcd']), board)) {
    if (tx[0] === 0xb7 && tx.length === 1) addressBytes = 4;
    else if (tx[0] === 0xe9 && tx.length === 1) addressBytes = 3;
    else if (tx[0] === 3 || tx[0] === 0x0b) {
      const start = 1 + addressBytes + (tx[0] === 0x0b ? 1 : 0);
      if (tx.length <= start) continue;
      const address = tx.readUIntBE(1, addressBytes);
      for (let i = start; i < rx.length; i++) {
        const at = address + i - start, counts = votes.get(at) || new Map(); votes.set(at, counts);
        counts.set(rx[i], (counts.get(rx[i]) || 0) + 1);
      }
    }
  }
  const read = (at, count) => {
    if (!Number.isSafeInteger(count) || count < 0 || count > 65536) throw Error('Invalid boot image size');
    return Buffer.from(Array.from({ length: count }, (_, i) => {
      const counts = votes.get(at + i);
      if (!counts) throw Error('Missing sampled flash byte');
      const ordered = [...counts].sort((a, b) => b[1] - a[1]), total = ordered.reduce((sum, item) => sum + item[1], 0);
      if (total < board.sampling.passes || ordered[0][1] * 2 <= total) throw Error('No strict sampled-byte majority');
      return ordered[0][0];
    }));
  };
  const valid = [];
  for (const value of board.slots) {
    const address = Number(value), header = read(address, 128);
    if (header.toString('ascii', 0, 8) !== 'ARBOOT2\0' || header.readUInt32LE(120) !== 0xc017cafe || header.readUInt32LE(8) < board.minimumGeneration) continue;
    if (!verify(null, header.subarray(0, 56), files['boot-authority.pem'], header.subarray(56, 120))) continue;
    const payload = read(address + 128, header.readUInt32LE(12)), digest = createHash('sha256').update(payload).digest();
    if (!digest.equals(header.subarray(24, 56))) continue;
    valid.push({ generation: header.readUInt32LE(8), digest });
  }
  valid.sort((a, b) => b.generation - a.generation);
  if (!valid.length || valid[1]?.generation === valid[0].generation) throw Error('No unique authenticated boot slot');
  return openSeal(JSON.parse(files['capsule.json']), valid[0].digest);
}
