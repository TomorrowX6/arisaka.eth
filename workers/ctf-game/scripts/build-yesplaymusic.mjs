import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { patchUpstream } from '../runtime/yesplaymusic/patches.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(root, 'runtime/yesplaymusic');
const maximumAssetBytes = 25 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const musicSource = Object.freeze({
  url: 'https://codeload.github.com/qier222/YesPlayMusic/zip/df075cca247eab7bf8686155cb8cc9a1f4c7e271',
  commit: 'df075cca247eab7bf8686155cb8cc9a1f4c7e271',
  sha256: '91592e1050a1806fe2450cf43f0d846bd5c52975c9be75ab55632e2b2b287e2e',
});

export function verifySourceArchive(bytes, source = musicSource) {
  if (hash(bytes) !== source.sha256) throw new Error('YesPlayMusic source archive checksum mismatch');
}

function safeName(name) {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('/')
    && !/[\\:\x00-\x1f]/.test(name)
    && !name.split('/').some(part => part === '.' || part === '..');
}

function wantedSource(name) {
  if (name.split('/').some(part => part.startsWith('.'))) return false;
  if (['LICENSE', 'package.json', 'babel.config.js', 'public/index.html', 'public/favicon.ico'].includes(name)) return true;
  if (name === 'src/electron/ipcRenderer.js') return true;
  if (name.startsWith('src/electron/') || ['src/background.js', 'src/ncmModDef.js', 'src/registerServiceWorker.js'].includes(name)) return false;
  if (name.startsWith('src/')) return /\.(?:vue|js|scss|css|svg|png|jpe?g|gif|webp|woff2?|ttf|eot)$/.test(name);
  return /^public\/img\/(?:icons|logos)\/[a-zA-Z0-9_.@-]+\.(?:png|svg|gif|jpe?g|webp|ico)$/.test(name);
}

export function extractSourceFiles(bytes, source = musicSource) {
  verifySourceArchive(bytes, source);
  const prefix = 'YesPlayMusic-' + source.commit + '/';
  let total = 0;
  let count = 0;
  const archive = unzipSync(bytes, { filter(entry) {
    if (!safeName(entry.name)) throw new Error('Unsafe YesPlayMusic archive path');
    if (!entry.name.startsWith(prefix) || entry.name.endsWith('/')) return false;
    const name = entry.name.slice(prefix.length);
    if (!wantedSource(name)) return false;
    total += entry.originalSize;
    if (++count > 2000 || entry.originalSize > maximumAssetBytes || total > 64 * 1024 * 1024) throw new Error('Unexpected YesPlayMusic source size');
    return true;
  } });
  const files = Object.fromEntries(Object.entries(archive).map(([name, bytes]) => [name.slice(prefix.length), Buffer.from(bytes)]));
  for (const name of ['src/main.js', 'src/App.vue', 'public/index.html', 'package.json', 'babel.config.js', 'LICENSE']) {
    if (!files[name]) throw new Error('YesPlayMusic source archive is missing ' + name);
  }
  if (JSON.parse(files['package.json']).version !== '0.4.10') throw new Error('Unexpected YesPlayMusic source version');
  return files;
}

export function validatePublicFiles(files) {
  for (const [name, bytes] of Object.entries(files)) {
    const allowed = ['index.html', 'bridge.js', 'favicon.ico', 'NOTICE.txt', 'LICENSE.txt'].includes(name)
      || /^js\/[a-zA-Z0-9_.-]+\.js(?:\.LICENSE\.txt)?$/.test(name)
      || /^css\/[a-zA-Z0-9_.-]+\.css$/.test(name)
      || /^(?:img|fonts)\/[a-zA-Z0-9_./@-]+\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/.test(name);
    if (!safeName(name) || name.split('/').some(part => part.startsWith('.')) || !allowed) throw new Error('Unsafe public YesPlayMusic asset: ' + name);
    if (!bytes.length || bytes.length > maximumAssetBytes) throw new Error('YesPlayMusic asset exceeds 25 MiB or is empty: ' + name);
  }
}

async function sourceArchive(cache) {
  const path = resolve(cache, 'source-' + musicSource.commit + '.zip');
  try {
    const bytes = await readFile(path);
    verifySourceArchive(bytes);
    return bytes;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('Downloading hash-pinned YesPlayMusic 0.4.10 source…');
  const response = await fetch(musicSource.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('YesPlayMusic source download failed: HTTP ' + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('Unexpected YesPlayMusic archive download size');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  verifySourceArchive(bytes);
  const temporary = path + '.' + process.pid + '.download';
  try { await writeFile(temporary, bytes); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  return bytes;
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function run(command, args, options) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error('YesPlayMusic build command failed with exit ' + code)));
  });
}

async function prepareDependencies() {
  const lock = await readFile(resolve(webRoot, 'package-lock.json'));
  const signature = hash(Buffer.concat([lock, await readFile(resolve(webRoot, 'package.json'))]));
  const stamp = resolve(webRoot, 'node_modules/.arisaka-lock-sha256');
  if (await exists(stamp) && (await readFile(stamp, 'utf8')).trim() === signature
    && await exists(resolve(webRoot, 'node_modules/@vue/cli-service/bin/vue-cli-service.js'))) return;
  // Invoke npm's JS entry with the current Node executable on Windows too.
  // This avoids cmd.exe interpolation and keeps the installation on Node 22.
  const npmCandidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH || '').split(delimiter).filter(Boolean).map(path => resolve(path, 'node_modules/npm/bin/npm-cli.js')),
  ].filter(path => path && /npm-cli\.js$/i.test(path));
  let npm;
  for (const path of npmCandidates) if (await exists(path)) { npm = path; break; }
  console.log('Installing locked YesPlayMusic web build dependencies…');
  if (npm) await run(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: webRoot });
  else if (process.platform !== 'win32') await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: webRoot });
  else throw new Error('npm is required to prepare the pinned YesPlayMusic web build dependencies');
  await writeFile(stamp, signature + '\n');
}

function inside(parent, target) {
  const path = relative(resolve(parent), resolve(target));
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new Error('Refusing an unsafe YesPlayMusic build path');
  return resolve(target);
}

async function writeFiles(directory, files) {
  for (const [name, bytes] of Object.entries(files)) {
    if (!safeName(name)) throw new Error('Unsafe YesPlayMusic output path');
    const path = inside(directory, resolve(directory, name));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}

async function readPublicDirectory(directory) {
  const files = {};
  async function visit(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Unsafe public asset symlink');
      if (entry.isDirectory()) await visit(resolve(path, entry.name), name + '/');
      else if (entry.isFile()) files[name] = await readFile(resolve(path, entry.name));
      else throw new Error('Unexpected public asset type');
    }
  }
  await visit(directory);
  return files;
}

async function verifiedCache(directory) {
  try {
    const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
    if (manifest.app !== 'yesplaymusic' || manifest.version !== '0.4.10'
      || JSON.stringify(manifest.source) !== JSON.stringify(musicSource)) throw new Error('Invalid cached YesPlayMusic manifest');
    const files = await readPublicDirectory(directory);
    delete files['manifest.json'];
    validatePublicFiles(files);
    if (!files['index.html'] || !files['bridge.js'] || !files['NOTICE.txt']) throw new Error('Incomplete cached YesPlayMusic build');
    if (Object.keys(files).length !== Object.keys(manifest.files).length) throw new Error('Unexpected cached YesPlayMusic asset');
    for (const [name, bytes] of Object.entries(files)) {
      if (manifest.files[name]?.size !== bytes.length || manifest.files[name]?.sha256 !== hash(bytes)) throw new Error('Cached YesPlayMusic asset checksum mismatch: ' + name);
    }
    return { manifest, files };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function buildYesPlayMusic({ directory = resolve(root, 'runtime/dist/yesplaymusic'), cache = resolve(root, '.private/yesplaymusic') } = {}) {
  await mkdir(cache, { recursive: true });
  const archive = await sourceArchive(cache);
  const inputs = await Promise.all(['package.json', 'package-lock.json', 'vue.config.cjs', 'patches.mjs', 'bridge.cjs', 'cookies.mjs', 'transport.mjs'].map(name => readFile(resolve(webRoot, name))));
  const fingerprint = hash(Buffer.concat([Buffer.from(JSON.stringify(musicSource) + process.versions.node), await readFile(fileURLToPath(import.meta.url)), ...inputs]));
  const cached = resolve(cache, 'build-' + fingerprint);
  let result = await verifiedCache(cached);
  if (!result) {
    await prepareDependencies();
    const scratchRoot = resolve(webRoot, '.build');
    await mkdir(scratchRoot, { recursive: true });
    const scratch = await mkdtemp(resolve(scratchRoot, 'source-'));
    try {
      const files = extractSourceFiles(archive);
      await writeFiles(scratch, files);
      // The web dependency subset is also the CLI plugin manifest. No upstream
      // Electron postinstall, server config, .env or secret is copied into it.
      const pkg = JSON.parse(await readFile(resolve(webRoot, 'package.json'), 'utf8'));
      await writeFile(resolve(scratch, 'package.json'), JSON.stringify({ ...pkg, name: 'yesplaymusic' }, null, 2));
      await writeFile(resolve(scratch, 'vue.config.js'), await readFile(resolve(webRoot, 'vue.config.cjs')));
      await writeFiles(scratch, {
        'src/arisaka/cookies.mjs': await readFile(resolve(webRoot, 'cookies.mjs')),
        'src/arisaka/transport.mjs': await readFile(resolve(webRoot, 'transport.mjs')),
        'public/bridge.js': await readFile(resolve(webRoot, 'bridge.cjs')),
        'public/LICENSE.txt': files.LICENSE,
        'public/NOTICE.txt': Buffer.from('YesPlayMusic 0.4.10\nhttps://github.com/qier222/YesPlayMusic\nSource commit: ' + musicSource.commit
          + '\nSource archive SHA-256: ' + musicSource.sha256
          + '\n\nThis web build retains the upstream Vue interface. Desktop adaptations add profile-scoped storage and API transport, a runtime bridge, and disable analytics and service-worker registration.\n\n'
          + files.LICENSE.toString('utf8')),
      });
      await patchUpstream(scratch);
      const output = resolve(scratch, 'dist');
      const env = { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '--openssl-legacy-provider', SOURCE_DATE_EPOCH: '1727740800' };
      // Only explicitly configured values enter this embedded build.
      for (const name of Object.keys(env)) if (name.startsWith('VUE_APP_')) delete env[name];
      console.log('Building the pinned YesPlayMusic Vue application…');
      await run(process.execPath, [resolve(webRoot, 'node_modules/@vue/cli-service/bin/vue-cli-service.js'), 'build', '--dest', output], { cwd: scratch, env });
      const publicFiles = await readPublicDirectory(output);
      validatePublicFiles(publicFiles);
      const manifest = {
        app: 'yesplaymusic', version: '0.4.10', source: musicSource,
        files: Object.fromEntries(Object.keys(publicFiles).sort().map(name => [name, { size: publicFiles[name].length, sha256: hash(publicFiles[name]) }])),
      };
      await writeFiles(cached, { ...publicFiles, 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n') });
      result = { manifest, files: publicFiles };
    } finally {
      await rm(inside(scratchRoot, scratch), { recursive: true, force: true });
    }
  }
  // Remove only previously emitted files in the selected application directory.
  // This avoids old chunks surviving when a new build changes its content hashes.
  try {
    const previous = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
    if (previous.app === 'yesplaymusic' && previous.files && typeof previous.files === 'object') {
      for (const name of Object.keys(previous.files)) {
        if (safeName(name) && !Object.hasOwn(result.files, name)) await rm(inside(directory, resolve(directory, name)), { force: true });
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFiles(directory, { ...result.files, 'manifest.json': Buffer.from(JSON.stringify(result.manifest, null, 2) + '\n') });
  console.log('Prepared YesPlayMusic 0.4.10: ' + Object.keys(result.files).length + ' assets, largest '
    + Math.max(...Object.values(result.files).map(bytes => bytes.length)) + ' bytes.');
  return result.manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildYesPlayMusic();
