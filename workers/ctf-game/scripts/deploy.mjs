import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build, publishEntrance, root } from './build-challenges.mjs';
import { verifyDeployment } from './deployment-health.mjs';
import { deployRuntimes } from './deploy-runtimes.mjs';
import { inspectUpgrade, upgradeSecretPolicy, assertUnchangedDeployment } from './deployment-upgrade.mjs';

const require = createRequire(import.meta.url);
if (process.env.CI && !process.env.CTF_BUILD_SEED) throw new Error('CI deployments require the original CTF_BUILD_SEED.');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--bootstrap')) throw new Error('Only --bootstrap is supported (for a genuinely new Worker).');
const bootstrap = args.includes('--bootstrap');

// A failed upload or health check must not point the blog at an unpublished edition.
const generated = await build({ syncEntrance: false });
const runtime = JSON.parse(await readFile(resolve(root, 'runtime/wrangler.jsonc'), 'utf8'));
const target = runtime.vars.DESKTOP_ORIGIN;
const before = await inspectUpgrade(target, generated.manifest, { bootstrap });
const secretPath = resolve(root, '.private', 'session-secret');
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
await deployRuntimes();
assertUnchangedDeployment(before, await inspectUpgrade(target, generated.manifest, { bootstrap }));
const secretsFile = resolve(root, '.private', 'deploy-secrets.json');
let wroteSecrets = false;

try {
  if (!policy.preserve) {
    await writeFile(secretsFile, JSON.stringify({ SESSION_SECRET: policy.secret }), { flag: 'wx', mode: 0o600 });
    wroteSecrets = true;
  }
  else console.log('Preserving the existing Worker SESSION_SECRET, cookies and completion proofs.');
  const wrangler = resolve(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
  let output = '';
  const child = spawn(process.execPath, [wrangler, 'deploy', '--env', '', ...(!policy.preserve ? ['--secrets-file', secretsFile] : [])], {
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
  const match = output.match(/https:\/\/arisaka-afterglow\.[a-z0-9-]+\.workers\.dev\b/);
  if (!match) throw new Error('Deployment succeeded but its workers.dev URL was not found in Wrangler output.');
  const url = match[0] + '/';
  if (new URL(url).origin !== target) throw new Error('Published Worker origin does not match preflight; the blog entrance was not changed.');
  await verifyDeployment(url, generated.manifest);
  await publishEntrance(generated, url);
  console.log('Verified ' + url + ' and updated src/data/ctf-deployment.json.');
} finally {
  if (wroteSecrets) await rm(secretsFile, { force: true });
}
