import { profileKey } from '/preferences.js';

export function apiFetch(input, options = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.origin);
  const headers = new Headers(options.headers);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) headers.set('X-Desktop-Profile', profileKey());
  return fetch(input, { ...options, headers });
}
