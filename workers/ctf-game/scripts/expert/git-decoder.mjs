import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { inflateSync } from 'node:zlib';
const hash=data=>createHash('sha1').update(data).digest();
const names={1:'commit',2:'tree',3:'blob',4:'tag'};
const id=(type,data)=>hash(Buffer.concat([Buffer.from(names[type]+' '+data.length+'\0'),data])).toString('hex');
export function unpackTar(bytes){
  const entries=new Map();
  for(let at=0;at+512<=bytes.length;){
    const header=bytes.subarray(at,at+512);if(header.every(byte=>!byte))break;
    const sum=header.reduce((value,byte,i)=>value+(i>=148&&i<156?32:byte),0);
    if(parseInt(header.toString('ascii',148,156),8)!==sum)throw Error('TAR header checksum mismatch');
    const field=(start,end)=>header.toString('utf8',start,end).split('\0')[0];
    const length=parseInt(field(124,136),8),name=(field(345,500)?field(345,500)+'/':'')+field(0,100);
    if(!Number.isSafeInteger(length)||length<0||at+512+length>bytes.length)throw Error('TAR bounds');
    entries.set(name,{bytes:bytes.subarray(at+512,at+512+length),type:field(156,157),link:field(157,257)});
    at+=512+Math.ceil(length/512)*512;
  }
  return entries;
}
function applyDelta(data,base){
  let at=0;const varint=()=>{let value=0,shift=0,byte;do{byte=data[at++];value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;};
  if(varint()!==base.length)throw Error('Delta base size');const result=Buffer.alloc(varint());let written=0;
  while(at<data.length){const instruction=data[at++];if(instruction&128){let offset=0,length=0;for(let i=0;i<4;i++)if(instruction&(1<<i))offset+=data[at++]*2**(i*8);for(let i=0;i<3;i++)if(instruction&(1<<(i+4)))length+=data[at++]*2**(i*8);length||=65536;if(offset+length>base.length||written+length>result.length)throw Error('Delta copy bounds');base.copy(result,written,offset,offset+length);written+=length;}else{if(!instruction||at+instruction>data.length||written+instruction>result.length)throw Error('Delta insertion bounds');data.copy(result,written,at,at+instruction);at+=instruction;written+=instruction;}}
  if(written!==result.length)throw Error('Incomplete delta');return result;
}
export function recoverGitSeed(pack,checkpoints,recipient){
  if(pack.toString('ascii',0,4)!=='PACK'||pack.readUInt32BE(4)!==2||!hash(pack.subarray(0,-20)).equals(pack.subarray(-20)))throw Error('Invalid pack');
  const byId=new Map(),byOffset=new Map(),pending=[];
  for(const {bytes}of unpackTar(checkpoints).values())byId.set(id(3,bytes),{type:3,data:bytes});
  let cursor=12;
  for(let count=pack.readUInt32BE(8);count;count--){
    const offset=cursor;let byte=pack[cursor++],size=byte&15,shift=4,type=byte>>>4&7;
    while(byte&128){byte=pack[cursor++];size+=(byte&127)*2**shift;shift+=7;}
    let base;
    if(type===6){byte=pack[cursor++];let distance=byte&127;while(byte&128){byte=pack[cursor++];distance=(distance+1)*128+(byte&127);}base={offset:offset-distance};}
    if(type===7){base={id:pack.subarray(cursor,cursor+20).toString('hex')};cursor+=20;}
    const decoded=inflateSync(pack.subarray(cursor),{info:true});cursor+=decoded.engine.bytesWritten;
    if(decoded.buffer.length!==size)throw Error('Pack entry size');
    const entry={offset,type,data:decoded.buffer,base};
    if(base)pending.push(entry);else{byOffset.set(offset,entry);byId.set(id(type,entry.data),entry);}
  }
  if(cursor!==pack.length-20)throw Error('Pack trailing bytes');
  while(pending.length){let progress=false;for(let i=pending.length-1;i>=0;i--){const entry=pending[i],base=entry.base.id?byId.get(entry.base.id):byOffset.get(entry.base.offset);if(!base)continue;entry.data=applyDelta(entry.data,base.data);entry.type=base.type;byOffset.set(entry.offset,entry);byId.set(id(entry.type,entry.data),entry);pending.splice(i,1);progress=true;}if(!progress)throw Error('Unresolved thin pack');}
  for(const object of byId.values()){
    if(object.type!==3)continue;const text=object.data.toString('utf8');
    if(!text.startsWith('-----BEGIN PRIVATE KEY-----'))continue;
    const key=createPrivateKey(text),pub=createPublicKey(key).export({type:'spki',format:'der'}).subarray(-32).toString('hex');
    if(pub===recipient)return key.export({type:'pkcs8',format:'der'}).subarray(-32);
  }
  throw Error('Recipient absent from recovered object graph');
}
