import { verify } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { openSeal } from '../decoders.mjs';

function base85(text) {
  text = text.replace(/\s/g, '').replace(/~>$/, '');
  const output = []; let group = [];
  function emit(padding = false) {
    const count = group.length;
    while (group.length < 5) group.push(84);
    const value = group.reduce((a, b) => a * 85 + b, 0);
    if (value > 0xffffffff || count === 1) throw Error('Invalid ASCII85');
    const block = Buffer.alloc(4); block.writeUInt32BE(value);
    output.push(padding ? block.subarray(0, count - 1) : block); group = [];
  }
  for (const char of text) {
    if (char === 'z') { if (group.length) throw Error('Invalid ASCII85 run'); output.push(Buffer.alloc(4)); continue; }
    const digit = char.charCodeAt(0) - 33;
    if (digit < 0 || digit > 84) throw Error('Invalid ASCII85 digit');
    group.push(digit); if (group.length === 5) emit();
  }
  if (group.length) emit(true);
  return Buffer.concat(output);
}

export function decodePdfEvidence(files) {
  let pdf = Buffer.from(files['release.pdf']);
  const whole = pdf.toString('latin1'), ends = [...whole.matchAll(/%%EOF\r?\n/g)].map(match => match.index + match[0].length);
  const signed = ends.filter(end => verify(null, pdf.subarray(0, end), files['signer.pem'], files['release.sig']));
  if (signed.length !== 1) throw Error('No authenticated PDF revision');
  pdf = pdf.subarray(0, signed[0]);
  const text = pdf.toString('latin1'), latest = [...text.matchAll(/startxref\s+(\d+)\s+%%EOF/g)].at(-1);
  const xref = new Map(), visited = new Set();
  function readObject(at) {
    const prefix = text.slice(at).match(/^(\d+)\s+(\d+)\s+obj\s*/);
    if (!prefix) throw Error('Invalid PDF object offset');
    const from = at + prefix[0].length, end = text.indexOf('endobj', from);
    if (end < 0) throw Error('Truncated PDF object');
    const body = text.slice(from, end), marker = body.indexOf('stream\n');
    if (marker < 0) return { dictionary: body };
    const dictionary = body.slice(0, marker), length = Number(dictionary.match(/\/Length\s+(\d+)/)?.[1]);
    if (!Number.isSafeInteger(length) || from + marker + 7 + length > pdf.length) throw Error('Invalid stream length');
    let data = pdf.subarray(from + marker + 7, from + marker + 7 + length);
    if (/\/ASCII85Decode/.test(dictionary)) data = base85(data.toString());
    if (/\/FlateDecode/.test(dictionary)) data = inflateSync(data);
    return { dictionary, data };
  }
  let offset = Number(latest?.[1]);
  while (offset) {
    if (visited.has(offset)) throw Error('Cyclic PDF xref'); visited.add(offset);
    const object = readObject(offset), ranges = object.dictionary.match(/\/Index\s*\[([^\]]+)\]/)?.[1].trim().split(/\s+/).map(Number);
    if (!ranges || !/\/W\s*\[1 4 2\]/.test(object.dictionary) || !object.data) throw Error('Unsupported xref stream');
    let at = 0;
    for (let i = 0; i < ranges.length; i += 2) for (let j = 0; j < ranges[i + 1]; j++) {
      if (at + 7 > object.data.length) throw Error('Truncated xref stream');
      const id = ranges[i] + j, entry = { type: object.data[at], offset: object.data.readUInt32BE(at + 1), index: object.data.readUInt16BE(at + 5) };
      if (!xref.has(id)) xref.set(id, entry); at += 7;
    }
    offset = Number(object.dictionary.match(/\/Prev\s+(\d+)/)?.[1] || 0);
  }
  const objectCache = new Map();
  function object(id) {
    if (objectCache.has(id)) return objectCache.get(id);
    const record = xref.get(id); if (!record || !record.type) throw Error('Missing PDF object');
    if (record.type === 1) { const value = readObject(record.offset); objectCache.set(id, value); return value; }
    if (record.type !== 2) throw Error('Invalid xref type');
    const owner = object(record.offset), n = Number(owner.dictionary.match(/\/N\s+(\d+)/)?.[1]), first = Number(owner.dictionary.match(/\/First\s+(\d+)/)?.[1]);
    const entries = owner.data.subarray(0, first).toString().trim().split(/\s+/).map(Number);
    if (entries.length !== n * 2 || entries[record.index * 2] !== id) throw Error('Invalid object stream index');
    const start = first + entries[record.index * 2 + 1], end = record.index + 1 === n ? owner.data.length : first + entries[record.index * 2 + 3];
    const value = { dictionary: owner.data.subarray(start, end).toString() }; objectCache.set(id, value); return value;
  }
  const root = object(1), namesId = Number(root.dictionary.match(/\/EmbeddedFiles\s+(\d+) 0 R/)?.[1]);
  const attachments = [...object(namesId).dictionary.matchAll(/\(([^)]+)\)\s+(\d+) 0 R/g)].sort((a, b) => a[1].localeCompare(b[1]));
  if (attachments.length !== 8) throw Error('Incomplete publication attachments');
  const material = Buffer.concat(attachments.map(([, , id]) => {
    const reference = Number(object(Number(id)).dictionary.match(/\/EF\s*<<\s*\/F\s+(\d+) 0 R/)?.[1]);
    return object(reference).data;
  }));
  return openSeal(JSON.parse(files['capsule.json']), material);
}
