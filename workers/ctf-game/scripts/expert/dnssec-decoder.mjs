import { createHash, createPublicKey, verify } from 'node:crypto';
import { openSeal } from '../decoders.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest();
const word = (value, size) => { const bytes = Buffer.alloc(size); bytes.writeUIntBE(value, 0, size); return bytes; };
const wireName = value => Buffer.concat([...value.toLowerCase().replace(/\.$/, '').split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
const keyTag = data => { let value = 0; for (let i = 0; i < data.length; i++) value += i % 2 ? data[i] : data[i] * 256; return (value + (value >>> 16)) & 65535; };

function readName(bytes, cursor) {
  const labels = [], seen = new Set(); let at = cursor.at, jumped = false, size = 1;
  for (;;) {
    if (at >= bytes.length || seen.has(at)) throw Error('Invalid DNS compression pointer');
    seen.add(at); const count = bytes[at++];
    if ((count & 192) === 192) {
      if (at >= bytes.length) throw Error('Truncated DNS pointer');
      if (!jumped) cursor.at = at + 1;
      at = (count & 63) * 256 + bytes[at]; jumped = true; continue;
    }
    if (count & 192 || count > 63 || at + count > bytes.length || (size += count + 1) > 255) throw Error('Invalid DNS label');
    if (!count) { if (!jumped) cursor.at = at; return labels.join('.').toLowerCase() + '.'; }
    labels.push(bytes.toString('ascii', at, at + count)); at += count;
  }
}

function messages(pcap) {
  const output = [];
  for (let at = 0; at < pcap.length;) {
    if (at + 12 > pcap.length) throw Error('Truncated PCAPNG');
    const length = pcap.readUInt32LE(at + 4);
    if (length < 12 || length % 4 || at + length > pcap.length || pcap.readUInt32LE(at + length - 4) !== length) throw Error('Invalid PCAPNG');
    if (pcap.readUInt32LE(at) === 6) {
      if (length < 32) throw Error('Truncated PCAPNG frame');
      const size = pcap.readUInt32LE(at + 20);
      if (size > length - 32) throw Error('Truncated captured frame');
      const packet = pcap.subarray(at + 28, at + 28 + size);
      if (packet.length < 42 || packet.readUInt16BE(12) !== 0x0800 || packet[23] !== 17) { at += length; continue; }
      const start = 14 + (packet[14] & 15) * 4;
      if (start < 34 || start + 8 > packet.length || packet.readUInt16BE(start) !== 53) throw Error('Invalid DNS transport');
      const end = start + packet.readUInt16BE(start + 4);
      if (end > packet.length || end < start + 20) throw Error('Truncated DNS message');
      output.push(packet.subarray(start + 8, end));
    }
    at += length;
  }
  return output;
}

function parseMessage(bytes) {
  if (bytes.length < 12) throw Error('Truncated DNS header');
  const cursor = { at: 12 }, records = [];
  for (let i = 0; i < bytes.readUInt16BE(4); i++) { readName(bytes, cursor); cursor.at += 4; }
  const count = bytes.readUInt16BE(6) + bytes.readUInt16BE(8) + bytes.readUInt16BE(10);
  if (count > 256) throw Error('Too many DNS records');
  for (let i = 0; i < count; i++) {
    const owner = readName(bytes, cursor);
    if (cursor.at + 10 > bytes.length) throw Error('Truncated resource record');
    const type = bytes.readUInt16BE(cursor.at), cls = bytes.readUInt16BE(cursor.at + 2), size = bytes.readUInt16BE(cursor.at + 8);
    cursor.at += 10; const end = cursor.at + size;
    if (end > bytes.length) throw Error('Truncated RDATA');
    const rdata = bytes.subarray(cursor.at, end), record = { owner, type, cls, rdata };
    if (type === 46) {
      if (size < 19) throw Error('Truncated RRSIG');
      const signerCursor = { at: cursor.at + 18 }, signer = readName(bytes, signerCursor);
      if (signerCursor.at > end) throw Error('Invalid RRSIG signer');
      record.signature = { covered: rdata.readUInt16BE(0), algorithm: rdata[2], labels: rdata[3], ttl: rdata.readUInt32BE(4),
        expires: rdata.readUInt32BE(8), starts: rdata.readUInt32BE(12), keyTag: rdata.readUInt16BE(16), signer,
        prefix: Buffer.concat([rdata.subarray(0, 18), wireName(signer)]), bytes: bytes.subarray(signerCursor.at, end) };
    }
    records.push(record); cursor.at = end;
  }
  if (cursor.at !== bytes.length) throw Error('Trailing DNS data');
  return records;
}

function validate(records, owner, type, trusted, now, signer) {
  const rrset = records.filter(record => record.owner === owner && record.type === type && record.cls === 1);
  if (!rrset.length) return null;
  for (const record of records.filter(record => record.owner === owner && record.type === 46 && record.cls === 1)) {
    const sig = record.signature;
    if (sig.covered !== type || sig.algorithm !== 15 || sig.starts > now || sig.expires < now || sig.signer !== signer) continue;
    const labels = owner.split('.').filter(Boolean);
    if (sig.labels > labels.length) continue;
    const canonicalOwner = sig.labels < labels.length ? '*.' + labels.slice(-sig.labels).join('.') + '.' : owner;
    const data = Buffer.concat([sig.prefix, ...rrset.map(record => record.rdata).sort(Buffer.compare).map(rdata =>
      Buffer.concat([wireName(canonicalOwner), word(type, 2), word(1, 2), word(sig.ttl, 4), word(rdata.length, 2), rdata]))]);
    for (const key of trusted) {
      if (key.length !== 36 || key[2] !== 3 || key[3] !== 15 || !(key.readUInt16BE(0) & 256) || key.readUInt16BE(0) & 128 || keyTag(key) !== sig.keyTag) continue;
      const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(4)]), format: 'der', type: 'spki' });
      if (verify(null, data, publicKey, sig.bytes)) return { data, records: rrset.map(record => record.rdata) };
    }
  }
  return null;
}

export function decodeDnssecEvidence(files) {
  const anchor = JSON.parse(files['trust-anchor.json']), replies = messages(Buffer.from(files['resolver.pcapng'])).map(parseMessage);
  const find = (owner, type, keys, signer) => {
    const found = replies.map(records => validate(records, owner, type, keys, anchor.observedAt, signer)).filter(Boolean);
    const unique = [...new Map(found.map(set => [hash(set.data).toString('hex'), set])).values()];
    if (unique.length !== 1) throw Error('No unique authenticated DNSSEC RRset: ' + owner + ' ' + type);
    return unique[0];
  };
  const root = find(anchor.owner, 48, [Buffer.from(anchor.dnskey, 'base64')], anchor.owner);
  const ds = find(anchor.delegation, 43, root.records, anchor.owner);
  const eligible = replies.flatMap(records => records.filter(record => record.owner === anchor.delegation && record.type === 48).map(record => record.rdata))
    .filter(key => ds.records.some(record => record.length === 36 && record.readUInt16BE(0) === keyTag(key) && record[2] === key[3] && record[3] === 2
      && hash(Buffer.concat([wireName(anchor.delegation), key])).equals(record.subarray(4))));
  const child = find(anchor.delegation, 48, eligible, anchor.delegation);
  const leaf = find(anchor.question.name, anchor.question.type, child.records, anchor.delegation);
  const material = hash(Buffer.concat([root.data, ds.data, child.data, leaf.data]));
  return openSeal(JSON.parse(files['capsule.json']), material);
}
