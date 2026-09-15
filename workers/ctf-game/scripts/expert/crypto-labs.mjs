import { createCipheriv } from 'node:crypto';

export function paddingEvidence(stage) {
  return {
    'service.json': JSON.stringify({ version: 3, endpoint: '/api/labs/' + stage, operations: { inspect: { method: 'GET' }, probe: { method: 'POST', body: { action: 'probe', tokens: ['hex(IV || ciphertext)'] }, batch: 64 }, redeem: { method: 'POST', body: { action: 'redeem', token: 'hex(IV || ciphertext)' } } } }, null, 2),
    'record.h': [
      '#include <stdint.h>', '#pragma pack(push, 1)',
      'struct record { char magic[4]; uint8_t nonce[16]; uint64_t created; uint32_t uid, groups; char purpose[16]; uint32_t crc; uint8_t trailer[8]; };',
      '#pragma pack(pop)', '#define RECORD_MAGIC "RBK3"', '#define RELEASE_UID 0', '#define RELEASE_GROUPS 0xffffffff', '#define RELEASE_PURPOSE "archive/release"',
      '#define RECORD_CRC_POLYNOMIAL 0xedb88320',
      '/* record_crc = crc32(record[0:52] || record[56:64]); integers: little endian */', '',
    ].join('\n'),
  };
}

export function gcmEvidence(stage, random) {
  const key = random(32), nonce = random(12), records = [];
  for (let i = 0; i < 4; i++) {
    const plaintext = Buffer.from(JSON.stringify({ uid: 1000 + i, scope: 'inspect', binding: random(16).toString('hex'), sequence: i }).padEnd(112 + i * 16, ' '));
    const aad = Buffer.from('archive/transport/' + i);
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    records.push({ nonce: nonce.toString('hex'), aad: aad.toString('hex'), plaintext: plaintext.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') });
  }
  return {
    key: key.toString('hex'), nonce: nonce.toString('hex'),
    files: {
      'capture.json': JSON.stringify({ cipher: 'AES-256-GCM', records }, null, 2),
      'service.json': JSON.stringify({ endpoint: '/api/labs/' + stage, inspect: 'GET', redeem: { method: 'POST', body: { action: 'redeem', token: 'hex(ciphertext || tag)' } }, claims: { uid: 'uint32', scope: 'string', binding: 'string' }, roles: { release: { uid: 0, scope: 'release' } } }, null, 2),
    },
  };
}
