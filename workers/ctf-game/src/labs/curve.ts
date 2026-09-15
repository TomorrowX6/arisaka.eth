import { concat, encode, hex, LabError, random, same, sha256, toHex, type Reward } from "./common";

type Point = { x: bigint; y: bigint } | null;
type Curve = { p: string; a: string; b: string; order: string; g: { x: string; y: string } };
export type CurveConfig = { kind: "curve"; curve: Curve; reward: Reward };
export type CurveState = { scalar: string; binding: string };
const integer = (value: Uint8Array) => BigInt("0x" + toHex(value));
const bytes = (value: bigint) => hex(value.toString(16).padStart(32, "0"), 16);

export const createCurveState = (config: CurveConfig): CurveState => ({
  scalar: (integer(random(16)) % (BigInt(config.curve.order) - 1n) + 1n).toString(), binding: toHex(random(16)),
});

function arithmetic(curve: Curve) {
  const p = BigInt(curve.p), a = BigInt(curve.a);
  const mod = (value: bigint) => (value % p + p) % p;
  function inverse(value: bigint) {
    let u = mod(value), v = p, x = 1n, y = 0n;
    while (v) { const q = u / v; [u, v] = [v, u % v]; [x, y] = [y, x - q * y]; }
    if (u !== 1n) throw new LabError(422, "点无效");
    return mod(x);
  }
  function add(left: Point, right: Point): Point {
    if (!left) return right;
    if (!right) return left;
    if (left.x === right.x && mod(left.y + right.y) === 0n) return null;
    const slope = left.x === right.x ? mod((3n * left.x * left.x + a) * inverse(2n * left.y))
      : mod((right.y - left.y) * inverse(right.x - left.x));
    const x = mod(slope * slope - left.x - right.x);
    return { x, y: mod(slope * (left.x - x) - left.y) };
  }
  function multiply(point: Point, scalar: bigint): Point {
    let result: Point = null;
    while (scalar) {
      if (scalar & 1n) result = add(result, point);
      point = add(point, point); scalar >>= 1n;
    }
    return result;
  }
  return { p, multiply };
}
const serialize = (point: Point) => point ? concat(bytes(point.x), bytes(point.y)) : new Uint8Array(32);

export async function runCurve(config: CurveConfig, state: CurveState, action: string, data: Record<string, unknown>) {
  const { p, multiply } = arithmetic(config.curve), scalar = BigInt(state.scalar);
  if (action === "inspect") {
    const point = multiply({ x: BigInt(config.curve.g.x), y: BigInt(config.curve.g.y) }, scalar)!;
    return { binding: state.binding, publicKey: { x: toHex(bytes(point.x)), y: toHex(bytes(point.y)) } };
  }
  if (action === "exchange") {
    const xBytes = hex(data.x, 16), yBytes = hex(data.y, 16);
    if (xBytes.length !== 16 || yBytes.length !== 16) throw new LabError(400, "坐标无效");
    const point = { x: integer(xBytes), y: integer(yBytes) };
    if (point.x >= p || point.y >= p) throw new LabError(422, "坐标无效");
    // The device's incomplete point validation is confined to this game service.
    const shared = multiply(point, scalar);
    return { confirmation: toHex(await sha256(concat(serialize(shared), hex(state.binding)))) };
  }
  if (action === "redeem") {
    const proof = hex(data.proof, 32);
    const key = await crypto.subtle.importKey("raw", bytes(scalar), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, concat(encode.encode("archive/release/"), hex(state.binding))));
    if (!same(proof, expected)) throw new LabError(403, "认证失败");
    return { ...config.reward };
  }
  throw new LabError(404, "不存在");
}
