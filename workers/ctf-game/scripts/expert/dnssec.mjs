import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { seal, sha256 } from '../core.mjs';
import { pcapng, u16be, u32be } from './formats.mjs';
import { udp } from './network.mjs';

const stamp = 1789430400; // A fixed acquisition time, not the build machine's clock.
function name(value) { return Buffer.concat([...value.replace(/\.$/, '').split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label.toLowerCase())])), Buffer.from([0])]); }

export function dnsKeyTag(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum += i & 1 ? bytes[i] : bytes[i] << 8;
  return (sum + (sum >>> 16)) & 65535;
}

function key(random, flags = 256) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), random(32)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const rdata = Buffer.concat([u16be(flags), Buffer.from([3, 15]), publicKey]);
  return { privateKey, publicKey, rdata, tag: dnsKeyTag(rdata) };
}

function signedSet(owner, type, rdatas, signerName, signingKey, { wildcard = false, expired = false } = {}) {
  const canonicalOwner = wildcard ? '*.' + owner.split('.').slice(1).join('.') : owner;
  const labels = canonicalOwner.split('.').filter(Boolean).length - (wildcard ? 1 : 0);
  const signatureHeader = Buffer.concat([u16be(type), Buffer.from([15, labels]), u32be(3600),
    u32be(stamp + (expired ? -60 : 3600)), u32be(stamp - 7200), u16be(signingKey.tag), name(signerName)]);
  const canonical = Buffer.concat([signatureHeader, ...[...rdatas].sort(Buffer.compare).map(rdata =>
    Buffer.concat([name(canonicalOwner), u16be(type), u16be(1), u32be(3600), u16be(rdata.length), rdata]))]);
  const signature = Buffer.concat([signatureHeader, sign(null, canonical, signingKey.privateKey)]);
  return { owner, type, rdatas, signature, canonical };
}

function response(set, id, flags = 0x8400) {
  // Message owners are compressed, have mixed case and have cache-aged TTLs.
  // DNSSEC canonical form uses neither these wire labels nor these TTL values.
  const questionName = name(set.owner);
  for (let i = 0; i < questionName.length; i++) if (questionName[i] >= 97 && questionName[i] <= 122 && i % 2) questionName[i] -= 32;
  const rr = (type, rdata) => Buffer.concat([Buffer.from('c00c', 'hex'), u16be(type), u16be(1), u32be(23), u16be(rdata.length), rdata]);
  return Buffer.concat([u16be(id), u16be(flags), u16be(1), u16be(set.rdatas.length + 1), u16be(0), u16be(0), questionName, u16be(set.type), u16be(1),
    rr(46, set.signature), ...set.rdatas.toReversed().map(rdata => rr(set.type, rdata))]);
}

export function dnssecEvidence(code, random) {
  const parent = 'archive.invalid.', child = 'relay.archive.invalid.', query = 'snapshot.relay.archive.invalid.';
  const root = key(random, 257), parentZsk = key(random), childKsk = key(random, 257), childZsk = key(random), retired = key(random, 385);
  const anchor = signedSet(parent, 48, [root.rdata, parentZsk.rdata], parent, root);
  const delegationData = Buffer.concat([u16be(childKsk.tag), Buffer.from([15, 2]), sha256(Buffer.concat([name(child), childKsk.rdata]))]);
  const delegation = signedSet(child, 43, [delegationData], parent, parentZsk);
  const childKeys = signedSet(child, 48, [childKsk.rdata, childZsk.rdata, retired.rdata], child, childKsk);
  const txt = bytes => {
    const first = Buffer.from('custody=v1;'), second = Buffer.from(bytes.toString('base64'));
    return Buffer.concat([Buffer.from([first.length]), first, Buffer.from([second.length]), second]);
  };
  const leaf = signedSet(query, 16, [txt(random(31)), txt(random(47)), txt(random(19))], child, childZsk, { wildcard: true });
  const sets = [anchor, delegation, childKeys, leaf];
  const records = [];
  for (let i = 0; i < 12; i++) {
    const fake = signedSet(query, 16, [txt(random(31)), txt(random(47)), txt(random(19))], child,
      i % 3 === 0 ? retired : i % 3 === 1 ? childZsk : key(random), { wildcard: i % 2 === 0, expired: i % 3 === 1 });
    // The AD bit is set even on forged/expired/revoked responses. It is not an anchor.
    records.push(response(fake, 200 + i, 0x8420));
  }
  records.splice(2, 0, response(childKeys, 103));
  records.splice(6, 0, response(leaf, 104));
  records.splice(9, 0, response(anchor, 101));
  records.push(response(delegation, 102));
  const material = sha256(Buffer.concat(sets.map(set => set.canonical)));
  return {
    'resolver.pcapng': pcapng(records.map((bytes, i) => ({ bytes: udp(bytes), time: BigInt(stamp) * 1000000n + BigInt(i * 137) }))),
    'trust-anchor.json': JSON.stringify({ format: 'dnssec-custody-v1', owner: parent, dnskey: root.rdata.toString('base64'),
      observedAt: stamp, delegation: child, question: { name: query, type: 16, class: 1 },
      custodyOrder: ['anchor DNSKEY', 'delegation DS', 'child DNSKEY', 'answer TXT'], digest: 'SHA-256(RRSIG canonical signed data, concatenated)' }, null, 2),
    'capsule.json': JSON.stringify(seal({ code }, material, 'archive/dnssec/custody', random), null, 2),
  };
}
