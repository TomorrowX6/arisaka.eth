// Operator-only recovery from the serialized audit log. No generator imports.
import { createHash, createPublicKey, verify, createECDH } from 'node:crypto';
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const mod = x => (x % N + N) % N;
function inv(x) {
  let a = mod(x), b = N, u = 1n, v = 0n;
  while (b) { const q = a / b; [a,b] = [b,a%b]; [u,v] = [v,u-q*v]; }
  if (a !== 1n) throw Error('Singular scalar'); return mod(u);
}
const trim = p => { while (p.length > 1 && !p.at(-1)) p.pop(); return p; };
const subtract = (p,q) => trim(Array.from({length:Math.max(p.length,q.length)}, (_,i) => mod((p[i]||0n)-(q[i]||0n))));
function multiply(p,q) {
  const r = Array(p.length+q.length-1).fill(0n);
  for (let i=0;i<p.length;i++) for (let j=0;j<q.length;j++) r[i+j]=mod(r[i+j]+p[i]*q[j]);
  return trim(r);
}
function remainder(p,q) {
  p=[...p]; const inverse=inv(q.at(-1));
  while (p.length>=q.length && p.some(Boolean)) {
    const factor=mod(p.at(-1)*inverse), offset=p.length-q.length;
    for(let j=0;j<q.length;j++) p[j+offset]=mod(p[j+offset]-factor*q[j]);
    trim(p);
  }
  return p;
}
function gcd(p,q) {
  while(q.some(Boolean)) [p,q]=[q,remainder(p,q)];
  const factor=inv(p.at(-1)); return p.map(x=>mod(x*factor));
}
export function recoverAffineScalar(ledger) {
  const publicBytes = Buffer.from(ledger.publicKey,'hex');
  const publicKey = createPublicKey({key:Buffer.concat([Buffer.from('3056301006072a8648ce3d020106052b8104000a034200','hex'),publicBytes]),type:'spki',format:'der'});
  const events = [...ledger.signatures].sort((a,b)=>JSON.parse(a.message).seq-JSON.parse(b.message).seq);
  if (events.length < 5) throw Error('Insufficient audit events');
  for(const s of events) if(!verify('sha256',Buffer.from(s.message),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(s.r+s.s,'hex'))) throw Error('Unauthenticated audit event');
  const base = events.slice(0,5).map(s=>{
    const inverse=inv(BigInt('0x'+s.s));
    const z=BigInt('0x'+createHash('sha256').update(s.message).digest('hex'));
    return [mod(z*inverse),mod(BigInt('0x'+s.r)*inverse)];
  });
  // Low-s normalizes each signature independently. A common sign reversal
  // preserves an affine recurrence, so the first sign can be fixed.
  for(let mask=0;mask<16;mask++) {
    const k=base.map((p,i)=>p.map(x=>i && mask & (1<<(i-1)) ? mod(-x):x));
    const d=k.slice(1).map((p,i)=>subtract(p,k[i]));
    const f=subtract(multiply(d[0],d[2]),multiply(d[1],d[1]));
    const g=subtract(multiply(d[1],d[3]),multiply(d[2],d[2]));
    const common=gcd(f,g);
    if(common.length!==2) continue;
    const scalar=mod(-common[0]*inv(common[1]));
    if(!scalar) continue;
    const bytes=Buffer.from(scalar.toString(16).padStart(64,'0'),'hex');
    const candidate=createECDH('secp256k1'); candidate.setPrivateKey(bytes);
    if(candidate.getPublicKey().equals(publicBytes)) return bytes;
  }
  throw Error('No authenticated affine-nonce solution');
}
