import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export function deploymentArguments(args, { runtimeOnly = false } = {}) {
  let target = 'production', bootstrap = false, selected = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && !selected && ['production', 'expert'].includes(args[i + 1])) { target = args[++i]; selected = true; }
    else if (args[i] === '--bootstrap' && !bootstrap && !runtimeOnly) bootstrap = true;
    else throw Error('Usage: --target production|expert' + (runtimeOnly ? '' : ' [--bootstrap]') + '. Local and arbitrary environments cannot be deployed by this script.');
  }
  return { target, bootstrap };
}

export function deploymentTarget(target, desktopConfig, runtimeConfig) {
  if (!['production', 'expert'].includes(target)) throw Error('Unknown deployment target.');
  const environment = target === 'production' ? '' : 'expert';
  const select = config => {
    if (!environment) return config;
    const override = config.env?.[environment];
    if (!override?.name || !override.vars || override.name === config.name) throw Error('The expert target requires an explicit, separate Worker name and vars.');
    return { ...config, ...override };
  };
  const desktop = select(desktopConfig), runtime = select(runtimeConfig);
  if (desktop.account_id !== runtime.account_id || !/^[a-f0-9]{32}$/.test(desktop.account_id || '')) throw Error('Both Workers must use the same explicitly configured account.');
  if (desktop.account_id !== desktopConfig.account_id || runtime.account_id !== runtimeConfig.account_id) throw Error('Named targets cannot silently change the configured account.');
  for (const name of [desktop.name, runtime.name]) if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw Error('Invalid Worker name.');
  const parent = new URL(runtime.vars.DESKTOP_ORIGIN), assets = new URL(desktop.vars.DESKTOP_APPS_ORIGIN);
  const suffix = assets.hostname.slice(runtime.name.length + 1);
  if (assets.protocol !== 'https:' || assets.port || assets.href !== assets.origin + '/' || desktop.vars.DESKTOP_APPS_ORIGIN !== assets.origin
    || assets.hostname !== runtime.name + '.' + suffix || !/^[a-z0-9-]+\.workers\.dev$/.test(suffix)) throw Error('Desktop asset origin does not match the selected runtime Worker.');
  const desktopOrigin = 'https://' + desktop.name + '.' + suffix;
  if (runtime.vars.DESKTOP_ORIGIN !== desktopOrigin || parent.href !== desktopOrigin + '/' || desktop.name === runtime.name) throw Error('Runtime frame policy does not match the selected desktop Worker.');
  if (environment && (assets.origin === desktopConfig.vars.DESKTOP_APPS_ORIGIN || desktopOrigin === runtimeConfig.vars.DESKTOP_ORIGIN)) throw Error('Expert and production origins must be distinct.');
  if (!desktop.durable_objects?.bindings?.some(item => item.name === 'GAME_SESSIONS' && item.class_name === 'GameSession')
    || !desktop.durable_objects?.bindings?.some(item => item.name === 'DESKTOP_PROFILES' && item.class_name === 'DesktopProfiles')
    || desktop.durable_objects.bindings.some(item => item.script_name || item.environment)) throw Error('The desktop target must own its game and profile Durable Objects, not bind to another Worker.');
  return { target, environment, desktopName: desktop.name, runtimeName: runtime.name, desktopOrigin, assetsOrigin: assets.origin, publishEntrance: !environment };
}

// The isolated release gets its own private entrance record, not the blog's
// paired production files. Call only after both deployments pass health checks.
export async function publishVerifiedRelease(generated, selected, { directory, publishEntrance, versionId } = {}) {
  if (!['production', 'expert'].includes(selected.target) || selected.publishEntrance !== (selected.target === 'production')) throw Error('Invalid release publication policy.');
  if (!directory) throw Error('A private release directory is required.');
  if (selected.publishEntrance) {
    if (typeof publishEntrance !== 'function') throw Error('Production publication requires the paired-entrance publisher.');
    await publishEntrance(generated, selected.desktopOrigin + '/');
  }
  const record = { target: selected.target, url: selected.desktopOrigin + '/', entrance: generated.answers.entryToken,
    edition: generated.manifest.version, cases: generated.manifest.digests.length, assetsOrigin: selected.assetsOrigin,
    ...(versionId ? { versionId } : {}), verifiedAt: new Date().toISOString() };
  const folder = resolve(directory, selected.target), path = resolve(folder, 'release.json'), temporary = path + '.' + randomUUID() + '.tmp';
  await mkdir(folder, { recursive: true, mode: 0o700 });
  let created = false;
  try { await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); created = true; await rename(temporary, path); }
  finally { if (created) await rm(temporary, { force: true }); }
  return record;
}
