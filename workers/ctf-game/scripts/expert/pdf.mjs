import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { seal } from '../core.mjs';

function ascii85(bytes) {
  let result = '';
  for (let at = 0; at < bytes.length; at += 4) {
    const block = Buffer.alloc(4); bytes.copy(block, 0, at, at + 4);
    let value = block.readUInt32BE(); const count = Math.min(4, bytes.length - at);
    if (!value && count === 4) { result += 'z'; continue; }
    let digits = '';
    for (let i = 0; i < 5; i++) { digits = String.fromCharCode(33 + value % 85) + digits; value = Math.floor(value / 85); }
    result += digits.slice(0, count + 1);
  }
  return Buffer.from(result + '~>');
}
const stream = (dictionary, data) => Buffer.concat([Buffer.from('<< ' + dictionary + ' /Length ' + data.length + ' >>\nstream\n'), data, Buffer.from('\nendstream')]);

export function pdfEvidence(code, receipt, random) {
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let size = chunks[0].length, previous = 0, signedRevision;
  const material = random(256);
  function object(id, body, offsets) {
    offsets.set(id, size);
    const record = Buffer.concat([Buffer.from(id + ' 0 obj\n'), Buffer.from(body), Buffer.from('\nendobj\n')]);
    chunks.push(record); size += record.length;
  }
  for (let revision = 0; revision < 4; revision++) {
    const offsets = new Map();
    if (!revision) {
      object(1, '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 108 0 R >> >>', offsets);
      object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', offsets);
      object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', offsets);
      object(4, stream('', Buffer.from('BT /F1 14 Tf 48 784 Td (AR-2718) Tj ET\n')), offsets);
      object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', offsets);
    }
    const payload = revision === 1 ? material : random(256), specs = [];
    for (let i = 0; i < 8; i++) {
      const name = i.toString(16).padStart(2, '0') + '.bin';
      object(10 + i, stream('/Type /EmbeddedFile /Subtype /application#2Foctet-stream /Params << /Size 32 >> /Filter [/ASCII85Decode /FlateDecode]', ascii85(deflateSync(payload.subarray(i * 32, i * 32 + 32)))), offsets);
      specs.push('<< /Type /Filespec /F (' + name + ') /UF (' + name + ') /EF << /F ' + (10 + i) + ' 0 R >> >>');
    }
    specs.push('<< /Names [' + specs.map((_, i) => '(' + i.toString(16).padStart(2, '0') + '.bin) ' + (100 + i) + ' 0 R').join(' ') + '] >>');
    let contentSize = 0;
    const index = specs.map((text, i) => { const entry = (100 + i) + ' ' + contentSize; contentSize += Buffer.byteLength(text) + 1; return entry; }).join(' ') + '\n';
    const objectStream = Buffer.from(index + specs.join('\n') + '\n');
    object(90, stream('/Type /ObjStm /N 9 /First ' + Buffer.byteLength(index) + ' /Filter /FlateDecode', deflateSync(objectStream)), offsets);
    const xrefOffset = size, ids = [0, ...offsets.keys(), 91, ...specs.map((_, i) => 100 + i)].sort((a, b) => a - b);
    const entries = ids.map(id => {
      const entry = Buffer.alloc(7);
      if (!id) entry.writeUInt16BE(65535, 5);
      else if (id >= 100) { entry[0] = 2; entry.writeUInt32BE(90, 1); entry.writeUInt16BE(id - 100, 5); }
      else { entry[0] = 1; entry.writeUInt32BE(id === 91 ? xrefOffset : offsets.get(id), 1); }
      return entry;
    });
    const ranges = [];
    for (const id of ids) {
      const last = ranges.at(-1);
      if (last && last[0] + last[1] === id) last[1]++; else ranges.push([id, 1]);
    }
    object(91, stream('/Type /XRef /Size 109 /Root 1 0 R /W [1 4 2] /Index [' + ranges.flat().join(' ') + ']' + (previous ? ' /Prev ' + previous : '') + ' /Filter /FlateDecode', deflateSync(Buffer.concat(entries))), offsets);
    const end = Buffer.from('startxref\n' + xrefOffset + '\n%%EOF\n'); chunks.push(end); size += end.length;
    if (revision === 1) signedRevision = Buffer.concat(chunks);
    previous = xrefOffset;
  }
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), random(32)]), format: 'der', type: 'pkcs8' });
  return {
    'release.pdf': Buffer.concat(chunks),
    'release.sig': sign(null, signedRevision, key),
    'signer.pem': createPublicKey(key).export({ type: 'spki', format: 'pem' }),
    'capsule.json': JSON.stringify(seal({ code, receipt }, material, 'archive/publication/2718', random), null, 2),
  };
}
