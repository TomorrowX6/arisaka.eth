import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPython } from './build-python.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildUI() {
  const output = resolve(root, 'public/vendor');
  await mkdir(output, { recursive: true });
  const result = await build({ entryPoints: [resolve(root, 'ui/editor-engine.js')], outfile: resolve(output, 'editor-engine.js'), bundle: true, format: 'esm', target: 'es2022', minify: true, legalComments: 'eof', metafile: true });
  const licenses = [];
  const seen = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes('node_modules')) continue;
    let directory = dirname(resolve(input));
    while (directory.includes('node_modules')) {
      try {
        const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
        if (!seen.has(pkg.name)) {
          let license;
          for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) {
            try { license = await readFile(resolve(directory, name), 'utf8'); break; } catch {}
          }
          if (!license) throw new Error('Missing license for ' + pkg.name);
          licenses.push(pkg.name + '\n\n' + license); seen.add(pkg.name);
        }
        break;
      } catch (error) { if (error.message.startsWith('Missing license')) throw error; }
      directory = dirname(directory);
    }
  }
  await writeFile(resolve(output, 'editor-engine.LICENSE.txt'), licenses.join('\n\n---\n\n'));
  await build({ entryPoints: [resolve(root, 'ui/codecs.js')], outfile: resolve(output, 'codecs.js'), bundle: true, format: 'esm', target: 'es2022', minify: true, legalComments: 'eof' });
  const codecRoot = resolve(root, 'node_modules/fflate');
  await writeFile(resolve(output, 'codecs.LICENSE.txt'), await readFile(resolve(codecRoot, 'LICENSE')));
  await build({ entryPoints: [resolve(root, 'ui/openpgp.js')], outfile: resolve(output, 'openpgp.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof' });
  await writeFile(resolve(output, 'openpgp.LICENSE.txt'), await readFile(resolve(root, 'node_modules/openpgp/LICENSE')));
  await build({ entryPoints: [resolve(root, 'ui/sqlite.js')], outfile: resolve(output, 'sqlite.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof', define: { 'process': 'undefined' } });
  await writeFile(resolve(output, 'sql-wasm.wasm'), await readFile(resolve(root, 'node_modules/sql.js/dist/sql-wasm.wasm')));
  await writeFile(resolve(output, 'sqlite.LICENSE.txt'), await readFile(resolve(root, 'node_modules/sql.js/LICENSE')));
  for (const name of ['pdf.mjs', 'pdf.worker.mjs']) await writeFile(resolve(output, name), await readFile(resolve(root, 'node_modules/pdfjs-dist/build', name)));
  await writeFile(resolve(output, 'pdf.LICENSE.txt'), await readFile(resolve(root, 'node_modules/pdfjs-dist/LICENSE')));
  await buildPython(root, output);
  for (const [source, target] of [['cmaps', 'pdf-cmaps'], ['standard_fonts', 'pdf-fonts'], ['wasm', 'pdf-wasm']]) {
    await mkdir(resolve(output, target), { recursive: true });
    for (const name of await readdir(resolve(root, 'node_modules/pdfjs-dist', source))) {
      await writeFile(resolve(output, target, name), await readFile(resolve(root, 'node_modules/pdfjs-dist', source, name)));
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildUI();
