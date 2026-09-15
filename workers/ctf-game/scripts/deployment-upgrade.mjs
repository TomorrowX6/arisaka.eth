const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Fail before either Worker is changed. A successful upload is not a safe
// upgrade if the local random seed belongs to a different set of player saves.
export async function inspectUpgrade(origin, manifest, { request = fetch, wait = pause, bootstrap = false, attempts = 3 } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin + '/' !== url.href || url.username || url.password) throw Error('Deployment preflight requires an HTTPS origin.');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw Error('Invalid deployment preflight retry count.');
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response, health;
    try {
      response = await request(new URL('/api/health', url), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (bootstrap && response.status === 404) return { installed: false };
      if (response.ok) health = await response.json();
    } catch { /* A transient network failure is not evidence of a new Worker. */ }
    if (health?.ok === true && /^[0-9a-f]{16}$/.test(health.edition) && Number.isSafeInteger(health.cases) && health.cases > 0) {
      const same = health.edition === manifest.version && health.cases === manifest.digests.length;
      const compatible = health.cases < manifest.digests.length && manifest.compatibleEditions?.some(item => item.version === health.edition && item.cases === health.cases);
      if (!same && !compatible) throw Error('Refusing to replace an incompatible live edition (' + health.edition + ', ' + health.cases + ' cases). Supply the original CTF_BUILD_SEED; preflight did not authorize a desktop upload or blog-entrance update.');
      return { installed: true, edition: health.edition, cases: health.cases };
    }
    if (attempt + 1 < attempts) await wait(1500);
  }
  throw Error('Cannot verify the live campaign before deployment. Preflight did not authorize a desktop upload or blog-entrance update. For a genuinely new Worker only, use --bootstrap.');
}

export function upgradeSecretPolicy(state, suppliedSecret) {
  // SESSION_SECRET is also the anonymous profile/cookie identity and proof key.
  // Never rotate it just because this checkout does not have a private copy.
  if (state.installed) return { preserve: true };
  if (typeof suppliedSecret !== 'string' || suppliedSecret.length < 32) throw Error('A new Worker requires a SESSION_SECRET of at least 32 characters.');
  return { preserve: false, secret: suppliedSecret };
}

export function assertUnchangedDeployment(before, after) {
  if (before.installed !== after.installed || before.edition !== after.edition || before.cases !== after.cases) {
    throw Error('The live campaign changed during runtime preparation; the desktop was not replaced. Re-run preflight before deploying.');
  }
}
