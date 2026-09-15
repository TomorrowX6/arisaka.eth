import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploymentArguments, deploymentTarget, publishVerifiedRelease } from '../scripts/deployment-target.mjs';

const desktop = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const runtime = JSON.parse(await readFile(new URL('../runtime/wrangler.jsonc', import.meta.url), 'utf8'));

test('deployment targets use distinct Worker names, matching frame policies and their own Durable Objects', () => {
  const production = deploymentTarget('production', desktop, runtime), expert = deploymentTarget('expert', desktop, runtime);
  assert.equal(production.desktopOrigin, 'https://arisaka-afterglow.454565615.workers.dev');
  assert.equal(production.environment, ''); assert.equal(production.publishEntrance, true);
  assert.equal(expert.desktopOrigin, 'https://arisaka-afterglow-expert.454565615.workers.dev');
  assert.equal(expert.assetsOrigin, 'https://arisaka-desktop-apps-expert.454565615.workers.dev');
  assert.equal(expert.environment, 'expert'); assert.equal(expert.publishEntrance, false);
  for (const property of ['desktopName', 'runtimeName', 'desktopOrigin', 'assetsOrigin']) assert.notEqual(expert[property], production[property]);
  assert.equal(desktop.name, 'arisaka-afterglow'); assert.equal(runtime.name, 'arisaka-desktop-apps');
});

test('deployment target selection rejects partial, cross-account, cross-origin and shared-state overrides', () => {
  const mutations = [
    d => delete d.env.expert,
    d => d.env.expert.name = d.name,
    d => delete d.env.expert.vars,
    d => d.env.expert.vars.DESKTOP_APPS_ORIGIN = d.vars.DESKTOP_APPS_ORIGIN,
    d => d.env.expert.vars.DESKTOP_APPS_ORIGIN += '/path',
    d => d.env.expert.vars.DESKTOP_APPS_ORIGIN += ':8443',
    d => d.env.expert.account_id = 'a'.repeat(32),
    d => d.env.expert.durable_objects.bindings[0].script_name = d.name,
    d => d.env.expert.durable_objects.bindings[0].environment = 'production',
    d => d.env.expert.durable_objects.bindings = [],
    (_d, r) => r.env.expert.vars.DESKTOP_ORIGIN = r.vars.DESKTOP_ORIGIN,
    (_d, r) => r.env.expert.vars.DESKTOP_ORIGIN += '#other',
    (_d, r) => r.account_id = 'a'.repeat(32),
  ];
  for (const mutate of mutations) { const d = structuredClone(desktop), r = structuredClone(runtime); mutate(d, r); assert.throws(() => deploymentTarget('expert', d, r)); }
  for (const name of ['local', '', '../production', 'preview', undefined]) assert.throws(() => deploymentTarget(name, desktop, runtime), /Unknown deployment target/);
});

test('deployment CLI is explicit and never forwards arbitrary environments or unknown arguments', () => {
  assert.deepEqual(deploymentArguments([]), { target: 'production', bootstrap: false });
  assert.deepEqual(deploymentArguments(['--bootstrap', '--target', 'expert']), { target: 'expert', bootstrap: true });
  assert.deepEqual(deploymentArguments(['--target', 'expert'], { runtimeOnly: true }), { target: 'expert', bootstrap: false });
  for (const args of [['--env', 'local'], ['--target'], ['--target', 'local'], ['--target=expert'], ['--target', 'expert', '--target', 'production'], ['--bootstrap', '--bootstrap'], ['--dry-run']]) {
    assert.throws(() => deploymentArguments(args), /Usage/);
  }
  assert.throws(() => deploymentArguments(['--bootstrap'], { runtimeOnly: true }), /Usage/);
});

test('an isolated verified release never calls the production entrance publisher and stores only its own record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ctf-release-'));
  const generated = { answers: { entryToken: 'fixture-entry' }, manifest: { version: '0123456789abcdef', digests: ['one', 'two'] } };
  try {
    const expert = deploymentTarget('expert', desktop, runtime);
    const record = await publishVerifiedRelease(generated, expert, { directory, publishEntrance: () => assert.fail('The production blog must not be touched'), versionId: 'fixture-version' });
    assert.equal(record.cases, 2); assert.equal(record.edition, generated.manifest.version); assert.equal(record.entrance, 'fixture-entry');
    assert.equal(record.versionId, 'fixture-version'); assert.equal(record.url, expert.desktopOrigin + '/');
    assert.deepEqual(await readdir(directory), ['expert']); assert.deepEqual(await readdir(join(directory, 'expert')), ['release.json']);
    const path = join(directory, 'expert/release.json'); assert.deepEqual(JSON.parse(await readFile(path)), record);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    let published = 0;
    const production = deploymentTarget('production', desktop, runtime);
    await publishVerifiedRelease(generated, production, { directory, publishEntrance: async (value, origin) => { assert.equal(value, generated); assert.equal(origin, production.desktopOrigin + '/'); published++; } });
    assert.equal(published, 1); assert.deepEqual((await readdir(directory)).sort(), ['expert', 'production']);
    await assert.rejects(publishVerifiedRelease(generated, { ...expert, publishEntrance: true }, { directory }), /publication policy/);
    await assert.rejects(publishVerifiedRelease(generated, production, { directory }), /paired-entrance publisher/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
