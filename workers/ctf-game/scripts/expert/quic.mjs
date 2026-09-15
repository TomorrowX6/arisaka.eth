import { createCipheriv, createHmac } from 'node:crypto';
import { seal, sha256 } from '../core.mjs';
import { pcapng, u16be, u32be } from './formats.mjs';
import { udp } from './network.mjs';

const salt = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex');
const retryKey = Buffer.from('be0c690b9f66575a1d766b54e368c84e', 'hex');
const retryNonce = Buffer.from('461599d35d632bf2239825bb', 'hex');
const hmac = (key, bytes) => createHmac('sha256', key).update(bytes).digest();
const vector = bytes => Buffer.concat([u16be(bytes.length), bytes]);

export function quicInteger(value) {
  value = BigInt(value);
  const size = value < 64n ? 1 : value < 16384n ? 2 : value < 1073741824n ? 4 : 8;
  if (value < 0n || value >= 1n << 62n) throw Error('QUIC integer out of range');
  const bytes = Buffer.alloc(size);
  for (let i = size - 1; i >= 0; i--, value >>= 8n) bytes[i] = Number(value & 255n);
  bytes[0] |= ({ 1: 0, 2: 64, 4: 128, 8: 192 })[size];
  return bytes;
}

function expand(secret, label, length) {
  const name = Buffer.from('tls13 ' + label);
  const info = Buffer.concat([u16be(length), Buffer.from([name.length]), name, Buffer.from([0, 1])]);
  return hmac(secret, info).subarray(0, length);
}

export function quicInitialKeys(dcid, role) {
  const secret = expand(hmac(salt, dcid), role + ' in', 32);
  return { key: expand(secret, 'quic key', 16), iv: expand(secret, 'quic iv', 12), hp: expand(secret, 'quic hp', 16) };
}

function cryptoFrame(offset, bytes) {
  return Buffer.concat([Buffer.from([6]), quicInteger(offset), quicInteger(bytes.length), bytes]);
}

function protect({ dcid, scid, token = Buffer.alloc(0), number, frames, keys, size = 1200, width = 2 }) {
  const prefix = Buffer.concat([Buffer.from([0xc0 | (width - 1)]), u32be(1), Buffer.from([dcid.length]), dcid,
    Buffer.from([scid.length]), scid, quicInteger(token.length), token]);
  // Every generated packet uses a two-byte length; padding is an actual sequence
  // of QUIC PADDING frames, not bytes added outside the protected payload.
  const clear = Buffer.concat([frames, Buffer.alloc(Math.max(24, size - prefix.length - 2 - width - 16 - frames.length))]);
  const pn = Buffer.alloc(width); pn.writeUIntBE(number % 2 ** (width * 8), 0, width);
  const header = Buffer.concat([prefix, quicInteger(width + clear.length + 16), pn]);
  const nonce = Buffer.from(keys.iv);
  for (let i = 0; i < 8; i++) nonce[11 - i] ^= Number(BigInt(number) >> BigInt(i * 8) & 255n);
  const cipher = createCipheriv('aes-128-gcm', keys.key, nonce); cipher.setAAD(header);
  const packet = Buffer.concat([header, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
  const pnOffset = header.length - width;
  const hp = createCipheriv('aes-128-ecb', keys.hp, null); hp.setAutoPadding(false);
  const mask = hp.update(packet.subarray(pnOffset + 4, pnOffset + 20));
  packet[0] ^= mask[0] & 15;
  for (let i = 0; i < width; i++) packet[pnOffset + i] ^= mask[i + 1];
  return packet;
}

function retry(odcid, dcid, scid, token) {
  const header = Buffer.concat([Buffer.from([0xf0]), u32be(1), Buffer.from([dcid.length]), dcid, Buffer.from([scid.length]), scid, token]);
  const cipher = createCipheriv('aes-128-gcm', retryKey, retryNonce);
  cipher.setAAD(Buffer.concat([Buffer.from([odcid.length]), odcid, header])); cipher.final();
  return Buffer.concat([header, cipher.getAuthTag()]);
}

function hellos(random, clientId) {
  const session = random(32);
  const extension = (type, bytes) => Buffer.concat([u16be(type), vector(bytes)]);
  const message = (type, bytes) => { const header = Buffer.alloc(4); header[0] = type; header.writeUIntBE(bytes.length, 1, 3); return Buffer.concat([header, bytes]); };
  const host = Buffer.from('relay.archive.invalid');
  const parameter = (id, bytes) => Buffer.concat([quicInteger(id), quicInteger(bytes.length), bytes]);
  const client = message(1, Buffer.concat([Buffer.from('0303', 'hex'), random(32), Buffer.from([32]), session,
    vector(Buffer.from('13011302', 'hex')), Buffer.from([1, 0]), vector(Buffer.concat([
      extension(0, vector(Buffer.concat([Buffer.from([0]), vector(host)]))),
      extension(43, Buffer.from('020304', 'hex')),
      extension(10, vector(u16be(29))),
      extension(13, vector(u16be(0x0807))),
      extension(51, vector(Buffer.concat([u16be(29), vector(random(32))]))),
      extension(16, vector(Buffer.from([2, 104, 51]))),
      extension(57, Buffer.concat([parameter(1, quicInteger(30000)), parameter(4, quicInteger(262144)), parameter(15, clientId)])),
    ]))]));
  const server = message(2, Buffer.concat([Buffer.from('0303', 'hex'), random(32), Buffer.from([32]), session,
    Buffer.from('130100', 'hex'), vector(Buffer.concat([
      extension(43, Buffer.from('0304', 'hex')),
      extension(51, Buffer.concat([u16be(29), vector(random(32))])),
    ]))]));
  return { client, server };
}

export function quicEvidence(code, random) {
  const odcid = random(8), clientId = random(8), retryId = random(12), token = random(24);
  const { client, server } = hellos(random, clientId), packets = [];
  const add = (bytes, direction = 'client') => packets.push({
    bytes: udp(bytes, direction === 'client'
      ? { source: '192.0.2.27', destination: '198.51.100.27', sport: 49327, dport: 443 }
      : { source: '198.51.100.27', destination: '192.0.2.27', sport: 443, dport: 49327 }),
    time: 1760000000000000n + BigInt(packets.length) * 791n,
  });
  add(protect({ dcid: odcid, scid: clientId, number: 0, frames: cryptoFrame(0, client), keys: quicInitialKeys(odcid, 'client') }));
  const falseRetry = retry(odcid, clientId, random(12), random(24)); falseRetry[falseRetry.length - 1] ^= 1;
  add(falseRetry, 'server');
  add(retry(odcid, clientId, retryId, token), 'server');
  const clientKeys = quicInitialKeys(retryId, 'client'), serverKeys = quicInitialKeys(retryId, 'server');
  // A captured PING establishes the truncated packet-number epoch. The next packets
  // cross 255, arrive out of order, and include one exact retransmission.
  add(protect({ dcid: retryId, scid: clientId, token, number: 248, width: 2,
    frames: Buffer.from([1]), keys: clientKeys }));
  const pieces = [];
  for (let offset = 0; offset < client.length; offset += 19) pieces.push({ offset, bytes: client.subarray(offset, offset + 19) });
  const order = pieces.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = random(1)[0] % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const flight = order.map((index, i) => protect({ dcid: retryId, scid: clientId, token, number: 249 + i, width: 1,
    frames: cryptoFrame(pieces[index].offset, pieces[index].bytes), keys: clientKeys, size: 620 }));
  for (let i = 0; i < flight.length; i += 2) add(Buffer.concat([flight[i + 1] || flight[i], flight[i]]));
  add(Buffer.concat([flight[2], flight[0]]));
  // Authenticated server flight: CRYPTO offsets, not arrival order, define TLS.
  const serverPieces = [];
  for (let offset = 0; offset < server.length; offset += 23) serverPieces.push({ offset, bytes: server.subarray(offset, offset + 23) });
  for (const [i, piece] of serverPieces.toReversed().entries()) add(protect({ dcid: clientId, scid: retryId, number: i,
    frames: Buffer.concat([Buffer.from([1]), cryptoFrame(piece.offset, piece.bytes)]), keys: serverKeys, size: 1200 }), 'server');
  const corrupted = protect({ dcid: clientId, scid: retryId, number: 30, frames: cryptoFrame(0, random(server.length)), keys: serverKeys, size: 1200 });
  corrupted[corrupted.length - 1] ^= 0x80; add(corrupted, 'server');
  return {
    'initial-flight.pcapng': pcapng(packets),
    'collector.json': JSON.stringify({ format: 'quic-transcript-custody-v1', version: 1,
      originalDestinationConnectionId: odcid.toString('hex'), clientSourceConnectionId: clientId.toString('hex'),
      client: '192.0.2.27:49327', server: '198.51.100.27:443',
      transcript: ['ClientHello', 'ServerHello'], digest: 'SHA-256', retryRequired: true }, null, 2),
    'capsule.json': JSON.stringify(seal({ code }, sha256(Buffer.concat([client, server])), 'archive/quic/transcript', random), null, 2),
  };
}
