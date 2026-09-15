import { keccak_256 } from '@noble/hashes/sha3';
import { seal } from '../core.mjs';

const hash = value => Buffer.from(keccak_256(value));
const integer = value => {
  const hex = BigInt(value).toString(16);
  return value === 0 || value === 0n ? Buffer.alloc(0) : Buffer.from(hex.padStart(Math.ceil(hex.length / 2) * 2, '0'), 'hex');
};
const word = value => Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex');
const length = (size, offset) => size < 56 ? Buffer.from([offset + size]) : Buffer.concat([Buffer.from([offset + 55 + integer(size).length]), integer(size)]);
export function rlpEncode(value) {
  if (Array.isArray(value)) {
    const payload = Buffer.concat(value.map(rlpEncode));
    return Buffer.concat([length(payload.length, 0xc0), payload]);
  }
  const bytes = Buffer.isBuffer(value) ? value : integer(value);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return Buffer.concat([length(bytes.length, 0x80), bytes]);
}
const nibbles = value => [...value].flatMap(byte => [byte >> 4, byte & 15]);
function compact(path, leaf) {
  const values = path.length & 1 ? [(leaf ? 3 : 1), ...path] : [(leaf ? 2 : 0), 0, ...path];
  return Buffer.from(Array.from({ length: values.length / 2 }, (_, i) => values[i * 2] * 16 + values[i * 2 + 1]));
}

function trie(records, allNodes) {
  const entries = records.map(([key, value]) => ({ path: nibbles(hash(key)), value }));
  function build(items, depth) {
    let node;
    if (items.length === 1) node = [compact(items[0].path.slice(depth), true), items[0].value];
    else {
      let shared = depth;
      while (shared < 64 && items.every(item => item.path[shared] === items[0].path[shared])) shared++;
      if (shared > depth) node = [compact(items[0].path.slice(depth, shared), false), reference(build(items, shared))];
      else {
        node = Array.from({ length: 17 }, () => Buffer.alloc(0));
        for (let i = 0; i < 16; i++) {
          const group = items.filter(item => item.path[depth] === i);
          if (group.length) node[i] = reference(build(group, depth + 1));
        }
      }
    }
    const encoded = rlpEncode(node);
    allNodes.set(hash(encoded).toString('hex'), encoded);
    return { encoded, node };
  }
  const reference = item => item.encoded.length < 32 ? item.node : hash(item.encoded);
  return hash(build(entries, 0).encoded);
}

export function trieEvidence(code, receipt, random) {
  const address = random(20), owner = random(20), ticket = random(8), material = random(128);
  const mapping = hash(Buffer.concat([Buffer.alloc(12), owner, word(9)]));
  const slot = hash(Buffer.concat([Buffer.alloc(24), ticket, mapping]));
  const dataSlot = BigInt('0x' + hash(slot).toString('hex'));
  const nodes = new Map(), rootHistory = [];
  const codeHash = hash(Buffer.from('archive-journal/evm/3'));
  for (let epoch = 0; epoch < 4; epoch++) {
    const storage = [];
    for (let i = 0; i < 384; i++) storage.push([random(32), rlpEncode(random(32))]);
    const value = epoch === 2 ? material : random(128);
    storage.push([slot, rlpEncode(integer(value.length * 2 + 1))]);
    for (let i = 0; i < 4; i++) storage.push([word(dataSlot + BigInt(i)), rlpEncode(value.subarray(i * 32, i * 32 + 32))]);
    const storageRoot = trie(storage, nodes);
    const accounts = Array.from({ length: 48 }, () => [random(20), rlpEncode([integer(random(2).readUInt16BE()), random(12), random(32), random(32)])]);
    accounts.push([address, rlpEncode([integer(37 + epoch), integer(0), storageRoot, codeHash])]);
    rootHistory.push(trie(accounts, nodes));
  }
  const header = rlpEncode([
    random(32), hash(rlpEncode([])), random(20), rootHistory[2], random(32), random(32), Buffer.alloc(256),
    integer(0), integer(22_900_027), integer(30_000_000), integer(16_721_803), integer(1_789_432_000),
    Buffer.from('archive-node/3'), random(32), Buffer.alloc(8), integer(2_000_000_000),
  ]);
  const records = [...nodes.values()];
  for (let i = records.length - 1; i; i--) {
    const j = random(4).readUInt32BE() % (i + 1); [records[i], records[j]] = [records[j], records[i]];
  }
  const witness = Buffer.concat([Buffer.from('MPTW'), word(records.length).subarray(28), ...records.flatMap(record => [word(record.length).subarray(28), record])]);
  return {
    'header.rlp': header,
    'witness.bin': witness,
    'transaction.json': JSON.stringify({ blockHash: '0x' + hash(header).toString('hex'), from: '0x' + owner.toString('hex'), to: '0x' + address.toString('hex'), input: '0x' + hash(Buffer.from('read(uint64)')).subarray(0, 4).toString('hex') + Buffer.concat([Buffer.alloc(24), ticket]).toString('hex') }, null, 2),
    'journal.sol': [
      'pragma solidity ^0.8.28;', 'contract Journal {', '    uint256[9] private reserved;',
      '    mapping(address => mapping(uint64 => bytes)) private journal;',
      '    function read(uint64 ticket) external view returns (bytes memory) {',
      '        return journal[msg.sender][ticket];', '    }', '}', '',
    ].join('\n'),
    'witness.h': '#include <stdint.h>\nstruct header { char magic[4]; uint32_t count_be; };\nstruct node { uint32_t size_be; uint8_t rlp[]; };\n',
    'capsule.json': JSON.stringify(seal({ code, receipt }, material, 'archive/evm/journal', random), null, 2),
  };
}
