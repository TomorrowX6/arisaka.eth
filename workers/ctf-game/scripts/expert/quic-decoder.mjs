import { createCipheriv, createDecipheriv, createHmac, createHash } from 'node:crypto';
import { openSeal } from '../decoders.mjs';

// Maintenance decoder: no imports from the evidence generator or private seed.
function integer(bytes, cursor) {
  if (cursor.at >= bytes.length) throw Error('Truncated QUIC integer');
  const size = 1 << (bytes[cursor.at] >> 6);
  if (cursor.at + size > bytes.length) throw Error('Truncated QUIC integer');
  let value = BigInt(bytes[cursor.at++] & 63);
  for (let i = 1; i < size; i++) value = value * 256n + BigInt(bytes[cursor.at++]);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('QUIC integer exceeds safe bound');
  return Number(value);
}

function expand(secret, label, length) {
  const name = Buffer.from('tls13 ' + label), header = Buffer.from([length >> 8, length & 255, name.length]);
  return createHmac('sha256', secret).update(Buffer.concat([header, name, Buffer.from([0, 1])])).digest().subarray(0, length);
}

export function initialSecrets(dcid, role) {
  const initial = createHmac('sha256', Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex')).update(dcid).digest();
  const traffic = expand(initial, role + ' in', 32);
  return { key: expand(traffic, 'quic key', 16), iv: expand(traffic, 'quic iv', 12), hp: expand(traffic, 'quic hp', 16) };
}

function datagrams(bytes) {
  const output = []; let at = 0, little = true;
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw Error('Truncated PCAPNG');
    if (bytes.readUInt32LE(at) === 0x0a0d0d0a) little = bytes.readUInt32LE(at + 8) === 0x1a2b3c4d;
    const word = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const type = word(at), length = word(at + 4);
    if (length < 12 || length % 4 || at + length > bytes.length || word(at + length - 4) !== length) throw Error('Invalid PCAPNG block');
    if (type === 6) {
      if (length < 32 || word(at + 20) > length - 32) throw Error('Truncated captured frame');
      const frame = bytes.subarray(at + 28, at + 28 + word(at + 20));
      if (frame.length >= 42 && frame.readUInt16BE(12) === 0x0800 && frame[23] === 17) {
        const start = 14 + (frame[14] & 15) * 4;
        if (start < 34 || start + 8 > frame.length) throw Error('Invalid IP header');
        const end = 14 + frame.readUInt16BE(16), udpEnd = start + frame.readUInt16BE(start + 4);
        if (end > frame.length || udpEnd > end || udpEnd < start + 8) throw Error('Truncated UDP datagram');
        output.push({ bytes: frame.subarray(start + 8, udpEnd), role: frame.readUInt16BE(start) === 443 ? 'server' : 'client' });
      }
    }
    at += length;
  }
  return output;
}

function header(bytes, start) {
  let at = start;
  if (at + 7 > bytes.length || !(bytes[at] & 128)) throw Error('Invalid QUIC long header');
  const flags = bytes[at++], version = bytes.readUInt32BE(at); at += 4;
  const takeId = () => {
    if (at >= bytes.length) throw Error('Truncated connection ID');
    const length = bytes[at++];
    if (length > 20 || at + length > bytes.length) throw Error('Invalid connection ID');
    const id = bytes.subarray(at, at + length); at += length; return id;
  };
  const dcid = takeId(), scid = takeId(), type = flags >> 4 & 3;
  if (version !== 1) throw Error('Unsupported QUIC version');
  if (type === 3) return { start, end: bytes.length, type, dcid, scid, token: bytes.subarray(at, -16), tagAt: bytes.length - 16 };
  const cursor = { at }; let token = Buffer.alloc(0);
  if (type === 0) { const size = integer(bytes, cursor); if (size > bytes.length - cursor.at) throw Error('Truncated token'); token = bytes.subarray(cursor.at, cursor.at + size); cursor.at += size; }
  const size = integer(bytes, cursor), end = cursor.at + size;
  if (size < 20 || end > bytes.length) throw Error('Truncated QUIC packet');
  return { start, end, type, dcid, scid, token, pnOffset: cursor.at };
}

function retryValid(bytes, item, odcid) {
  if (item.tagAt < item.start || item.token.length < 1) return false;
  try {
    const cipher = createDecipheriv('aes-128-gcm', Buffer.from('be0c690b9f66575a1d766b54e368c84e', 'hex'), Buffer.from('461599d35d632bf2239825bb', 'hex'));
    cipher.setAAD(Buffer.concat([Buffer.from([odcid.length]), odcid, bytes.subarray(item.start, item.tagAt)]));
    cipher.setAuthTag(bytes.subarray(item.tagAt)); cipher.final(); return true;
  } catch { return false; }
}

function openPacket(bytes, item, keys, expected) {
  const data = Buffer.from(bytes.subarray(item.start, item.end)), pnAt = item.pnOffset - item.start;
  if (pnAt + 20 > data.length) throw Error('Truncated header protection sample');
  // Header protection uses AES encryption in both directions.
  const hp = createCipheriv('aes-128-ecb', keys.hp, null); hp.setAutoPadding(false);
  const mask = hp.update(data.subarray(pnAt + 4, pnAt + 20));
  data[0] ^= mask[0] & 15;
  const width = (data[0] & 3) + 1;
  if (data[0] & 12) throw Error('Invalid reserved bits');
  for (let i = 0; i < width; i++) data[pnAt + i] ^= mask[i + 1];
  const truncated = data.readUIntBE(pnAt, width), window = 2 ** (width * 8);
  let number = Math.floor(expected / window) * window + truncated;
  if (number + window / 2 <= expected) number += window;
  else if (number > expected + window / 2 && number >= window) number -= window;
  const nonce = Buffer.from(keys.iv);
  for (let i = 0; i < 8; i++) nonce[11 - i] ^= Number(BigInt(number) >> BigInt(i * 8) & 255n);
  const cipher = createDecipheriv('aes-128-gcm', keys.key, nonce);
  cipher.setAAD(data.subarray(0, pnAt + width)); cipher.setAuthTag(data.subarray(-16));
  return { number, clear: Buffer.concat([cipher.update(data.subarray(pnAt + width, -16)), cipher.final()]) };
}

function cryptoPieces(clear) {
  const cursor = { at: 0 }, pieces = [];
  while (cursor.at < clear.length) {
    const type = integer(clear, cursor);
    if (type === 0 || type === 1) continue;
    if (type === 2 || type === 3) {
      integer(clear, cursor); integer(clear, cursor); const count = integer(clear, cursor); integer(clear, cursor);
      if (count > 1024) throw Error('Too many ACK ranges');
      for (let i = 0; i < count * 2 + (type === 3 ? 3 : 0); i++) integer(clear, cursor);
    } else if (type === 6) {
      const offset = integer(clear, cursor), size = integer(clear, cursor);
      if (offset + size > 65536 || cursor.at + size > clear.length) throw Error('CRYPTO range exceeds bounds');
      pieces.push({ offset, bytes: clear.subarray(cursor.at, cursor.at + size) }); cursor.at += size;
    } else throw Error('Unexpected Initial frame');
  }
  return pieces;
}

function assemble(pieces, type) {
  if (!pieces.length) throw Error('Missing authenticated CRYPTO flight');
  const size = Math.max(...pieces.map(piece => piece.offset + piece.bytes.length)), bytes = Buffer.alloc(size), present = Buffer.alloc(size);
  for (const piece of pieces) for (let i = 0; i < piece.bytes.length; i++) {
    const at = piece.offset + i;
    if (present[at] && bytes[at] !== piece.bytes[i]) throw Error('Conflicting CRYPTO retransmission');
    bytes[at] = piece.bytes[i]; present[at] = 1;
  }
  if (present.includes(0) || size < 4 || bytes[0] !== type || bytes.readUIntBE(1, 3) + 4 !== size) throw Error('Incomplete TLS handshake message');
  return bytes;
}

export function decodeQuicEvidence(files) {
  const custody = JSON.parse(files['collector.json']), odcid = Buffer.from(custody.originalDestinationConnectionId, 'hex');
  const clientId = Buffer.from(custody.clientSourceConnectionId, 'hex'), packets = datagrams(Buffer.from(files['initial-flight.pcapng']));
  let retryId, token;
  const pieces = { client: [], server: [] }, expected = { client: 0, server: 0 };
  for (const packet of packets) for (let at = 0; at < packet.bytes.length;) {
    const item = header(packet.bytes, at); at = item.end;
    if (item.type === 3) {
      if (!retryId && packet.role === 'server' && item.dcid.equals(clientId) && retryValid(packet.bytes, item, odcid)) { retryId = item.scid; token = item.token; }
      continue;
    }
    if (!retryId || item.type !== 0) continue;
    const role = packet.role;
    if (role === 'client' ? !item.dcid.equals(retryId) || !item.scid.equals(clientId) || !item.token.equals(token)
      : !item.dcid.equals(clientId) || !item.scid.equals(retryId)) continue;
    let opened;
    try { opened = openPacket(packet.bytes, item, initialSecrets(retryId, role), expected[role]); }
    catch { continue; } // A failed AEAD packet never contributes bytes or advances PN state.
    expected[role] = Math.max(expected[role], opened.number + 1);
    pieces[role].push(...cryptoPieces(opened.clear));
  }
  if (!retryId) throw Error('Missing authenticated Retry');
  const transcript = Buffer.concat([assemble(pieces.client, 1), assemble(pieces.server, 2)]);
  return openSeal(JSON.parse(files['capsule.json']), createHash('sha256').update(transcript).digest());
}
