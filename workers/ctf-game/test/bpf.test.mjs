import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BpfMachine, decodeBpf, rawBpf, BPF_CODE_LIMIT } from '../public/bpf-core.js';
import { loadBpf } from '../public/bpf-elf.js';
import { seededRandom } from '../scripts/core.mjs';

const instruction = (op, dst = 0, src = 0, off = 0, imm = 0) => {
  const bytes = Buffer.alloc(8); bytes[0] = op; bytes[1] = src * 16 + dst; bytes.writeInt16LE(off, 2); bytes.writeInt32LE(imm | 0, 4); return bytes;
};
const wide = (dst, value) => { value = BigInt.asUintN(64, value); return Buffer.concat([instruction(0x18, dst, 0, 0, Number(value & 0xffffffffn)), instruction(0, 0, 0, 0, Number(value >> 32n))]); };
const program = (...instructions) => rawBpf(Buffer.concat(instructions));
const exit = () => instruction(0x95);
function run(...instructions) {
  const machine = new BpfMachine(program(...instructions, exit())); machine.run();
  assert.equal(machine.status, 'halted', machine.reason); return machine.registers[0];
}

// Deliberately independent of the challenge's assembler/ELF producer. This is a
// minimal two-code-section object with one LLVM REL call and one data reference.
export function elfFixture({ localCall = false } = {}) {
  const names = Buffer.from('\0.text\0xdp\0.rodata\0.symtab\0.strtab\0.relxdp\0.shstrtab\0');
  const strings = Buffer.from('\0multiply\0constant\0entry\0');
  const text = Buffer.concat([instruction(0xbf, 0, 1), instruction(0x27, 0, 0, 0, 3), exit(), instruction(0xb7, 0, 0, 0, 42), exit()]);
  const xdp = Buffer.concat([wide(2, 4n), instruction(0x61, 1, 2), instruction(0x85, 0, 1, 0, localCall ? 2 : -1), exit()]);
  const data = Buffer.from([0, 0, 0, 0, 7, 0, 0, 0]);
  const sym = Buffer.alloc(5 * 24), rel = Buffer.alloc(32);
  const symbol = (i, name, kind, section, value, size) => { const at = i * 24; sym.writeUInt32LE(strings.indexOf(name + '\0'), at); sym[at + 4] = 16 + kind; sym.writeUInt16LE(section, at + 6); sym.writeBigUInt64LE(BigInt(value), at + 8); sym.writeBigUInt64LE(BigInt(size), at + 16); };
  symbol(1, 'multiply', 2, 1, 0, 24); symbol(2, 'constant', 1, 3, 0, 8); symbol(3, 'entry', 2, 2, 0, xdp.length);
  // A section symbol exercises the encoded (byte addend / 8 - 1) case.
  sym[4 * 24 + 4] = 3; sym.writeUInt16LE(1, 4 * 24 + 6);
  rel.writeBigUInt64LE(0n, 0); rel.writeBigUInt64LE(2n << 32n | 1n, 8);
  rel.writeBigUInt64LE(24n, 16); rel.writeBigUInt64LE(BigInt(localCall ? 4 : 1) << 32n | 10n, 24);
  const list = [null, [text, '.text', 1, 6, 0, 0, 8], [xdp, 'xdp', 1, 6, 0, 0, 8], [data, '.rodata', 1, 2, 0, 0, 4],
    [sym, '.symtab', 2, 0, 5, 1, 8, 24], [strings, '.strtab', 3, 0, 0, 0, 1], [rel, '.relxdp', 9, 0, 4, 2, 8, 16], [names, '.shstrtab', 3, 0, 0, 0, 1]];
  let position = 64; const offsets = [];
  for (const section of list.slice(1)) { position = Math.ceil(position / 8) * 8; offsets.push(position); position += section[0].length; }
  const shoff = Math.ceil(position / 8) * 8, bytes = Buffer.alloc(shoff + 64 * list.length);
  bytes.set([127, 69, 76, 70, 2, 1, 1]); bytes.writeUInt16LE(1, 16); bytes.writeUInt16LE(247, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(BigInt(shoff), 40); bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(64, 58); bytes.writeUInt16LE(list.length, 60); bytes.writeUInt16LE(7, 62);
  for (const [i, section] of list.entries()) {
    if (!section) continue; const [content, name, type, flags, link, info, align, stride = 0] = section, at = shoff + i * 64;
    content.copy(bytes, offsets[i - 1]); bytes.writeUInt32LE(names.indexOf(name + '\0'), at); bytes.writeUInt32LE(type, at + 4);
    bytes.writeBigUInt64LE(BigInt(flags), at + 8); bytes.writeBigUInt64LE(BigInt(offsets[i - 1]), at + 24); bytes.writeBigUInt64LE(BigInt(content.length), at + 32);
    bytes.writeUInt32LE(link, at + 40); bytes.writeUInt32LE(info, at + 44); bytes.writeBigUInt64LE(BigInt(align), at + 48); bytes.writeBigUInt64LE(BigInt(stride), at + 56);
  }
  return bytes;
}

test('BPF wide immediates preserve full 64 bits; decoding rejects reserved fields and continuation jumps', () => {
  const bytes = Buffer.concat([wide(0, 0xfedcba9876543210n), exit()]), decoded = decodeBpf(bytes);
  assert.equal(decoded[0].wide, 0xfedcba9876543210n); assert.equal(decoded[1].pc, 2); assert.equal(run(wide(0, decoded[0].wide)), decoded[0].wide);
  assert.throws(() => decodeBpf(bytes.subarray(0, 8)), /第二个 slot/);
  assert.throws(() => decodeBpf(Buffer.alloc(BPF_CODE_LIMIT + 8)), /128 KiB/);
  assert.throws(() => decodeBpf(Buffer.alloc(9)), /8 字节/);
  for (const input of [program(instruction(0x05, 0, 0, 1), wide(0, 1n), exit()), program(instruction(0xb7, 10), exit()), program(instruction(0x0f, 0, 1, 0, 1), exit()), program(instruction(0x8f), exit())]) {
    assert.ok(input.instructions.some(ins => ins.error)); assert.throws(() => new BpfMachine(input), /pc/);
  }
  const bad = Buffer.from(bytes); bad[8] = 1; assert.match(decodeBpf(bad)[0].error, /保留字段/);
});

test('BPF ALU32 zero-extension differs from sign-extended ALU64 immediates and signed moves', () => {
  assert.equal(run(instruction(0xb4, 0, 0, 0, -1)), 0xffffffffn);
  assert.equal(run(instruction(0xb7, 0, 0, 0, -1)), 0xffffffffffffffffn);
  assert.equal(run(wide(0, 0xfeedffffffffn), instruction(0x04, 0, 0, 0, 1)), 0n);
  assert.equal(run(instruction(0xb7, 0, 0, 0, -1), instruction(0x07, 0, 0, 0, 2)), 1n);
  assert.equal(run(instruction(0xb7, 1, 0, 0, 0x80), instruction(0xbc, 0, 1, 8)), 0xffffff80n);
  assert.equal(run(instruction(0xb7, 1, 0, 0, 0x8000), instruction(0xbf, 0, 1, 16)), 0xffffffffffff8000n);
  assert.equal(run(wide(1, 0xffffffff80000000n), instruction(0xbf, 0, 1, 32)), 0xffffffff80000000n);
  assert.throws(() => new BpfMachine(program(instruction(0xbc, 0, 1, 32), exit())), /offset/);
});

test('BPF arithmetic uses width-masked shifts, truncating signed division and specified zero-divisor behavior', () => {
  assert.equal(run(instruction(0xb7, 0, 0, 0, 1), instruction(0x64, 0, 0, 0, 33)), 2n);
  assert.equal(run(instruction(0xb7, 0, 0, 0, -4), instruction(0xc7, 0, 0, 0, 65)), 0xfffffffffffffffen);
  assert.equal(run(instruction(0xb7, 0, 0, 0, -13), instruction(0x37, 0, 0, 1, 3)), 0xfffffffffffffffcn);
  assert.equal(run(instruction(0xb7, 0, 0, 0, -13), instruction(0x97, 0, 0, 1, 3)), 0xffffffffffffffffn);
  assert.equal(run(wide(0, 0x8000000000000000n), instruction(0x37, 0, 0, 1, -1)), 0x8000000000000000n);
  assert.equal(run(wide(0, 0x1234567887654321n), instruction(0x97)), 0x1234567887654321n);
  assert.equal(run(wide(0, 0x1234567887654321n), instruction(0x94)), 0x87654321n);
  assert.equal(run(wide(0, 0x1234567887654321n), instruction(0x37)), 0n);
  assert.equal(run(instruction(0xb7, 0, 0, 0, -1), instruction(0x37, 0, 0, 0, -1)), 1n);
});

test('BPF LE/BE and unconditional byte swaps write the declared width, including END64 in ALU class', () => {
  for (const op of [0xdc, 0xd7]) {
    assert.equal(run(wide(0, 0x0123456789abcdefn), instruction(op, 0, 0, 0, 64)), 0xefcdab8967452301n);
    assert.equal(run(wide(0, 0x0123456789abcdefn), instruction(op, 0, 0, 0, 16)), 0xefcdn);
  }
  assert.equal(run(wide(0, 0x0123456789abcdefn), instruction(0xd4, 0, 0, 0, 64)), 0x0123456789abcdefn);
  assert.equal(run(wide(0, 0x0123456789abcdefn), instruction(0xd4, 0, 0, 0, 32)), 0x89abcdefn);
  assert.throws(() => new BpfMachine(program(instruction(0xdf, 0, 0, 0, 64), exit())), /字节交换/);
});

test('BPF JMP/JMP32 compare the proper width and signedness, and gotol uses a slot-relative imm', () => {
  const branch = (op, imm) => run(instruction(0xb7, 0, 0, 0, -1), instruction(op, 0, 0, 1, imm), instruction(0xb7, 0, 0, 0, 99));
  assert.equal(branch(0x15, -1), 0xffffffffffffffffn);
  assert.equal(branch(0xa6, 0), 99n); // unsigned -1 < 0 is false
  assert.equal(branch(0xc6, 0), 0xffffffffffffffffn); // signed -1 < 0
  assert.equal(run(instruction(0xb7, 0, 0, 0, 7), instruction(0x06, 0, 0, 0, 1), instruction(0xb7, 0, 0, 0, 9)), 7n);
  const machine = new BpfMachine(program(instruction(0x05, 0, 0, -1)));
  assert.equal(machine.run({ limit: 19 }).steps, 19); assert.equal(machine.reason, 'instruction budget');
  assert.throws(() => machine.run({ limit: 50001 }), /50000/);
});

test('BPF memory is little endian, bounds checked and refuses uninitialized stack/register reads', () => {
  assert.equal(run(instruction(0x62, 10, 0, -4, 0x807f0102), instruction(0x81, 0, 10, -4)), 0xffffffff807f0102n);
  assert.equal(run(instruction(0x6a, 10, 0, -2, 0x807f), instruction(0x89, 0, 10, -2)), 0xffffffffffff807fn);
  assert.equal(run(instruction(0x72, 10, 0, -1, 0x80), instruction(0x91, 0, 10, -1)), 0xffffffffffffff80n);
  const machine = new BpfMachine(program(instruction(0x72, 10, 0, -1, 42), instruction(0x61, 0, 10, -4), exit()));
  machine.step(); assert.deepEqual([...machine.inspectMemory('stack/0', 508, 4).initialized], [0, 0, 0, 1]);
  machine.step(); assert.equal(machine.status, 'error'); assert.match(machine.reason, /未初始化的栈/); assert.equal(machine.registers[0], null);
  for (const ins of [instruction(0x07, 0, 0, 0, 1), instruction(0x79, 0, 10, -513), instruction(0x72, 10, 0, 0, 1), instruction(0x62, 1)]) {
    const state = new BpfMachine(program(ins, exit())).run(); assert.equal(state.status, 'error'); assert.match(state.reason, /未初始化|越界|只读/);
  }
  const pointer = program(wide(0, 0x30000000n), instruction(0x72, 0), exit()); pointer.regions = [{ address: 0x30000000n, bytes: Buffer.from([1]), name: '.rodata', writable: false }];
  assert.match(new BpfMachine(pointer).run().reason, /只读/);
});

test('BPF XDP context exposes only a bounded packet, and execution does not mutate the source', () => {
  const bytes = Buffer.from([1, 2, 3, 4]), code = program(instruction(0x61, 2, 1), instruction(0x62, 2, 0, 0, -1), instruction(0x61, 0, 2), exit());
  const machine = new BpfMachine(code, bytes); machine.run(); assert.equal(machine.registers[0], 0xffffffffn);
  assert.deepEqual([...bytes], [1, 2, 3, 4]); assert.deepEqual([...machine.inspectMemory('packet').bytes], [255, 255, 255, 255]);
  assert.equal(new BpfMachine(code, bytes.subarray(0, 3)).run().status, 'error');
});

test('BPF local calls preserve caller callee-saved registers, separate stacks, invalidate caller-saved values and bound depth', () => {
  const code = program(instruction(0xb7, 6, 0, 0, 123), instruction(0x62, 10, 0, -4, 9), instruction(0x85, 0, 1, 0, 2), instruction(0x0f, 0, 6), exit(),
    instruction(0xb7, 6, 0, 0, 456), instruction(0x62, 10, 0, -4, 7), instruction(0x61, 0, 10, -4), exit());
  const machine = new BpfMachine(code); machine.run(); assert.equal(machine.registers[0], 130n); assert.equal(machine.regions.at(-1).name, 'stack/0');
  assert.equal(machine.load(machine.registers[10] - 4n, 4), 9n); assert.equal(machine.registers[1], null);
  const recursion = new BpfMachine(program(instruction(0x85, 0, 1, 0, -1), exit())); recursion.run(); assert.match(recursion.reason, /8 帧/);
  const noReturn = new BpfMachine(program(instruction(0xb7, 0, 0, 0, 1), instruction(0x85, 0, 1, 0, 1), exit(), exit()));
  noReturn.run(); assert.match(noReturn.reason, /未初始化寄存器 r0/);
  assert.match(new BpfMachine(program(instruction(0x85, 0, 0, 0, 1), exit())).run().reason, /不执行平台/);
});

test('BPF breakpoints stop before execution, resume one instruction, and snapshots are exact', () => {
  const machine = new BpfMachine(program(instruction(0xb7, 0, 0, 0, 7), instruction(0x07, 0, 0, 0, 1), exit()));
  machine.run({ breakpoints: [0], skipCurrent: false }); assert.equal(machine.steps, 0);
  machine.run({ breakpoints: [1] }); assert.equal(machine.steps, 1); assert.equal(machine.pc, 1); assert.equal(machine.reason, 'breakpoint');
  machine.run({ breakpoints: [1] }); assert.equal(machine.registers[0], 8n); assert.equal(machine.status, 'halted');
  assert.deepEqual(machine.snapshot().registers[0], { hex: '0x0000000000000008', unsigned: '8', signed: '8' });
});

test('ELF64 BPF loader resolves LLVM REL data and local calls across distinct code sections', () => {
  for (const localCall of [false, true]) {
    const code = loadBpf(elfFixture({ localCall })); assert.equal(code.entry, 5); assert.equal(code.format, 'ELF64-LE-BPF');
    assert.equal(code.regions.length, 1); assert.equal(code.regions[0].writable, false); assert.equal(code.relocations.filter(row => row.applied).length, 2);
    const machine = new BpfMachine(code); machine.run(); assert.equal(machine.status, 'halted', machine.reason); assert.equal(machine.registers[0], localCall ? 42n : 21n);
    assert.equal(code.instructions.find(ins => ins.pc === 5).wide, 0x30000004n); assert.ok(code.entries.some(entry => entry.name.includes('multiply')));
    assert.ok(code.instructions.every(ins => Number.isInteger(ins.fileOffset)));
  }
});

test('ELF loader rejects malformed ranges, undefined symbols, continuation relocations and unsupported ABI features', () => {
  const initial = elfFixture(), parsed = loadBpf(initial), header = Number(initial.readBigUInt64LE(40));
  const mutations = [b => b[5] = 2, b => b.writeUInt16LE(62, 18), b => b.writeBigUInt64LE(2n ** 63n, 40), b => b.writeUInt16LE(0, 60),
    b => b.writeBigUInt64LE(2n ** 40n, header + 3 * 64 + 32), b => b.writeUInt16LE(0, parsed.sections[4].offset + 2 * 24 + 6),
    b => b.writeBigUInt64LE(8n, parsed.sections[6].offset), b => b.writeUInt32LE(2, parsed.sections[6].offset + 8),
    b => b.writeBigUInt64LE(24n, parsed.sections[6].offset), b => b.writeUInt32LE(999, parsed.sections[4].offset + 24),
    b => b.writeBigUInt64LE(12n, parsed.sections[4].offset + 24 + 8), b => b.writeUInt32LE(32, parsed.sections[2].offset + 4)];
  for (const mutate of mutations) { const b = Buffer.from(initial); mutate(b); assert.throws(() => loadBpf(b), /ELF|BPF/); }
  for (let end = 4; end < initial.length; end += 7) assert.throws(() => loadBpf(initial.subarray(0, end)), /ELF|BPF/);
});

test('bounded BPF fuzzing never executes unsupported opcodes or escapes the instruction budget', () => {
  const random = seededRandom(Buffer.alloc(32, 61), 'bpf-fuzz');
  for (let i = 0; i < 400; i++) {
    let code; try { code = rawBpf(random(8 * (1 + i % 31))); } catch { continue; }
    if (code.instructions.some(ins => ins.error)) { assert.throws(() => new BpfMachine(code)); continue; }
    const result = new BpfMachine(code).run({ limit: 64 }); assert.ok(result.steps <= 64); assert.ok(['paused', 'error', 'halted'].includes(result.status));
  }
});
