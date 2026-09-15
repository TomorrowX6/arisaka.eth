import { openSeal } from '../decoders.mjs';
import { loadBpf } from '../../public/bpf-elf.js';
import { BpfMachine } from '../../public/bpf-core.js';

// Recovery is independent of the producer: reconstruct the ARX inverse and
// undo CBC/byte wiring. The generic VM is used only to verify the final packet.
function tableFromElf(input) {
  const bytes = Buffer.from(input), size = bytes.length;
  if (size < 64 || !bytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) || bytes.readUInt16LE(18) !== 247) throw Error('Invalid BPF ELF');
  const table = Number(bytes.readBigUInt64LE(40)), count = bytes.readUInt16LE(60), stringIndex = bytes.readUInt16LE(62);
  if (!Number.isSafeInteger(table) || !count || count > 256 || table < 64 || table + count * 64 > size || stringIndex >= count) throw Error('Invalid BPF section table');
  const section = index => {
    const at = table + index * 64, start = Number(bytes.readBigUInt64LE(at + 24)), length = Number(bytes.readBigUInt64LE(at + 32));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || start + length > size) throw Error('Invalid BPF section span');
    return { name: bytes.readUInt32LE(at), bytes: bytes.subarray(start, start + length) };
  };
  const names = section(stringIndex).bytes;
  for (let index = 1; index < count; index++) {
    const item = section(index), end = names.indexOf(0, item.name);
    if (end < item.name) throw Error('Invalid BPF section name');
    if (names.subarray(item.name, end).toString() === '.rodata') {
      if (item.bytes.length !== 96) throw Error('Unknown archive table layout'); return item.bytes;
    }
  }
  throw Error('BPF archive table missing');
}

export function recoverBpfMaterial(files) {
  const data = tableFromElf(files['filter.bpf.o']), u32 = n => BigInt.asUintN(32, n), read = offset => BigInt(data.readUInt32LE(offset));
  const delta = read(88), rounds = Number(read(92)), permutation = [...data.subarray(0, 16)];
  if (!(delta & 1n) || rounds < 48 || rounds > 63 || new Set(permutation).size !== 16 || permutation.some(n => n > 15)) throw Error('Invalid archive ARX parameters');
  const keys = [5n, 9n, 13n, 17n].map((shift, i) => {
    const mixed = read(32 + i * 4) ^ read(48 + (i + 1) % 4 * 4);
    return u32(u32(mixed << shift) | mixed >> (32n - shift)) + delta * BigInt(i + 1) & 0xffffffffn;
  });
  const unmixed = Buffer.alloc(16), mix = value => u32((u32(value << 4n) ^ value >> 5n) + value);
  for (let block = 0; block < 2; block++) {
    let left = read(72 + block * 8), right = read(76 + block * 8), sum = u32(delta * BigInt(rounds));
    for (let round = 0; round < rounds; round++) {
      right = u32(right - (mix(left) ^ u32(sum + keys[Number(sum >> 11n & 3n)])));
      sum = u32(sum - delta);
      left = u32(left - (mix(right) ^ u32(sum + keys[Number(sum & 3n)])));
    }
    const previous = block ? 72 : 64;
    unmixed.writeUInt32LE(Number(left ^ read(previous)), block * 8); unmixed.writeUInt32LE(Number(right ^ read(previous + 4)), block * 8 + 4);
  }
  const material = Buffer.alloc(16);
  permutation.forEach((source, index) => material[source] = unmixed[index] ^ data[16 + index]);
  const machine = new BpfMachine(loadBpf(files['filter.bpf.o']), Buffer.concat([Buffer.from('R32\0'), material]));
  machine.run();
  if (machine.status !== 'halted' || machine.registers[0] !== 2n) throw Error('Recovered BPF packet was not accepted: ' + machine.reason);
  return { material, rounds, instructions: machine.steps };
}

export function decodeBpfEvidence(files, frostMaterial, rs16Material) {
  if (frostMaterial?.length !== 32 || rs16Material?.length !== 32) throw Error('Both authenticated upstream materials are required');
  const { material } = recoverBpfMaterial(files);
  return openSeal(JSON.parse(files['capsule.json']), Buffer.concat([material, frostMaterial, rs16Material]));
}
