import { createPrivateKey, createPublicKey } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { seal, sha256 } from '../core.mjs';
import { hash, tar, u32be } from './formats.mjs';
const names={1:'commit',2:'tree',3:'blob',4:'tag'};
const oid=(type,data)=>hash('sha1',Buffer.concat([Buffer.from(names[type]+' '+data.length+'\0'),data]));
const variable=value=>{const bytes=[];do{bytes.push((value&127)|(value>127?128:0));value>>>=7;}while(value);return Buffer.from(bytes);};
function header(type,length){const bytes=[type<<4|length&15];length>>>=4;while(length){bytes[bytes.length-1]|=128;bytes.push(length&127);length>>>=7;}return Buffer.from(bytes);}
function copy(offset,length){let command=0x80;const bytes=[];for(let i=0;i<4;i++)if(offset>>>(i*8)&255){command|=1<<i;bytes.push(offset>>>(i*8)&255);}for(let i=0;i<3;i++)if(length>>>(i*8)&255){command|=1<<(i+4);bytes.push(length>>>(i*8)&255);}return Buffer.from([command,...bytes]);}
function delta(base,target){
  let prefix=0,suffix=0;
  while(prefix<Math.min(base.length,target.length)&&base[prefix]===target[prefix])prefix++;
  while(suffix<Math.min(base.length,target.length)-prefix&&base[base.length-1-suffix]===target[target.length-1-suffix])suffix++;
  const chunks=[variable(base.length),variable(target.length)];if(prefix)chunks.push(copy(0,prefix));
  for(let at=prefix;at<target.length-suffix;at+=127){const part=target.subarray(at,Math.min(at+127,target.length-suffix));chunks.push(Buffer.from([part.length]),part);}
  if(suffix)chunks.push(copy(base.length-suffix,suffix));return Buffer.concat(chunks);
}
function distance(value){const result=[value&127];while((value>>>=7)>0){value--;result.unshift(128|value&127);}return Buffer.from(result);}
function pem(seed){const der=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]);return '-----BEGIN PRIVATE KEY-----\n'+der.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END PRIVATE KEY-----\n';}

export function gitEvidence(code,random){
  const objects=[], offsets=[], baseSeed=random(32), seed=random(32), base=Buffer.from(pem(baseSeed));
  const targetKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
  const recipient=createPublicKey(targetKey).export({format:'der',type:'spki'}).subarray(-32).toString('hex');
  function add(type,data,baseRef){data=Buffer.from(data);const item={type,data,id:oid(type,data),baseRef};objects.push(item);return item;}
  const readme=add(3,'service=archive\nversion=4\ntransport=unix\n');
  let parent,previousBlob;const commits=[];
  for(let epoch=0;epoch<24;epoch++){
    const settings=add(3,JSON.stringify({version:4,epoch,socket:'/run/archive.sock',uid:1000,log:'/var/log/archive.log',clientId:random(16).toString('hex')})+'\n',epoch&&epoch%3?previousBlob:undefined);previousBlob=settings;
    const keySeed=epoch===11?seed:random(32);
    const credential=add(3,pem(keySeed),{type:3,data:base,id:oid(3,base),external:true});
    const entries=[['100644','README',readme],['100644','service.json',settings]];
    if(epoch%4!==3)entries.push(['100644','identity.pem',credential]);
    entries.sort((a,b)=>Buffer.compare(Buffer.from(a[1]),Buffer.from(b[1])));
    const tree=add(2,Buffer.concat(entries.map(([mode,name,item])=>Buffer.concat([Buffer.from(mode+' '+name+'\0'),item.id]))));
    const timestamp=1726311600+epoch*97;
    const commit=add(1,'tree '+tree.id.toString('hex')+'\n'+(parent?'parent '+parent.id.toString('hex')+'\n':'')+'author archive <build@archive.invalid> '+timestamp+' +0000\ncommitter archive <build@archive.invalid> '+timestamp+' +0000\n\ncheckpoint '+epoch+'\n');
    commits.push(commit);parent=commit;
  }
  const parts=[Buffer.from('PACK'),u32be(2),u32be(objects.length)];let position=12;
  for(const object of objects){
    offsets.push(position);let data=object.data, prefix=Buffer.alloc(0),type=object.type;
    if(object.baseRef){
      data=delta(object.baseRef.data,object.data);
      if(object.baseRef.external){type=7;prefix=object.baseRef.id;}
      else{type=6;prefix=distance(position-offsets[objects.indexOf(object.baseRef)]);}
    }
    const encoded=Buffer.concat([header(type,data.length),prefix,deflateSync(data,{level:9})]);parts.push(encoded);position+=encoded.length;
  }
  const packed=Buffer.concat(parts),pack=Buffer.concat([packed,hash('sha1',packed)]);
  const checkpoints={};
  for(let i=0;i<15;i++)checkpoints['cache/'+sha256(String(i)+recipient).toString('hex').slice(0,16)+'.bin']=i===7?base:Buffer.from(pem(random(32)));
  checkpoints['refs/heads/main']=parent.id.toString('hex')+'\n';
  checkpoints['logs/HEAD']=commits.map((commit,i)=>(i?commits[i-1].id.toString('hex'):'0'.repeat(40))+' '+commit.id.toString('hex')+' archive <build@archive.invalid> '+(1726311600+i*97)+' +0000\tcheckpoint\n').join('');
  checkpoints['HEAD']='ref: refs/heads/main\n';
  return {
    'objects.pack':pack,
    'checkpoint.tar':tar(checkpoints),
    'capsule.json':JSON.stringify({...seal({code},seed,'afterglow/case-01',random),recipient:{kty:'OKP',crv:'Ed25519',x:recipient}},null,2),
  };
}
