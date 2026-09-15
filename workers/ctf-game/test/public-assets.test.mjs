import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inspectPublicDependencies, verifyPublicAssets } from '../scripts/public-assets.mjs';

test('every shipped desktop entry, first-party module and literal Worker dependency is explicitly published', async () => {
  const result = await verifyPublicAssets(fileURLToPath(new URL('..', import.meta.url)));
  assert.ok(result.sources > 40); assert.ok(result.dependencies > 100);
});

test('static dependency preflight catches forgotten assets before a blank desktop can be deployed', () => {
  const files = ['/index.html', '/app.js', '/worker.js', '/data.js', '/style.css'];
  const sources = new Map([
    ['/index.html', '<link rel="stylesheet" href="/style.css"><script type="module" src="/app.js"></script>'],
    ['/app.js', 'import { data } from "./data.js"; export { data } from "/data.js"; const lazy=()=>import(`/data.js`); new Worker(new URL("./worker.js",import.meta.url));'],
    ['/worker.js', 'import "./data.js";'], ['/data.js', 'export const data = 1;'],
  ]);
  assert.equal(inspectPublicDependencies(sources, files).dependencies, 7);
  assert.throws(() => inspectPublicDependencies(sources, files.filter(path => path !== '/data.js')), /Unpublished desktop dependency/);
  assert.throws(() => inspectPublicDependencies(new Map([['/app.js', 'new SharedWorker("/missing.js")']]), files), /missing.js/);
  assert.throws(() => inspectPublicDependencies(new Map([['/app.js', 'import "https://external.example/script.js"']]), files), /Unpublished/);
  for (const path of ['/scripts/expert/radio-decoder.mjs', '/src/generated/manifest.json', '/test/campaign.test.mjs', '/.private/build-seed', '/../secret', '//external']) assert.throws(() => inspectPublicDependencies(new Map(), [...files, path]), /Unsafe/);
  assert.throws(() => inspectPublicDependencies(new Map(), [...files, '/app.js']), /duplicate/);
});
