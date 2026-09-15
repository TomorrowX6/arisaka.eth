const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function verifyDeployment(url, manifest, { request = fetch, wait = pause, attempts = 3 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await request(new URL('api/health', url), {
        cache: 'no-store', signal: AbortSignal.timeout(15_000),
      });
      const health = await response.json();
      if (response.ok && health?.ok === true && health.edition === manifest.version
        && health.cases === manifest.digests.length) return;
    } catch { /* Allow the new deployment to reach the edge. */ }
    if (attempt + 1 < attempts) await wait(1500);
  }
  throw new Error('Deployment health check failed; the blog entrance was not changed.');
}
