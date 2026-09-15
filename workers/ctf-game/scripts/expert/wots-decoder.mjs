import { createHash } from 'node:crypto';

export function forgeWotsSignature(parameters, captures, binding) {
  const hash = (...items) => createHash('sha256').update(Buffer.concat(items.map(item => Buffer.from(item)))).digest().subarray(0, 16);
  const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  function digits(value) {
    const data = [...hash(value)].flatMap(byte => [byte >> 4, byte & 15]);
    const checksum = data.reduce((sum, value) => sum + 15 - value, 0);
    return [...data, checksum >>> 8, checksum >>> 4 & 15, checksum & 15];
  }
  const groups = new Map();
  for (const capture of captures) { if (!groups.has(capture.index)) groups.set(capture.index, []); groups.get(capture.index).push(capture); }
  const [index, records] = [...groups].sort((a, b) => b[1].length - a[1].length)[0];
  if (records.length < 2) throw Error('No repeated signing index');
  const positions = records.map(record => digits(Buffer.from(record.message, 'hex')));
  const selected = Array.from({ length: 35 }, (_, column) => positions.reduce((best, value, i) => value[column] < positions[best][column] ? i : best, 0));
  const seed = Buffer.from(parameters.seed, 'hex');
  for (let nonce = 0; nonce < 100000; nonce++) {
    const wanted = digits(Buffer.from('archive/release/' + binding + '/' + nonce));
    if (!wanted.every((value, column) => value >= positions[selected[column]][column])) continue;
    const chains = wanted.map((target, column) => {
      let value = Buffer.from(records[selected[column]].chains[column], 'hex');
      for (let step = positions[selected[column]][column]; step < target; step++) value = hash('W0', seed, u32(index), u32(column), u32(step), value);
      return value.toString('hex');
    });
    return { nonce: String(nonce), index, chains, authentication: records[0].authentication };
  }
  throw Error('No forward-reachable signature');
}
