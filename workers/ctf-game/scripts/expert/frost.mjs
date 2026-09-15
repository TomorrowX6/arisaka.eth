import { createECDH } from 'node:crypto';
import { crc32, curveOrder as Q, inverse, mod, seal, sha256, toBytes } from '../core.mjs';

const suite = 'FROST-secp256k1-SHA256-v1';
const scalar = value => toBytes(value, 32);
const point = value => {
  const key = createECDH('secp256k1'); key.setPrivateKey(scalar(value));
  return key.getPublicKey(undefined, 'compressed');
};
const hash = (...parts) => sha256(Buffer.concat(parts.map(part => Buffer.from(part))));

// RFC 9591 section 6.5 / RFC 9380 expand_message_xmd, L = 48.
export function frostHashScalar(label, message) {
  const dst = Buffer.from(suite + label), suffix = Buffer.concat([dst, Buffer.from([dst.length])]);
  const b0 = hash(Buffer.alloc(64), message, [0, 48, 0], suffix);
  const b1 = hash(b0, [1], suffix);
  const b2 = hash(Buffer.from(b0.map((byte, i) => byte ^ b1[i])), [2], suffix);
  return BigInt('0x' + Buffer.concat([b1, b2]).subarray(0, 48).toString('hex')) % Q;
}

export function frostBindingFactors(publicKey, commitments, message) {
  const ordered = [...commitments].sort((a, b) => a.id - b.id);
  const encoded = Buffer.concat(ordered.flatMap(item => [scalar(BigInt(item.id)), item.hiding, item.binding]));
  const prefix = Buffer.concat([publicKey, hash(suite + 'msg', message), hash(suite + 'com', encoded)]);
  return new Map(ordered.map(item => [item.id, frostHashScalar('rho', Buffer.concat([prefix, scalar(BigInt(item.id))]))]));
}

// A minimal deterministic CBOR encoder for evidence. The independent decoder
// and the desktop inspector do not import this implementation.
export function encodeFrostCbor(value) {
  const head = (major, length) => {
    if (length < 24) return Buffer.from([major * 32 + length]);
    if (length < 256) return Buffer.from([major * 32 + 24, length]);
    const bytes = Buffer.alloc(3); bytes[0] = major * 32 + 25; bytes.writeUInt16BE(length, 1); return bytes;
  };
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (Number.isSafeInteger(value) && value >= 0 && value < 65536) return head(0, value);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeFrostCbor)]);
  const pairs = Object.entries(value).map(([key, data]) => [encodeFrostCbor(key), encodeFrostCbor(data)]);
  pairs.sort((a, b) => a[0].length - b[0].length || Buffer.compare(a[0], b[0]));
  return Buffer.concat([head(5, pairs.length), ...pairs.flat()]);
}

export function frostEvidence(code, random) {
  const draw = () => { for (;;) { const n = BigInt('0x' + random(32).toString('hex')); if (n > 0n && n < Q) return n; } };
  const secret = draw(), publicKey = point(secret), threshold = 3;
  const polynomials = new Map([9, 10].map(epoch => [epoch, [secret, draw(), draw()]]));
  const share = (epoch, id) => polynomials.get(epoch).reduceRight((sum, coefficient) => mod(sum * BigInt(id) + coefficient, Q), 0n);
  const reused = new Map([1, 3, 5].map(id => [id, [draw(), draw()]]));
  const sessions = [], records = []; let sequence = 1000;
  const record = (session, id, z, flags = 1) => {
    const bytes = Buffer.alloc(64); session.id.copy(bytes); bytes.writeUInt32BE(session.epoch, 16);
    bytes.writeUInt16BE(id, 20); bytes.writeUInt16BE(flags, 22); scalar(z).copy(bytes, 24);
    bytes.writeUInt32BE(sequence++, 56); bytes.writeUInt32LE(crc32(bytes.subarray(0, 60)), 60); return bytes;
  };
  const rosters = [[1, 2, 3, 5], [1, 3, 4, 5], [1, 3, 5], [2, 3, 4], [1, 2, 4, 5]];
  for (const epoch of [9, 10]) for (let flight = 0; flight < (epoch === 9 ? 2 : 5); flight++) {
    const ids = rosters[flight], nonce = new Map(ids.map(id => [id, flight < 3 && reused.has(id) ? reused.get(id) : [draw(), draw()]]));
    const commitments = ids.map(id => ({ id, hiding: point(nonce.get(id)[0]), binding: point(nonce.get(id)[1]) }));
    const session = { id: random(16), epoch, message: Buffer.concat([Buffer.from('custody/request\0'), random(56)]) };
    const rho = frostBindingFactors(publicKey, commitments, session.message);
    const r = ids.reduce((sum, id) => mod(sum + nonce.get(id)[0] + rho.get(id) * nonce.get(id)[1], Q), 0n), R = point(r);
    const challenge = frostHashScalar('chal', Buffer.concat([R, publicKey, session.message]));
    const responses = ids.map(id => {
      const lambda = ids.filter(other => other !== id).reduce((value, other) => mod(value * BigInt(other) * inverse(BigInt(other - id), Q), Q), 1n);
      return mod(nonce.get(id)[0] + rho.get(id) * nonce.get(id)[1] + challenge * lambda * share(epoch, id), Q);
    });
    session.signature = Buffer.concat([R, scalar(responses.reduce((a, b) => mod(a + b, Q), 0n))]);
    // Capture ordering is not the protocol's sorted commitment-list ordering.
    session.commitments = commitments.toReversed().map(item => [item.id, item.hiding, item.binding]);
    sessions.push(session);
    ids.forEach((id, index) => records.push(record(session, id, responses[index])));
    if (epoch === 10 && flight === 0) {
      records.push(record(session, ids[0], mod(responses[0] + 1n, Q))); // well-framed, invalid share
      const damaged = record(session, ids[1], responses[1]); damaged[35] ^= 128; records.push(damaged);
      records.push(Buffer.from(records.at(-3))); // exact retransmission
    }
  }
  for (let i = records.length - 1; i > 0; i--) { const j = random(2).readUInt16BE() % (i + 1); [records[i], records[j]] = [records[j], records[i]]; }
  const header = Buffer.alloc(16); header.write('FJ30'); header.writeUInt16BE(1, 4); header.writeUInt16BE(64, 6);
  header.writeUInt32BE(records.length, 8); header.writeUInt32LE(crc32(header.subarray(0, 12)), 12);
  const epochs = [...polynomials].map(([epoch, coefficients]) => ({ epoch,
    coefficientCommitments: coefficients.map(value => point(value).toString('hex')),
    verificationShares: [1, 2, 3, 4, 5].map(id => ({ id, point: point(share(epoch, id)).toString('hex') })),
  }));
  return {
    'key-package.json': JSON.stringify({ format: 'frost-custody-v1', ciphersuite: suite, threshold, participants: 5,
      currentEpoch: 10, groupPublicKey: publicKey.toString('hex'), epochs }, null, 2),
    'sessions.cbor': encodeFrostCbor({ format: 'frost-rounds-v1', sessions: sessions.toReversed() }),
    'responses.journal': Buffer.concat([header, ...records]),
    'collector.txt': [
      'FROST: RFC 9591, section 6.5. Scalar: 32-byte big-endian. Element: SEC1 compressed.',
      'Threshold key packages include Feldman coefficient commitments for each refresh epoch.',
      'Each CBOR session contains id(bytes16), epoch, message(bytes), commitments([id,D,E]), signature(R||z).',
      'Transport order is capture order. Protocol commitment lists are ordered by scalar identifier.',
      'Journal header: magic FJ30, version:u16be, stride:u16be, count:u32be, CRC32/IEEE:u32le over first 12 bytes.',
      'Record (64 bytes): session:bytes16, epoch:u32be, id:u16be, flags:u16be, z:bytes32, sequence:u32be, CRC32/IEEE:u32le over first 60 bytes.',
      'Flags describe transport receipt, not cryptographic validity. Sequence is collector-local, not signer state.',
      'Capsule key material: SerializeScalar(group secret). No nonce or private share is included in this export.', '',
    ].join('\n'),
    'signer.c': [
      '#include "frost.h"',
      'void respond(request *req) {',
      '    nonce_pair n = load_slot(req->signer);',
      '    if (n.spent) { n = nonce_generate(); save_slot(req->signer, n); }',
      '    scalar z = sign(req, n);',
      '    transmit(req->session, z);',
      '    wait_for_coordinator_ack();',
      '    n.spent = true; save_slot(req->signer, n);',
      '}', '',
    ].join('\n'),
    'capsule.json': JSON.stringify(seal({ code }, scalar(secret), 'archive/frost/threshold', random), null, 2),
  };
}
