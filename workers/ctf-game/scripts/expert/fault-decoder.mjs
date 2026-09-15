// Operator-only differential-fault analysis; independent of the device code.
import { createCipheriv } from 'node:crypto';
function mul(a,b){let r=0;while(b){if(b&1)r^=a;a<<=1;if(a&256)a^=0x11b;b>>=1;}return r;}
function power(a,n){let r=1;while(n){if(n&1)r=mul(r,a);a=mul(a,a);n>>=1;}return r;}
const sbox=Array.from({length:256},(_,x)=>{const y=x?power(x,254):0;let out=y^0x63;for(let n=1;n<=4;n++)out^=(y<<n|y>>>(8-n))&255;return out;});
const inverse=Array(256);sbox.forEach((x,i)=>inverse[x]=i);
const mix=[[2,3,1,1],[1,2,3,1],[1,1,2,3],[3,1,1,2]];
function candidates(clean,fault,positions){
  const tables=positions.map(pos=>{const table=Array.from({length:256},()=>[]);for(let k=0;k<256;k++)table[inverse[clean[pos]^k]^inverse[fault[pos]^k]].push(k);return table;});
  const keys=new Set();
  for(let row=0;row<4;row++)for(let error=1;error<256;error++){
    const allowed=tables.map((table,i)=>table[mul(mix[i][row],error)]);
    if(allowed.some(list=>!list.length))continue;
    for(const a of allowed[0])for(const b of allowed[1])for(const c of allowed[2])for(const d of allowed[3])keys.add(((a<<24|b<<16|c<<8|d)>>>0));
  }
  return keys;
}
function reverseSchedule(last){
  const key=Buffer.alloc(176);last.copy(key,160);const rcon=[0,1];for(let i=2;i<=10;i++)rcon[i]=mul(rcon[i-1],2);
  for(let word=43;word>=4;word--){let t=[...key.subarray((word-1)*4,word*4)];if(word%4===0)t=[sbox[t[1]]^rcon[word/4],sbox[t[2]],sbox[t[3]],sbox[t[0]]];for(let i=0;i<4;i++)key[(word-4)*4+i]=key[word*4+i]^t[i];}
  return key.subarray(0,16);
}
export function recoverFaultKey(csv){
  const rows=String(csv).trim().split(/\r?\n/).slice(1).map(line=>line.split(','));
  const successful=rows.find(row=>row[3]==='9000');if(!successful)throw Error('No successful transaction');
  const input=Buffer.from(successful[1].slice(10),'hex'),clean=Buffer.from(successful[2],'hex');
  const groups=Array.from({length:4},()=>[]);
  for(const row of rows){
    if(row[1]!==successful[1]||row[3]==='9000')continue;const fault=Buffer.from(row[2],'hex');
    const changed=Array.from({length:16},(_,i)=>i).filter(i=>clean[i]!==fault[i]);if(changed.length!==4)continue;
    for(let col=0;col<4;col++){const positions=Array.from({length:4},(_,r)=>r+((col-r+4)%4)*4);if(positions.every(pos=>changed.includes(pos)))groups[col].push(fault);}
  }
  const roundKey=Buffer.alloc(16);
  for(let col=0;col<4;col++){
    const positions=Array.from({length:4},(_,r)=>r+((col-r+4)%4)*4);let possible;
    for(const fault of groups[col]){const next=candidates(clean,fault,positions);possible=possible?new Set([...possible].filter(value=>next.has(value))):next;if(possible.size===1)break;}
    if(possible?.size!==1)throw Error('Ambiguous fault system');
    const value=[...possible][0];for(let i=0;i<4;i++)roundKey[positions[i]]=value>>>(24-i*8)&255;
  }
  const key=reverseSchedule(roundKey),cipher=createCipheriv('aes-128-ecb',key,null);cipher.setAutoPadding(false);
  if(!Buffer.concat([cipher.update(input),cipher.final()]).equals(clean))throw Error('Recovered key fails known transaction');
  return key;
}
