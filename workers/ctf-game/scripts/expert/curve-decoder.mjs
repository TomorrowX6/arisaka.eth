// Operator solver. Derives each small point order from serialized peers; it
// does not import the fixture file or the service's elliptic-curve routines.
import { createHash, createHmac } from 'node:crypto';

export async function recoverCurveProof(parameters, peers, record, exchange) {
  const p = BigInt(parameters.curve.p), a = BigInt(parameters.curve.a);
  const mod = (value, n = p) => (value % n + n) % n;
  function inverse(value, n) {
    let r = mod(value, n), s = n, x = 1n, y = 0n;
    while (s) { const q = r / s; [r, s] = [s, r % s]; [x, y] = [y, x - q * y]; }
    if (r !== 1n) throw Error('Noninvertible element'); return mod(x, n);
  }
  function add(left, right) {
    if (!left) return right; if (!right) return left;
    if (left.x === right.x && mod(left.y + right.y) === 0n) return null;
    const slope = left.x === right.x ? mod((3n * left.x ** 2n + a) * inverse(2n * left.y, p))
      : mod((right.y - left.y) * inverse(right.x - left.x, p));
    const x = mod(slope ** 2n - left.x - right.x);
    return { x, y: mod(slope * (left.x - x) - left.y) };
  }
  const scalarBytes = value => Buffer.from(value.toString(16).padStart(32, '0'), 'hex');
  const encode = point => point ? Buffer.concat([scalarBytes(point.x), scalarBytes(point.y)]) : Buffer.alloc(32);
  if (peers.subarray(0, 4).toString() !== 'ECP2' || peers.length !== 8 + peers.readUInt32BE(4) * 32) throw Error('Invalid peer cache');
  let scalar = 0n, modulus = 1n;
  for (let at = 8; at < peers.length; at += 32) {
    const x = peers.subarray(at, at + 16).toString('hex'), y = peers.subarray(at + 16, at + 32).toString('hex');
    const base = { x: BigInt('0x' + x), y: BigInt('0x' + y) }, confirmation = (await exchange({ x, y })).confirmation;
    let point = null, residue = -1, order = 0;
    do {
      const hash = createHash('sha256').update(encode(point)).update(Buffer.from(record.binding, 'hex')).digest('hex');
      if (hash === confirmation) residue = order;
      point = add(point, base); order++;
      if (order > 8192) throw Error('Peer order exceeds acquisition bound');
    } while (point);
    if (residue < 0) throw Error('No confirmed shared point');
    const r = BigInt(order);
    scalar += modulus * mod((BigInt(residue) - scalar) * inverse(modulus, r), r); modulus *= r;
  }
  if (modulus <= BigInt(parameters.curve.order) || scalar >= BigInt(parameters.curve.order)) throw Error('Incomplete scalar recovery');
  let point = null, base = { x: BigInt(parameters.curve.g.x), y: BigInt(parameters.curve.g.y) }, value = scalar;
  while (value) { if (value & 1n) point = add(point, base); base = add(base, base); value >>= 1n; }
  if (encode(point).toString('hex') !== record.publicKey.x + record.publicKey.y) throw Error('Public key mismatch');
  return createHmac('sha256', scalarBytes(scalar)).update('archive/release/').update(Buffer.from(record.binding, 'hex')).digest('hex');
}
