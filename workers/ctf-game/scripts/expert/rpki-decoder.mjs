import { createHash, createPublicKey, verify } from 'node:crypto';
import { openSeal } from '../decoders.mjs';

// Offline maintenance validator. No producer imports, network requests, ASN.1
// code generation or trusting a filename in place of its signed content.
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest();
const must = (condition, message) => { if (!condition) throw Error('RPKI: ' + message); };
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const ascii = bytes => { must(bytes.length <= 8192 && bytes.every(byte => byte <= 127), 'non-ASCII or oversized profile string'); return Buffer.from(bytes).toString('ascii'); };
const O = {
  rsa: '1.2.840.113549.1.1.1', signature: '1.2.840.113549.1.1.11', sha256: '2.16.840.1.101.3.4.2.1',
  cms: '1.2.840.113549.1.7.2', roa: '1.2.840.113549.1.9.16.1.24', manifest: '1.2.840.113549.1.9.16.1.26',
  contentType: '1.2.840.113549.1.9.3', digest: '1.2.840.113549.1.9.4', resources: '1.3.6.1.5.5.7.1.7',
  policy: '1.3.6.1.5.5.7.14.2', repository: '1.3.6.1.5.5.7.48.5', manifestUri: '1.3.6.1.5.5.7.48.10',
  objectUri: '1.3.6.1.5.5.7.48.11', notification: '1.3.6.1.5.5.7.48.13', caIssuers: '1.3.6.1.5.5.7.48.2',
};

export function parseRPKIDER(input) {
  const bytes = Buffer.from(input); let count = 0;
  must(bytes.length > 0 && bytes.length <= 1048576, 'DER size bound');
  function read(start, limit, depth) {
    must(depth <= 24 && ++count <= 20000 && start + 2 <= limit, 'DER nesting / truncation');
    let at = start; const tag = bytes[at++]; let length = bytes[at++];
    must((tag & 31) !== 31 && tag !== 0, 'unsupported DER tag');
    if (length & 128) {
      const width = length & 127; must(width > 0 && width <= 3 && at + width <= limit && bytes[at] !== 0, 'DER length encoding');
      length = 0; for (let i = 0; i < width; i++) length = length * 256 + bytes[at++];
      must(length >= 128, 'non-minimal DER length');
    }
    const end = at + length; must(end <= limit, 'truncated DER value');
    const node = { tag, start, offset: at, end, raw: bytes.subarray(start, end), value: bytes.subarray(at, end), children: [] };
    if (tag & 32) {
      for (let pos = at; pos < end;) { const child = read(pos, end, depth + 1); node.children.push(child); pos = child.end; }
      if (tag === 0x31) for (let i = 1; i < node.children.length; i++) must(Buffer.compare(node.children[i - 1].raw, node.children[i].raw) <= 0, 'unsorted DER SET');
    } else if (tag === 2) {
      must(length > 0 && !(length > 1 && ((bytes[at] === 0 && !(bytes[at + 1] & 128)) || (bytes[at] === 255 && (bytes[at + 1] & 128)))), 'non-minimal DER integer');
    } else if (tag === 3) {
      must(length > 0 && bytes[at] <= 7 && (length > 1 || bytes[at] === 0) && (length === 1 || !(bytes[end - 1] & ((1 << bytes[at]) - 1))), 'DER bit string padding');
    } else if (tag === 1) must(length === 1 && [0, 255].includes(bytes[at]), 'DER boolean');
    else if (tag === 5) must(length === 0, 'DER NULL');
    return node;
  }
  const node = read(0, bytes.length, 0); must(node.end === bytes.length, 'trailing DER bytes'); return node;
}
const tag = (node, expected) => { must(node?.tag === expected, 'DER tag ' + expected); return node; };
const children = (node, size, expected = 0x30) => { const list = tag(node, expected).children; must(size === undefined || list.length === size, 'DER field count'); return list; };
const integer = node => { const value = tag(node, 2).value; must(!(value[0] & 128) && value.length <= 21, 'unsigned integer bound'); return BigInt('0x' + value.toString('hex')); };
const limitedInteger = (node, max) => { const n = integer(node); must(n <= BigInt(max), 'integer range'); return Number(n); };
function objectId(node) {
  const bytes = tag(node, 6).value, components = []; let n = 0n, begin = true;
  must(bytes.length > 0 && bytes.length <= 64, 'OID length');
  for (const byte of bytes) { must(!begin || byte !== 128, 'non-minimal OID'); n = n * 128n + BigInt(byte & 127); begin = !(byte & 128); if (begin) { components.push(n); n = 0n; } }
  must(begin, 'truncated OID'); const first = components.shift();
  return [first < 40n ? 0n : first < 80n ? 1n : 2n, first < 40n ? first : first < 80n ? first - 40n : first - 80n, ...components].join('.');
}
function algorithm(node, expected, nullable = false) {
  const list = children(node); must(objectId(list[0]) === expected, 'signature / digest algorithm');
  must(list.length === (nullable ? 2 : 1), 'algorithm parameters'); if (nullable) tag(list[1], 5);
}
function bitValue(node, width) {
  const data = tag(node, 3).value, length = (data.length - 1) * 8 - data[0]; must(length <= width, 'address bit length');
  const n = data.length === 1 ? 0n : BigInt('0x' + data.subarray(1).toString('hex')) >> BigInt(data[0]);
  return { length, low: n << BigInt(width - length), high: (n + 1n) * (1n << BigInt(width - length)) - 1n, n };
}
function time(node, generalized = false) {
  tag(node, generalized ? 24 : 23); let value = ascii(node.value);
  must((generalized ? /^\d{14}Z$/ : /^\d{12}Z$/).test(value), 'time syntax');
  if (!generalized) value = (Number(value.slice(0, 2)) >= 50 ? '19' : '20') + value;
  const iso = value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8) + 'T' + value.slice(8, 10) + ':' + value.slice(10, 12) + ':' + value.slice(12, 14) + '.000Z';
  const result = Date.parse(iso); must(Number.isFinite(result) && new Date(result).toISOString() === iso, 'invalid calendar time'); return result;
}
function distinguishedName(node) {
  const list = children(node); must(list.length === 1, 'profile distinguished name');
  const pair = children(children(list[0], 1, 0x31)[0], 2); must(objectId(pair[0]) === '2.5.4.3', 'profile commonName');
  must([0x13, 0x0c].includes(pair[1].tag) && pair[1].value.length > 0 && pair[1].value.length <= 64, 'commonName value');
  if (pair[1].tag === 0x13) must(/^[A-Za-z0-9 '()+,\-./:=?]+$/.test(ascii(pair[1].value)), 'PrintableString commonName');
  else new TextDecoder('utf-8', { fatal: true }).decode(pair[1].value);
  return node.raw;
}
function extensions(node) {
  const result = new Map();
  for (const item of children(node)) {
    const list = children(item), id = objectId(list[0]); must(list.length === 2 || list.length === 3, 'extension fields');
    const critical = list.length === 3; if (critical) must(tag(list[1], 1).value[0] === 255, 'explicit default critical flag');
    must(!result.has(id), 'duplicate extension'); result.set(id, { critical, node: parseRPKIDER(tag(list.at(-1), 4).value) });
  }
  return result;
}
const extension = (exts, id, critical) => { const item = exts.get(id); must(item && item.critical === critical, 'missing / critical extension ' + id); return item.node; };
function uri(value, protocol = 'rsync:') {
  const text = Buffer.isBuffer(value) ? ascii(value) : value;
  must(typeof text === 'string' && text.length <= 512 && /^[\x21-\x7e]+$/.test(text) && !/[&%\\]/.test(text), 'URI syntax');
  const parsed = new URL(text); must(parsed.protocol === protocol && !parsed.username && !parsed.password && !parsed.port && !parsed.hash && !parsed.search && parsed.href === text, 'URI profile'); return text;
}
function accessLocations(node) {
  const result = new Map();
  for (const item of children(node)) { const pair = children(item, 2), id = objectId(pair[0]); must(!result.has(id), 'duplicate access method'); result.set(id, ascii(tag(pair[1], 0x86).value)); }
  return result;
}

export function parseRPKIResources(node, inherited = null) {
  const result = new Map(), choices = new Map(); let previousAfi = 0;
  for (const family of children(node)) {
    const [addressFamily, choice] = children(family, 2), bytes = tag(addressFamily, 4).value;
    must(bytes.length === 2 && bytes[0] === 0 && [1, 2].includes(bytes[1]) && bytes[1] > previousAfi, 'resource AFI ordering');
    const afi = bytes[1], width = afi === 1 ? 32 : 128; previousAfi = afi;
    if (choice.tag === 5) { must(inherited?.has(afi), 'unresolved resource inheritance'); result.set(afi, inherited.get(afi)); choices.set(afi, 'inherit'); continue; }
    const spans = [];
    for (const entry of children(choice)) {
      let low, high;
      if (entry.tag === 3) ({ low, high } = bitValue(entry, width));
      else {
        const endpoints = children(entry, 2), min = bitValue(endpoints[0], width), max = bitValue(endpoints[1], width);
        must((!min.length || (min.n & 1n)) && (!max.length || !(max.n & 1n)), 'non-canonical resource range endpoints');
        low = min.low; high = max.high; const size = high - low + 1n;
        must(size > 0n && !((size & (size - 1n)) === 0n && low % size === 0n), 'range should be a prefix');
      }
      must(!spans.length || low > spans.at(-1)[1] + 1n, 'overlapping / adjacent resource ranges');
      if (inherited) must(inherited.get(afi)?.some(([a, b]) => a <= low && high <= b), 'certificate resource overclaim');
      spans.push([low, high]);
    }
    must(spans.length > 0, 'empty resource family'); result.set(afi, spans); choices.set(afi, 'explicit');
  }
  must(result.size > 0, 'empty IP resources'); return { resources: result, choices };
}

function certificate(bytes, parent, objectUri, now, ca) {
  const outer = children(parseRPKIDER(bytes), 3), fields = children(outer[0], 8);
  must(integer(children(fields[0], 1, 0xa0)[0]) === 2n, 'certificate version');
  const serial = integer(fields[1]); must(serial > 0n && serial < 1n << 159n, 'certificate serial');
  algorithm(outer[1], O.signature, true); algorithm(fields[2], O.signature, true);
  const issuer = distinguishedName(fields[3]), subject = distinguishedName(fields[5]), validity = children(fields[4], 2);
  const notBefore = time(validity[0]), notAfter = time(validity[1]); must(notBefore <= now && now <= notAfter && notBefore < notAfter, 'certificate validity');
  const spki = children(fields[6], 2); algorithm(spki[0], O.rsa, true); must(tag(spki[1], 3).value[0] === 0, 'public key bit string');
  const publicKey = createPublicKey({ key: fields[6].raw, type: 'spki', format: 'der' }), jwk = publicKey.export({ format: 'jwk' });
  must(publicKey.asymmetricKeyDetails.modulusLength === 2048 && jwk.e === 'AQAB', 'RSA-2048 / e=65537 profile');
  const signature = tag(outer[2], 3).value; must(signature.length === 257 && signature[0] === 0, 'certificate signature length');
  must(eq(issuer, parent?.subject ?? subject) && verify('sha256', outer[0].raw, parent?.publicKey ?? publicKey, signature.subarray(1)), 'certificate issuer / signature');
  const exts = extensions(children(fields[7], 1, 0xa3)[0]);
  const allowed = ['2.5.29.14', '2.5.29.35', '2.5.29.15', '2.5.29.32', O.resources, '1.3.6.1.5.5.7.1.11', ...(ca ? ['2.5.29.19'] : []), ...(parent ? ['1.3.6.1.5.5.7.1.1', '2.5.29.31'] : [])];
  must(exts.size === allowed.length && [...exts.keys()].every(id => allowed.includes(id)), 'unsupported certificate extension');
  const ski = tag(extension(exts, '2.5.29.14', false), 4).value;
  must(ski.length === 20 && eq(ski, digest(spki[1].value.subarray(1), 'sha1')), 'subject key identifier');
  const aki = tag(children(extension(exts, '2.5.29.35', false), 1)[0], 0x80).value;
  must(eq(aki, parent?.ski ?? ski), 'authority key identifier');
  must(eq(tag(extension(exts, '2.5.29.15', true), 3).value, ca ? [1, 6] : [7, 128]), 'key usage');
  const policies = children(extension(exts, '2.5.29.32', true), 1); must(objectId(children(policies[0], 1)[0]) === O.policy, 'legacy resource policy');
  if (ca) must(tag(children(extension(exts, '2.5.29.19', true), 1)[0], 1).value[0] === 255, 'CA basic constraints');
  const allocation = parseRPKIResources(extension(exts, O.resources, true), parent?.resources);
  const sia = accessLocations(extension(exts, '1.3.6.1.5.5.7.1.11', false)); let repo, manifestUri, notification, crlUri;
  if (ca) {
    must(sia.size === 3 && [O.repository, O.manifestUri, O.notification].every(id => sia.has(id)), 'CA SIA methods');
    repo = uri(sia.get(O.repository)); manifestUri = uri(sia.get(O.manifestUri)); notification = uri(sia.get(O.notification), 'https:');
    must(repo.endsWith('/') && manifestUri.startsWith(repo) && /^[A-Za-z0-9_.-]+\.mft$/.test(manifestUri.slice(repo.length)), 'publication URI binding');
  } else must(sia.size === 1 && uri(sia.get(O.objectUri)) === objectUri, 'signed object SIA binding');
  if (parent) {
    const aia = accessLocations(extension(exts, '1.3.6.1.5.5.7.1.1', false)); must(aia.size === 1 && uri(aia.get(O.caIssuers)) === parent.uri, 'issuer AIA binding');
    const point = children(extension(exts, '2.5.29.31', false), 1)[0];
    crlUri = uri(tag(children(children(children(point, 1)[0], 1, 0xa0)[0], 1, 0xa0)[0], 0x86).value);
    must(crlUri.startsWith(parent.repo) && !crlUri.slice(parent.repo.length).includes('/'), 'CRL distribution point binding');
    if (parent.crlUri) must(parent.crlUri === crlUri, 'issuer CRL mismatch');
    must(!parent.revoked?.has(serial.toString()), 'revoked certificate');
  }
  return { publicKey, ski, serial, subject, uri: objectUri, repo, manifestUri, notification, issuerCrlUri: crlUri, ...allocation };
}

function signedObject(bytes, ca, uri, now, contentType) {
  const outer = children(parseRPKIDER(bytes), 2); must(objectId(outer[0]) === O.cms, 'CMS content type');
  const signed = children(children(outer[1], 1, 0xa0)[0], 5); must(integer(signed[0]) === 3n, 'SignedData version');
  algorithm(children(signed[1], 1, 0x31)[0], O.sha256);
  const encapsulated = children(signed[2], 2); must(objectId(encapsulated[0]) === contentType, 'encapsulated content type');
  const content = tag(children(encapsulated[1], 1, 0xa0)[0], 4).value;
  const ee = certificate(children(signed[3], 1, 0xa0)[0].raw, ca, uri, now, false);
  must([...ee.choices.values()].every(choice => choice === (contentType === O.manifest ? 'inherit' : 'explicit')), 'signed object resource profile');
  const signer = children(children(signed[4], 1, 0x31)[0], 6); must(integer(signer[0]) === 3n, 'SignerInfo version');
  must(eq(tag(signer[1], 0x80).value, ee.ski), 'CMS signer identifier'); algorithm(signer[2], O.sha256); algorithm(signer[4], O.rsa, true);
  const attributes = children(signer[3], 2, 0xa0), values = new Map();
  for (let i = 0; i < attributes.length; i++) {
    if (i) must(Buffer.compare(attributes[i - 1].raw, attributes[i].raw) < 0, 'CMS attribute DER order');
    const pair = children(attributes[i], 2), id = objectId(pair[0]); must(!values.has(id), 'duplicate signed attribute'); values.set(id, children(pair[1], 1, 0x31)[0]);
  }
  must(objectId(values.get(O.contentType)) === contentType, 'signed content-type attribute');
  must(eq(tag(values.get(O.digest), 4).value, digest(content)), 'CMS message digest');
  const signatureInput = Buffer.from(signer[3].raw); signatureInput[0] = 0x31;
  must(tag(signer[5], 4).value.length === 256 && verify('sha256', signatureInput, ee.publicKey, signer[5].value), 'CMS signature');
  return { ee, content: parseRPKIDER(content) };
}

function manifestObject(bytes, ca, now) {
  const signed = signedObject(bytes, ca, ca.manifestUri, now, O.manifest), fields = children(signed.content, 5);
  const number = integer(fields[0]), thisUpdate = time(fields[1], true), nextUpdate = time(fields[2], true);
  must(number < 1n << 159n && thisUpdate <= now && now < nextUpdate && thisUpdate < nextUpdate, 'manifest time / number');
  must(objectId(fields[3]) === O.sha256, 'manifest hash algorithm'); const files = new Map();
  for (const item of children(fields[4])) {
    const pair = children(item, 2), filename = ascii(tag(pair[0], 22).value), expected = tag(pair[1], 3).value;
    must(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}$/.test(filename) && !files.has(filename) && ca.repo + filename !== ca.manifestUri, 'manifest filename / duplicate');
    must(expected.length === 33 && expected[0] === 0, 'manifest hash size'); files.set(filename, expected.subarray(1));
  }
  must(files.size > 0 && files.size <= 512, 'manifest file bound'); return { ...signed, files, number, thisUpdate, nextUpdate };
}
function revocationList(bytes, ca, now) {
  const outer = children(parseRPKIDER(bytes), 3), fields = children(outer[0]); must(fields.length === 6 || fields.length === 7, 'CRL fields');
  must(integer(fields[0]) === 1n, 'CRL version'); algorithm(fields[1], O.signature, true); algorithm(outer[1], O.signature, true);
  must(eq(distinguishedName(fields[2]), ca.subject), 'CRL issuer'); const signature = tag(outer[2], 3).value;
  must(signature.length === 257 && signature[0] === 0 && verify('sha256', outer[0].raw, ca.publicKey, signature.subarray(1)), 'CRL signature');
  const thisUpdate = time(fields[3]), nextUpdate = time(fields[4]); must(thisUpdate <= now && now < nextUpdate && thisUpdate < nextUpdate, 'CRL time');
  const exts = extensions(children(fields.at(-1), 1, 0xa0)[0]); must(exts.size === 2, 'CRL extensions');
  must(eq(tag(children(extension(exts, '2.5.29.35', false), 1)[0], 0x80).value, ca.ski), 'CRL authority key identifier');
  const number = integer(extension(exts, '2.5.29.20', false)); must(number < 1n << 159n, 'CRL number'); const revoked = new Set();
  if (fields.length === 7) for (const item of children(fields[5])) {
    const pair = children(item, 2), serial = integer(pair[0]).toString(); must(!revoked.has(serial) && time(pair[1]) <= thisUpdate, 'CRL entry'); revoked.add(serial);
  }
  return { revoked, number, thisUpdate, nextUpdate };
}
function roaObject(bytes, ca, uri, now) {
  const { content, ee } = signedObject(bytes, ca, uri, now, O.roa), fields = children(content, 2), asn = limitedInteger(fields[0], 4294967295), rows = [];
  let previousAfi = 0;
  for (const family of children(fields[1])) {
    const pair = children(family, 2), encoded = tag(pair[0], 4).value;
    must(encoded.length === 2 && encoded[0] === 0 && [1, 2].includes(encoded[1]) && encoded[1] > previousAfi, 'ROA AFI ordering');
    const afi = encoded[1], width = afi === 1 ? 32 : 128; previousAfi = afi;
    const addresses = children(pair[1]); must(addresses.length > 0, 'empty ROA family');
    for (const entry of addresses) {
      const parts = children(entry); must(parts.length === 1 || parts.length === 2, 'ROA address fields');
      const address = bitValue(parts[0], width), max = parts.length === 2 ? limitedInteger(parts[1], width) : address.length;
      must(max >= address.length, 'ROA maxLength');
      must(ee.resources.get(afi)?.some(([low, high]) => low <= address.low && address.high <= high), 'ROA resource overclaim');
      rows.push([afi, address.low.toString(16).padStart(width / 4, '0'), address.length, max, asn]);
    }
  }
  must(rows.length > 0 && rows.length <= 4096, 'ROA prefix count'); return rows;
}

// Deliberately small, bounded XML grammar for RRDP: no DTD, entities, external
// resolution, comments, processing instructions, namespace aliases or nesting
// beyond the root and its records. Both single and double attribute quotes work.
export function parseRRDPXML(input) {
  const bytes = Buffer.from(input); must(bytes.length > 0 && bytes.length <= 4194304, 'RRDP XML size');
  let source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  source = source.replace(/^<\?xml\s+version=(['"])1\.0\1\s+encoding=(['"])UTF-8\2\s*\?>\s*/i, '');
  must(!/[&\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source) && !source.includes('<!') && !source.includes('<?'), 'forbidden XML entity / declaration');
  const stack = []; let root, at = 0, count = 0;
  while (at < source.length) {
    if (source[at] !== '<') { let end = source.indexOf('<', at); if (end < 0) end = source.length; const text = source.slice(at, end); if (stack.length) stack.at(-1).text += text; else must(!text.trim(), 'XML trailing text'); at = end; continue; }
    const end = source.indexOf('>', at); must(end >= 0 && end - at <= 4096, 'XML tag bound'); const raw = source.slice(at + 1, end); at = end + 1;
    if (raw[0] === '/') { must(/^\/[a-z_]+\s*$/.test(raw) && stack.at(-1)?.name === raw.slice(1).trim(), 'XML closing tag'); stack.pop(); continue; }
    const match = /^([a-z_]+)([\s\S]*?)(\/?)$/.exec(raw); must(match, 'XML tag syntax');
    const node = { name: match[1], attrs: {}, children: [], text: '' }; let tail = match[2];
    while (tail.length) {
      if (!tail.trim()) break;
      const attr = /^\s+([a-z_]+)\s*=\s*(['"])([^<>]*?)\2/.exec(tail); must(attr && !Object.hasOwn(node.attrs, attr[1]) && Object.keys(node.attrs).length < 16 && attr[3].length <= 512, 'XML attribute / duplicate');
      node.attrs[attr[1]] = attr[3]; tail = tail.slice(attr[0].length);
    }
    must(++count <= 1024 && stack.length < 2, 'XML record / nesting bound');
    if (stack.length) stack.at(-1).children.push(node); else { must(!root, 'multiple XML roots'); root = node; }
    if (!match[3]) stack.push(node);
  }
  must(root && !stack.length && !root.text.trim() && root.children.every(item => !item.children.length), 'XML tree shape'); return root;
}
const RRDP_NS = 'http://www.ripe.net/rpki/rrdp';
const serialNumber = value => { must(typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) < 1n << 64n, 'RRDP serial'); return BigInt(value); };
const attributes = (node, required, optional = []) => { must(required.every(key => Object.hasOwn(node.attrs, key)) && Object.keys(node.attrs).every(key => required.includes(key) || optional.includes(key)), 'RRDP attributes'); };
function rrdpRoot(bytes, kind) {
  const node = parseRRDPXML(bytes); attributes(node, ['xmlns', 'version', 'session_id', 'serial']);
  must(node.name === kind && node.attrs.xmlns === RRDP_NS && node.attrs.version === '1' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(node.attrs.session_id), 'RRDP root');
  return { node, session: node.attrs.session_id, serial: serialNumber(node.attrs.serial) };
}
function hexDigest(value) { must(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'RRDP hash'); return value; }
function base64(text) {
  const compact = text.replace(/[\t\n\r ]/g, ''); must(compact.length > 0 && compact.length <= 1398104 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact), 'RRDP base64');
  const bytes = Buffer.from(compact, 'base64'); must(bytes.toString('base64') === compact, 'noncanonical base64'); return bytes;
}
function applyRecords(before, root, snapshot) {
  const next = new Map(before), seen = new Set(); let size = 0;
  for (const item of root.children) {
    must(item.name === 'publish' || (!snapshot && item.name === 'withdraw'), 'RRDP record');
    attributes(item, item.name === 'withdraw' ? ['uri', 'hash'] : ['uri'], snapshot ? [] : ['hash']);
    const key = uri(item.attrs.uri); must(!seen.has(key), 'repeated RRDP object'); seen.add(key);
    if (Object.hasOwn(item.attrs, 'hash')) must(next.has(key) && digest(next.get(key)).toString('hex') === hexDigest(item.attrs.hash), 'RRDP prior-object hash');
    else must(!next.has(key), 'RRDP publish requires prior hash');
    if (item.name === 'withdraw') { must(!item.text.trim(), 'withdraw content'); next.delete(key); }
    else next.set(key, base64(item.text));
  }
  for (const bytes of next.values()) size += bytes.length; must(next.size <= 512 && size <= 16777216, 'repository bound'); return next;
}
export function applyRRDPDelta(state, bytes) {
  const delta = rrdpRoot(bytes, 'delta'); must(delta.session === state.session && delta.serial === state.serial + 1n, 'nonconsecutive RRDP delta');
  return { session: state.session, serial: delta.serial, objects: applyRecords(state.objects, delta.node, false) };
}
export function rebuildRPKIRepository(files) {
  const capture = JSON.parse(files['capture.json']); must(capture.format === 'rpki-repository-capture-v1', 'capture format');
  must(capture.cached.file === 'cached-snapshot.xml' && digest(files[capture.cached.file]).toString('hex') === hexDigest(capture.cached.sha256), 'cached acquisition hash');
  const snapshot = rrdpRoot(files[capture.cached.file], 'snapshot');
  must(snapshot.session === capture.cached.session && snapshot.serial === serialNumber(capture.cached.serial), 'cached snapshot binding');
  const notification = rrdpRoot(files['notification.xml'], 'notification'); must(notification.session === snapshot.session && notification.serial >= snapshot.serial, 'RRDP notification session / rollback');
  const deltas = new Map(); let snapshots = 0;
  for (const item of notification.node.children) {
    must(!item.text.trim(), 'notification record content');
    if (item.name === 'snapshot') { attributes(item, ['uri', 'hash']); uri(item.attrs.uri, 'https:'); hexDigest(item.attrs.hash); snapshots++; }
    else {
      must(item.name === 'delta', 'notification record'); attributes(item, ['serial', 'uri', 'hash']);
      const serial = serialNumber(item.attrs.serial); must(!deltas.has(serial) && serial <= notification.serial, 'notification delta serial');
      deltas.set(serial, { uri: uri(item.attrs.uri, 'https:'), hash: hexDigest(item.attrs.hash) });
    }
  }
  must(snapshots === 1, 'notification snapshot count');
  const numbers = [...deltas.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  for (let i = 1; i < numbers.length; i++) must(numbers[i] === numbers[i - 1] + 1n, 'notification delta gap');
  if (numbers.length) must(numbers.at(-1) === notification.serial, 'notification final delta');
  let state = { session: snapshot.session, serial: snapshot.serial, objects: applyRecords(new Map(), snapshot.node, true) };
  must(notification.serial - state.serial <= 1024n, 'delta chain bound');
  while (state.serial < notification.serial) {
    const reference = deltas.get(state.serial + 1n); must(reference, 'missing consecutive delta');
    const file = capture.captures?.[reference.uri]; must(typeof file === 'string' && /^[A-Za-z0-9_-]+\.xml$/.test(file) && Object.hasOwn(files, file), 'uncaptured delta');
    must(digest(files[file]).toString('hex') === reference.hash, 'delta acquisition hash'); state = applyRRDPDelta(state, files[file]);
  }
  return { ...state, capture };
}

function canonicalVRPs(rows) {
  return [...new Map(rows.map(row => [JSON.stringify(row), row])).values()].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2] || a[3] - b[3] || a[4] - b[4]);
}
export function validateRPKIRepository(files, state = rebuildRPKIRepository(files)) {
  const now = Date.parse(state.capture.evaluationTime); must(state.capture.evaluationTime === '2025-05-31T12:00:00Z' && Number.isFinite(now), 'historical evaluation time');
  const tal = ascii(Buffer.from(files['trust-anchor.tal'])).trim().split(/\r?\n\r?\n/); must(tal.length === 2, 'TAL structure');
  const anchorUri = uri(tal[0]), spki = base64(tal[1]);
  const root = certificate(files['ta.cer'], null, anchorUri, now, true); must(eq(root.publicKey.export({ type: 'spki', format: 'der' }), spki), 'TAL SPKI anchor mismatch');
  const rows = [], diagnostics = [], publications = [], accepted = [], visited = new Set();
  function visit(ca, depth) {
    must(depth <= 8 && visited.size < 32 && !visited.has(ca.repo), 'CA recursion / repeated repository'); visited.add(ca.repo);
    let manifest;
    try {
      must(state.objects.has(ca.manifestUri), 'missing current manifest'); manifest = manifestObject(state.objects.get(ca.manifestUri), ca, now);
      for (const [filename, expected] of manifest.files) { const bytes = state.objects.get(ca.repo + filename); must(bytes && eq(digest(bytes), expected), 'manifest file hash: ' + filename); }
      const crls = [...manifest.files.keys()].filter(name => name.endsWith('.crl')); must(crls.length === 1, 'manifest must list one CRL');
      ca.crlUri = ca.repo + crls[0]; must(manifest.ee.issuerCrlUri === ca.crlUri, 'manifest CRL binding');
      const crl = revocationList(state.objects.get(ca.crlUri), ca, now); ca.revoked = crl.revoked;
      must(crl.thisUpdate === manifest.thisUpdate && crl.nextUpdate === manifest.nextUpdate, 'manifest / CRL synchronization');
      must(!ca.revoked.has(manifest.ee.serial.toString()), 'revoked manifest EE');
      publications.push({ uri: ca.repo, manifestNumber: manifest.number.toString(), crlNumber: crl.number.toString(), revoked: [...ca.revoked] });
    } catch (error) { diagnostics.push({ uri: ca.manifestUri, error: error.message }); return; }
    for (const filename of manifest.files.keys()) {
      const objectUri = ca.repo + filename, bytes = state.objects.get(objectUri);
      try {
        if (filename.endsWith('.cer')) visit(certificate(bytes, ca, objectUri, now, true), depth + 1);
        else if (filename.endsWith('.roa')) { rows.push(...roaObject(bytes, ca, objectUri, now)); accepted.push(objectUri); }
      } catch (error) { diagnostics.push({ uri: objectUri, error: error.message }); }
    }
  }
  visit(root, 0); return { vrps: canonicalVRPs(rows), diagnostics, publications, accepted };
}

function routePrefix(text) {
  must(typeof text === 'string' && text.length <= 64 && text.split('/').length === 2, 'announcement prefix');
  const [address, bits] = text.split('/'); must(/^(0|[1-9]\d{0,2})$/.test(bits), 'prefix length');
  let afi, value, width;
  if (!address.includes(':')) {
    const parts = address.split('.'); must(parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255), 'IPv4 syntax');
    afi = 1; width = 32; value = parts.reduce((n, part) => n * 256n + BigInt(part), 0n);
  } else {
    const halves = address.split('::'); must(halves.length <= 2, 'IPv6 compression');
    const left = halves[0] ? halves[0].split(':') : [], right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    must([...left, ...right].every(part => /^[0-9a-fA-F]{1,4}$/.test(part)) && (halves.length === 1 ? left.length === 8 : left.length + right.length < 8), 'IPv6 syntax');
    const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    afi = 2; width = 128; value = parts.reduce((n, part) => n * 65536n + BigInt('0x' + part), 0n);
  }
  const length = Number(bits); must(length <= width && value % (1n << BigInt(width - length)) === 0n, 'non-network announcement / length');
  return { afi, width, value, length };
}
export function classifyRPKIOrigins(vrps, announcements) {
  must(Array.isArray(announcements) && announcements.length <= 4096 && vrps.length <= 4096, 'origin validation bounds');
  const ids = new Set();
  return announcements.map(item => {
    must(item && typeof item.id === 'string' && !ids.has(item.id) && Number.isInteger(item.asn) && item.asn > 0 && item.asn <= 4294967295, 'positive origin ASN / duplicate announcement'); ids.add(item.id);
    const route = routePrefix(item.prefix); let covered = false;
    for (const [afi, network, prefixLength, maxLength, asn] of vrps) {
      if (afi !== route.afi || prefixLength > route.length || route.value >> BigInt(route.width - prefixLength) !== BigInt('0x' + network) >> BigInt(route.width - prefixLength)) continue;
      covered = true; if (asn === item.asn && route.length <= maxLength) return 'V';
    }
    return covered ? 'I' : 'N';
  }).join('');
}
export function recoverRPKIMaterial(files) {
  const state = rebuildRPKIRepository(files), validation = validateRPKIRepository(files, state);
  const decisions = classifyRPKIOrigins(validation.vrps, JSON.parse(files['announcements.json']));
  return { ...validation, serial: state.serial, session: state.session, decisions, material: Buffer.from(JSON.stringify({ vrps: validation.vrps, decisions })) };
}
export function decodeRPKIEvidence(files) { return openSeal(JSON.parse(files['capsule.json']), recoverRPKIMaterial(files).material); }
