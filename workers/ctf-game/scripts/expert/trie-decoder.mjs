import { keccak_256 } from '@noble/hashes/sha3';
import { openSeal } from '../decoders.mjs';

const digest = bytes => Buffer.from(keccak_256(bytes));
function rlp(bytes) {
  function item(at) {
    if (at >= bytes.length) throw Error('Truncated RLP');
    const tag = bytes[at];
    if (tag < 128) return [bytes.subarray(at, at + 1), at + 1];
    const list = tag >= 192, base = list ? 192 : 128;
    let count = tag - base, start = at + 1;
    if (count > 55) {
      const width = count - 55;
      if (width > 6 || start + width > bytes.length || !bytes[start]) throw Error('Noncanonical RLP length');
      count = Number(BigInt('0x' + bytes.subarray(start, start + width).toString('hex')));
      start += width;
      if (count < 56) throw Error('Noncanonical RLP length');
    }
    const end = start + count;
    if (end > bytes.length || !list && count === 1 && bytes[start] < 128) throw Error('Noncanonical RLP');
    if (!list) return [bytes.subarray(start, end), end];
    const result = []; let cursor = start;
    while (cursor < end) { const [value, next] = item(cursor); if (next > end) throw Error('Invalid RLP list'); result.push(value); cursor = next; }
    return [result, end];
  }
  const [value, end] = item(0);
  if (end !== bytes.length) throw Error('Trailing RLP');
  return value;
}
const pathBytes = value => [...value].flatMap(byte => [byte >>> 4, byte & 15]);
const word = value => Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex');

export function decodeTrieEvidence(files) {
  const headerBytes = Buffer.from(files['header.rlp']), header = rlp(headerBytes), tx = JSON.parse(files['transaction.json']);
  if (tx.blockHash !== '0x' + digest(headerBytes).toString('hex')) throw Error('Block hash mismatch');
  const bytes = Buffer.from(files['witness.bin']);
  if (bytes.subarray(0, 4).toString() !== 'MPTW') throw Error('Invalid witness');
  const nodes = new Map(); let cursor = 8;
  for (let i = 0; i < bytes.readUInt32BE(4); i++) {
    if (cursor + 4 > bytes.length) throw Error('Truncated witness');
    const length = bytes.readUInt32BE(cursor); cursor += 4;
    if (!length || cursor + length > bytes.length) throw Error('Truncated witness');
    const node = bytes.subarray(cursor, cursor + length); cursor += length;
    nodes.set(digest(node).toString('hex'), node);
  }
  if (cursor !== bytes.length) throw Error('Trailing witness bytes');
  function lookup(root, key) {
    const path = pathBytes(digest(key)); let depth = 0, reference = root;
    for (let iteration = 0; iteration < 66; iteration++) {
      let node;
      if (Array.isArray(reference)) node = reference;
      else {
        if (reference.length !== 32) throw Error('Invalid trie reference');
        const encoded = nodes.get(reference.toString('hex'));
        if (!encoded) throw Error('Missing authenticated trie node');
        node = rlp(encoded);
      }
      if (node.length === 17) {
        if (depth === path.length) return node[16];
        reference = node[path[depth++]];
      } else if (node.length === 2) {
        const packed = pathBytes(node[0]), flag = packed[0];
        if (flag > 3 || !(flag & 1) && packed[1]) throw Error('Invalid compact path');
        const prefix = packed.slice(flag & 1 ? 1 : 2);
        if (!prefix.every((value, i) => path[depth + i] === value)) throw Error('Absent storage path');
        depth += prefix.length;
        if (flag & 2) { if (depth !== path.length) throw Error('Incomplete leaf'); return node[1]; }
        reference = node[1];
      } else throw Error('Invalid trie arity');
    }
    throw Error('Cyclic witness');
  }
  const account = rlp(lookup(header[3], Buffer.from(tx.to.slice(2), 'hex')));
  const owner = Buffer.concat([Buffer.alloc(12), Buffer.from(tx.from.slice(2), 'hex')]);
  const slot = digest(Buffer.concat([Buffer.from(tx.input.slice(10), 'hex'), digest(Buffer.concat([owner, word(9)]))]));
  const stored = rlp(lookup(account[2], slot));
  const encodedLength = Number(BigInt('0x' + stored.toString('hex')));
  if (!(encodedLength & 1) || encodedLength > 4097) throw Error('Invalid dynamic storage length');
  const length = (encodedLength - 1) / 2, base = BigInt('0x' + digest(slot).toString('hex'));
  const chunks = [];
  for (let i = 0; i < Math.ceil(length / 32); i++) {
    const part = rlp(lookup(account[2], word(base + BigInt(i))));
    chunks.push(Buffer.concat([Buffer.alloc(32 - part.length), part]));
  }
  return openSeal(JSON.parse(files['capsule.json']), Buffer.concat(chunks).subarray(0, length));
}
