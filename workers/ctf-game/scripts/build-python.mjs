import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const selected = ['numpy', 'sympy', 'mpmath', 'pycryptodome'];
export async function buildPython(root, output) {
  const distribution = resolve(root, 'node_modules/pyodide');
  const { version } = JSON.parse(await readFile(resolve(distribution, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(distribution, 'pyodide-lock.json'), 'utf8'));
  const target = resolve(output, 'pyodide'), cache = resolve(root, '.private/python-cache');
  await mkdir(target, { recursive: true }); await mkdir(cache, { recursive: true });
  for (const name of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
    await writeFile(resolve(target, name), await readFile(resolve(distribution, name)));
  }
  const names = new Set();
  function visit(name) {
    if (names.has(name)) return;
    const item = lock.packages[name];
    if (!item || !/^[a-zA-Z0-9_.-]+\.whl$/.test(item.file_name) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Invalid Python package: ' + name);
    names.add(name); item.depends.forEach(visit);
  }
  selected.forEach(visit);
  for (const name of names) {
    const item = lock.packages[name], cached = resolve(cache, item.sha256);
    let bytes;
    try { bytes = await readFile(cached); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const digest = data => createHash('sha256').update(data).digest('hex');
    if (!bytes || digest(bytes) !== item.sha256) {
      const url = 'https://cdn.jsdelivr.net/pyodide/v' + version + '/full/' + item.file_name;
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw Error('Python package download failed: ' + name + ' (' + response.status + ')');
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 25 * 1024 * 1024 || digest(bytes) !== item.sha256) throw Error('Python package integrity failed: ' + name);
      await writeFile(cached, bytes);
    }
    await writeFile(resolve(target, item.file_name), bytes);
  }
  await writeFile(resolve(target, 'LICENSE.txt'), await readFile(resolve(root, 'ui/licenses/pyodide.txt')));
}
