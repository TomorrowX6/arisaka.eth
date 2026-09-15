import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { seededRandom } from '../scripts/core.mjs';
import { generate } from '../scripts/build-challenges.mjs';
import { rpkiEvidence } from '../scripts/expert/rpki.mjs';
import { parseRPKIDER, parseRPKIResources, parseRRDPXML, applyRRDPDelta, rebuildRPKIRepository,
  validateRPKIRepository, classifyRPKIOrigins, recoverRPKIMaterial, decodeRPKIEvidence } from '../scripts/expert/rpki-decoder.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = rpkiEvidence('synthetic-rpki-fixture', seededRandom(Buffer.alloc(32, 0x46), 'rpki-test'));
const state = rebuildRPKIRepository(fixture), recovered = recoverRPKIMaterial(fixture);
const reason = text => recovered.diagnostics.find(item => item.error.includes(text));
const alpha = reason('ROA maxLength').uri.replace(/[^/]+$/, '');
const xml = (body, serial = '9007199254740993', session = '12345678-1234-1234-1234-123456789abc') =>
  `<delta xmlns="http://www.ripe.net/rpki/rrdp" version="1" session_id="${session}" serial="${serial}">${body}</delta>`;
const raw = hex => Buffer.from(hex, 'hex');
const tlv = (tag, bytes) => Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
const seq = (...bytes) => tlv(0x30, Buffer.concat(bytes));
const family = (afi, choice) => seq(tlv(4, Buffer.from([0, afi])), choice);
const parseResources = (bytes, parent) => parseRPKIResources(parseRPKIDER(bytes), parent);

test('bounded DER enforces minimal lengths, integers, SET ordering and bit-string padding', () => {
  assert.equal(parseRPKIDER(raw('3006020101020102')).children.length, 2);
  for (const hex of ['30800000', '308106020101020102', '02810101', '02020001', '0202ffff', '03020800', '03020101', '030101', '050100', '010101', '3106020102020101', '300302010100']) {
    assert.throws(() => parseRPKIDER(raw(hex)), /RPKI/);
  }
  let nested = raw('0500'); for (let i = 0; i < 27; i++) nested = seq(nested);
  assert.throws(() => parseRPKIDER(nested), /nesting/);
  assert.throws(() => parseRPKIDER(Buffer.alloc(1048577)), /size/);
});

test('RFC 3779 prefix, non-CIDR range, IPv6 partial octet and inheritance algebra have independent numeric anchors', () => {
  const ipv4 = seq(family(1, seq(raw('0302000a'))));
  const v4 = parseResources(ipv4); assert.deepEqual(v4.resources.get(1), [[0x0a000000n, 0x0affffffn]]);
  const v6 = parseResources(seq(family(2, seq(raw('03060720010db880')))));
  assert.deepEqual(v6.resources.get(2), [[0x20010db8800000000000000000000000n, 0x20010db8ffffffffffffffffffffffffn]]);
  const interval = seq(family(1, seq(seq(raw('0302010a'), raw('0304000a0002')))));
  assert.deepEqual(parseResources(interval, v4.resources).resources.get(1), [[0x0a000000n, 0x0a0002ffn]]);
  assert.deepEqual(parseResources(seq(family(1, raw('0500'))), v4.resources).resources, v4.resources);
  assert.throws(() => parseResources(seq(family(1, raw('0500')))), /inheritance/);
  assert.throws(() => parseResources(seq(family(1, seq(raw('0302000b')))), v4.resources), /overclaim/);
  assert.throws(() => parseResources(seq(family(1, seq(seq(raw('0302010a'), raw('0302000a')))))), /should be a prefix/);
  assert.throws(() => parseResources(seq(family(1, seq(raw('0302000a'), raw('0302000a'))))), /overlapping/);
  assert.throws(() => parseResources(seq(family(2, seq(raw('030100'))), family(1, seq(raw('030100'))))), /AFI ordering/);
  const all = parseResources(seq(family(1, seq(raw('030100'))), family(2, seq(raw('030100')))));
  assert.deepEqual(all.resources.get(1), [[0n, (1n << 32n) - 1n]]); assert.deepEqual(all.resources.get(2), [[0n, (1n << 128n) - 1n]]);
});

test('RRDP exact uint64 transitions verify prior hashes transactionally, not partially or through Number', () => {
  const uri = 'rsync://archive.invalid/a.roa', bytes = Buffer.from('old'), other = 'rsync://archive.invalid/b.roa';
  const before = { session: '12345678-1234-1234-1234-123456789abc', serial: 9007199254740992n, objects: new Map([[uri, bytes]]) };
  const replaced = applyRRDPDelta(before, xml(`<publish uri="${uri}" hash="${hash(bytes)}">bmV3</publish>`));
  assert.equal(replaced.serial, 9007199254740993n); assert.equal(replaced.objects.get(uri).toString(), 'new'); assert.equal(before.objects.get(uri).toString(), 'old');
  assert.equal(Number(replaced.serial), Number(before.serial));
  assert.throws(() => applyRRDPDelta(before, xml(`<publish uri="${other}">bmV3</publish><withdraw uri="${uri}" hash="${'0'.repeat(64)}"/>`)), /prior-object hash/);
  assert.equal(before.objects.size, 1); assert.equal(before.objects.has(other), false);
  const removed = applyRRDPDelta(before, xml(`<withdraw uri="${uri}" hash="${hash(bytes)}"/>`)); assert.equal(removed.objects.size, 0);
  for (const body of [`<publish uri="${uri}">bmV3</publish>`, `<withdraw uri="${other}" hash="${hash(bytes)}"/>`, `<publish uri="${other}">bmV3</publish><publish uri="${other}">bmV3</publish>`, `<publish uri="${other}">YQ=A</publish>`]) assert.throws(() => applyRRDPDelta(before, xml(body)));
  assert.throws(() => applyRRDPDelta(before, xml('', '9007199254740994')), /nonconsecutive/);
  assert.throws(() => applyRRDPDelta(before, xml('', '9007199254740993', '22345678-1234-1234-1234-123456789abc')), /nonconsecutive/);
  assert.throws(() => applyRRDPDelta(before, xml('', '18446744073709551616')), /serial/);
});

test('offline XML and capture parser reject entities, namespaces, missing deltas, hash changes and stale session substitutions', () => {
  assert.equal(parseRRDPXML(xml('<publish uri="rsync://archive.invalid/a">YQ==</publish>')).children.length, 1);
  for (const source of ['<!DOCTYPE x [<!ENTITY p SYSTEM "file:///etc/passwd">]>' + xml(''), xml('&amp;'), xml('<publish uri="a" uri="b">YQ==</publish>'), xml('<publish><nested/></publish>'), xml('') + xml('')]) assert.throws(() => parseRRDPXML(source), /RPKI/);
  assert.throws(() => parseRRDPXML(Buffer.from([0xc0, 0x80])));
  assert.throws(() => parseRRDPXML(' '.repeat(4194305)), /size/);
  for (const name of ['cached-snapshot.xml', 'delta-a.xml', 'delta-b.xml']) assert.throws(() => rebuildRPKIRepository({ ...fixture, [name]: Buffer.concat([Buffer.from(fixture[name]), Buffer.from(' ')]) }), /acquisition hash/);
  const captures = JSON.parse(fixture['capture.json']); delete captures.captures[Object.keys(captures.captures)[0]];
  assert.throws(() => rebuildRPKIRepository({ ...fixture, 'capture.json': JSON.stringify(captures) }), /uncaptured/);
  const notification = String(fixture['notification.xml']);
  assert.throws(() => rebuildRPKIRepository({ ...fixture, 'notification.xml': notification.replace(/session_id="[^"]+"/, 'session_id="12345678-1234-1234-1234-123456789abc"') }), /session/);
  assert.throws(() => rebuildRPKIRepository({ ...fixture, 'notification.xml': notification.replace(/  <delta[^>]+\/>\n/, '') }), /missing|gap|final delta/);
  assert.throws(() => rebuildRPKIRepository({ ...fixture, 'notification.xml': notification.replace('http://www.ripe.net/rpki/rrdp', 'https://wrong.invalid/') }), /root/);
});

test('full resource paths reject each independent invalid object and ignore unlisted or withdrawn publications', () => {
  assert.equal(recovered.vrps.length, 6); assert.equal(recovered.accepted.length, 5); assert.equal(recovered.publications.length, 3); assert.equal(recovered.diagnostics.length, 9);
  for (const message of ['certificate resource overclaim', 'certificate validity', 'ROA maxLength', 'revoked certificate', 'ROA resource overclaim', 'CMS message digest', 'CMS signature']) assert.ok(reason(message), message);
  assert.equal(recovered.diagnostics.filter(item => item.error.includes('certificate validity')).length, 2);
  assert.equal(recovered.diagnostics.filter(item => item.error.includes('certificate resource overclaim')).length, 2);
  assert.ok(recovered.publications.every(item => BigInt(item.manifestNumber) > 9007199254740991n));
  const withdrawals = parseRRDPXML(fixture['delta-a.xml']).children.filter(item => item.name === 'withdraw'); assert.equal(withdrawals.length, 1); assert.equal(state.objects.has(withdrawals[0].attrs.uri), false);
  const examined = new Set([...recovered.accepted, ...recovered.diagnostics.map(item => item.uri)]);
  const unlisted = [...state.objects.keys()].filter(uri => uri.startsWith(alpha) && uri.endsWith('.roa') && !examined.has(uri)); assert.equal(unlisted.length, 1);
  const without = { ...state, objects: new Map(state.objects) }; without.objects.delete(unlisted[0]); assert.deepEqual(validateRPKIRepository(fixture, without), validateRPKIRepository(fixture, state));
  assert.ok([...state.objects.keys()].filter(uri => uri.endsWith('.roa') || uri.endsWith('.cer')).every(uri => /\/[0-9a-f]{16}\.(roa|cer)$/.test(uri)), 'filenames do not reveal object validity');
  for (const missing of [alpha + 'issuer.crl', alpha + 'current.mft', recovered.accepted.find(uri => uri.startsWith(alpha))]) {
    const broken = { ...state, objects: new Map(state.objects) }; broken.objects.delete(missing);
    const result = validateRPKIRepository(fixture, broken); assert.equal(result.vrps.length, 2); assert.equal(result.accepted.length, 1);
    assert.ok(result.diagnostics.some(item => item.uri === alpha + 'current.mft'));
  }
  const corrupt = { ...state, objects: new Map(state.objects) }, bytes = Buffer.from(corrupt.objects.get(alpha + 'current.mft')); bytes[bytes.length - 1] ^= 1;
  corrupt.objects.set(alpha + 'current.mft', bytes); assert.equal(validateRPKIRepository(fixture, corrupt).vrps.length, 2);
  assert.throws(() => recoverRPKIMaterial({ ...fixture, 'trust-anchor.tal': String(fixture['trust-anchor.tal']).replace(/\n\n./, '\n\nA') }), /anchor/);
  const badTime = { ...state, capture: { ...state.capture, evaluationTime: '2026-01-01T00:00:00Z' } }; assert.throws(() => validateRPKIRepository(fixture, badTime), /evaluation/);
  const seal = JSON.parse(fixture['capsule.json']); seal.tag = Buffer.alloc(16).toString('base64'); assert.throws(() => decodeRPKIEvidence({ ...fixture, 'capsule.json': JSON.stringify(seal) }));
});

test('origin validation is ANY-match, honors maxLength and AS0, and preserves IPv6 and uint32 ASNs', () => {
  const vrps = [[1, '0a000000', 8, 24, 64512], [1, '0a800000', 9, 25, 64513], [1, 'c0000200', 24, 32, 0], [2, '20010db8800000000000000000000000', 33, 64, 4294967295]];
  const inputs = [['10.128.0.0/24', 64512], ['10.128.0.0/25', 64513], ['10.128.0.0/25', 64512], ['10.0.0.0/7', 64512], ['192.0.2.1/32', 64512], ['2001:db8:8000::/64', 4294967295], ['2001:db8:8000::/65', 4294967295], ['2001:db8::/33', 4294967295]];
  const announcements = inputs.map(([prefix, asn], i) => ({ id: String(i), prefix, asn }));
  assert.equal(classifyRPKIOrigins(vrps, announcements), 'VVINIVIN');
  assert.equal(classifyRPKIOrigins([...vrps].reverse(), announcements), 'VVINIVIN');
  for (const item of [{ id: 'a', prefix: '10.0.0.1/24', asn: 64512 }, { id: 'a', prefix: '2001::db8::/32', asn: 64512 }, { id: 'a', prefix: '10.0.0.0/8', asn: 0 }, { id: 'a', prefix: '10.0.0.0/8', asn: 4294967296 }]) assert.throws(() => classifyRPKIOrigins(vrps, [item]));
  assert.throws(() => classifyRPKIOrigins(vrps, [announcements[0], announcements[0]]), /duplicate/);
});

test('OpenSSL independently verifies real X.509 paths, CMS attribute signatures and CRLs, including negative signatures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rpki-openssl-'));
  const run = args => spawnSync('openssl', args, { cwd: dir, encoding: 'utf8', timeout: 10000 });
  const pem = (kind, bytes) => `-----BEGIN ${kind}-----\n${Buffer.from(bytes).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${kind}-----\n`;
  try {
    const caFiles = [...state.objects].filter(([uri]) => uri.endsWith('.cer'));
    await writeFile(join(dir, 'ta.pem'), pem('CERTIFICATE', fixture['ta.cer'])); await writeFile(join(dir, 'ca.pem'), caFiles.map(([, bytes]) => pem('CERTIFICATE', bytes)).join(''));
    const subjects = [fixture['ta.cer'], ...caFiles.map(([, bytes]) => bytes)].map(bytes => ({ bytes, subject: parseRPKIDER(bytes).children[0].children[5].raw }));
    for (const uri of [...recovered.accepted, ...recovered.publications.map(item => item.uri + 'current.mft'), reason('CMS message digest').uri, reason('CMS signature').uri]) {
      const bytes = state.objects.get(uri), signed = parseRPKIDER(bytes).children[1].children[0];
      await writeFile(join(dir, 'object.der'), bytes);
      const result = run(['cms', '-verify', '-inform', 'DER', '-in', 'object.der', '-noverify', '-binary', '-out', 'content.der']);
      const invalid = [reason('CMS message digest').uri, reason('CMS signature').uri].includes(uri);
      assert.equal(result.status === 0, !invalid, uri + '\n' + result.stderr);
      if (!invalid) {
        await writeFile(join(dir, 'ee.pem'), pem('CERTIFICATE', signed.children[3].children[0].raw));
        // ignore_critical is solely for OpenSSL builds without RFC 3779 support;
        // resource semantics are checked independently above, never ignored by the decoder.
        const path = run(['verify', '-ignore_critical', '-attime', '1748692800', '-CAfile', 'ta.pem', '-untrusted', 'ca.pem', 'ee.pem']);
        assert.equal(path.status, 0, path.stderr);
      }
    }
    for (const publication of recovered.publications) {
      const bytes = state.objects.get(publication.uri + 'issuer.crl'), issuer = parseRPKIDER(bytes).children[0].children[2].raw;
      await writeFile(join(dir, 'issuer.pem'), pem('CERTIFICATE', subjects.find(item => item.subject.equals(issuer)).bytes)); await writeFile(join(dir, 'crl.der'), bytes);
      const result = run(['crl', '-inform', 'DER', '-in', 'crl.der', '-CAfile', 'issuer.pem', '-verify', '-noout']); assert.equal(result.status, 0, result.stderr);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('multi-seed opaque repositories solve only after current manifests, resource paths and positive origin validation', () => {
  for (let i = 0; i < 10; i++) {
    const code = 'synthetic-rpki-seed-' + i, files = rpkiEvidence(code, seededRandom(i < 8 ? Buffer.alloc(32, i) : randomBytes(32), 'rpki-test'));
    const result = recoverRPKIMaterial(files); assert.deepEqual(decodeRPKIEvidence(files), { code });
    assert.equal(result.vrps.length, 6); assert.equal(result.diagnostics.length, 9); assert.equal(result.accepted.length, 5); assert.equal(result.publications.length, 3);
    assert.equal(result.serial, BigInt(JSON.parse(files['capture.json']).cached.serial) + 2n); assert.equal(result.decisions.length, 37);
    assert.deepEqual(new Set(result.decisions), new Set(['V', 'I', 'N']));
    assert.equal(result.material.toString(), JSON.stringify({ vrps: result.vrps, decisions: result.decisions }));
    for (const bytes of Object.values(files)) assert.equal(Buffer.from(bytes).includes(Buffer.from(code)), false);
    const shuffled = JSON.parse(files['announcements.json']).reverse();
    assert.throws(() => decodeRPKIEvidence({ ...files, 'announcements.json': JSON.stringify(shuffled) }), 'capsule binds array order, not announcement ID sorting');
  }
});

test('seeded RSA evidence is reproducible and publication record ordering is not an object-validity label', () => {
  const repeated = rpkiEvidence('synthetic-rpki-fixture', seededRandom(Buffer.alloc(32, 0x46), 'rpki-test'));
  for (const name of Object.keys(fixture)) assert.deepEqual(Buffer.from(repeated[name]), Buffer.from(fixture[name]), name);
  const order = parseRRDPXML(fixture['cached-snapshot.xml']).children.map(item => item.attrs.uri), classifications = order.filter(uri => uri.startsWith(alpha) && uri.endsWith('.roa')).map(uri => recovered.accepted.includes(uri));
  assert.ok(classifications.some((valid, i) => valid && i > 0 && !classifications[i - 1]), 'valid records are not simply all before rejected records');
  const parsed = parseRRDPXML(fixture['delta-a.xml']); assert.ok(parsed.children.some(item => item.name === 'withdraw'));
  assert.throws(() => validateRPKIRepository({ ...fixture, 'trust-anchor.tal': Buffer.from([0xff, ...Buffer.from(fixture['trust-anchor.tal'])]) }, state), /non-ASCII/);
});

test('RPKI extension preserves all 34 preceding evidence sets and declares the exact prior edition compatible', async () => {
  const { artifacts, answers, manifest } = await generate(Buffer.alloc(32, 0x42)), digest = createHash('sha256');
  for (const [stage, files] of Object.entries(artifacts)) if (Number(stage) <= 34) for (const [name, content] of Object.entries(files)) digest.update(stage + '/' + name + '\0').update(content);
  assert.equal(digest.digest('hex'), '4a89e5eee68304600104e067050be872b4f74426d193e78e624461c3b097444e');
  assert.equal(hash(JSON.stringify(answers.codes.slice(0, 34))), '077cbd2670578a255bedab65d70ef11e523d5e98970a9b6437490b874e2d0338');
  assert.deepEqual(manifest.compatibleEditions.find(item => item.cases === 34), { version: '43a0c3defd914256', cases: 34 });
  assert.deepEqual(decodeRPKIEvidence(artifacts[35]), { code: answers.codes[34] });
});
