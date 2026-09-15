import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeRoot } from './build-runtimes.mjs';
import { prepareRuntimes } from './prepare-runtimes.mjs';
import { verifyRuntimeDeployment, verifyMusicDeployment } from './runtime-deployment-health.mjs';
import { deploymentArguments, deploymentTarget } from './deployment-target.mjs';

const require = createRequire(import.meta.url);

export async function deployRuntimes({ target = 'production' } = {}) {
  const desktop = JSON.parse(await readFile(resolve(runtimeRoot, 'wrangler.jsonc'), 'utf8'));
  const runtime = JSON.parse(await readFile(resolve(runtimeRoot, 'runtime/wrangler.jsonc'), 'utf8'));
  const selected = deploymentTarget(target, desktop, runtime), origin = new URL(selected.assetsOrigin), desktopOrigin = selected.desktopOrigin;
  const manifests = await prepareRuntimes();
  const wrangler = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  let output = '';
  const child = spawn(process.execPath, [wrangler, 'deploy', '--config', 'runtime/wrangler.jsonc', '--env', selected.environment], {
    cwd: runtimeRoot, env: process.env, stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true,
  });
  child.stdout.on('data', chunk => { process.stdout.write(chunk); output += chunk.toString(); });
  const exit = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  if (exit !== 0) throw new Error('Runtime Wrangler deployment failed with exit code ' + exit);
  const published = output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/g) || [];
  if (!published.includes(origin.origin)) throw new Error('Runtime deployment did not publish the configured desktop application origin');
  await verifyRuntimeDeployment(origin.href, manifests.minecraft, { desktopOrigin });
  console.log('Verified Minecraft 1.12.2 u3 at ' + origin.origin + '/minecraft/1.12.2/');
  await verifyMusicDeployment(origin.href, manifests.yesplaymusic, { desktopOrigin });
  console.log('Verified YesPlayMusic 0.4.10 at ' + origin.origin + '/yesplaymusic/');
  return origin.origin;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await deployRuntimes(deploymentArguments(process.argv.slice(2), { runtimeOnly: true }));
