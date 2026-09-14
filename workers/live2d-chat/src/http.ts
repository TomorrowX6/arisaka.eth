export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfter?: number,
  ) {
    super(code);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

// Limit bytes while streaming, including chunked bodies and upstream responses.
export async function readJson(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMs: number,
): Promise<unknown> {
  if (!body) throw new HttpError(400, "invalid_json");
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new HttpError(413, "body_too_large");
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
        } catch {
          throw new HttpError(400, "invalid_json");
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HttpError(408, "request_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // Cancellation can reject if the upstream signal has already aborted.
    void reader.cancel().catch(() => {});
  }
}
