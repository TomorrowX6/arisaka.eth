// Operator-only polynomial related-message recovery over Z/NZ.
import { openSeal } from '../decoders.mjs';
function inverse(value,n){
  let a=(value%n+n)%n,b=n,u=1n,v=0n;
  while(b){const q=a/b;[a,b]=[b,a%b];[u,v]=[v,u-q*v];}
  if(a!==1n){const error=Error('Nonunit polynomial coefficient');error.factor=a;throw error;}
  return (u%n+n)%n;
}
function power(a,e,n){let r=1n;while(e){if(e&1n)r=r*a%n;a=a*a%n;e>>=1n;}return r;}
const trim=p=>{while(p.length>1&&!p.at(-1))p.pop();return p;};
function polynomialMultiply(a,b,n,degree,constant){
  const output=Array(a.length+b.length-1).fill(0n);
  for(let i=0;i<a.length;i++)if(a[i])for(let j=0;j<b.length;j++)if(b[j])output[i+j]=(output[i+j]+a[i]*b[j])%n;
  for(let i=output.length-1;i>=degree;i--)output[i-degree]=(output[i-degree]+output[i]*constant)%n;
  return trim(output.slice(0,degree));
}
function remainder(a,b,n){
  const p=[...a],inv=inverse(b.at(-1),n);
  while(p.length>=b.length&&p.some(Boolean)){
    const shift=p.length-b.length,multiple=p.at(-1)*inv%n;
    for(let j=0;j<b.length;j++)p[shift+j]=(p[shift+j]-multiple*b[j]%n+n)%n;
    trim(p);
  }
  return p;
}
export function decodeRsaEvidence(telemetry,emitter,sealed){
  const data=typeof telemetry==='string'?JSON.parse(telemetry):telemetry,n=BigInt('0x'+data.n),degree=data.e;
  const coefficients=['B','A'].map(name=>{const match=new RegExp('^'+name+' = 0x([0-9a-f]+)$','m').exec(String(emitter));if(!match)throw Error('Missing device coefficient');return BigInt('0x'+match[1]);});
  const c0=BigInt('0x'+data.records[0].block),c1=BigInt('0x'+data.records[1].block);
  let polynomial=[1n],base=[...coefficients,1n],exponent=degree;
  while(exponent){if(exponent&1)polynomial=polynomialMultiply(polynomial,base,n,degree,c0);base=polynomialMultiply(base,base,n,degree,c0);exponent>>>=1;}
  polynomial[0]=(polynomial[0]-c1+n)%n;
  let a=[(n-c0)%n,...Array(degree-1).fill(0n),1n],b=trim(polynomial),message;
  try{
    while(b.some(Boolean))[a,b]=[b,remainder(a,b,n)];
    if(a.length!==2)throw Error('Nonlinear common factor');message=((n-a[0])*inverse(a[1],n))%n;
  }catch(error){
    if(!error.factor||error.factor===n)throw error;
    const factor=error.factor,d=inverse(BigInt(degree),(factor-1n)*(n/factor-1n));message=power(c0,d,n);
  }
  if(power(message,BigInt(degree),n)!==c0)throw Error('Ciphertext verification failed');
  const size=Math.ceil(n.toString(2).length/8),block=Buffer.from(message.toString(16).padStart(size*2,'0'),'hex');
  const separator=block.indexOf(0,2);if(block[0]!==0||block[1]!==2||separator<10||block.length-separator-1!==32)throw Error('Invalid transport block');
  return openSeal(sealed,block.subarray(separator+1));
}
