import { createHash } from 'node:crypto';
import { openSeal } from '../decoders.mjs';

export function decodeCoreEvidence(core, capsule) {
  core = Buffer.from(core);
  if (core.subarray(0, 6).toString('hex') !== '7f454c460201' || core.readUInt16LE(16) !== 4 || core.readUInt16LE(18) !== 62) throw Error('Unsupported core format');
  const count = core.readUInt16LE(56), size = core.readUInt16LE(54), start = Number(core.readBigUInt64LE(32)), loads = [], notes = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * size;
    if (size < 56 || at + 56 > core.length) throw Error('Invalid program headers');
    const type = core.readUInt32LE(at), offset = Number(core.readBigUInt64LE(at + 8)), bytes = Number(core.readBigUInt64LE(at + 32));
    if (offset + bytes > core.length) throw Error('Truncated core segment');
    if (type === 1) loads.push({ address: core.readBigUInt64LE(at + 16), bytes: core.subarray(offset, offset + bytes) });
    if (type === 4) {
      let cursor = offset;
      while (cursor < offset + bytes) {
        const nameSize = core.readUInt32LE(cursor), dataSize = core.readUInt32LE(cursor + 4), kind = core.readUInt32LE(cursor + 8);
        const name = core.subarray(cursor + 12, cursor + 12 + nameSize).toString().replace(/\0+$/, '');
        const dataAt = cursor + 12 + Math.ceil(nameSize / 4) * 4;
        if (dataAt + dataSize > offset + bytes) throw Error('Truncated core note');
        notes.push({ name, kind, bytes: core.subarray(dataAt, dataAt + dataSize) }); cursor = dataAt + Math.ceil(dataSize / 4) * 4;
      }
    }
  }
  const memory = (address, length) => {
    const segment = loads.find(segment => address >= segment.address && address + BigInt(length) <= segment.address + BigInt(segment.bytes.length));
    if (!segment) throw Error('Unmapped virtual address');
    const offset = Number(address - segment.address); return segment.bytes.subarray(offset, offset + length);
  };
  const status = notes.find(note => note.name === 'CORE' && note.kind === 1)?.bytes;
  const aux = notes.find(note => note.name === 'CORE' && note.kind === 6)?.bytes;
  if (!status || !aux) throw Error('Missing process notes');
  let cookie;
  for (let i = 0; i + 16 <= aux.length; i += 16) if (aux.readBigUInt64LE(i) === 25n) cookie = memory(aux.readBigUInt64LE(i + 8), 16);
  if (!cookie) throw Error('Missing process entropy');
  const register = status.readBigUInt64LE(136), mask = (1n << 64n) - 1n;
  let address = (register >> 17n | register << 47n & mask) ^ cookie.readBigUInt64LE(8);
  const hash = value => createHash('sha256').update(value).digest();
  const fragments = new Map(), visited = new Set();
  while (address) {
    if (visited.has(address) || visited.size >= 64) throw Error('Cyclic slab list'); visited.add(address);
    const block = memory(address, 64), ordinal = block.readUInt32LE(8), size = block.readUInt32LE(12);
    if (!hash(Buffer.concat([cookie, block.subarray(0, 48)])).subarray(0, 16).equals(block.subarray(48, 64))) throw Error('Slab authentication failed');
    if (ordinal > 63 || size !== 32 || fragments.has(ordinal)) throw Error('Invalid slab metadata');
    const encodedAddress = Buffer.alloc(8); encodedAddress.writeBigUInt64LE(address);
    const stream = hash(Buffer.concat([cookie, encodedAddress, Buffer.from('slab-v3')]));
    fragments.set(ordinal, Buffer.from(block.subarray(16, 48).map((byte, i) => byte ^ stream[i])));
    address = block.readBigUInt64LE() ^ address >> 12n;
  }
  if (fragments.size !== 8 || [...fragments.keys()].some(key => key >= 8)) throw Error('Incomplete slab sequence');
  return openSeal(capsule, Buffer.concat(Array.from({ length: 8 }, (_, i) => fragments.get(i))));
}
