import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomPath, seal, seededRandom, sha256, splitSecret } from './core.mjs';
import { stereoTransmission } from './formats.mjs';
import { glassMachine, imagePair, qrFragments, signedArchive } from './puzzles.mjs';
import { buildUI } from './build-ui.mjs';
import { verifyPublicAssets } from './public-assets.mjs';
import { gitEvidence } from './expert/git.mjs';
import { tlsEvidence } from './expert/tls.mjs';
import { walEvidence } from './expert/wal.mjs';
import { rsaEvidence } from './expert/rsa.mjs';
import { faultEvidence } from './expert/faults.mjs';
import { ociEvidence } from './expert/oci.mjs';
import { storageEvidence } from './expert/storage.mjs';
import { nandEvidence } from './expert/nand.mjs';
import { gcmEvidence, paddingEvidence } from './expert/crypto-labs.mjs';
import { curveEvidence } from './expert/curve.mjs';
import { trieEvidence } from './expert/trie.mjs';
import { coreEvidence } from './expert/core-dump.mjs';
import { pdfEvidence } from './expert/pdf.mjs';
import { latticeEvidence } from './expert/lattice.mjs';
import { wotsEvidence } from './expert/wots.mjs';
import { sequencerEvidence } from './expert/sequencer.mjs';
import { powerEvidence } from './expert/power.mjs';
import { quicEvidence } from './expert/quic.mjs';
import { dnssecEvidence } from './expert/dnssec.mjs';
import { logicEvidence } from './expert/logic.mjs';
import { frostEvidence, frostGroupMaterial } from './expert/frost.mjs';
import { rs16Evidence, rs16CustodyMaterial } from './expert/rs16.mjs';
import { bpfEvidence } from './expert/bpf.mjs';
import { mlkemEvidence } from './expert/mlkem.mjs';
import { radioEvidence } from './expert/radio.mjs';
import caseWidgets from '../src/case-catalog.json' with { type: 'json' };

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const json = (value) => JSON.stringify(value, null, 2) + '\n';

async function buildSeed() {
  const directory = resolve(root, '.private');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'build-seed');
  if (process.env.CTF_BUILD_SEED) {
    if (!/^[0-9a-f]{64}$/i.test(process.env.CTF_BUILD_SEED)) {
      throw new Error('CTF_BUILD_SEED must contain exactly 64 hexadecimal characters.');
    }
    return Buffer.from(process.env.CTF_BUILD_SEED, 'hex');
  }
  try {
    const saved = (await readFile(path, 'utf8')).trim();
    if (!/^[0-9a-f]{64}$/i.test(saved)) throw new Error('The saved build seed must contain exactly 64 hexadecimal characters.');
    return Buffer.from(saved, 'hex');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const seed = randomBytes(32);
    await writeFile(path, seed.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    return seed;
  }
}

export async function generate(seed) {
  if (seed.length !== 32) throw new Error('The build seed must be 32 bytes.');
  const edition = count => sha256(Buffer.concat([Buffer.from('afterglow-expert-v5:' + JSON.stringify(caseWidgets.slice(0, count)) + ':'), seed])).toString('hex').slice(0, 16);
  const version = edition(caseWidgets.length);
  // An explicit append-only release lineage, not a blanket acceptance of any
  // old version. Bump the domain above for an incompatible artifact change.
  const compatibleEditions = [26, 29, 31, 32, 33].filter(cases => cases < caseWidgets.length).map(cases => ({ version: edition(cases), cases }));
  const entryToken = randomPath(seededRandom(seed, 'terminal-entry-route'));
  const codes = Array.from({ length: caseWidgets.length }, (_, i) => randomPath(seededRandom(seed, 'code/' + (i + 1))));
  const finalKey = seededRandom(seed, 'final-key')(16);
  const shares = splitSecret(finalKey, seededRandom(seed, 'shares'));
  const terminalClue = '[object-store]\nversion = 2\nformat = sha1\npack = objects.pack\ncheckpoint = checkpoint.tar\n';
  const etag = '"afterimage-' + seededRandom(seed, 'etag')(8).toString('hex') + '"';
  const gcm = gcmEvidence(17, seededRandom(seed, 'gcm-evidence'));
  const curve = curveEvidence(19, seededRandom(seed, 'curve-evidence'));
  const wots = wotsEvidence(24, seededRandom(seed, 'wots-evidence'));
  const artifacts = {
    1: gitEvidence(codes[0], seededRandom(seed, 'git-evidence')),
    2: {},
    3: sequencerEvidence(codes[2], seededRandom(seed, 'sequencer-evidence')),
    4: {
      'exchange-api.txt': [
        'Start: 1 card, 0 stands. Stand price: 1 card. Sealed note: 4 cards and at least 1 stand.',
        '',
        'All POST requests: Content-Type: application/json; X-Afterglow: 1',
        'GET /api/shop',
        'POST /api/shop/quote       {"item":"stand","quantity":1}',
        'POST /api/shop/checkout    {"quoteId":"..."}',
        'POST /api/shop/redeem      {}',
        'POST /api/shop/reset       {}',
        '',
        'Quote TTL: 300 seconds. Uses: 1.',
        '',
      ].join('\n'),
    },
    5: qrFragments(codes[4], seededRandom(seed, 'qr')),
    6: {
      'last-broadcast.wav': stereoTransmission(codes[5], shares[0]),
    },
    7: imagePair(codes[6], shares[0], shares[1]),
    8: signedArchive(codes[7], shares[2], seededRandom(seed, 'signatures')),
    9: await glassMachine(codes[8], shares[3], seededRandom(seed, 'wasm')),
    10: tlsEvidence(codes[9], undefined, seededRandom(seed, 'tls-evidence')),
    11: await walEvidence(codes[10], undefined, seededRandom(seed, 'wal-evidence')),
    12: rsaEvidence(codes[11], undefined, seededRandom(seed, 'rsa-evidence')),
    13: faultEvidence(codes[12], undefined, seededRandom(seed, 'fault-evidence')),
    14: ociEvidence(codes[13], undefined, seededRandom(seed, 'oci-evidence')),
    15: storageEvidence(codes[14], undefined, seededRandom(seed, 'storage-evidence')),
    16: nandEvidence(codes[15], undefined, seededRandom(seed, 'nand-evidence')),
    17: gcm.files,
    18: paddingEvidence(18),
    19: curve.files,
    20: trieEvidence(codes[19], undefined, seededRandom(seed, 'trie-evidence')),
    21: coreEvidence(codes[20], undefined, seededRandom(seed, 'core-evidence')),
    22: pdfEvidence(codes[21], undefined, seededRandom(seed, 'pdf-evidence')),
    23: latticeEvidence(codes[22], undefined, seededRandom(seed, 'lattice-evidence')),
    24: wots.files,
    25: powerEvidence(codes[24], undefined, seededRandom(seed, 'power-evidence')),
    26: {
      'last-letter.json': json({
        ...seal({
          code: codes[25],
        }, finalKey, 'afterglow/final', seededRandom(seed, 'final-seal')),
      }),
      'custody.json': json({ version: 1, field: 256, polynomial: 283, threshold: 4, members: 4, width: 16 }),
    },
    27: quicEvidence(codes[26], seededRandom(seed, 'quic-evidence')),
    28: dnssecEvidence(codes[27], seededRandom(seed, 'dnssec-evidence')),
    29: logicEvidence(codes[28], seededRandom(seed, 'logic-evidence')),
    30: frostEvidence(codes[29], seededRandom(seed, 'frost-evidence')),
    31: rs16Evidence(codes[30], seededRandom(seed, 'rs16-evidence')),
    32: bpfEvidence(codes[31], [frostGroupMaterial(seededRandom(seed, 'frost-evidence')), rs16CustodyMaterial(seededRandom(seed, 'rs16-evidence'))], seededRandom(seed, 'bpf-evidence')),
    33: mlkemEvidence(codes[32], seededRandom(seed, 'mlkem-evidence')),
    34: radioEvidence(codes[33], seededRandom(seed, 'radio-evidence')),
  };
  const files = Object.fromEntries(Object.entries(artifacts).map(([stage, entries]) => [stage, Object.keys(entries)]));
  const manifest = {
    version,
    compatibleEditions,
    entryDigest: sha256('afterglow/entry/v1/' + entryToken).toString('hex'),
    digests: codes.map((code, i) => sha256('afterglow:' + version + ':' + (i + 1) + ':' + code).toString('hex')),
    files,
    terminalClue,
    etag,
    conditionalClue: Buffer.from('ARSK2\n' + codes[1] + '\n', 'ascii').toString('base64'),
    shopCode: codes[3],
    labs: {
      17: { kind: 'gcm', key: gcm.key, nonce: gcm.nonce, reward: { code: codes[16] } },
      18: { kind: 'padding', key: seededRandom(seed, 'padding-key')(32).toString('hex'), reward: { code: codes[17] } },
      19: { kind: 'curve', curve: curve.curve, reward: { code: codes[18] } },
      24: { kind: 'wots', seed: wots.seed, root: wots.root, reward: { code: codes[23] } },
    },
  };
  return { manifest, artifacts, answers: { version, codes, shares, entryToken } };
}

export async function publishEntrance(generated, url, blogRoot = resolve(root, '..', '..')) {
  const deploymentPath = resolve(blogRoot, 'src', 'data', 'ctf-deployment.json');
  const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
  await writeFile(resolve(blogRoot, 'public', 'README', 'README.md'), generated.terminalEnvelope + '\n');
  await writeFile(deploymentPath, json({ url: url ?? deployment.url ?? '', entrance: generated.answers.entryToken }));
}

export async function build({ syncEntrance = false } = {}) {
  const seed = await buildSeed();
  const generated = await generate(seed);
  const entranceRoot = resolve(root, '..', '..', 'public', 'README');
  const legacyMidi = await readFile(resolve(entranceRoot, 'README.mid'));
  const passwords = legacyMidi.toString('latin1').match(/[A-Za-z0-9]{20}/g) || [];
  if (passwords.length !== 1) throw new Error('The original terminal artifact is missing or invalid.');
  const randomness = seededRandom(seed, 'terminal-envelope')(28);
  const salt = randomness.subarray(0, 16);
  const nonce = randomness.subarray(16);
  const key = pbkdf2Sync(passwords[0], salt, 600_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = '/' + generated.answers.entryToken + '/';
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const envelope = ['v1', '600000', salt.toString('base64url'), nonce.toString('base64url'), ciphertext.toString('base64url')].join('.');
  generated.terminalEnvelope = envelope;
  const puzzleRoot = resolve(root, 'public', '_puzzles');
  if (relative(root, puzzleRoot).replaceAll('\\', '/') !== 'public/_puzzles') {
    throw new Error('Refusing to clear an unexpected artifact directory.');
  }
  // This ignored directory contains only generated artifacts. Remove stale files
  // so renamed/removed puzzle material cannot be accidentally shipped again.
  await rm(puzzleRoot, { recursive: true, force: true });
  for (const [stage, files] of Object.entries(generated.artifacts)) {
    const directory = resolve(root, 'public', '_puzzles', stage);
    await mkdir(directory, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(resolve(directory, name), content);
    }
  }
  await mkdir(resolve(root, 'src', 'generated'), { recursive: true });
  await writeFile(resolve(root, 'src', 'generated', 'manifest.json'), json(generated.manifest));
  await writeFile(resolve(root, '.private', 'answers.json'), json(generated.answers), { mode: 0o600 });
  await mkdir(resolve(root, 'public', 'vendor'), { recursive: true });
  await writeFile(resolve(root, 'public', 'vendor', 'jsQR.js'), await readFile(require.resolve('jsqr')));
  await writeFile(resolve(root, 'public', 'vendor', 'jsQR-LICENSE.txt'),
    await readFile(resolve(dirname(require.resolve('jsqr')), '..', 'LICENSE')));
  await buildUI();
  await verifyPublicAssets(root);
  if (syncEntrance) await publishEntrance(generated);
  console.log('Generated ' + caseWidgets.length + ' cases for edition ' + generated.manifest.version + '. Answers remain private.');
  return generated;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build({ syncEntrance: process.argv.includes('--sync-entrance') });
}
