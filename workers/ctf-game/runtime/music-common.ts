export type MusicParams = Record<string, unknown>;

export class MusicApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function isRecord(value: unknown): value is MusicParams {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function checkFields(params: MusicParams, fields: readonly string[]): void {
  for (const key of Object.keys(params)) {
    if (!fields.includes(key)) throw new MusicApiError(400, `Unsupported parameter: ${key.slice(0, 60)}.`);
  }
}

export function textParam(params: MusicParams, key: string, fallback?: string, maximum = 2048): string {
  const value = params[key] ?? fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length > maximum || !String(value).length) {
    throw new MusicApiError(400, `Invalid ${key} parameter.`);
  }
  return String(value);
}

export function numberParam(params: MusicParams, key: string, fallback: number, minimum = 0, maximum = 1_000_000): number {
  const input = params[key] ?? fallback;
  if ((typeof input !== 'number' && typeof input !== 'string') || !/^[-]?\d+$/.test(String(input))) {
    throw new MusicApiError(400, `Invalid ${key} parameter.`);
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new MusicApiError(400, `Invalid ${key} parameter.`);
  return value;
}

export function idParam(params: MusicParams, key: string, fallback?: string): string {
  const value = textParam(params, key, fallback, 20);
  if (!/^\d{1,20}$/.test(value) || (typeof params[key] === 'number' && !Number.isSafeInteger(params[key]))) {
    throw new MusicApiError(400, `Invalid ${key} parameter.`);
  }
  return value.replace(/^0+(?=\d)/, '');
}

export function idsParam(params: MusicParams, key: string): string[] {
  const input = params[key];
  const values: unknown[] = Array.isArray(input) ? input : textParam(params, key, undefined, 24_000).split(',');
  if (!values.length || values.length > 1000) throw new MusicApiError(400, `${key} must contain between 1 and 1000 IDs.`);
  return values.map(value => idParam({ [key]: typeof value === 'string' ? value.trim() : value }, key));
}

export function booleanParam(params: MusicParams, key: string, fallback: boolean): boolean {
  const value = params[key] ?? fallback;
  if ([true, 'true', 1, '1'].includes(value as string | number | boolean)) return true;
  if ([false, 'false', 0, '0'].includes(value as string | number | boolean)) return false;
  throw new MusicApiError(400, `Invalid ${key} parameter.`);
}

export function choiceParam(params: MusicParams, key: string, choices: readonly string[], fallback?: string): string {
  const value = textParam(params, key, fallback, 64);
  if (!choices.includes(value)) throw new MusicApiError(400, `Invalid ${key} parameter.`);
  return value;
}

export function nestedParams(value: unknown): MusicParams {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new MusicApiError(400, 'Invalid data parameter.'); }
  }
  if (!isRecord(value)) throw new MusicApiError(400, 'Expected an object parameter.');
  return value;
}

/** Bounds the decompressed stream, including when Content-Length is absent or misleading. */
export async function readMusicBody(body: ReadableStream<Uint8Array> | null, maximum: number, signal: AbortSignal, failureStatus: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  let rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new MusicApiError(504, 'NetEase request timed out.'));
  signal.addEventListener('abort', onAbort, { once: true });
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (signal.aborted) onAbort();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new MusicApiError(failureStatus, failureStatus === 413 ? 'Music API request is too large.' : 'NetEase response is too large.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
