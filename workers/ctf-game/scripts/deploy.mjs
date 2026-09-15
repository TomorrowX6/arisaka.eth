import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build, publishEntrance, root } from './build-challenges.mjs';
import { verifyDeployment } from './deployment-health.mjs';
import { deployRuntimes } from './deploy-runtimes.mjs';

const require = createRequire(import.meta.url);
if (process.env.CI && (!process.env.CTF_BUILD_SEED || !process.env.CTF_SESSION_SECRET)) {
  throw new Error('CI deployments require CTF_BUILD_SEED and CTF_SESSION_SECRET.');
}

// A failed upload or health check must not point the blog at an unpublished edition.
const generated = await build({ syncEntrance: false });
const secretPath = resolve(root, '.private', 'session-secret');
let secret = process.env.CTF_SESSION_SECRET;
if (!secret) {
  try {
    secret = (await readFile(secretPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secret = randomBytes(48).toString('hex');
    await writeFile(secretPath, secret + '\n', { flag: 'wx', mode: 0o600 });
  }
}
if (secret.length < 32) throw new Error('CTF_SESSION_SECRET must contain at least 32 characters.');
// Publish and verify the game engines and music app before their desktop launchers.
await deployRuntimes();
const secretsFile = resolve(root, '.private', 'deploy-secrets.json');
await writeFile(secretsFile, JSON.stringify({ SESSION_SECRET: secret }), { mode: 0o600 });

try {
  const wrangler = resolve(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
  let output = '';
  const child = spawn(process.execPath, [wrangler, 'deploy', '--env', '', '--secrets-file', secretsFile], {
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
  await verifyDeployment(url, generated.manifest);
  await publishEntrance(generated, url);
  console.log('Verified ' + url + ' and updated src/data/ctf-deployment.json.');
} finally {
  await rm(secretsFile, { force: true });
}
