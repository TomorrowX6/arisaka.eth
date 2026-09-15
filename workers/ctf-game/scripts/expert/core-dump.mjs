import { createHash } from 'node:crypto';
import { seal } from '../core.mjs';

const mask64 = (1n << 64n) - 1n;
const rotate = (value, bits) => (value << BigInt(bits) | value >> BigInt(64 - bits)) & mask64;
const align = (value, unit = 4096) => Math.ceil(value / unit) * unit;
const hash = value => createHash('sha256').update(value).digest();
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };

function note(type, descriptor, name = 'CORE') {
  const label = Buffer.from(name + '\0'), header = Buffer.alloc(12);
  header.writeUInt32LE(label.length); header.writeUInt32LE(descriptor.length, 4); header.writeUInt32LE(type, 8);
  return Buffer.concat([header, label, Buffer.alloc(align(label.length, 4) - label.length), descriptor, Buffer.alloc(align(descriptor.length, 4) - descriptor.length)]);
}

export function coreEvidence(code, receipt, random) {
  const heapBase = 0x555600000000n + BigInt(random(3).readUIntBE(0, 3)) * 4096n;
  const stackBase = 0x7ffc00000000n + BigInt(random(3).readUIntBE(0, 3)) * 4096n;
  const heap = random(96 * 4096), stack = random(8192), guard = random(8).readBigUInt64LE();
  const randomOffset = 0x12b0, seed = random(32), material = random(256), positions = [];
  for (let i = 0; i < 96; i++) positions.push(i * 4096 + 0x140 + (random(1)[0] & 7) * 0x80);
  for (let i = positions.length - 1; i; i--) { const j = random(2).readUInt16BE() % (i + 1); [positions[i], positions[j]] = [positions[j], positions[i]]; }
  const chosen = positions.slice(0, 8), order = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = 7; i; i--) { const j = random(1)[0] % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  seed.copy(stack, randomOffset); stack.writeBigUInt64LE(guard, randomOffset + 8);
  const cookie = stack.subarray(randomOffset, randomOffset + 16);
  for (let i = 0; i < positions.length; i++) {
    const offset = positions[i], address = heapBase + BigInt(offset), next = i < 7 ? heapBase + BigInt(chosen[i + 1]) : 0n;
    heap.writeBigUInt64LE(next ^ address >> 12n, offset);
    heap.writeUInt32LE(i < 8 ? order[i] : random(1)[0] % 8, offset + 8);
    heap.writeUInt32LE(32, offset + 12);
    const clear = i < 8 ? material.subarray(order[i] * 32, order[i] * 32 + 32) : random(32);
    const mask = hash(Buffer.concat([cookie, u64(address), Buffer.from('slab-v3')]));
    for (let byte = 0; byte < 32; byte++) heap[offset + 16 + byte] = clear[byte] ^ mask[byte];
    hash(Buffer.concat([cookie, heap.subarray(offset, offset + 48)])).copy(heap, offset + 48, 0, 16);
  }
  const status = Buffer.alloc(336);
  status.writeUInt32LE(4242, 32);
  // Linux x86_64 elf_prstatus: register array begins at offset 112; r12 is #3.
  status.writeBigUInt64LE(rotate((heapBase + BigInt(chosen[0])) ^ guard, 17), 112 + 3 * 8);
  status.writeBigUInt64LE(0x555555554970n, 112 + 16 * 8);
  status.writeBigUInt64LE(stackBase + 0x1000n, 112 + 19 * 8);
  const auxv = Buffer.concat([u64(6n), u64(4096n), u64(25n), u64(stackBase + BigInt(randomOffset)), u64(9n), u64(0x555555554970n), Buffer.alloc(16)]);
  const notes = Buffer.concat([note(1, status), note(6, auxv), note(3, hash(Buffer.from('snapshot/3')).subarray(0, 20), 'GNU')]);
  const segments = [
    { type: 4, flags: 0, address: 0n, bytes: notes },
    { type: 1, flags: 6, address: stackBase, bytes: stack },
    ...Array.from({ length: 6 }, (_, i) => ({ type: 1, flags: 6, address: heapBase + BigInt(i * 16 * 4096), bytes: heap.subarray(i * 16 * 4096, (i + 1) * 16 * 4096) })),
  ];
  // PT_LOAD records are intentionally not ordered by virtual address.
  [segments[2], segments[5]] = [segments[5], segments[2]];
  [segments[3], segments[7]] = [segments[7], segments[3]];
  let end = align(64 + segments.length * 56);
  for (const segment of segments) { segment.offset = end; end = align(end + segment.bytes.length); }
  const elf = Buffer.alloc(end);
  Buffer.from('7f454c46020101000000000000000000', 'hex').copy(elf);
  elf.writeUInt16LE(4, 16); elf.writeUInt16LE(62, 18); elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(64n, 32); elf.writeUInt16LE(64, 52); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(segments.length, 56);
  segments.forEach((segment, i) => {
    const at = 64 + i * 56;
    elf.writeUInt32LE(segment.type, at); elf.writeUInt32LE(segment.flags, at + 4);
    elf.writeBigUInt64LE(BigInt(segment.offset), at + 8); elf.writeBigUInt64LE(segment.address, at + 16);
    elf.writeBigUInt64LE(BigInt(segment.bytes.length), at + 32); elf.writeBigUInt64LE(BigInt(segment.bytes.length), at + 40);
    elf.writeBigUInt64LE(segment.type === 4 ? 4n : 4096n, at + 48); segment.bytes.copy(elf, segment.offset);
  });
  return {
    'process.core': elf,
    'allocator.h': [
      '#include <stdint.h>', '#define PROTECT_PTR(pos, ptr) (((uintptr_t)(pos) >> 12) ^ (uintptr_t)(ptr))',
      'struct slab { uint64_t next; uint32_t ordinal, size; uint8_t payload[32], authenticator[16]; };',
      '/* payload_mask = SHA256(AT_RANDOM[0:16] || LE64(address) || "slab-v3") */',
      '/* authenticator = SHA256(AT_RANDOM[0:16] || slab[0:48])[0:16] */',
      '/* saved r12: rol64(head ^ pointer_guard, 17); pointer_guard: AT_RANDOM[8:16] */', '',
    ].join('\n'),
    'capsule.json': JSON.stringify(seal({ code, receipt }, material, 'archive/process/slabs', random), null, 2),
  };
}
