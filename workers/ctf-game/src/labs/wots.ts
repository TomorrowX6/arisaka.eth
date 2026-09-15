import { concat, encode, hex, LabError, random, same, sha256, toHex, type Reward } from "./common";

export type WotsConfig = { kind: "wots"; seed: string; root: string; reward: Reward };
export type WotsState = { binding: string };
export const createWotsState = (): WotsState => ({ binding: toHex(random(16)) });
const integer = (value: number) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes; };
const hash = async (...parts: Uint8Array[]) => (await sha256(concat(...parts))).slice(0, 16);
const fixed = (value: unknown) => { const bytes = hex(value, 16); if (bytes.length !== 16) throw new LabError(400, "字段格式无效"); return bytes; };

export async function runWots(config: WotsConfig, state: WotsState, action: string, data: Record<string, unknown>) {
  if (action === "inspect") return { binding: state.binding };
  if (action !== "redeem") throw new LabError(404, "不存在");
  if (typeof data.nonce !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/.test(data.nonce) || Number(data.nonce) > 0xffffffff
    || typeof data.index !== "number" || !Number.isInteger(data.index) || data.index < 0 || data.index >= 64
    || !Array.isArray(data.chains) || data.chains.length !== 35 || !Array.isArray(data.authentication) || data.authentication.length !== 6) throw new LabError(400, "记录无效");
  const signature = data.chains.map(fixed), auth = data.authentication.map(fixed), seed = fixed(config.seed);
  const message = encode.encode("archive/release/" + state.binding + "/" + data.nonce);
  const values = [...await hash(message)].flatMap(byte => [byte >> 4, byte & 15]);
  const sum = values.reduce((total, value) => total + 15 - value, 0);
  values.push(sum >> 8, sum >> 4 & 15, sum & 15);
  const publicKey = [];
  for (let column = 0; column < 35; column++) {
    let value = signature[column];
    for (let step = values[column]; step < 15; step++) value = await hash(encode.encode("W0"), seed, integer(data.index), integer(column), integer(step), value);
    publicKey.push(value);
  }
  let root = await hash(encode.encode("WL"), ...publicKey);
  for (let height = 0; height < 6; height++) root = await hash(encode.encode("WT"), integer(height), ...(data.index >> height & 1 ? [auth[height], root] : [root, auth[height]]));
  if (!same(root, fixed(config.root))) throw new LabError(403, "签名无效");
  return { ...config.reward };
}
