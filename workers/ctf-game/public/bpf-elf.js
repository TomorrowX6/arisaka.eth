import { BPF_CODE_LIMIT, BPF_DATA_LIMIT, decodeBpf, rawBpf } from './bpf-core.js';

export const BPF_ELF_LIMIT = 8 * 1024 * 1024;
const hex = n => '0x' + n.toString(16);
const relocationNames = { 0: 'R_BPF_NONE', 1: 'R_BPF_64_64', 2: 'R_BPF_64_ABS64', 3: 'R_BPF_64_ABS32', 4: 'R_BPF_64_NODYLD32', 10: 'R_BPF_64_32' };

// Intentionally a bounded offline linker, not libbpf. LLVM REL references to
// program-local functions and ordinary data are resolved into virtual regions.
// Maps, CO-RE, externs and platform helpers are never silently approximated.
export function loadBpf(input) {
  if (!(input instanceof Uint8Array || input instanceof ArrayBuffer) || input.byteLength > BPF_ELF_LIMIT) throw Error('BPF 文件必须为字节且不超过 8 MiB');
  const bytes = new Uint8Array(input);
  if (bytes[0] !== 0x7f || bytes[1] !== 69 || bytes[2] !== 76 || bytes[3] !== 70) return rawBpf(bytes);
  const fail = message => { throw Error('BPF ELF：' + message); };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const range = (offset, size) => { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > bytes.length - size) fail('文件范围越界'); };
  const number = value => { if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('64 位范围超出安全索引'); return Number(value); };
  range(0, 64);
  if (bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 || view.getUint16(16, true) !== 1 || view.getUint16(18, true) !== 247
    || view.getUint32(20, true) !== 1 || view.getUint16(52, true) !== 64) fail('仅支持 ELF64 little-endian ET_REL / EM_BPF');
  if (view.getBigUint64(24, true) || view.getBigUint64(32, true) || view.getUint16(56, true) || view.getUint32(48, true)) fail('不支持入口地址、program headers 或平台 flags');
  const shoff = number(view.getBigUint64(40, true)), count = view.getUint16(60, true), nameIndex = view.getUint16(62, true);
  if (!count || count > 256 || view.getUint16(58, true) !== 64 || !nameIndex || nameIndex >= count) fail('section 表无效（最多 256，不支持扩展编号）');
  range(shoff, count * 64);
  const sections = [];
  for (let index = 0; index < count; index++) {
    const at = shoff + index * 64, flags = view.getBigUint64(at + 8, true);
    const section = { index, nameOffset: view.getUint32(at, true), type: view.getUint32(at + 4, true), flags: hex(flags),
      offset: number(view.getBigUint64(at + 24, true)), size: number(view.getBigUint64(at + 32, true)), link: view.getUint32(at + 40, true), info: view.getUint32(at + 44, true),
      alignment: number(view.getBigUint64(at + 48, true)), stride: number(view.getBigUint64(at + 56, true)), alloc: Boolean(flags & 2n), executable: Boolean(flags & 4n), writable: Boolean(flags & 1n) };
    if (section.type !== 8) range(section.offset, section.size);
    if (section.alloc && (flags & ~7n || view.getBigUint64(at + 16, true))) fail('不支持 alloc section 的平台 flags / address');
    if (section.alignment > 1048576 || section.alignment && (BigInt(section.alignment) & BigInt(section.alignment - 1))) fail('section 对齐无效');
    sections.push(section);
  }
  if (sections[0].type !== 0 || sections[0].size) fail('section 0 必须为 NULL');
  function string(section, offset) {
    if (!section || section.type !== 3 || offset >= section.size) fail('字符串表索引无效');
    let end = section.offset + offset;
    while (end < section.offset + section.size && bytes[end] && end - section.offset - offset <= 1024) end++;
    if (end >= section.offset + section.size || bytes[end]) fail('字符串未终止或超过 1024 字节');
    return new TextDecoder().decode(bytes.subarray(section.offset + offset, end));
  }
  for (const section of sections) section.name = string(sections[nameIndex], section.nameOffset);
  const codeSections = sections.filter(section => section.executable && section.alloc && section.size), regions = [], warnings = [];
  let codeSize = 0, dataSize = 0, address = 0x30000000n;
  const originalStarts = new Map();
  for (const section of codeSections) {
    if (section.type !== 1 || section.size % 8 || (codeSize += section.size) > BPF_CODE_LIMIT) fail('代码 section 无效或总计超过 128 KiB');
    section.codeOffset = codeSize - section.size;
    // Decode each section separately so a wide instruction cannot straddle two.
    originalStarts.set(section.index, new Map(decodeBpf(bytes.subarray(section.offset, section.offset + section.size)).map(ins => [ins.offset, ins])));
  }
  if (!codeSize) fail('没有可执行 section');
  const code = new Uint8Array(codeSize), patched = new DataView(code.buffer);
  for (const section of codeSections) code.set(bytes.subarray(section.offset, section.offset + section.size), section.codeOffset);
  for (const section of sections.filter(section => section.alloc && !section.executable && section.size)) {
    if (![1, 8].includes(section.type) || /^(?:\.?maps)$/.test(section.name)) fail('不支持的内核 / 数据 section：' + section.name);
    dataSize += section.size; if (dataSize > BPF_DATA_LIMIT) fail('数据 section 总计超过 8 MiB');
    const alignment = BigInt(Math.max(8, section.alignment)); address = (address + alignment - 1n) / alignment * alignment;
    if (address + BigInt(section.size) > 0x70000000n) fail('虚拟数据地址空间耗尽');
    section.address = hex(address);
    regions.push({ name: section.name + ' [' + section.index + ']', address, writable: section.writable,
      bytes: section.type === 8 ? new Uint8Array(section.size) : bytes.slice(section.offset, section.offset + section.size) });
    address += BigInt(section.size) + 16n;
  }
  const symbols = [], tables = new Map();
  for (const table of sections.filter(section => section.type === 2)) {
    if (table.stride !== 24 || table.size % 24 || table.size / 24 + symbols.length > 8192 || table.info > table.size / 24) fail('符号表无效或超过 8192 个符号');
    const entries = [];
    for (let index = 0; index < table.size / 24; index++) {
      const at = table.offset + index * 24, sectionIndex = view.getUint16(at + 6, true), section = sections[sectionIndex];
      const value = view.getBigUint64(at + 8, true), size = view.getBigUint64(at + 16, true), kind = bytes[at + 4] & 15;
      if (sectionIndex && sectionIndex < 0xff00 && (!section || value + size > BigInt(section.size))) fail('符号范围超出 section');
      const symbol = { index, table: table.index, name: string(sections[table.link], view.getUint32(at, true)), kind,
        binding: bytes[at + 4] >> 4, visibility: bytes[at + 5] & 3, section: sectionIndex, sectionName: section?.name || '', value: hex(value), size: hex(size) };
      if (section?.codeOffset !== undefined && value < BigInt(section.size) && value % 8n === 0n) symbol.pc = section.codeOffset / 8 + Number(value / 8n);
      if (section?.address) symbol.address = hex(BigInt(section.address) + value);
      symbols.push(symbol); entries.push(symbol);
    }
    tables.set(table.index, entries);
  }
  const relocations = [], seen = new Set();
  for (const table of sections.filter(section => section.type === 9 || section.type === 4)) {
    const stride = table.type === 9 ? 16 : 24, target = sections[table.info], entries = tables.get(table.link);
    if (table.stride !== stride || table.size % stride || !target || !entries || relocations.length + table.size / stride > 8192) fail('重定位表无效或超过 8192 项');
    for (let at = table.offset; at < table.offset + table.size; at += stride) {
      const offset = number(view.getBigUint64(at, true)), info = view.getBigUint64(at + 8, true), type = Number(info & 0xffffffffn), symbol = entries[Number(info >> 32n)];
      if (!symbol || offset >= target.size) fail('重定位符号或偏移无效');
      const row = { section: target.name, offset, type: relocationNames[type] || 'type ' + type, symbol: symbol.name || symbol.sectionName, applied: false };
      relocations.push(row); if (!type) continue;
      if (!target.alloc) { row.note = '非加载元数据，仅展示、不重定位'; continue; }
      if (table.type !== 9 || !target.executable || ![1, 10].includes(type)) fail('仅支持代码中的 LLVM REL 数据 / 本地调用重定位：' + row.type);
      const ins = originalStarts.get(target.index)?.get(offset), location = target.codeOffset + offset, destination = sections[symbol.section];
      if (!ins || seen.has(location) || !symbol.section || !destination) fail('重定位落在 continuation、重复或依赖外部符号');
      seen.add(location); row.pc = location / 8;
      if (type === 1) {
        if (ins.opcode !== 0x18 || ins.src || ins.off || ins.wide >> 32n || !destination.address) fail('数据重定位必须引用普通数据 section 的 ldimm64');
        const relative = BigInt(symbol.value) + ins.wide;
        if (relative > BigInt(destination.size)) fail('数据重定位 addend 越界');
        const value = BigInt(destination.address) + relative;
        patched.setUint32(location + 4, Number(value & 0xffffffffn), true); patched.setUint32(location + 12, Number(value >> 32n), true);
        row.addend = hex(ins.wide); row.resolved = hex(value);
      } else {
        if (ins.opcode !== 0x85 || ins.src !== 1 || ins.dst || ins.off || destination.codeOffset === undefined) fail('调用重定位必须引用本地代码');
        const relative = BigInt(symbol.value) + BigInt(ins.imm + 1) * 8n;
        if (relative < 0n || relative >= BigInt(destination.size) || relative % 8n || !originalStarts.get(destination.index).has(Number(relative))) fail('调用重定位 addend 不在指令边界');
        const targetPc = (destination.codeOffset + Number(relative)) / 8;
        patched.setInt32(location + 4, targetPc - location / 8 - 1, true);
        row.addend = hex(BigInt(ins.imm + 1) * 8n); row.resolved = 'pc ' + targetPc;
      }
      row.applied = true;
    }
  }
  const instructions = decodeBpf(code), starts = new Set(instructions.map(ins => ins.pc));
  for (const ins of instructions) {
    const section = codeSections.find(section => ins.offset >= section.codeOffset && ins.offset < section.codeOffset + section.size);
    ins.section = section.name; ins.sectionOffset = ins.offset - section.codeOffset; ins.fileOffset = section.offset + ins.sectionOffset;
    // Flattening must not accidentally make an out-of-section jump valid.
    if (ins.target !== undefined && ins.op !== 8 && (ins.target * 8 < section.codeOffset || ins.target * 8 >= section.codeOffset + section.size)) ins.error ||= '普通分支越过 section 边界';
    if (ins.opcode !== 0x95 && ins.opcode !== 0x05 && ins.opcode !== 0x06 && (ins.pc + ins.size) * 8 === section.codeOffset + section.size) ins.error ||= '指令可能顺序落出 section';
  }
  const entries = [];
  for (const section of codeSections) entries.push({ pc: section.codeOffset / 8, name: section.name + ' / pc ' + section.codeOffset / 8 });
  for (const symbol of symbols.filter(symbol => symbol.kind === 2 && symbol.pc !== undefined)) {
    if (!starts.has(symbol.pc)) fail('函数符号落在 continuation');
    entries.push({ pc: symbol.pc, name: symbol.sectionName + ' :: ' + (symbol.name || '(anonymous)') + ' / pc ' + symbol.pc });
  }
  const preferred = codeSections.find(section => /^xdp(?:\/|$)/.test(section.name)) || codeSections.find(section => section.name === '.text') || codeSections[0];
  if (relocations.some(row => row.note)) warnings.push('非加载的 debug / BTF 元数据重定位仅列出，不执行 CO-RE。');
  warnings.push('离线虚拟数据指针，不是 Linux map FD；不执行 helpers、BTF 调用、原子指令或 JIT。');
  return { format: 'ELF64-LE-BPF', code, instructions, entry: preferred.codeOffset / 8, entries, symbols, sections, relocations, regions, warnings };
}
