import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build, publishEntrance, root } from './build-challenges.mjs';
import { verifyDeployment } from './deployment-health.mjs';
import { deployRuntimes } from './deploy-runtimes.mjs';
import { inspectUpgrade, upgradeSecretPolicy, assertUnchangedDeployment } from './deployment-upgrade.mjs';
import { deploymentArguments, deploymentTarget, publishVerifiedRelease } from './deployment-target.mjs';

const require = createRequire(import.meta.url);
if (process.env.CI && !process.env.CTF_BUILD_SEED) throw new Error('CI deployments require the original CTF_BUILD_SEED.');
const { target, bootstrap } = deploymentArguments(process.argv.slice(2));
const desktop = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
const runtime = JSON.parse(await readFile(resolve(root, 'runtime/wrangler.jsonc'), 'utf8'));
const selected = deploymentTarget(target, desktop, runtime);

// A failed upload or health check must not point the blog at an unpublished edition.
const generated = await build({ syncEntrance: false });
const before = await inspectUpgrade(selected.desktopOrigin, generated.manifest, { bootstrap });
const privateDirectory = target === 'production' ? resolve(root, '.private') : resolve(root, '.private/releases', target);
await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
const secretPath = resolve(privateDirectory, 'session-secret');
let secret;
if (!before.installed) {
  secret = process.env.CTF_SESSION_SECRET;
  if (process.env.CI && !secret) throw new Error('Bootstrapping in CI requires CTF_SESSION_SECRET.');
}
if (!before.installed && !secret) {
  try {
    secret = (await readFile(secretPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secret = randomBytes(48).toString('hex');
    await writeFile(secretPath, secret + '\n', { flag: 'wx', mode: 0o600 });
  }
}
const policy = upgradeSecretPolicy(before, secret);
// Publish and verify the game engines and music app before their desktop launchers.
await deployRuntimes({ target });
assertUnchangedDeployment(before, await inspectUpgrade(selected.desktopOrigin, generated.manifest, { bootstrap }));
const secretsFile = resolve(privateDirectory, 'deploy-secrets.json');
let wroteSecrets = false;

try {
  if (!policy.preserve) {
    await writeFile(secretsFile, JSON.stringify({ SESSION_SECRET: policy.secret }), { flag: 'wx', mode: 0o600 });
    wroteSecrets = true;
  }
  else console.log('Preserving the existing Worker SESSION_SECRET, cookies and completion proofs.');
  const wrangler = resolve(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
  let output = '';
  const child = spawn(process.execPath, [wrangler, 'deploy', '--env', selected.environment, ...(!policy.preserve ? ['--secrets-file', secretsFile] : [])], {
    cwd: root, env: process.env, stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true,
  });
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    output += chunk.toString();
  });
  const exit = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code));
  });
  if (exit !== 0) throw new Error('Wrangler deployment failed with exit code ' + exit);
  const published = output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/g) || [];
  if (!published.includes(selected.desktopOrigin)) throw new Error('Published Worker origin does not match preflight; the blog entrance was not changed.');
  const url = selected.desktopOrigin + '/';
  await verifyDeployment(url, generated.manifest);
  await publishVerifiedRelease(generated, selected, { directory: resolve(root, '.private/releases'), publishEntrance, versionId: output.match(/Current Version ID:\s*([0-9a-f-]{36})/i)?.[1] });
  console.log('Verified ' + url + (selected.publishEntrance ? ' and updated the paired production entrance.' : '; isolated expert release recorded privately. Production entrance and saves were not changed.'));
} finally {
  if (wroteSecrets) await rm(secretsFile, { force: true });
}
