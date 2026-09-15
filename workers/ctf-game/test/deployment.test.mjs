import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDeployment } from '../scripts/deployment-health.mjs';
import { inspectUpgrade, upgradeSecretPolicy, assertUnchangedDeployment } from '../scripts/deployment-upgrade.mjs';
import { publishEntrance } from '../scripts/build-challenges.mjs';
import widgets from '../src/case-catalog.json' with { type: 'json' };

const manifest = { version: '0123456789abcdef', digests: widgets.map(() => 'test-digest') };
const healthy = { ok: true, edition: manifest.version, cases: widgets.length };

test('deployment health follows the complete catalog rather than the old ten-case campaign', async () => {
  assert.equal(widgets.length, 32);
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

test('upgrade preflight accepts only an exact current or explicitly compatible live edition', async () => {
  const candidate = { ...manifest, compatibleEditions: [{ version: 'fedcba9876543210', cases: 26 }] };
  for (const health of [healthy, { ok: true, edition: 'fedcba9876543210', cases: 26 }]) {
    const state = await inspectUpgrade('https://worker.example', candidate, { request: async (url, options) => {
      assert.equal(url.href, 'https://worker.example/api/health'); assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store'); assert.ok(options.signal instanceof AbortSignal); return Response.json(health);
    } });
    assert.deepEqual(state, { installed: true, edition: health.edition, cases: health.cases });
  }
  for (const health of [{ ...healthy, edition: 'eeeeeeeeeeeeeeee' }, { ...healthy, cases: 26 },
    { ok: true, edition: 'fedcba9876543210', cases: 25 }, { ...healthy, cases: 999 }]) {
    // --bootstrap is not a bypass for a different existing campaign.
    await assert.rejects(inspectUpgrade('https://worker.example', candidate, { bootstrap: true, request: async () => Response.json(health) }), /incompatible live edition/);
  }
});

test('preflight fails closed on network, HTTP and schema errors; first deployment must be explicit', async () => {
  for (const request of [async () => { throw Error('offline'); }, async () => new Response('not-json'), async () => Response.json(null),
    async () => Response.json({ ...healthy, ok: false }), async () => Response.json({ ...healthy, cases: '32' }),
    async () => new Response('', { status: 503 }), async () => new Response('', { status: 404 })]) {
    let waits = 0;
    await assert.rejects(inspectUpgrade('https://worker.example', manifest, { request, wait: async n => { assert.equal(n, 1500); waits++; } }), /Cannot verify/);
    assert.equal(waits, 2);
  }
  assert.deepEqual(await inspectUpgrade('https://worker.example', manifest, { bootstrap: true, request: async () => new Response('', { status: 404 }) }), { installed: false });
  for (const url of ['http://worker.example', 'https://worker.example/path', 'https://a:b@worker.example', 'https://worker.example?x=1', 'https://worker.example#x']) {
    await assert.rejects(inspectUpgrade(url, manifest, { request: () => assert.fail('invalid origins must not make requests') }), /HTTPS origin/);
  }
});

test('existing deployments never upload a replacement identity secret; new deployments require one', () => {
  for (const value of [undefined, '', 'short', 'unrelated-local-value'.repeat(4)]) assert.deepEqual(upgradeSecretPolicy({ installed: true }, value), { preserve: true });
  for (const value of [undefined, '', 'short']) assert.throws(() => upgradeSecretPolicy({ installed: false }, value), /new Worker requires/);
  assert.deepEqual(upgradeSecretPolicy({ installed: false }, 'x'.repeat(32)), { preserve: false, secret: 'x'.repeat(32) });
  const before = { installed: true, edition: manifest.version, cases: widgets.length };
  assertUnchangedDeployment(before, { ...before });
  for (const after of [{ installed: false }, { ...before, cases: 10 }, { ...before, edition: 'fedcba9876543210' }]) assert.throws(() => assertUnchangedDeployment(before, after), /changed during runtime/);
});
