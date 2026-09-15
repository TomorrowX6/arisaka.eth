import { createHash, verify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { posix } from 'node:path';
import { unpackTar } from './git-decoder.mjs';
import { openSeal } from '../decoders.mjs';

const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export function overlay(filesystem, archive) {
  const entries = unpackTar(archive);
  // Whiteouts affect lower layers only, regardless of their position in the TAR.
  for (const path of entries.keys()) {
    const name = posix.basename(path), directory = posix.dirname(path);
    if (!name.startsWith('.wh.')) continue;
    const target = directory + '/' + name.slice(4);
    for (const key of filesystem.keys()) {
      if (name === '.wh..wh..opq' ? key.startsWith(directory + '/') : key === target || key.startsWith(target + '/')) filesystem.delete(key);
    }
  }
  for (const [path, entry] of entries) {
    if (posix.basename(path).startsWith('.wh.')) continue;
    if (entry.type === '1') {
      const inode = filesystem.get(posix.normalize(entry.link).replace(/^\//, ''));
      if (!inode || inode.type !== '0') throw Error('Missing hardlink target');
      filesystem.set(path, inode);
    } else if (entry.type === '0' || entry.type === '' || entry.type === '2') {
      filesystem.set(path, { ...entry, type: entry.type || '0' });
    }
  }
  return filesystem;
}

export function decodeOciEvidence(files) {
  const execution = JSON.parse(files['execution.json']);
  const dsse = JSON.parse(files['provenance.dsse.json']);
  const payload = Buffer.from(dsse.payload, 'base64');
  const pae = Buffer.concat([Buffer.from('DSSEv1 ' + Buffer.byteLength(dsse.payloadType) + ' ' + dsse.payloadType + ' ' + payload.length + ' '), payload]);
  if (!dsse.signatures.some(item => verify(null, pae, execution.authority, Buffer.from(item.sig, 'base64')))) throw Error('Invalid provenance signature');
  const statement = JSON.parse(payload);
  if (statement.predicate.runDetails.metadata.invocationId !== execution.invocationId) throw Error('Capture identity mismatch');
  const image = unpackTar(files['image.oci.tar']);
  const index = JSON.parse(image.get('index.json').bytes);
  const selected = index.manifests.find(item => item.digest === 'sha256:' + statement.subject[0].digest.sha256 && item.platform.architecture === execution.architecture);
  if (!selected) throw Error('Image absent');
  function blob(item) {
    const bytes = image.get('blobs/sha256/' + item.digest.slice(7))?.bytes;
    if (!bytes || bytes.length !== item.size || digest(bytes) !== item.digest) throw Error('OCI content address mismatch');
    return bytes;
  }
  const manifest = JSON.parse(blob(selected)), config = JSON.parse(blob(manifest.config));
  const filesystem = new Map();
  manifest.layers.forEach((item, i) => {
    const bytes = gunzipSync(blob(item));
    if (digest(bytes) !== config.rootfs.diff_ids[i]) throw Error('OCI diff-id mismatch');
    overlay(filesystem, bytes);
  });
  if (digest(files['upper.tar']) !== execution.rootfs.upper) throw Error('Overlay mismatch');
  overlay(filesystem, files['upper.tar']);
  function read(path) {
    path = posix.normalize(path).replace(/^\//, '');
    for (let hops = 0; hops < 32; hops++) {
      const item = filesystem.get(path);
      if (!item) throw Error('Missing overlay file: ' + path);
      if (item.type === '0') return item.bytes;
      path = posix.normalize(item.link.startsWith('/') ? item.link : posix.dirname(path) + '/' + item.link).replace(/^\//, '');
    }
    throw Error('Symlink loop');
  }
  const configuration = JSON.parse(read('/etc/vault/current'));
  const key = createHash('sha256').update(Buffer.concat(configuration.fragments.map(read))).digest();
  return openSeal(JSON.parse(files['capsule.json']), key);
}
