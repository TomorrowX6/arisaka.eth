import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unstable_dev } from 'wrangler';
import { build, root } from './build-challenges.mjs';
import { verifyDeployment } from './deployment-health.mjs';

const files = process.argv.slice(2);
if (!files.length) files.push('test/browser.test.mjs', 'test/campaign.test.mjs');
let worker, tests, interrupted;
const interrupt = signal => {
  interrupted = signal;
  tests?.kill(signal);
};
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);

try {
  let url = process.env.CTF_E2E_URL;
  let manifest;
  if (url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('CTF_E2E_URL must be a Worker origin.');
    url = parsed.origin;
    manifest = JSON.parse(await readFile(resolve(root, 'src/generated/manifest.json'), 'utf8'));
  } else {
    // Keep development saves and the committed blog entrance untouched.
    ({ manifest } = await build({ syncEntrance: false }));
    worker = await unstable_dev(resolve(root, 'src/index.ts'), {
      config: resolve(root, 'wrangler.jsonc'), env: 'local',
      ip: '127.0.0.1', port: 0, inspectorPort: 0, local: true, persist: false,
      vars: { SESSION_SECRET: randomBytes(48).toString('hex') },
      logLevel: 'error',
      experimental: {
        forceLocal: true, watch: false, disableDevRegistry: true,
        disableExperimentalWarning: true, showInteractiveDevSession: false,
      },
    });
    url = 'http://' + worker.address + ':' + worker.port;
  }
  await verifyDeployment(url + '/', manifest);
  if (interrupted) throw new Error('Browser tests interrupted');
  console.log('Testing ' + manifest.digests.length + ' cases against an edition-verified Worker.');
  tests = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root, env: { ...process.env, CTF_E2E_URL: url }, stdio: 'inherit', windowsHide: true,
  });
  const code = await new Promise((resolveExit, reject) => {
    tests.once('error', reject);
    tests.once('exit', code => resolveExit(code));
  });
  process.exitCode = code ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await worker?.stop();
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
  if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
}
