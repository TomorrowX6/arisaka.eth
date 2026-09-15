import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unstable_dev } from 'wrangler';
import { build, root } from './build-challenges.mjs';
import { prepareRuntimes } from './prepare-runtimes.mjs';
import { verifyDeployment } from './deployment-health.mjs';

let desktop, runtime, tests;
const stop = signal => tests?.kill(signal);
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  let url = process.env.CTF_E2E_URL;
  let manifest;
  if (url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin + '/' !== parsed.href || parsed.username || parsed.password) throw new Error('CTF_E2E_URL must be a Worker origin');
    url = parsed.origin;
    manifest = JSON.parse(await readFile(resolve(root, 'src/generated/manifest.json'), 'utf8'));
  } else {
    ({ manifest } = await build({ syncEntrance: false }));
    await prepareRuntimes();
    const options = { env: 'local', ip: '127.0.0.1', port: 0, inspectorPort: 0, local: true, persist: false, logLevel: 'error',
      experimental: { forceLocal: true, watch: false, disableDevRegistry: true, disableExperimentalWarning: true, showInteractiveDevSession: false } };
    runtime = await unstable_dev(resolve(root, 'runtime/worker.ts'), { ...options, config: resolve(root, 'runtime/wrangler.jsonc') });
    desktop = await unstable_dev(resolve(root, 'src/index.ts'), { ...options, config: resolve(root, 'wrangler.jsonc'),
      vars: { SESSION_SECRET: randomBytes(48).toString('hex'), DESKTOP_APPS_ORIGIN: 'http://' + runtime.address + ':' + runtime.port } });
    url = 'http://' + desktop.address + ':' + desktop.port;
  }
  await verifyDeployment(url + '/', manifest);
  const args = process.argv.slice(2);
  if (!args.some(arg => arg.endsWith('.mjs'))) args.push('test/runtime-engines.browser.test.mjs');
  tests = spawn(process.execPath, ['--test', '--test-concurrency=1', ...args], {
    cwd: root, env: { ...process.env, CTF_E2E_URL: url }, stdio: 'inherit', windowsHide: true,
  });
  process.exitCode = await new Promise((resolveExit, reject) => { tests.once('error', reject); tests.once('exit', code => resolveExit(code ?? 1)); });
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await desktop?.stop(); await runtime?.stop(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
