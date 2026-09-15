import { checkPrimeSync } from 'node:crypto';
import { seal } from '../core.mjs';
const integer=bytes=>BigInt('0x'+bytes.toString('hex'));
function power(value,exponent,n){let result=1n;while(exponent){if(exponent&1n)result=result*value%n;value=value*value%n;exponent>>=1n;}return result;}
function prime(random,bits,exponent){
  const bytes=random(bits/8);bytes[0]|=192;bytes[bytes.length-1]|=1;
  let value=integer(bytes);
  while(true){if((value-1n)%exponent&&[3n,5n,7n,11n,13n,17n,19n,23n,29n,31n,37n,41n,43n].every(p=>value%p)&&checkPrimeSync(value,{checks:32}))return value;value+=2n;}
}
export function rsaEvidence(code,receipt,random){
  const e=257n,p=prime(random,768,e);let q=prime(random,768,e);while(q===p)q=prime(random,768,e);
  const n=p*q,size=Math.ceil(n.toString(2).length/8),key=random(32),padding=random(size-key.length-3);
  for(let i=0;i<padding.length;i++)if(!padding[i])padding[i]=1;
  const message=integer(Buffer.concat([Buffer.from([0,2]),padding,Buffer.from([0]),key]));
  const A=integer(random(16)),B=integer(random(64)),related=(message*message+A*message+B)%n;
  const records=[power(message,e,n),power(related,e,n)];
  return {
    'telemetry.json':JSON.stringify({format:'rsa/v1',n:n.toString(16),e:Number(e),records:records.map((ciphertext,i)=>({counter:17+i,block:ciphertext.toString(16).padStart(size*2,'0')}))},null,2),
    'emitter.py':[
      'A = 0x'+A.toString(16),'B = 0x'+B.toString(16),'E = 257','',
      'def emit(block, modulus):','    state = int.from_bytes(block, "big")','    yield pow(state, E, modulus)','    state = (state * state + A * state + B) % modulus','    yield pow(state, E, modulus)','',
    ].join('\n'),
    'capsule.json':JSON.stringify(seal({code,receipt},key,'afterglow/telemetry',random),null,2),
  };
}
