import { seal } from '../core.mjs';

const word = (bytes, offset) => bytes.readUInt32LE(offset);
const rol = (x, n) => (x << n | x >>> (32 - n)) >>> 0;
const rotations = [5, 9, 13, 17];

class Assembler {
  constructor() { this.slots = []; this.labels = new Map(); this.jumps = []; this.relocations = []; }
  label(name) { if (this.labels.has(name)) throw Error('duplicate label'); this.labels.set(name, this.slots.length); }
  op(code, dst = 0, src = 0, offset = 0, imm = 0) {
    const bytes = Buffer.alloc(8); bytes[0] = code; bytes[1] = src * 16 + dst; bytes.writeInt16LE(offset, 2); bytes.writeInt32LE(imm | 0, 4); this.slots.push(bytes);
  }
  jump(code, dst, src, imm, target) { this.jumps.push({ pc: this.slots.length, target }); this.op(code, dst, src, 0, imm); }
  data(dst) { this.relocations.push({ offset: this.slots.length * 8, type: 1, symbol: 4 }); this.op(0x18, dst); this.op(0); }
  call() { this.relocations.push({ offset: this.slots.length * 8, type: 10, symbol: 3 }); this.op(0x85, 0, 1, 0, -1); }
  bytes() {
    for (const { pc, target } of this.jumps) {
      const offset = this.labels.get(target) - pc - 1;
      if (!Number.isInteger(offset) || offset < -32768 || offset > 32767) throw Error('bad branch');
      this.slots[pc].writeInt16LE(offset, 2);
    }
    return Buffer.concat(this.slots);
  }
}

// This fixture is emitted as real ELF64 ET_REL, not a JSON program disguised
// with an .o suffix. readelf can independently inspect its symbols and RELs.
function objectFile(main, block, data) {
  const names = Buffer.from('\0.text\0xdp/archive\0.rodata\0.relxdp\0.symtab\0.strtab\0.shstrtab\0');
  const strings = Buffer.from('\0archive_filter\0mix_block\0archive_table\0');
  const symbols = Buffer.alloc(5 * 24), relocations = Buffer.alloc(main.relocations.length * 16);
  symbols[24 + 4] = 3; symbols.writeUInt16LE(1, 24 + 6); // local STT_SECTION
  const addSymbol = (index, name, type, section, size) => {
    const at = index * 24; symbols.writeUInt32LE(strings.indexOf(name + '\0'), at); symbols[at + 4] = 16 | type;
    symbols.writeUInt16LE(section, at + 6); symbols.writeBigUInt64LE(BigInt(size), at + 16);
  };
  const code = main.bytes(), functionCode = block.bytes();
  addSymbol(2, 'archive_filter', 2, 2, code.length); addSymbol(3, 'mix_block', 2, 1, functionCode.length); addSymbol(4, 'archive_table', 1, 3, data.length);
  main.relocations.forEach((rel, i) => { relocations.writeBigUInt64LE(BigInt(rel.offset), i * 16); relocations.writeBigUInt64LE(BigInt(rel.symbol) << 32n | BigInt(rel.type), i * 16 + 8); });
  const sections = [null, { name: '.text', content: functionCode, type: 1, flags: 6 }, { name: 'xdp/archive', content: code, type: 1, flags: 6 },
    { name: '.rodata', content: data, type: 1, flags: 2 }, { name: '.relxdp', content: relocations, type: 9, link: 5, info: 2, stride: 16 },
    { name: '.symtab', content: symbols, type: 2, link: 6, info: 2, stride: 24 }, { name: '.strtab', content: strings, type: 3 }, { name: '.shstrtab', content: names, type: 3 }];
  let size = 64;
  for (const section of sections.slice(1)) { size = (size + 7) & ~7; section.offset = size; size += section.content.length; }
  const shoff = (size + 7) & ~7, bytes = Buffer.alloc(shoff + 64 * sections.length);
  bytes.set([127, 69, 76, 70, 2, 1, 1]); bytes.writeUInt16LE(1, 16); bytes.writeUInt16LE(247, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(BigInt(shoff), 40); bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(64, 58); bytes.writeUInt16LE(sections.length, 60); bytes.writeUInt16LE(7, 62);
  for (const [index, section] of sections.entries()) {
    if (!section) continue; const at = shoff + index * 64; section.content.copy(bytes, section.offset);
    bytes.writeUInt32LE(names.indexOf(section.name + '\0'), at); bytes.writeUInt32LE(section.type, at + 4); bytes.writeBigUInt64LE(BigInt(section.flags || 0), at + 8);
    bytes.writeBigUInt64LE(BigInt(section.offset), at + 24); bytes.writeBigUInt64LE(BigInt(section.content.length), at + 32);
    bytes.writeUInt32LE(section.link || 0, at + 40); bytes.writeUInt32LE(section.info || 0, at + 44); bytes.writeBigUInt64LE(section.type === 3 ? 1n : 8n, at + 48);
    bytes.writeBigUInt64LE(BigInt(section.stride || 0), at + 56);
  }
  return bytes;
}

export function bpfEvidence(code, upstream, random) {
  if (!Array.isArray(upstream) || upstream.length !== 2 || upstream.some(value => value.length !== 32)) throw Error('BPF convergence requires both upstream materials');
  const material = random(16), data = random(96), permutation = Array.from({ length: 16 }, (_, i) => i);
  for (let i = 15; i > 0; i--) { const j = random(1)[0] % (i + 1); [permutation[i], permutation[j]] = [permutation[j], permutation[i]]; }
  data.set(permutation); const delta = (word(data, 88) | 1) >>> 0, rounds = 48 + (data[92] & 15);
  data.writeUInt32LE(delta, 88); data.writeUInt32LE(rounds, 92);
  const keys = rotations.map((rotation, i) => (rol(word(data, 32 + i * 4) ^ word(data, 48 + ((i + 1) & 3) * 4), rotation) + delta * (i + 1)) >>> 0);
  const transformed = Buffer.from(permutation.map((index, i) => material[index] ^ data[16 + i]));
  let previous = [word(data, 64), word(data, 68)];
  for (let block = 0; block < 2; block++) {
    let a = (word(transformed, block * 8) ^ previous[0]) >>> 0, b = (word(transformed, block * 8 + 4) ^ previous[1]) >>> 0, sum = 0;
    for (let round = 0; round < rounds; round++) {
      a = (a + ((((b << 4 ^ b >>> 5) + b) >>> 0) ^ ((sum + keys[sum & 3]) >>> 0))) >>> 0;
      sum = (sum + delta) >>> 0;
      b = (b + ((((a << 4 ^ a >>> 5) + a) >>> 0) ^ ((sum + keys[sum >>> 11 & 3]) >>> 0))) >>> 0;
    }
    data.writeUInt32LE(a, 72 + block * 8); data.writeUInt32LE(b, 76 + block * 8); previous = [a, b];
  }

  const main = new Assembler(), block = new Assembler();
  main.op(0x61, 6, 1); main.op(0x61, 7, 1, 4); // data / data_end
  main.op(0xbf, 8, 6); main.op(0x07, 8, 0, 0, 20); main.jump(0x2d, 8, 7, 0, 'drop'); main.jump(0x5d, 8, 7, 0, 'drop');
  main.op(0x61, 0, 6); main.jump(0x56, 0, 0, 0x00323352, 'drop'); main.data(9);
  for (const [i, rotation] of rotations.entries()) {
    main.op(0x61, 0, 9, 32 + i * 4); main.op(0x61, 1, 9, 48 + ((i + 1) & 3) * 4); main.op(0xac, 0, 1);
    main.op(0xbc, 1, 0); main.op(0x64, 0, 0, 0, rotation); main.op(0x74, 1, 0, 0, 32 - rotation); main.op(0x4c, 0, 1);
    main.op(0x61, 1, 9, 88); main.op(0x24, 1, 0, 0, i + 1); main.op(0x0c, 0, 1); main.op(0x63, 10, 0, -16 + i * 4);
  }
  main.op(0xb7, 7); main.label('permute');
  main.op(0xbf, 1, 9); main.op(0x0f, 1, 7); main.op(0x71, 2, 1); main.op(0x0f, 2, 6); main.op(0x71, 0, 2, 4);
  main.op(0x71, 3, 1, 16); main.op(0xac, 0, 3); main.op(0xbf, 2, 10); main.op(0x07, 2, 0, 0, -32); main.op(0x0f, 2, 7); main.op(0x73, 2, 0);
  main.op(0x07, 7, 0, 0, 1); main.jump(0xa5, 7, 0, 16, 'permute');
  main.op(0x79, 0, 9, 64); main.op(0x7b, 10, 0, -40); main.op(0xb7, 7); main.label('blocks');
  main.op(0xbf, 8, 10); main.op(0x07, 8, 0, 0, -32); main.op(0x0f, 8, 7);
  main.op(0x79, 0, 8); main.op(0x79, 1, 10, -40); main.op(0xaf, 0, 1); main.op(0x7b, 8, 0);
  main.op(0xbf, 1, 8); main.op(0xbf, 2, 10); main.op(0x07, 2, 0, 0, -16); main.op(0x61, 3, 9, 88); main.op(0x61, 4, 9, 92); main.call();
  main.op(0x79, 0, 8); main.op(0x7b, 10, 0, -40); main.op(0x07, 7, 0, 0, 8); main.jump(0x55, 7, 0, 16, 'blocks');
  main.op(0x79, 0, 10, -32); main.op(0x79, 1, 9, 72); main.op(0xaf, 0, 1); main.op(0x79, 2, 10, -24); main.op(0x79, 3, 9, 80);
  main.op(0xaf, 2, 3); main.op(0x4f, 0, 2); main.jump(0x55, 0, 0, 0, 'drop'); main.op(0xb7, 0, 0, 0, 2); main.op(0x95);
  main.label('drop'); main.op(0xb7, 0, 0, 0, 1); main.op(0x95);

  block.op(0x7b, 10, 1, -8); block.op(0x7b, 10, 2, -16); block.op(0x63, 10, 3, -24);
  block.op(0xbc, 9, 4); block.op(0x61, 6, 1); block.op(0x61, 7, 1, 4); block.op(0xb4, 8); block.label('round');
  const mix = (value, destination, second) => {
    block.op(0xbc, 0, value); block.op(0x64, 0, 0, 0, 4); block.op(0xbc, 1, value); block.op(0x74, 1, 0, 0, 5);
    block.op(0xac, 0, 1); block.op(0x0c, 0, value); block.op(0xbc, 1, 8); if (second) block.op(0x74, 1, 0, 0, 11);
    block.op(0x54, 1, 0, 0, 3); block.op(0x64, 1, 0, 0, 2); block.op(0x79, 2, 10, -16); block.op(0x0f, 2, 1);
    block.op(0x61, 1, 2); block.op(0x0c, 1, 8); block.op(0xac, 0, 1); block.op(0x0c, destination, 0);
  };
  mix(7, 6, false); block.op(0x61, 1, 10, -24); block.op(0x0c, 8, 1); mix(6, 7, true);
  block.op(0x14, 9, 0, 0, 1); block.jump(0x56, 9, 0, 0, 'round');
  block.op(0x79, 1, 10, -8); block.op(0x63, 1, 6); block.op(0x63, 1, 7, 4); block.op(0xb7, 0); block.op(0x95);
  return {
    'filter.bpf.o': objectFile(main, block, data),
    'probe.bin': Buffer.concat([Buffer.from('R32\0'), Buffer.alloc(16)]),
    'loader.txt': [
      'Archive release gate / eBPF object, ELF64 little-endian ET_REL, EM_BPF 247.',
      'Entry section: xdp/archive. xdp_md: data:u32le at +0, data_end:u32le at +4.',
      'Packet: 52 33 32 00 || candidate:bytes16. Packet length must be exactly 20 bytes.',
      'Return values: XDP_DROP=1, XDP_PASS=2. The supplied probe is a framing example, not an accepted packet.',
      'LLVM REL: R_BPF_64_64 binds ordinary read-only section data; R_BPF_64_32 binds the program-local function.',
      'The offline desktop debugger uses virtual data addresses, 512-byte call stacks and no kernel helper implementation.',
      'Capsule key material, in order:',
      '  accepted candidate bytes (16)',
      '  case 30 SerializeScalar(current group secret) (32, big-endian)',
      '  case 31 authenticated material OCTET STRING (32)',
      'Previous archive codes are not custody material. Keep the recovered bytes from both preceding investigations.', '',
    ].join('\n'),
    'capsule.json': JSON.stringify(seal({ code }, Buffer.concat([material, ...upstream]), 'archive/bpf/convergence', random), null, 2),
  };
}
