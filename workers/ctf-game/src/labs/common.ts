export class LabError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type Reward = { code: string; receipt?: string };
export const encode = new TextEncoder();
export const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function hex(value: unknown, maximum = 4096): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length % 2 || value.length > maximum * 2 || !/^[0-9a-f]*$/i.test(value)) {
    throw new LabError(400, "字段格式无效");
  }
  return Uint8Array.from(value.match(/../g) || [], pair => parseInt(pair, 16));
}
export const toHex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
export const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
export const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const aesKeys = new Map<string, Promise<CryptoKey>>();
export function aesKey(material: string, algorithm: "AES-CBC" | "AES-GCM") {
  const id = algorithm + ":" + material;
  if (!aesKeys.has(id)) aesKeys.set(id, crypto.subtle.importKey("raw", hex(material, 32), algorithm, false, ["encrypt", "decrypt"]));
  return aesKeys.get(id)!;
}
