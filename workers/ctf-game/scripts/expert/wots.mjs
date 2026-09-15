import { createHash } from 'node:crypto';

const H = (...parts) => createHash('sha256').update(Buffer.concat(parts.map(part => Buffer.from(part)))).digest().subarray(0, 16);
const integer = value => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
function digits(message) {
  const values = [...H(message)].flatMap(byte => [byte >> 4, byte & 15]);
  const sum = values.reduce((total, value) => total + 15 - value, 0);
  return [...values, sum >> 8, sum >> 4 & 15, sum & 15];
}

export function wotsEvidence(stage, random) {
  const seed = random(16), secrets = Array.from({ length: 64 }, () => Array.from({ length: 35 }, () => random(16)));
  function chain(value, index, column, from, to) {
    for (let step = from; step < to; step++) value = H('W0', seed, integer(index), integer(column), integer(step), value);
    return value;
  }
  const levels = [secrets.map((columns, index) => H('WL', ...columns.map((value, column) => chain(value, index, column, 0, 15))))];
  for (let height = 0; levels.at(-1).length > 1; height++) {
    const current = levels.at(-1), next = [];
    for (let i = 0; i < current.length; i += 2) next.push(H('WT', integer(height), current[i], current[i + 1]));
    levels.push(next);
  }
  const repeat = 32 + random(1)[0] % 32, captures = [];
  for (let i = 0; i < 40; i++) {
    const index = i < 8 ? repeat : i - 8;
    const message = Buffer.from('archive/inspect/' + random(20).toString('hex'));
    const values = digits(message), authentication = [];
    for (let height = 0; height < 6; height++) authentication.push(levels[height][(index >> height) ^ 1].toString('hex'));
    captures.push({ message: message.toString('hex'), index, chains: values.map((value, column) => chain(secrets[index][column], index, column, 0, value).toString('hex')), authentication });
  }
  for (let i = captures.length - 1; i; i--) { const j = random(1)[0] % (i + 1); [captures[i], captures[j]] = [captures[j], captures[i]]; }
  const root = levels.at(-1)[0].toString('hex');
  return {
    seed: seed.toString('hex'), root,
    files: {
      'device.json': JSON.stringify({ hash: 'SHA-256/128', w: 16, chains: 35, height: 6, seed: seed.toString('hex'), root }, null, 2),
      'capture.json': JSON.stringify(captures, null, 2),
      'service.json': JSON.stringify({ endpoint: '/api/labs/' + stage, inspect: 'GET', release: { method: 'POST', body: { action: 'redeem', nonce: 'uint32 decimal string', index: 'uint6', chains: 'hex[35][16]', authentication: 'hex[6][16]' } }, message: 'UTF-8("archive/release/" || binding || "/" || nonce)' }, null, 2),
      'device.py': [
        'from hashlib import sha256',
        'def H(*args): return sha256(b"".join(args)).digest()[:16]',
        'def u32(x): return x.to_bytes(4, "big")',
        'def chain(x, seed, index, column, start, stop):',
        '    for j in range(start, stop): x = H(b"W0", seed, u32(index), u32(column), u32(j), x)',
        '    return x',
        'def digits(message):',
        '    values = [v for b in H(message) for v in (b >> 4, b & 15)]',
        '    checksum = sum(15 - v for v in values)',
        '    return values + [checksum >> 8, (checksum >> 4) & 15, checksum & 15]',
        'def leaf(public): return H(b"WL", *public)',
        'def parent(height, left, right): return H(b"WT", u32(height), left, right)', '',
      ].join('\n'),
    },
  };
}
