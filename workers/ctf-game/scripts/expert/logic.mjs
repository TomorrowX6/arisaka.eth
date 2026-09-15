import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { seal, sha256 } from '../core.mjs';

export function logicEvidence(code, random) {
  const signer = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), random(32)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(signer).export({ format: 'pem', type: 'spki' });
  function image(generation, committed = true, damaged = false) {
    const payload = random(192), header = Buffer.alloc(128, 255);
    header.write('ARBOOT2\0', 0, 'ascii'); header.writeUInt32LE(generation, 8); header.writeUInt32LE(payload.length, 12);
    header.writeUInt32LE(0x08004000, 16); header.writeUInt32LE(0, 20);
    sha256(payload).copy(header, 24); sign(null, header.subarray(0, 56), signer).copy(header, 56);
    if (damaged) header[71] ^= 1;
    header.writeUInt32LE(committed ? 0xc017cafe : 0xffffffff, 120);
    return { payload, bytes: Buffer.concat([header, payload]) };
  }
  const old = image(40), current = image(47), torn = image(48, false), forged = image(49, true, true);
  const slots = [{ address: 0x00003000, image: old }, { address: 0x01003000, image: current },
    { address: 0x01005000, image: torn }, { address: 0x01007000, image: forged }];
  const lines = ['$date 2026-09-15 $end', '$version afterglow logic acquisition 3 $end', '$timescale 1 ns $end',
    '$scope module probe $end', '$var wire 1 ! n12 $end', '$var wire 1 " n07 $end', '$var wire 1 # n09 $end', '$var wire 1 $ n10 $end',
    '$var wire 8 % status $end', '$upscope $end', '$enddefinitions $end', '#0', '$dumpvars', '1!', '1"', '0#', '0$', 'b00000000 %', '$end'];
  let time = 0, transfers = 0;
  const tick = delta => lines.push('#' + (time += delta));
  function transfer(tx, rx, abortBits = 0) {
    tick(100 + random(1)[0]); lines.push('0"');
    const count = tx.length * 8 - abortBits;
    for (let i = 0; i < count; i++) {
      tick(5 + random(1)[0] % 5); lines.push('0!');
      lines.push(((tx[i >> 3] >> (7 - i % 8)) & 1) + '#', ((rx[i >> 3] >> (7 - i % 8)) & 1) + '$');
      tick(5 + random(1)[0] % 5); lines.push('1!');
    }
    tick(7); lines.push('1"');
    if (++transfers % 19 === 0) { tick(2); lines.push('b' + (transfers & 255).toString(2).padStart(8, '0') + ' %'); }
  }
  transfer(Buffer.from([0x9f, 0, 0, 0]), Buffer.from([0, 0xef, 0x40, 0x19]));
  transfer(Buffer.from([0x03, 0, 0x30, 0, 0, 0]), Buffer.alloc(6), 3); // An interrupted read is not evidence for a whole byte.
  const reads = [];
  for (const slot of slots) for (let offset = 0; offset < slot.image.bytes.length; offset += 32) {
    const bytes = slot.image.bytes.subarray(offset, offset + 32), address = slot.address + offset;
    for (let copy = 0; copy < 3; copy++) {
      const data = Buffer.from(bytes);
      if (copy === 1) data[random(1)[0] % data.length] ^= 1 << (random(1)[0] % 8);
      reads.push({ address, bytes: data, fast: Boolean(random(1)[0] & 1) });
    }
  }
  for (let i = reads.length - 1; i > 0; i--) { const j = random(1)[0] % (i + 1); [reads[i], reads[j]] = [reads[j], reads[i]]; }
  let wide = false;
  for (const read of reads) {
    const needsWide = read.address >= 1 << 24;
    if (wide !== needsWide) { transfer(Buffer.from([needsWide ? 0xb7 : 0xe9]), Buffer.from([0])); wide = needsWide; }
    const address = Buffer.alloc(wide ? 4 : 3); address.writeUIntBE(read.address, 0, address.length);
    const header = Buffer.concat([Buffer.from([read.fast ? 0x0b : 3]), address, read.fast ? Buffer.from([0]) : Buffer.alloc(0)]);
    transfer(Buffer.concat([header, Buffer.alloc(read.bytes.length)]), Buffer.concat([Buffer.alloc(header.length), read.bytes]));
  }
  return {
    'bus.vcd': lines.join('\n') + '\n',
    'board.json': JSON.stringify({ format: 'spi-boot-custody-v2', device: 'SPI NOR', mode: 3, bitOrder: 'MSB',
      signals: { clock: 'probe.n12', select: 'probe.n07', mosi: 'probe.n09', miso: 'probe.n10' },
      addressBytesAtReset: 3, slots: slots.map(slot => '0x' + slot.address.toString(16)), minimumGeneration: 45,
      sampling: { passes: 3, correction: 'strict byte majority', partialTransfers: 'discard' },
      digest: 'SHA-256(selected payload)' }, null, 2),
    'boot-format.h': ['#include <stdint.h>', '#pragma pack(push, 1)', 'struct boot_slot {',
      '    char magic[8]; /* ARBOOT2 followed by NUL */', '    uint32_t generation, payload_size, load_address, flags; /* little-endian */',
      '    uint8_t sha256[32];', '    uint8_t ed25519[64]; /* signature of bytes [0, 56) */',
      '    uint32_t commit; /* 0xc017cafe */', '    uint8_t reserved[4];', '    uint8_t payload[];', '};', '#pragma pack(pop)',
      '/* Boot policy: highest committed, authenticated generation >= monotonic counter. */', ''].join('\n'),
    'boot-authority.pem': publicKey,
    'capsule.json': JSON.stringify(seal({ code }, sha256(current.payload), 'archive/spi/boot', random), null, 2),
  };
}
