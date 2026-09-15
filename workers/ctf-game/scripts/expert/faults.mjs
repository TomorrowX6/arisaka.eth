import { createCipheriv } from 'node:crypto';
import { gfMul, seal } from '../core.mjs';
const multiply = gfMul;
const rotate=(x,n)=>(x<<n|x>>>(8-n))&255;
const box=Uint8Array.from({length:256},(_,value)=>{
  let inverse=value?1:0;for(let i=0;i<254;i++)inverse=multiply(inverse,value);
  return inverse^rotate(inverse,1)^rotate(inverse,2)^rotate(inverse,3)^rotate(inverse,4)^0x63;
});
function expand(key){
  const output=Buffer.alloc(176);key.copy(output);let rcon=1;
  for(let at=16;at<176;at+=4){let temp=[...output.subarray(at-4,at)];if(at%16===0){temp.push(temp.shift());temp=temp.map(x=>box[x]);temp[0]^=rcon;rcon=multiply(rcon,2);}for(let i=0;i<4;i++)output[at+i]=output[at+i-16]^temp[i];}
  return output;
}
export function aesFaultEncrypt(input,key,fault){
  const keys=expand(key),state=Buffer.from(input);
  const add=round=>{for(let i=0;i<16;i++)state[i]^=keys[round*16+i];};
  add(0);
  for(let round=1;round<=10;round++){
    for(let i=0;i<16;i++)state[i]=box[state[i]];
    const before=Buffer.from(state);for(let row=0;row<4;row++)for(let col=0;col<4;col++)state[row+col*4]=before[row+((col+row)%4)*4];
    if(fault?.round===round)state[fault.column*4+fault.row]^=fault.value;
    if(round<10)for(let col=0;col<4;col++){
      const s=[...state.subarray(col*4,col*4+4)],sum=s[0]^s[1]^s[2]^s[3];
      for(let row=0;row<4;row++)state[col*4+row]=s[row]^sum^multiply(s[row]^s[(row+1)%4],2);
    }
    add(round);
  }
  return state;
}
export function faultEvidence(code,receipt,random){
  const key=random(16),input=random(16),clean=aesFaultEncrypt(input,key);
  const check=createCipheriv('aes-128-ecb',key,null);check.setAutoPadding(false);
  if(!Buffer.concat([check.update(input),check.final()]).equals(clean))throw Error('AES device self-test failed');
  const samples=[{result:clean,status:'9000',pulse:0}];
  for(let column=0;column<4;column++)for(let repeat=0;repeat<4;repeat++){
    const value=random(1)[0]||1,row=random(1)[0]%4;
    samples.push({result:aesFaultEncrypt(input,key,{round:9,column,row,value}),status:'6985',pulse:376+random(1)[0]%9});
  }
  for(let i=0;i<6;i++)samples.push({result:aesFaultEncrypt(input,key,{round:8,column:i%4,row:random(1)[0]%4,value:random(1)[0]||1}),status:'6985',pulse:343+random(1)[0]%7});
  for(let i=samples.length-1;i>0;i--){const j=random(2).readUInt16BE(0)%(i+1);[samples[i],samples[j]]=[samples[j],samples[i]];}
  const records=['capture,command,response,sw,pulse_ns'];
  for(let i=0;i<samples.length;i++)records.push([i,'80A0000010'+input.toString('hex').toUpperCase(),samples[i].result.toString('hex').toUpperCase(),samples[i].status,samples[i].pulse].join(','));
  return {
    'acquisition.csv':records.join('\r\n')+'\r\n',
    'device.json':JSON.stringify({atr:'3B8F8001804F0CA000000306030001000000006A',apdu:{cla:128,ins:160,input:16,output:16},primitive:'AES-128',clockHz:48000000,capture:'sync-rising'},null,2),
    'capsule.json':JSON.stringify(seal({code,receipt},key,'afterglow/device',random),null,2),
  };
}
