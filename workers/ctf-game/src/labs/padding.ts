import { aesKey, concat, crc32, encode, hex, LabError, random, same, sha256, toHex, type Reward } from "./common";

export type PaddingConfig = { kind: "padding"; key: string; reward: Reward };
export type PaddingState = { nonce: string; created: number };
export const createPaddingState = (): PaddingState => ({ nonce: toHex(random(16)), created: Date.now() });
const purpose = new Uint8Array(16); purpose.set(encode.encode("archive/release"));

export async function runPadding(config: PaddingConfig, state: PaddingState, action: string, data: Record<string, unknown>) {
  const key = await aesKey(config.key, "AES-CBC");
  async function decrypt(token: unknown) {
    const bytes = hex(token, 2048);
    if (bytes.length < 32 || bytes.length % 16) return null;
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: bytes.slice(0, 16) }, key, bytes.slice(16))); }
    catch { return null; }
  }
  if (action === "inspect") {
    const record = new Uint8Array(64), view = new DataView(record.buffer);
    record.set(encode.encode("RBK3")); record.set(hex(state.nonce), 4);
    view.setBigUint64(20, BigInt(state.created), true); view.setUint32(28, 1000, true); view.setUint32(32, 1, true);
    record.set(encode.encode("archive/read"), 36);
    record.set((await sha256(encode.encode(state.nonce + "/padding"))).slice(0, 8), 56);
    view.setUint32(52, crc32(concat(record.slice(0, 52), record.slice(56))), true);
    const iv = (await sha256(encode.encode(state.nonce + "/iv"))).slice(0, 16);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, record));
    return { token: toHex(concat(iv, encrypted)), nonce: state.nonce, created: state.created };
  }
  if (action === "probe") {
    const tokens = data.tokens;
    if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 64) throw new LabError(400, "批次数量无效");
    // Intentional validation oracle, confined to synthetic backup tokens.
    const results = [];
    for (const token of tokens) results.push(await decrypt(token) !== null ? 422 : 400);
    return { results };
  }
  if (action === "redeem") {
    const record = await decrypt(data.token);
    if (!record) throw new LabError(400, "记录无效");
    if (record.length !== 64) throw new LabError(422, "记录无效");
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (!same(record.slice(0, 4), encode.encode("RBK3")) || !same(record.slice(4, 20), hex(state.nonce)) || view.getBigUint64(20, true) !== BigInt(state.created)
      || view.getUint32(52, true) !== crc32(concat(record.slice(0, 52), record.slice(56)))) throw new LabError(422, "记录无效");
    if (view.getUint32(28, true) !== 0 || view.getUint32(32, true) !== 0xffffffff || !same(record.slice(36, 52), purpose)) throw new LabError(403, "权限不足");
    return { ...config.reward };
  }
  throw new LabError(404, "不存在");
}
