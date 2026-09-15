import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv } from 'node:crypto';
import { seededRandom } from '../scripts/core.mjs';
import { openSeal } from '../scripts/decoders.mjs';
import { aesFaultEncrypt, faultEvidence } from '../scripts/expert/faults.mjs';
import { recoverFaultKey } from '../scripts/expert/fault-decoder.mjs';
import { ociEvidence } from '../scripts/expert/oci.mjs';
import { decodeOciEvidence } from '../scripts/expert/oci-decoder.mjs';
import { storageEvidence } from '../scripts/expert/storage.mjs';
import { decodeStorageEvidence } from '../scripts/expert/storage-decoder.mjs';
import { nandEvidence } from '../scripts/expert/nand.mjs';
import { decodeNandEvidence } from '../scripts/expert/nand-decoder.mjs';
import { trieEvidence } from '../scripts/expert/trie.mjs';
import { decodeTrieEvidence } from '../scripts/expert/trie-decoder.mjs';
import { coreEvidence } from '../scripts/expert/core-dump.mjs';
import { decodeCoreEvidence } from '../scripts/expert/core-decoder.mjs';
import { pdfEvidence } from '../scripts/expert/pdf.mjs';
import { decodePdfEvidence } from '../scripts/expert/pdf-decoder.mjs';
import { latticeEvidence } from '../scripts/expert/lattice.mjs';
import { decodeLatticeEvidence } from '../scripts/expert/lattice-decoder.mjs';
import { sequencerEvidence } from '../scripts/expert/sequencer.mjs';
import { decodeSequencerEvidence } from '../scripts/expert/sequencer-decoder.mjs';
import { powerEvidence } from '../scripts/expert/power.mjs';
import { decodePowerEvidence, recoverPowerKey, readPowerTraces } from '../scripts/expert/power-decoder.mjs';

test('second-order power recovery aligns traces, removes drift, and recovers an unknown byte schedule', () => {
  for (let edition = 0; edition < 4; edition++) {
    const files = powerEvidence('power-test-code', 'power-receipt', seededRandom(randomBytes(32), 'power'));
    assert.deepEqual(decodePowerEvidence(files), { code: 'power-test-code', receipt: 'power-receipt' });
    assert.throws(() => readPowerTraces(files['acquisition.trs'].subarray(0, -2)), /Truncated/);
    const altered = { ...files, 'capsule.json': JSON.stringify({ ...JSON.parse(files['capsule.json']), tag: Buffer.alloc(16).toString('base64') }) };
    assert.throws(() => decodePowerEvidence(altered));
  }
});

test('MIDI recovery handles running status, tempo changes, eight erasures, and twenty-eight silent errors', () => {
  for (let edition = 0; edition < 6; edition++) {
    const files = sequencerEvidence('sequencer-test-code', seededRandom(randomBytes(32), 'sequencer'));
    assert.deepEqual(decodeSequencerEvidence(files), { code: 'sequencer-test-code' });
    assert.throws(() => decodeSequencerEvidence({ ...files, 'afterimage.mid': files['afterimage.mid'].subarray(0, -1) }), /Truncated/);
  }
});

test('hidden-number lattice recovery validates the scalar against the curve public key', () => {
  for (let edition = 0; edition < 3; edition++) {
    const files = latticeEvidence('lattice-test-code', 'lattice-receipt', seededRandom(randomBytes(32), 'lattice'));
    assert.deepEqual(decodeLatticeEvidence(JSON.parse(files['signatures.json']), files['trace.bin'], JSON.parse(files['capsule.json'])), { code: 'lattice-test-code', receipt: 'lattice-receipt' });
  }
});

test('PDF recovery verifies the signed historical revision and resolves compressed xref entries', () => {
  for (let edition = 0; edition < 4; edition++) {
    const files = pdfEvidence('pdf-test-code', 'pdf-receipt', seededRandom(randomBytes(32), 'pdf'));
    assert.deepEqual(decodePdfEvidence(files), { code: 'pdf-test-code', receipt: 'pdf-receipt' });
    const signature = Buffer.from(files['release.sig']); signature[10] ^= 1;
    assert.throws(() => decodePdfEvidence({ ...files, 'release.sig': signature }), /authenticated/);
  }
});

test('Ethereum storage recovery authenticates a historical account and nested dynamic mapping', () => {
  for (let edition = 0; edition < 3; edition++) {
    const files = trieEvidence('trie-test-code', 'trie-receipt', seededRandom(randomBytes(32), 'trie'));
    assert.deepEqual(decodeTrieEvidence(files), { code: 'trie-test-code', receipt: 'trie-receipt' });
    const header = Buffer.from(files['header.rlp']); header[60] ^= 1;
    assert.throws(() => decodeTrieEvidence({ ...files, 'header.rlp': header }), /hash mismatch/);
    assert.throws(() => decodeTrieEvidence({ ...files, 'witness.bin': files['witness.bin'].subarray(0, -1) }), /Truncated/);
  }
});

test('ELF core recovery resolves virtual memory, register mangling, and authenticated safe-linked slabs', () => {
  for (let edition = 0; edition < 4; edition++) {
    const files = coreEvidence('core-test-code', 'core-receipt', seededRandom(randomBytes(32), 'core'));
    const capsule = JSON.parse(files['capsule.json']);
    assert.deepEqual(decodeCoreEvidence(files['process.core'], capsule), { code: 'core-test-code', receipt: 'core-receipt' });
    const core = Buffer.from(files['process.core']);
    core.writeBigUInt64LE(0n, 64 + 56 + 16);
    assert.throws(() => decodeCoreEvidence(core, capsule), /Unmapped/);
  }
});

test('NAND recovery corrects BCH errors before replaying committed FTL maps and FAT chains', () => {
  for (let edition = 0; edition < 3; edition++) {
    const files = nandEvidence('nand-test-code', 'nand-receipt', seededRandom(randomBytes(32), 'nand'));
    assert.deepEqual(decodeNandEvidence(files['nand.bin']), { code: 'nand-test-code', receipt: 'nand-receipt' });
  }
});

test('OCI evidence preserves hardlink inodes through opaque whiteouts and a runtime overlay', () => {
  for (let edition = 0; edition < 3; edition++) {
    const files = ociEvidence('oci-test-code', 'oci-receipt', seededRandom(randomBytes(32), 'oci'));
    assert.deepEqual(decodeOciEvidence(files), { code: 'oci-test-code', receipt: 'oci-receipt' });
    const changed = { ...files, 'upper.tar': Buffer.from(files['upper.tar']) };
    changed['upper.tar'][600] ^= 1;
    assert.throws(() => decodeOciEvidence(changed), /Overlay mismatch/);
    const dsse = JSON.parse(files['provenance.dsse.json']);
    dsse.signatures[0].sig = Buffer.alloc(64).toString('base64');
    assert.throws(() => decodeOciEvidence({ ...files, 'provenance.dsse.json': JSON.stringify(dsse) }), /signature/);
  }
});

test('storage recovery corrects twelve silent errors and eight erasures per stripe', () => {
  for (let edition = 0; edition < 2; edition++) {
    const files = storageEvidence('storage-test-code', 'storage-receipt', seededRandom(randomBytes(32), 'storage'));
    assert.deepEqual(decodeStorageEvidence(files['fragments.tar']), { code: 'storage-test-code', receipt: 'storage-receipt' });
  }
});

test('AES acquisition agrees with the standard cipher and survives unknown fault locations', () => {
  for(let i=0;i<4;i++){
    const seed=randomBytes(32),key=seed.subarray(0,16),input=seed.subarray(16);
    const standard=createCipheriv('aes-128-ecb',key,null);standard.setAutoPadding(false);
    assert.deepEqual(aesFaultEncrypt(input,key),Buffer.concat([standard.update(input),standard.final()]));
    const files=faultEvidence('expert-test-code','test-receipt',seededRandom(seed,'dfa'));
    const result=openSeal(JSON.parse(files['capsule.json']),recoverFaultKey(files['acquisition.csv']));
    assert.equal(result.code,'expert-test-code');assert.equal(result.receipt,'test-receipt');
  }
});

import { tlsEvidence } from '../scripts/expert/tls.mjs';
import { decodeTlsEvidence } from '../scripts/expert/tls-decoder.mjs';
test('network evidence requires coherent TCP reconstruction through TLS key updates and HTTP/2', () => {
  for(let edition=0;edition<3;edition++){
    const files=tlsEvidence('network-test-code','network-receipt',seededRandom(randomBytes(32),'tls'));
    const result=decodeTlsEvidence(files['wire.pcapng']);
    assert.equal(result.code,'network-test-code');assert.equal(result.receipt,'network-receipt');
    assert.throws(()=>decodeTlsEvidence(files['wire.pcapng'],'first'));
  }
});

import { walEvidence } from '../scripts/expert/wal.mjs';
import { decodeWalEvidence, walSnapshots } from '../scripts/expert/wal-decoder.mjs';
test('SQLite recovery respects frame checksums, commit boundaries, truncation, and historical pages', async () => {
  for(let edition=0;edition<3;edition++){
    const files=await walEvidence('database-test-code','database-receipt',seededRandom(randomBytes(32),'wal'));
    const snapshots=walSnapshots(files['catalog.db'],files['journal.segment']);
    assert.equal(snapshots.length,3);
    const result=await decodeWalEvidence(files['catalog.db'],files['journal.segment'],JSON.parse(files['capsule.json']));
    assert.equal(result.code,'database-test-code');assert.equal(result.receipt,'database-receipt');
    const corrupt=Buffer.from(files['journal.segment']);corrupt[65]^=1;
    assert.equal(walSnapshots(files['catalog.db'],corrupt).length,0);
  }
});

import { rsaEvidence } from '../scripts/expert/rsa.mjs';
import { decodeRsaEvidence } from '../scripts/expert/rsa-decoder.mjs';
test('RSA polynomial recovery works with exponent 257 and quadratic message evolution', () => {
  for(let edition=0;edition<2;edition++){
    const files=rsaEvidence('rsa-test-code','rsa-receipt',seededRandom(randomBytes(32),'rsa'));
    const result=decodeRsaEvidence(files['telemetry.json'],files['emitter.py'],JSON.parse(files['capsule.json']));
    assert.equal(result.code,'rsa-test-code');assert.equal(result.receipt,'rsa-receipt');
  }
});
