import { checkPrimeSync, createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto';
import { inverse, seal } from '../core.mjs';

// Producer-only DER / RSA construction. The reference validator has its own
// parser, resource algebra, RRDP state machine and origin-validation rules.
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest();
const big = bytes => BigInt('0x' + bytes.toString('hex'));
const octets = n => Buffer.from(n.toString(16).padStart(n.toString(16).length + n.toString(16).length % 2, '0'), 'hex');
const der = (tag, value) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.concat(value), n = data.length, encoded = octets(BigInt(n));
  return Buffer.concat([Buffer.from([tag]), n < 128 ? Buffer.from([n]) : Buffer.concat([Buffer.from([128 + encoded.length]), encoded]), data]);
};
const seq = (...values) => der(0x30, values), set = (...values) => der(0x31, values.toSorted(Buffer.compare)), octet = bytes => der(4, bytes);
const uint = n => { const bytes = octets(BigInt(n)); return der(2, bytes[0] & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes); };
const oid = text => {
  const parts = text.split('.').map(BigInt), values = [parts[0] * 40n + parts[1], ...parts.slice(2)], bytes = [];
  for (let value of values) { const group = [Number(value & 127n)]; while (value >>= 7n) group.unshift(Number(value & 127n) | 128); bytes.push(...group); }
  return der(6, Buffer.from(bytes));
};
const NULL = der(5, Buffer.alloc(0)), TRUE = der(1, Buffer.from([255]));
const O = { rsa: '1.2.840.113549.1.1.1', signature: '1.2.840.113549.1.1.11', sha256: '2.16.840.1.101.3.4.2.1', cms: '1.2.840.113549.1.7.2',
  roa: '1.2.840.113549.1.9.16.1.24', manifest: '1.2.840.113549.1.9.16.1.26', contentType: '1.2.840.113549.1.9.3', digest: '1.2.840.113549.1.9.4',
  resources: '1.3.6.1.5.5.7.1.7', policy: '1.3.6.1.5.5.7.14.2', repository: '1.3.6.1.5.5.7.48.5', manifestUri: '1.3.6.1.5.5.7.48.10', objectUri: '1.3.6.1.5.5.7.48.11', notification: '1.3.6.1.5.5.7.48.13' };
const rsaAlgorithm = seq(oid(O.rsa), NULL), signatureAlgorithm = seq(oid(O.signature), NULL), digestAlgorithm = seq(oid(O.sha256));
const extension = (id, value, critical = false) => seq(oid(id), ...(critical ? [TRUE] : []), octet(value));
const name = text => seq(set(seq(oid('2.5.4.3'), der(0x13, Buffer.from(text)))));
const utc = text => der(0x17, Buffer.from(text.slice(2).replaceAll('-', '').replaceAll(':', '').replace('T', '')));
const generalized = text => der(0x18, Buffer.from(text.replaceAll('-', '').replaceAll(':', '').replace('T', '')));
const access = (id, uri) => seq(oid(id), der(0x86, Buffer.from(uri)));
const NAMESPACE = 'http://www.ripe.net/rpki/rrdp', ORIGIN = 'rsync://rpki.archive.invalid/repo/', RRDP = 'https://rpki.archive.invalid/rrdp/';
const EVALUATION = '2025-05-31T12:00:00Z', START = '2025-01-01T00:00:00Z', END = '2027-01-01T00:00:00Z';

function rsa(random) {
  const exponent = 65537n;
  function prime() {
    for (;;) {
      const bytes = random(128); bytes[0] |= 192; bytes[127] |= 1; let value = big(bytes);
      while (value < 1n << 1024n) {
        if ((value - 1n) % exponent && [3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n].every(p => value % p) && checkPrimeSync(value, { checks: 32 })) return value;
        value += 2n;
      }
    }
  }
  const p = prime(); let q; do { q = prime(); } while (q === p);
  const n = p * q, d = inverse(exponent, (p - 1n) * (q - 1n)), encode = value => octets(value).toString('base64url');
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'RSA', n: encode(n), e: encode(exponent), d: encode(d), p: encode(p), q: encode(q), dp: encode(d % (p - 1n)), dq: encode(d % (q - 1n)), qi: encode(inverse(q, p)) } });
  const publicKey = createPublicKey(key), spki = publicKey.export({ type: 'spki', format: 'der' });
  return { key, publicKey, spki, ski: hash(publicKey.export({ type: 'pkcs1', format: 'der' }), 'sha1') };
}

function prefix(afi, network, length, maxLength = length) { const width = afi === 1 ? 32 : 128; return { afi, network: network >> BigInt(width - length) << BigInt(width - length), length, maxLength }; }
function bits(value, width, length) {
  const size = Math.ceil(length / 8), unused = size * 8 - length;
  const data = size ? Buffer.from((value >> BigInt(width - length) << BigInt(unused)).toString(16).padStart(size * 2, '0'), 'hex') : Buffer.alloc(0);
  return der(3, Buffer.concat([Buffer.from([unused]), data]));
}
function rangeEnd(value, width, maximum) {
  let length = width, n = value;
  while (length && (n & 1n) === BigInt(maximum)) { n >>= 1n; length--; }
  return bits(value, width, length);
}
function resources(rows) {
  return seq(...[1, 2].flatMap(afi => {
    const group = rows.filter(row => row.afi === afi); if (!group.length) return [];
    const family = Buffer.from([0, afi]), width = afi === 1 ? 32 : 128;
    return [seq(octet(family), group[0].inherit ? NULL : seq(...group.map(row => row.range ? seq(rangeEnd(row.range[0], width, false), rangeEnd(row.range[1], width, true)) : bits(row.network, width, row.length))))];
  }));
}
const address = row => (row.afi === 1 ? [24n, 16n, 8n, 0n].map(shift => Number(row.network >> shift & 255n)).join('.') : row.network.toString(16).padStart(32, '0').match(/.{4}/g).map(group => parseInt(group, 16).toString(16)).join(':')) + '/' + row.length;
const vrpRows = rows => rows.map(row => [row.afi, row.network.toString(16).padStart(row.afi === 1 ? 8 : 32, '0'), row.length, row.maxLength, row.asn]);
function canonical(rows) {
  const unique = new Map(vrpRows(rows).map(row => [JSON.stringify(row), row]));
  return [...unique.values()].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2] || a[3] - b[3] || a[4] - b[4]);
}

export function rpkiEvidence(code, random) {
  const serialBase = 9007199254740992n + BigInt(random(2).readUInt16LE()) * 128n; let certSerial = serialBase + 1n;
  const epoch = serialBase + 65n, b = (1 + random(1)[0] % 12) * 16, h = 1 + random(1)[0] % 14, asn = 64512 + random(1)[0] % 100;
  // Publication names are opaque. Neither filenames, subjects nor shared EE
  // keys identify which objects are valid; validation must inspect the evidence.
  const labels = new Map();
  const label = role => { if (!labels.has(role)) labels.set(role, random(8).toString('hex')); return labels.get(role); };
  const filename = role => label(role) + '.' + role.split('.').at(-1);
  const repository = role => ORIGIN + label('repository:' + role) + '/';
  const shuffled = values => { const out = [...values]; for (let i = out.length - 1; i; i--) { const j = random(4).readUInt32LE() % (i + 1); [out[i], out[j]] = [out[j], out[i]]; } return out; };
  const ipv4 = (second, third = 0) => 10n << 24n | BigInt(second) << 16n | BigInt(third) << 8n;
  const v6Root = 0x20010db8000000000000000000000000n, v6 = v6Root | BigInt(h) << 92n | 0xa0n << 80n;
  const rootResources = [prefix(1, 10n << 24n, 8), prefix(2, v6Root, 32)], inherited = [{ afi: 1, inherit: true }, { afi: 2, inherit: true }];
  function certificate(key, issuer, subject, allocation, uri, options = {}) {
    const ca = Boolean(options.ca), serial = certSerial++, ownName = name(subject), issuerName = issuer?.name ?? ownName;
    const exts = [extension('2.5.29.14', octet(key.ski)), extension('2.5.29.35', seq(der(0x80, issuer?.key.ski ?? key.ski))),
      extension('2.5.29.15', der(3, Buffer.from(ca ? [1, 6] : [7, 128])), true), extension('2.5.29.32', seq(seq(oid(O.policy))), true), extension(O.resources, resources(allocation), true)];
    if (ca) exts.push(extension('2.5.29.19', seq(TRUE), true));
    const repo = options.repo;
    exts.push(extension('1.3.6.1.5.5.7.1.11', ca ? seq(access(O.repository, repo), access(O.manifestUri, repo + 'current.mft'), access(O.notification, RRDP + 'notification.xml')) : seq(access(O.objectUri, uri))));
    if (issuer) {
      exts.push(extension('1.3.6.1.5.5.7.1.1', seq(access('1.3.6.1.5.5.7.48.2', issuer.uri))));
      exts.push(extension('2.5.29.31', seq(seq(der(0xa0, der(0xa0, der(0x86, Buffer.from(issuer.repo + 'issuer.crl'))))))));
    }
    const tbs = seq(der(0xa0, uint(2)), uint(serial), signatureAlgorithm, issuerName, seq(utc(options.notBefore ?? START), utc(options.notAfter ?? END)), ownName, key.spki, der(0xa3, seq(...exts)));
    const bytes = seq(tbs, signatureAlgorithm, der(3, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, issuer?.key.key ?? key.key)])));
    return { key, bytes, serial, name: ownName, allocation, uri, repo };
  }
  const root = certificate(rsa(random), null, 'Archive TA', rootResources, 'rsync://rpki.archive.invalid/anchors/ta.cer', { ca: true, repo: repository('ta') });
  const alpha = certificate(rsa(random), root, 'Archive CA ' + label('alpha'), [{ afi: 1, range: [ipv4(b), ipv4(b + 15) - 1n] }, prefix(2, v6Root | BigInt(h) << 92n, 36)], root.repo + filename('alpha.cer'), { ca: true, repo: repository('alpha') });
  const beta = certificate(rsa(random), root, 'Archive CA ' + label('beta'), inherited, root.repo + filename('beta.cer'), { ca: true, repo: repository('beta') });
  const overflow = certificate(rsa(random), root, 'Archive CA ' + label('overflow'), [prefix(1, 0n, 0)], root.repo + filename('overflow.cer'), { ca: true, repo: repository('overflow') });
  function cms(ca, uri, type, content, allocation, options = {}) {
    const key = options.key ?? rsa(random), ee = certificate(key, ca, 'Archive EE ' + certSerial, allocation, uri, options);
    const digest = hash(content); if (options.badDigest) digest[7] ^= 1;
    const attributes = [seq(oid(O.contentType), set(oid(type))), seq(oid(O.digest), set(octet(digest)))].sort(Buffer.compare);
    const signature = sign('sha256', set(...attributes), key.key); if (options.badSignature) signature[29] ^= 1;
    const signer = seq(uint(3), der(0x80, key.ski), digestAlgorithm, der(0xa0, attributes), rsaAlgorithm, octet(signature));
    return { bytes: seq(oid(O.cms), der(0xa0, seq(uint(3), set(digestAlgorithm), seq(oid(type), der(0xa0, octet(content))), der(0xa0, ee.bytes), set(signer)))), ee };
  }
  function roa(ca, role, origin, rows, options = {}) {
    const objectName = filename(role);
    const content = seq(uint(origin), seq(...[1, 2].flatMap(afi => {
      const group = rows.filter(row => row.afi === afi); if (!group.length) return [];
      return [seq(octet(Buffer.from([0, afi])), seq(...group.map(row => seq(bits(row.network, afi === 1 ? 32 : 128, row.length), ...(row.maxLength === row.length ? [] : [uint(row.maxLength)])))))];
    })));
    const result = cms(ca, ca.repo + objectName, O.roa, content, options.allocation ?? rows, options);
    return { ...result, filename: objectName, vrps: rows.map(row => ({ ...row, asn: origin })) };
  }
  const good = [roa(alpha, 'broad.roa', asn, [prefix(1, ipv4(b), 16, 24)]), roa(alpha, 'specific.roa', asn + 1, [prefix(1, ipv4(b, 128), 17, 25)]),
    roa(alpha, 'as0.roa', 0, [prefix(1, ipv4(b + 1), 16, 24)]), roa(alpha, 'ipv6.roa', asn + 2, [prefix(2, v6, 43, 64)]),
    roa(beta, 'dual-stack.roa', asn + 3, [prefix(1, ipv4(240), 16, 23), prefix(2, v6Root | 0xfc00n << 80n, 40, 48)])];
  const decoys = [
    roa(alpha, 'revoked.roa', asn, [prefix(1, ipv4(b + 2), 16, 24)]),
    roa(alpha, 'expired.roa', asn + 1, [prefix(1, ipv4(b + 3), 16, 24)], { notAfter: '2025-01-02T00:00:00Z' }),
    roa(alpha, 'future.roa', asn + 2, [prefix(1, ipv4(b + 4), 16, 24)], { notBefore: '2025-06-01T00:00:00Z' }),
    roa(alpha, 'max-length.roa', asn + 3, [prefix(1, ipv4(b + 5), 16, 15)]),
    roa(alpha, 'ee-overclaim.roa', asn, [prefix(1, ipv4(250), 16, 24)]),
    roa(alpha, 'roa-overclaim.roa', asn + 1, [prefix(1, ipv4(b + 6), 16, 24)], { allocation: [prefix(1, ipv4(b + 6), 17)] }),
    roa(alpha, 'wrong-digest.roa', asn + 2, [prefix(1, ipv4(b + 7), 16, 24)], { badDigest: true }),
    roa(alpha, 'wrong-signature.roa', asn + 3, [prefix(1, ipv4(b + 8), 16, 24)], { badSignature: true }),
  ];
  const retired = roa(alpha, 'retired.roa', asn + 4, [prefix(1, ipv4(b + 10), 16, 24)]), orphan = roa(alpha, 'unlisted.roa', asn + 4, [prefix(1, ipv4(b + 9), 16, 24)]);
  const initialBroad = roa(alpha, 'broad.roa', asn + 5, [prefix(1, ipv4(b), 16, 24)]), overflowRoa = roa(overflow, 'over-delegated.roa', asn + 4, [prefix(1, 0xcb007100n, 24)]);
  function crl(ca, number, revoked, time) {
    const entries = revoked.map(serial => seq(uint(serial), utc('2025-05-31T09:00:00Z')));
    const tbs = seq(uint(1), signatureAlgorithm, ca.name, utc(time), utc('2025-06-01T00:00:00Z'), ...(entries.length ? [seq(...entries)] : []),
      der(0xa0, seq(extension('2.5.29.35', seq(der(0x80, ca.key.ski))), extension('2.5.29.20', uint(number)))));
    return seq(tbs, signatureAlgorithm, der(3, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, ca.key.key)])));
  }
  function publication(ca, objects, number, revoked = [], time = '2025-05-31T11:00:00Z') {
    const entries = new Map(objects); entries.set('issuer.crl', crl(ca, number, revoked, time));
    const content = seq(uint(number), generalized(time), generalized('2025-06-01T00:00:00Z'), oid(O.sha256), seq(...[...entries].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([filename, bytes]) => seq(der(0x16, Buffer.from(filename)), bits(big(hash(bytes)), 256, 256)))));
    const manifest = cms(ca, ca.repo + 'current.mft', O.manifest, content, ca.allocation.map(row => ({ afi: row.afi, inherit: true })));
    entries.set('current.mft', manifest.bytes); return new Map([...entries].map(([filename, bytes]) => [ca.repo + filename, bytes]));
  }
  const alphaObjects = [...good.slice(0, 4), ...decoys].map(row => [row.filename, row.bytes]);
  const alphaOld = publication(alpha, alphaObjects.map(([filename, bytes]) => [filename, filename === good[0].filename ? initialBroad.bytes : bytes]).concat([[retired.filename, retired.bytes]]), epoch, [], '2025-05-31T10:00:00Z');
  const alphaCurrent = publication(alpha, alphaObjects, epoch + 1n, [decoys[0].ee.serial]);
  const betaPublication = publication(beta, [[good[4].filename, good[4].bytes]], epoch);
  const overflowPublication = publication(overflow, [[overflowRoa.filename, overflowRoa.bytes]], epoch);
  const rootObjects = [alpha, beta, overflow].map(ca => [ca.uri.slice(root.repo.length), ca.bytes]);
  const rootOld = publication(root, rootObjects, epoch, [], '2025-05-31T10:00:00Z'), rootCurrent = publication(root, rootObjects, epoch + 2n);
  const initial = new Map([...rootOld, ...alphaOld, ...betaPublication, ...overflowPublication]);
  const middle = new Map([...initial]); for (const [uri, bytes] of alphaCurrent) middle.set(uri, bytes); middle.delete(alpha.repo + retired.filename); middle.set(alpha.repo + orphan.filename, orphan.bytes);
  const final = new Map([...middle]); for (const [uri, bytes] of rootCurrent) final.set(uri, bytes);
  const sessionBytes = random(16); sessionBytes[6] = sessionBytes[6] & 15 | 64; sessionBytes[8] = sessionBytes[8] & 63 | 128;
  const s = sessionBytes.toString('hex'), session = [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20)].join('-');
  const xml = (kind, number, records) => '<?xml version="1.0" encoding="UTF-8"?>\n<' + kind + ' xmlns="' + NAMESPACE + '" version="1" session_id="' + session + '" serial="' + number + '">\n' + records.join('\n') + '\n</' + kind + '>\n';
  const snapshot = xml('snapshot', epoch, shuffled([...initial].map(([uri, bytes]) => '  <publish uri="' + uri + '">' + bytes.toString('base64') + '</publish>')));
  const delta = (before, after, number) => xml('delta', number, shuffled([
    ...[...before].filter(([uri]) => !after.has(uri)).map(([uri, bytes]) => '  <withdraw uri="' + uri + '" hash="' + hash(bytes).toString('hex') + '"/>'),
    ...[...after].filter(([uri, bytes]) => !before.get(uri)?.equals(bytes)).map(([uri, bytes]) => '  <publish uri="' + uri + '"' + (before.has(uri) ? ' hash="' + hash(before.get(uri)).toString('hex') + '"' : '') + '>' + bytes.toString('base64') + '</publish>'),
  ]));
  const d1 = delta(initial, middle, epoch + 1n), d2 = delta(middle, final, epoch + 2n), currentSnapshot = xml('snapshot', epoch + 2n, shuffled([...final].map(([uri, bytes]) => '  <publish uri="' + uri + '">' + bytes.toString('base64') + '</publish>')));
  const uri1 = RRDP + session + '/' + (epoch + 1n) + '/delta.xml', uri2 = RRDP + session + '/' + (epoch + 2n) + '/delta.xml';
  const notification = xml('notification', epoch + 2n, ['  <snapshot uri="' + RRDP + session + '/' + (epoch + 2n) + '/snapshot.xml" hash="' + hash(currentSnapshot).toString('hex') + '"/>',
    '  <delta serial="' + (epoch + 2n) + '" uri="' + uri2 + '" hash="' + hash(d2).toString('hex') + '"/>', '  <delta serial="' + (epoch + 1n) + '" uri="' + uri1 + '" hash="' + hash(d1).toString('hex') + '"/>']);
  const routes = [], add = (row, origin) => routes.push({ ...row, asn: origin, id: random(8).toString('hex') });
  for (const [length, origin, third] of [[16, asn, 0], [15, asn, 0], [24, asn, 0], [25, asn, 0], [18, asn, 128], [18, asn + 1, 128], [25, asn + 1, 128], [26, asn + 1, 128], [24, asn + 4, 0], [24, asn + 1, 0], [24, asn + 5, 0]]) add(prefix(1, ipv4(b, third), length), origin);
  for (const length of [16, 25]) add(prefix(1, ipv4(b + 1), length), asn);
  for (const length of [16, 23, 24]) add(prefix(1, ipv4(240), length), asn + 3); add(prefix(1, ipv4(241), 24), asn + 3);
  for (const length of [43, 64, 65, 42]) add(prefix(2, v6, length), asn + 2); add(prefix(2, v6, 64), asn + 4);
  for (const length of [40, 48, 49]) add(prefix(2, v6Root | 0xfc00n << 80n, length), asn + 3);
  add(prefix(2, 0x20010db9000000000000000000000000n, 32), asn);
  for (let i = 2; i <= 10; i++) add(prefix(1, ipv4(b + i), 24), asn + 4);
  add(prefix(1, ipv4(250), 24), asn + 4); add(prefix(1, 0xcb007100n, 24), asn + 4);
  for (let i = routes.length - 1; i; i--) { const j = random(2).readUInt16LE() % (i + 1); [routes[i], routes[j]] = [routes[j], routes[i]]; }
  const valid = good.flatMap(row => row.vrps), decisions = routes.map(route => {
    const covering = valid.filter(row => row.afi === route.afi && row.length <= route.length && prefix(row.afi, route.network, row.length).network === row.network);
    return covering.some(row => row.asn === route.asn && route.length <= row.maxLength) ? 'V' : covering.length ? 'I' : 'N';
  }).join('');
  const material = Buffer.from(JSON.stringify({ vrps: canonical(valid), decisions }));
  return {
    'trust-anchor.tal': root.uri + '\n\n' + root.key.spki.toString('base64').match(/.{1,64}/g).join('\n') + '\n', 'ta.cer': root.bytes,
    'cached-snapshot.xml': snapshot, 'notification.xml': notification, 'delta-a.xml': d1, 'delta-b.xml': d2,
    'announcements.json': JSON.stringify(routes.map(row => ({ id: row.id, prefix: address(row), asn: row.asn })), null, 2) + '\n',
    'capture.json': JSON.stringify({ format: 'rpki-repository-capture-v1', evaluationTime: EVALUATION,
      cached: { session, serial: epoch.toString(), file: 'cached-snapshot.xml', sha256: hash(snapshot).toString('hex') }, captures: { [uri1]: 'delta-a.xml', [uri2]: 'delta-b.xml' },
      snapshot: 'Validated cached snapshot and its acquisition SHA-256 are the starting state. The current snapshot body was not captured; apply the complete consecutive RRDP delta chain described by notification.xml, including prior-object hash checks and withdrawals.',
      validation: 'Offline historical evaluation at evaluationTime, not the wall clock. TAL SPKI anchors ta.cer. RFC 6487 legacy RFC 3779 IP resource profile (id-cp-ipAddr-asNumber), RSA-2048 / SHA-256, RFC 6488 signed objects, RFC 9286 manifests, RFC 9582 ROAs, RFC 8182 RRDP. No external fetches or permissive cache fallback.',
      policy: 'A publication point is used only with a current, valid manifest, its listed current CRL, and matching hashes for every listed object. Invalid or overclaiming child certificates contribute no descendants. Only manifest-listed ROAs contribute VRPs; files merely present in the repository do not. Check certificate path, validity, revocation, resource inheritance/containment, CMS attributes/digests/signatures, and ROA prefix/maxLength semantics.',
      originValidation: 'RFC 6811 / 8481: V if ANY covering VRP matches the positive origin ASN and permits the announcement length; I if covered but no such VRP; N if not covered. This is not longest-prefix-only selection. AS0 is not a positive route origin.',
      capsuleMaterial: 'UTF-8 compact JSON with keys in order {"vrps":ROWS,"decisions":TEXT}. Each VRP row is [afi,networkHex,plen,maxLength,asn], with lowercase networkHex padded to 8/32 digits. Deduplicate rows and sort lexicographically by these five numeric fields (fixed-width hex sorts numerically). TEXT concatenates V/I/N in announcements.json ARRAY order, not id order. The outer capsule SHA-256 hashes these raw UTF-8 bytes.',
    }, null, 2) + '\n',
    'capsule.json': JSON.stringify(seal({ code }, material, 'archive/rpki/validated-origin', random), null, 2) + '\n',
  };
}
