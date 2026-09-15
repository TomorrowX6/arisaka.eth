// RFC 9669 instruction semantics. This is an offline interpreter, not a
// kernel verifier: no helpers, syscalls, networking, JIT or host memory access.
export const BPF_CODE_LIMIT = 128 * 1024;
export const BPF_INPUT_LIMIT = 1024 * 1024;
export const BPF_DATA_LIMIT = 8 * 1024 * 1024;
const u64 = n => BigInt.asUintN(64, n), signed = (bits, n) => BigInt.asIntN(bits, n);
const aluNames = ['add', 'sub', 'mul', 'div', 'or', 'and', 'lsh', 'rsh', 'neg', 'mod', 'xor', 'mov', 'arsh', 'end'];
const jumps = { 1: 'jeq', 2: 'jgt', 3: 'jge', 4: 'jset', 5: 'jne', 6: 'jsgt', 7: 'jsge', 10: 'jlt', 11: 'jle', 12: 'jslt', 13: 'jsle' };
const hex = n => '0x' + n.toString(16);

export function decodeBpf(input) {
  if (!(input instanceof Uint8Array || input instanceof ArrayBuffer) || !input.byteLength || input.byteLength % 8 || input.byteLength > BPF_CODE_LIMIT) throw Error('BPF 代码必须为 8 字节倍数，且不超过 128 KiB');
  const bytes = new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), instructions = [];
  for (let pc = 0; pc < bytes.length / 8; pc++) {
    const at = pc * 8, opcode = bytes[at], dst = bytes[at + 1] & 15, src = bytes[at + 1] >> 4;
    const off = view.getInt16(at + 2, true), imm = view.getInt32(at + 4, true), cls = opcode & 7, op = opcode >> 4, register = Boolean(opcode & 8);
    const ins = { pc, offset: at, size: 1, opcode, dst, src, off, imm, cls, op, register, mnemonic: '.insn', operands: hex(opcode), error: '' };
    const bad = message => ins.error ||= message;
    if (dst > 10 || src > 10) bad('寄存器编号超过 r10');
    if (opcode === 0x18) {
      if (pc + 1 >= bytes.length / 8) throw Error('BPF ldimm64 缺少第二个 slot');
      if (view.getUint32(at + 8, true)) bad('ldimm64 continuation 的保留字段非零');
      ins.size = 2; ins.wide = BigInt(view.getUint32(at + 4, true)) | BigInt(view.getUint32(at + 12, true)) << 32n;
      ins.mnemonic = 'ldimm64'; ins.operands = 'r' + dst + ', ' + hex(ins.wide) + (src ? ' [pseudo=' + src + ']' : '');
      if (off || src > 6) bad('ldimm64 保留字段无效'); if (dst === 10) bad('r10 只读'); pc++;
    } else if ([1, 2, 3].includes(cls) && [0x60, 0x80].includes(opcode & 0xe0)) {
      ins.width = [4, 2, 1, 8][opcode >> 3 & 3]; ins.signExtend = (opcode & 0xe0) === 0x80;
      if (ins.signExtend && (cls !== 1 || ins.width === 8)) bad('无效 MEMSX 模式');
      const address = '[r' + (cls === 1 ? src : dst) + (off < 0 ? '' : '+') + off + ']';
      ins.mnemonic = (cls === 1 ? 'ldx' : cls === 2 ? 'st' : 'stx') + (ins.signExtend ? 's' : '') + ins.width * 8;
      ins.operands = cls === 1 ? 'r' + dst + ', ' + address : address + ', ' + (cls === 2 ? String(imm) : 'r' + src);
      if (cls !== 2 && imm || cls === 2 && src) bad('内存指令保留字段非零'); if (cls === 1 && dst === 10) bad('r10 只读');
    } else if (cls === 4 || cls === 7) {
      ins.bits = cls === 4 ? 32 : 64; ins.mnemonic = (aluNames[op] || '.insn') + ins.bits;
      ins.operands = 'r' + dst + (op === 8 ? '' : ', ' + (register ? 'r' + src : imm));
      if (!aluNames[op]) bad('未定义的 ALU 操作');
      if (dst === 10) bad('r10 只读'); if (!register && src) bad('立即数 ALU 的 src_reg 必须为 0'); if (register && imm && op !== 13) bad('寄存器 ALU 的 imm 必须为 0');
      if (off && !([3, 9].includes(op) && off === 1 || op === 11 && register && (cls === 4 ? [8, 16] : [8, 16, 32]).includes(off))) bad('ALU offset 无效');
      if ([3, 9].includes(op) && off === 1) ins.mnemonic = (op === 3 ? 'sdiv' : 'smod') + ins.bits;
      if (op === 11 && off) ins.mnemonic = 'movsx' + off + '/' + ins.bits;
      if (op === 8 && (register || imm || src)) bad('NEG 保留字段非零');
      if (op === 13) {
        if (off || src || ![16, 32, 64].includes(imm) || cls === 7 && register) bad('字节交换字段无效');
        ins.mnemonic = (cls === 7 ? 'bswap' : register ? 'be' : 'le') + imm; ins.operands = 'r' + dst;
      }
    } else if (cls === 5 || cls === 6) {
      ins.bits = cls === 5 ? 64 : 32;
      if (!op) {
        ins.mnemonic = cls === 5 ? 'ja' : 'gotol'; ins.target = pc + 1 + (cls === 5 ? off : imm); ins.operands = 'pc ' + ins.target;
        if (register || dst || src || cls === 5 && imm || cls === 6 && off) bad('JA 保留字段非零');
      } else if (jumps[op]) {
        ins.target = pc + 1 + off; ins.mnemonic = jumps[op] + ins.bits; ins.operands = 'r' + dst + ', ' + (register ? 'r' + src : imm) + ', pc ' + ins.target;
        if (!register && src || register && imm) bad('条件跳转保留字段非零');
      } else if (cls === 5 && op === 8 && !register) {
        ins.mnemonic = src === 1 ? 'call.local' : src === 2 ? 'call.btf' : 'call.helper';
        if (src === 1) ins.target = pc + 1 + imm;
        ins.operands = src === 1 ? 'pc ' + ins.target : String(imm); if (dst || off || src > 2) bad('CALL 字段无效');
      } else if (cls === 5 && op === 9 && !register) { ins.mnemonic = 'exit'; ins.operands = ''; if (dst || src || off || imm) bad('EXIT 保留字段非零'); }
      else bad('未定义的跳转操作');
    } else bad('此离线解释器不支持该指令（legacy packet / atomic / platform 扩展）');
    instructions.push(ins);
  }
  const starts = new Set(instructions.map(ins => ins.pc));
  for (const ins of instructions) if (ins.target !== undefined && !starts.has(ins.target)) ins.error ||= '分支落在代码外或 ldimm64 的 continuation';
  return instructions;
}

export function rawBpf(input) {
  const instructions = decodeBpf(input), bytes = new Uint8Array(input);
  return { format: 'raw', code: bytes, instructions, entry: 0, entries: [{ pc: 0, name: 'raw / pc 0' }], symbols: [], sections: [], relocations: [], regions: [], warnings: [] };
}

export class BpfMachine {
  constructor(program, input = new Uint8Array(), entry = program.entry) {
    const invalid = program.instructions.find(ins => ins.error); if (invalid) throw Error('pc ' + invalid.pc + ': ' + invalid.error);
    if (!(input instanceof Uint8Array) || input.length > BPF_INPUT_LIMIT) throw Error('输入必须为字节且不超过 1 MiB');
    this.instructions = new Map(program.instructions.map(ins => [ins.pc, ins]));
    if (!this.instructions.has(entry)) throw Error('入口不是有效指令');
    this.pc = entry; this.steps = 0; this.status = 'paused'; this.reason = 'ready'; this.frames = [];
    let dataSize = 0;
    this.regions = (program.regions || []).map(region => {
      dataSize += region.bytes?.byteLength || 0;
      if (!(region.bytes instanceof Uint8Array) || dataSize > BPF_DATA_LIMIT || typeof region.address !== 'bigint'
        || region.address < 0x30000000n || region.address + BigInt(region.bytes.length) > 0x70000000n) throw Error('离线数据区域无效或超过 8 MiB');
      return { ...region, bytes: new Uint8Array(region.bytes), initialized: new Uint8Array(region.bytes.length).fill(1) };
    });
    for (const [index, region] of this.regions.entries()) if (this.regions.slice(0, index).some(other => other.name === region.name
      || region.address < other.address + BigInt(other.bytes.length) && other.address < region.address + BigInt(region.bytes.length))) throw Error('离线数据区域重叠或重名');
    const context = new Uint8Array(24), view = new DataView(context.buffer);
    view.setUint32(0, 0x10000000, true); view.setUint32(4, 0x10000000 + input.length, true);
    this.regions.push({ name: 'packet', address: 0x10000000n, bytes: new Uint8Array(input), writable: true, initialized: new Uint8Array(input.length).fill(1) },
      { name: 'xdp_md', address: 0x20000000n, bytes: context, writable: false, initialized: new Uint8Array(context.length).fill(1) });
    this.registers = Array(11).fill(null); this.registers[1] = 0x20000000n; this.pushStack();
  }
  pushStack() {
    const address = 0x80000000n + BigInt(this.frames.length) * 1024n;
    this.regions.push({ name: 'stack/' + this.frames.length, address, bytes: new Uint8Array(512), initialized: new Uint8Array(512), writable: true, stack: true });
    this.registers[10] = address + 512n;
  }
  register(index) { const value = this.registers[index]; if (value === null) throw Error('读取未初始化寄存器 r' + index); return value; }
  memory(address, length, write = false) {
    const region = this.regions.find(item => address >= item.address && address + BigInt(length) <= item.address + BigInt(item.bytes.length));
    if (!region) throw Error('内存访问越界：' + hex(address) + ' / ' + length + ' B');
    if (write && !region.writable) throw Error('写入只读区域：' + region.name);
    return { region, at: Number(address - region.address) };
  }
  load(address, width) {
    const { region, at } = this.memory(address, width); let value = 0n;
    for (let i = width - 1; i >= 0; i--) { if (!region.initialized[at + i]) throw Error('读取未初始化的栈字节：' + hex(address + BigInt(i))); value = value << 8n | BigInt(region.bytes[at + i]); }
    return value;
  }
  store(address, width, value) {
    const { region, at } = this.memory(address, width, true);
    for (let i = 0; i < width; i++) { region.bytes[at + i] = Number(value & 255n); region.initialized[at + i] = 1; value >>= 8n; }
  }
  step() {
    if (this.status === 'halted' || this.status === 'error') return;
    const ins = this.instructions.get(this.pc); if (!ins) { this.status = 'error'; this.reason = '程序离开指令边界'; return; }
    try {
      const { opcode, cls, op, dst, src, off, imm, register, bits } = ins; let next = this.pc + ins.size;
      const write = value => { if (dst === 10) throw Error('r10 只读'); this.registers[dst] = u64(value); };
      if (opcode === 0x18) { if (src) throw Error('未绑定的 pseudo ldimm64；不模拟内核 map FD'); write(ins.wide); }
      else if ([1, 2, 3].includes(cls)) {
        const address = this.register(cls === 1 ? src : dst) + BigInt(off);
        if (cls === 1) { const value = this.load(address, ins.width); write(ins.signExtend ? signed(ins.width * 8, value) : value); }
        else this.store(address, ins.width, cls === 2 ? u64(BigInt(imm)) : this.register(src));
      } else if (cls === 4 || cls === 7) {
        const mask = n => BigInt.asUintN(bits, n), a = op === 11 ? 0n : mask(this.register(dst));
        let b = op === 8 || op === 13 ? 0n : mask(register ? this.register(src) : BigInt(imm)), value;
        if (op === 0) value = a + b;
        else if (op === 1) value = a - b;
        else if (op === 2) value = a * b;
        else if (op === 3) value = !b ? 0n : off === 1 ? signed(bits, a) / signed(bits, b) : a / b;
        else if (op === 4) value = a | b;
        else if (op === 5) value = a & b;
        else if (op === 6) value = a << (b & BigInt(bits - 1));
        else if (op === 7) value = a >> (b & BigInt(bits - 1));
        else if (op === 8) value = -a;
        else if (op === 9) value = !b ? a : off === 1 ? signed(bits, a) % signed(bits, b) : a % b;
        else if (op === 10) value = a ^ b;
        else if (op === 11) value = off ? signed(off, b) : b;
        else if (op === 12) value = signed(bits, a) >> (b & BigInt(bits - 1));
        else if (op === 13) {
          value = BigInt.asUintN(imm, this.register(dst));
          if (cls === 7 || register) { let out = 0n; for (let i = 0; i < imm / 8; i++) { out = out << 8n | value & 255n; value >>= 8n; } value = out; }
          // END64 in the ALU class still writes a full 64-bit result.
          write(value); value = undefined;
        } else throw Error('未实现的 ALU');
        if (value !== undefined) write(mask(value));
      } else if (cls === 5 || cls === 6) {
        if (!op) next = ins.target;
        else if (op === 8) {
          if (src !== 1) throw Error('离线解释器不执行平台 helper / BTF 调用：' + imm);
          if (this.frames.length >= 7) throw Error('调用深度超过 8 帧');
          this.frames.push({ returnPc: next, saved: this.registers.slice(6, 11) });
          this.registers[0] = null;
          for (let i = 6; i <= 9; i++) this.registers[i] = null;
          this.pushStack(); next = ins.target;
        } else if (op === 9) {
          const result = this.register(0);
          if (!this.frames.length) { this.status = 'halted'; this.reason = 'exit ' + result; }
          else {
            const frame = this.frames.pop(); this.regions.pop();
            frame.saved.forEach((value, i) => this.registers[i + 6] = value);
            for (let i = 1; i <= 5; i++) this.registers[i] = null;
            this.registers[0] = result; next = frame.returnPc;
          }
        } else {
          const a = BigInt.asUintN(bits, this.register(dst)), b = BigInt.asUintN(bits, register ? this.register(src) : BigInt(imm));
          const conditions = { 1: a === b, 2: a > b, 3: a >= b, 4: Boolean(a & b), 5: a !== b,
            6: signed(bits, a) > signed(bits, b), 7: signed(bits, a) >= signed(bits, b), 10: a < b, 11: a <= b,
            12: signed(bits, a) < signed(bits, b), 13: signed(bits, a) <= signed(bits, b) };
          if (conditions[op]) next = ins.target;
        }
      }
      this.pc = next; this.steps++; if (this.status !== 'halted') { this.status = 'paused'; this.reason = 'step'; }
    } catch (error) { this.status = 'error'; this.reason = 'pc ' + ins.pc + ': ' + error.message; }
  }
  run({ limit = 50000, breakpoints = [], skipCurrent = true } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50000) throw Error('每次执行上限为 50000 条指令');
    const stops = new Set(breakpoints);
    for (let i = 0; i < limit && this.status === 'paused'; i++) {
      if ((!skipCurrent || i) && stops.has(this.pc)) { this.reason = 'breakpoint'; return this.snapshot(); }
      this.step();
    }
    if (this.status === 'paused') this.reason = 'instruction budget'; return this.snapshot();
  }
  snapshot() {
    return { pc: this.pc, steps: this.steps, status: this.status, reason: this.reason, depth: this.frames.length + 1,
      registers: this.registers.map(n => n === null ? null : { hex: '0x' + n.toString(16).padStart(16, '0'), unsigned: String(n), signed: String(signed(64, n)) }),
      regions: this.regions.map(region => ({ name: region.name, address: hex(region.address), size: region.bytes.length, writable: region.writable })) };
  }
  inspectMemory(name, offset = 0, length = 256) {
    const region = this.regions.find(region => region.name === name);
    if (!region || !Number.isInteger(offset) || offset < 0 || offset > region.bytes.length || !Number.isInteger(length) || length < 0 || length > 4096) throw Error('内存预览范围无效');
    const end = Math.min(region.bytes.length, offset + length);
    return { address: hex(region.address + BigInt(offset)), bytes: region.bytes.slice(offset, end), initialized: region.initialized.slice(offset, end), total: region.bytes.length };
  }
}
