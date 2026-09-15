import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDeployment } from '../scripts/deployment-health.mjs';
import { publishEntrance } from '../scripts/build-challenges.mjs';
import widgets from '../src/case-catalog.json' with { type: 'json' };

const manifest = { version: '0123456789abcdef', digests: widgets.map(() => 'test-digest') };
const healthy = { ok: true, edition: manifest.version, cases: widgets.length };

test('deployment health follows the complete catalog rather than the old ten-case campaign', async () => {
  assert.equal(widgets.length, 29);
  await verifyDeployment('https://worker.example/', manifest, {
    request: async (url, options) => {
      assert.equal(url.href, 'https://worker.example/api/health');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(healthy);
    },
    wait: () => assert.fail('A healthy edition needs no retry'),
  });
});

test('deployment rejects stale, incomplete, unsuccessful, and malformed health responses', async () => {
  for (const response of [
    () => Response.json({ ...healthy, cases: 10 }),
    () => Response.json({ ...healthy, edition: 'old-edition' }),
    () => Response.json({ ...healthy, ok: false }),
    () => Response.json(healthy, { status: 503 }),
    () => Response.json(null),
    () => new Response('not JSON'),
    () => { throw new Error('offline'); },
  ]) {
    let calls = 0, waits = 0;
    await assert.rejects(verifyDeployment('https://worker.example/', manifest, {
      request: () => { calls++; return response(); },
      wait: async milliseconds => { assert.equal(milliseconds, 1500); waits++; },
    }), /blog entrance was not changed/);
    assert.equal(calls, 3);
    assert.equal(waits, 2);
  }
});

test('deployment waits for edge propagation before accepting the new edition', async () => {
  let calls = 0;
  await verifyDeployment('https://worker.example/', manifest, {
    request: async () => Response.json(++calls === 3 ? healthy : { ...healthy, edition: 'old' }),
    wait: async () => {},
  });
  assert.equal(calls, 3);
});

test('publishing keeps the encrypted terminal artifact and randomized gateway together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'afterglow-entrance-'));
  try {
    await mkdir(join(root, 'src/data'), { recursive: true });
    await mkdir(join(root, 'public/README'), { recursive: true });
    const config = join(root, 'src/data/ctf-deployment.json');
    await writeFile(config, JSON.stringify({ url: 'https://existing.example/', entrance: 'old' }));
    const generated = { terminalEnvelope: 'test-encrypted-envelope', answers: { entryToken: 'a'.repeat(20) } };
    await publishEntrance(generated, undefined, root);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { url: 'https://existing.example/', entrance: generated.answers.entryToken });
    assert.equal(await readFile(join(root, 'public/README/README.md'), 'utf8'), generated.terminalEnvelope + '\n');
    await publishEntrance(generated, 'https://published.example/', root);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).url, 'https://published.example/');
  } finally { await rm(root, { recursive: true, force: true }); }
});
