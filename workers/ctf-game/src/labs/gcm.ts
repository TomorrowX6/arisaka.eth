import { aesKey, decode, encode, hex, LabError, random, toHex, type Reward } from "./common";

export type GcmConfig = { kind: "gcm"; key: string; nonce: string; reward: Reward };
export type GcmState = { binding: string };
export const createGcmState = (): GcmState => ({ binding: toHex(random(16)) });

export async function runGcm(config: GcmConfig, state: GcmState, action: string, data: Record<string, unknown>) {
  if (action === "inspect") return { binding: state.binding, nonce: config.nonce, context: "archive/access/v3" };
  if (action !== "redeem") throw new LabError(404, "不存在");
  const sealed = hex(data.token, 256);
  if (sealed.length < 16) throw new LabError(400, "记录无效");
  let payload: unknown;
  try {
    const key = await aesKey(config.key, "AES-GCM");
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hex(config.nonce), additionalData: encode.encode("archive/access/v3"), tagLength: 128 }, key, sealed);
    payload = JSON.parse(decode.decode(clear));
  } catch { throw new LabError(403, "认证失败"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new LabError(422, "记录无效");
  const token = payload as Record<string, unknown>;
  if (token.uid !== 0 || token.scope !== "release" || token.binding !== state.binding) throw new LabError(403, "权限不足");
  return { ...config.reward };
}
