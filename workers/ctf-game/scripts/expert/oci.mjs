import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { seal, sha256 } from '../core.mjs';
import { tar } from './formats.mjs';

const json = value => Buffer.from(JSON.stringify(value));
const digest = value => 'sha256:' + sha256(value).toString('hex');
const types = {
  manifest: 'application/vnd.oci.image.manifest.v1+json',
  config: 'application/vnd.oci.image.config.v1+json',
  layer: 'application/vnd.oci.image.layer.v1.tar+gzip',
};

export function ociEvidence(code, receipt, random) {
  const blobs = {}, candidates = [], materials = [];
  function put(bytes, mediaType) {
    const id = digest(bytes);
    blobs['blobs/sha256/' + id.slice(7)] = bytes;
    return { mediaType, digest: id, size: bytes.length };
  }
  for (const architecture of ['amd64', 'arm64', 's390x']) {
    const retained = random(32), active = random(32), runtime = random(32);
    const layers = [], uncompressed = [];
    const layer = entries => {
      const bytes = tar(entries);
      uncompressed.push(digest(bytes));
      layers.push(put(gzipSync(bytes, { level: 9 }), types.layer));
    };
    const initial = {};
    for (let i = 0; i < 48; i++) initial['usr/share/vault/chunk-' + i.toString(16).padStart(2, '0')] = random(32);
    initial['usr/share/vault/part-a'] = retained;
    initial['usr/share/vault/part-b'] = random(32);
    initial['usr/share/vault/part-c'] = random(32);
    initial['etc/os-release'] = 'ID=alpine\nVERSION_ID=3.22.0\n';
    layer(initial);
    layer({
      'var/lib/vault/retained': { type: '1', link: 'usr/share/vault/part-a' },
      'var/lib/vault/old-c': { type: '1', link: 'usr/share/vault/part-c' },
      'etc/vault/current': { type: '2', link: '../../var/lib/vault/config/2024' },
      'var/lib/vault/config/2024': json({ fragments: ['/usr/share/vault/part-a', '/usr/share/vault/part-b'] }),
    });
    layer({
      'usr/share/vault/.wh..wh..opq': '',
      'usr/share/vault/part-a': random(32),
      'usr/share/vault/part-b': random(32),
      'usr/share/vault/part-c': active,
      'usr/share/vault/cache': random(1024),
    });
    layer({
      'var/lib/vault/active': { type: '1', link: 'usr/share/vault/part-c' },
      'usr/share/vault/part-c': random(32),
      'var/lib/vault/config/2025': json({ fragments: ['/var/lib/vault/retained', '/var/lib/vault/active', '/etc/vault/session'] }),
      'etc/vault/.wh.current': '',
      'etc/vault/current': { type: '2', link: '../../var/lib/vault/config/2025' },
    });
    layer({
      'var/lib/vault/.wh.old-c': '',
      'usr/share/vault/.wh.part-a': '',
      'usr/share/vault/part-b': random(32),
      'var/lib/vault/session': random(32),
      'etc/vault/session': { type: '2', link: '../../var/lib/vault/session' },
    });
    layer({
      'usr/local/bin/release.py': [
        'import hashlib, json, pathlib',
        'cfg = json.loads(pathlib.Path("/etc/vault/current").read_bytes())',
        'material = hashlib.sha256(b"".join(pathlib.Path(p).read_bytes() for p in cfg["fragments"])).digest()',
        'def credential():',
        '    return material',
        '',
      ].join('\n'),
      'var/log/build.log': random(2800),
      'usr/share/vault/old-release': random(32),
    });
    layer({
      'var/log/.wh.build.log': '',
      'usr/share/vault/.wh.old-release': '',
      'etc/machine-id': random(16).toString('hex') + '\n',
      'var/lib/vault/config/2023': json({ fragments: ['/usr/share/vault/part-b', '/usr/share/vault/part-c'] }),
    });
    const config = put(json({
      architecture, os: 'linux', config: { User: '1000:1000', Entrypoint: ['/usr/local/bin/release.py'] },
      rootfs: { type: 'layers', diff_ids: uncompressed },
      history: layers.map((_, i) => ({ created_by: 'build-step ' + i })),
    }), types.config);
    candidates.push({ ...put(json({ schemaVersion: 2, mediaType: types.manifest, config, layers }), types.manifest), platform: { os: 'linux', architecture } });
    materials.push({ key: sha256(Buffer.concat([retained, active, runtime])), runtime });
  }
  const selected = random(1)[0] % candidates.length, image = candidates[selected];
  const upper = tar({
    'var/lib/vault/.wh.session': '',
    'var/lib/vault/session': materials[selected].runtime,
    'var/lib/vault/config/.wh.2023': '',
    'var/lib/vault/.wh.active-old': '',
    'tmp/session.log': random(1700),
  });
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), random(32)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' });
  const captureId = random(12).toString('hex');
  const payloadType = 'application/vnd.in-toto+json';
  const payload = json({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'release', digest: { sha256: image.digest.slice(7) } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: { runDetails: { metadata: { invocationId: captureId } }, buildDefinition: { buildType: 'oci', externalParameters: { architecture: image.platform.architecture } } },
  });
  const pae = Buffer.concat([Buffer.from('DSSEv1 ' + payloadType.length + ' ' + payloadType + ' ' + payload.length + ' '), payload]);
  return {
    'image.oci.tar': tar({ 'oci-layout': json({ imageLayoutVersion: '1.0.0' }), 'index.json': json({ schemaVersion: 2, manifests: candidates.toReversed() }), ...blobs }),
    'upper.tar': upper,
    'execution.json': json({ invocationId: captureId, architecture: image.platform.architecture, rootfs: { upper: digest(upper), mode: 'overlay' }, authority: publicKey }),
    'provenance.dsse.json': json({ payloadType, payload: payload.toString('base64'), signatures: [{ keyid: digest(Buffer.from(publicKey)), sig: sign(null, pae, privateKey).toString('base64') }] }),
    'capsule.json': JSON.stringify(seal({ code, receipt }, materials[selected].key, 'afterglow/oci', random)),
  };
}
