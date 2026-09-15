import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runtimeRoot } from './build-runtimes.mjs';

const require = createRequire(import.meta.url);
const wrangler = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
await promisify(execFile)(process.execPath, [wrangler, 'types', '--config', 'runtime/wrangler.jsonc', '--env-interface', 'RuntimeEnv',
  '--include-runtime=false', '--strict-vars=false', 'runtime/worker-configuration.d.ts'], { cwd: runtimeRoot, windowsHide: true });
// Keep the second Worker's generated Cloudflare namespace local to its module.
await appendFile(resolve(runtimeRoot, 'runtime/worker-configuration.d.ts'), '\nexport type { RuntimeEnv };\n');
console.log('Generated runtime Worker bindings.');
