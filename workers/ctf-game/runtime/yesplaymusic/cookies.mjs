const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE_VALUE = /^[\x21-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

export function storeCookies(storage, records, now = Date.now()) {
  if (typeof records !== 'string' || records.length > 32768) return;
  for (const record of records.split(';;')) {
    if (/[\r\n\0]/.test(record)) continue;
    const parts = record.split(';');
    const pair = parts.shift().trim();
    const equals = pair.indexOf('=');
    if (equals < 1) continue;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) continue;
    let expired = false;
    let maxAge;
    for (const part of parts) {
      const separator = part.indexOf('=');
      const attribute = (separator < 0 ? part : part.slice(0, separator)).trim().toLowerCase();
      const parameter = separator < 0 ? '' : part.slice(separator + 1).trim();
      if (attribute === 'max-age' && /^-?\d+$/.test(parameter)) maxAge = Number(parameter);
      if (attribute === 'expires') {
        const date = Date.parse(parameter);
        if (Number.isFinite(date) && date <= now) expired = true;
      }
    }
    if (maxAge !== undefined) expired = maxAge <= 0;
    if (!value || expired) storage.removeItem('cookie-' + name);
    else storage.setItem('cookie-' + name, value);
  }
}

export function getStoredCookie(storage, name) {
  if (!COOKIE_NAME.test(name)) return undefined;
  const value = storage.getItem('cookie-' + name);
  return value && COOKIE_VALUE.test(value) ? value : undefined;
}

export function cookieHeader(storage) {
  const pairs = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key || !key.startsWith('cookie-')) continue;
    const name = key.slice(7);
    const value = getStoredCookie(storage, name);
    if (value !== undefined) pairs.push(name + '=' + value);
  }
  return pairs.join('; ');
}
