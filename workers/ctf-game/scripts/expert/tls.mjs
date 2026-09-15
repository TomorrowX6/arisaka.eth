import { createCipheriv, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { crc32, seal, sha256 } from '../core.mjs';
import { pcapng, u16be, u32be } from './formats.mjs';
import { tcp, udp } from './network.mjs';
const u24=n=>Buffer.from([n>>>16&255,n>>>8&255,n&255]);
const frame=(type,flags,stream,data)=>Buffer.concat([u24(data.length),Buffer.from([type,flags]),u32be(stream),data]);
const handshake=(type,data)=>Buffer.concat([Buffer.from([type]),u24(data.length),data]);
const record=(type,data)=>Buffer.concat([Buffer.from([type,3,3]),u16be(data.length),data]);
const extension=(type,data)=>Buffer.concat([u16be(type),u16be(data.length),data]);
const vector=data=>Buffer.concat([u16be(data.length),data]);
function expand(secret,label,length){
  const name=Buffer.from('tls13 '+label),info=Buffer.concat([u16be(length),Buffer.from([name.length]),name,Buffer.from([0])]);
  let result=Buffer.alloc(0),previous=Buffer.alloc(0),counter=1;
  while(result.length<length){previous=createHmac('sha256',secret).update(Buffer.concat([previous,info,Buffer.from([counter++])])).digest();result=Buffer.concat([result,previous]);}
  return result.subarray(0,length);
}
function protector(secret){let sequence=0n;return(content,type=23,padding=0)=>{
  const iv=expand(secret,'iv',12),key=expand(secret,'key',16);for(let i=0;i<8;i++)iv[11-i]^=Number(sequence>>BigInt(i*8)&255n);sequence++;
  const clear=Buffer.concat([content,Buffer.from([type]),Buffer.alloc(padding)]),head=Buffer.concat([Buffer.from([23,3,3]),u16be(clear.length+16)]);
  const cipher=createCipheriv('aes-128-gcm',key,iv);cipher.setAAD(head);
  return Buffer.concat([head,cipher.update(clear),cipher.final(),cipher.getAuthTag()]);
};}
const hpackString=text=>{const bytes=Buffer.from(text);if(bytes.length>=127)throw Error('HPACK string limit');return Buffer.concat([Buffer.from([bytes.length]),bytes]);};
const literal=(name,value)=>Buffer.concat([Buffer.from([0x40]),hpackString(name),hpackString(value)]);
const varint=n=>{const data=[];do{data.push((n&127)|(n>127?128:0));n>>>=7;}while(n);return Buffer.from(data);};
const protobufBytes=(field,data)=>Buffer.concat([varint(field*8+2),varint(data.length),data]);

export function tlsEvidence(code,receipt,random){
  const clientRandom=random(32),serverRandom=random(32),session=random(16);
  const serverHandshake=random(32),clientHandshake=random(32),traffic=random(32),envelopeKey=random(16);
  const extensions=Buffer.concat([
    extension(43,Buffer.from([2,3,4])),extension(10,Buffer.from([0,2,0,29])),extension(13,Buffer.from([0,4,8,7,4,3])),
    extension(51,vector(Buffer.concat([u16be(29),vector(random(32))]))),extension(45,Buffer.from([1,1])),
    extension(16,vector(Buffer.from([2,104,50]))),
  ]);
  const ch=handshake(1,Buffer.concat([u16be(0x303),clientRandom,Buffer.from([session.length]),session,vector(Buffer.from([0x13,1])),Buffer.from([1,0]),vector(extensions)]));
  const sh=handshake(2,Buffer.concat([u16be(0x303),serverRandom,Buffer.from([session.length]),session,Buffer.from([0x13,1,0]),vector(Buffer.concat([extension(43,Buffer.from([3,4])),extension(51,Buffer.concat([u16be(29),vector(random(32))]))]))]));
  const ee=handshake(8,vector(extension(16,vector(Buffer.from([2,104,50])))));
  const finished=handshake(20,createHmac('sha256',expand(serverHandshake,'finished',32)).update(sha256(Buffer.concat([ch,sh,ee]))).digest());
  const protectHandshake=protector(serverHandshake),protect=protector(traffic),nextTraffic=expand(traffic,'traffic upd',32),protectNext=protector(nextTraffic);
  const dummyKey=random(16).toString('hex');
  const headersA=Buffer.concat([Buffer.from([0x88,0x5f]),hpackString('application/grpc'),literal('x-session-key',dummyKey)]);
  const headersB=Buffer.concat([Buffer.from([0x88,0xbf,0x7e]),hpackString(envelopeKey.toString('hex'))]);
  const headersC=Buffer.from([0x88,0xc0,0xbe]);
  const capsule=seal({code,receipt},envelopeKey,'afterglow/wire',random);
  const protobuf=Buffer.concat([Buffer.from([8]),varint(711),protobufBytes(2,sha256(envelopeKey)),protobufBytes(3,Buffer.from(JSON.stringify(capsule)))]);
  const message=gzipSync(protobuf),grpc=Buffer.concat([Buffer.from([1]),u32be(message.length),message]);
  const before=Buffer.concat([frame(4,0,0,Buffer.concat([u16be(1),u32be(4096)])),frame(1,4,1,headersA),frame(0,1,1,Buffer.from([0,0,0,0,0])),frame(1,4,3,headersB)]);
  const after=Buffer.concat([frame(1,4,7,headersC),frame(0,0,7,grpc.subarray(0,31)),frame(0,0,7,grpc.subarray(31)),frame(1,5,7,literal('grpc-status','0'))]);
  const serverRecords=[record(22,sh),protectHandshake(ee,22,3),protectHandshake(finished,22,0),protect(before.subarray(0,37),23,4),protect(before.subarray(37),23,2),protect(handshake(24,Buffer.from([0])),22,1)];
  for(let at=0;at<after.length;at+=113)serverRecords.push(protectNext(after.subarray(at,at+113),23,random(1)[0]%8));
  const serverStream=Buffer.concat(serverRecords),clientStream=record(22,ch);
  const keylog=['SERVER_HANDSHAKE_TRAFFIC_SECRET '+clientRandom.toString('hex')+' '+serverHandshake.toString('hex'),'CLIENT_HANDSHAKE_TRAFFIC_SECRET '+clientRandom.toString('hex')+' '+clientHandshake.toString('hex'),'SERVER_TRAFFIC_SECRET_0 '+clientRandom.toString('hex')+' '+traffic.toString('hex')].join('\n')+'\n';
  const compressed=gzipSync(Buffer.from(keylog)),covert=Buffer.concat([Buffer.from('DLOG'),u32be(compressed.length),compressed,u32be(crc32(compressed))]);
  let stamp=1726311600000000n;const packets=[];
  function push(bytes,iface=0){packets.push({bytes,time:stamp+=BigInt(150+random(2).readUInt16BE(0)%700),interface:iface});}
  push(tcp(Buffer.alloc(0),{source:'192.0.2.20',destination:'192.0.2.10',sport:49152,dport:443,seq:1000,ack:0,flags:2}));
  push(tcp(Buffer.alloc(0),{seq:9000,ack:1001,flags:0x12}));
  push(tcp(clientStream,{source:'192.0.2.20',destination:'192.0.2.10',sport:49152,dport:443,seq:1001,ack:9001}));
  const dns=[];
  for(let at=0,index=0;at<covert.length;at+=14,index++){
    const body=Buffer.alloc(16);body.writeUInt16BE(index);covert.copy(body,2,at,Math.min(at+14,covert.length));
    const labels=['cache-'+random(2).toString('hex'),'resolver','invalid'];
    const name=Buffer.concat([...labels.map(label=>Buffer.concat([Buffer.from([label.length]),Buffer.from(label)])),Buffer.from([0])]);
    const question=Buffer.concat([name,u16be(28),u16be(1)]);
    const answer=Buffer.concat([Buffer.from([0xc0,0x0c]),u16be(28),u16be(1),u32be(60),u16be(16),body]);
    dns.push(udp(Buffer.concat([random(2),u16be(0x8180),u16be(1),u16be(1),u16be(0),u16be(0),question,answer]),{id:200+index}));
  }
  let at=0,index=0;
  while(at<serverStream.length||dns.length){
    if(dns.length)push(dns.splice(random(1)[0]%dns.length,1)[0],1);
    if(at>=serverStream.length)continue;
    const count=43+random(1)[0]%131,chunk=serverStream.subarray(at,at+count);
    if(index%5===2){const shadow=Buffer.from(chunk);shadow[Math.min(11,shadow.length-1)]^=0x40;push(tcp(shadow,{seq:9001+at,ack:1001+clientStream.length,id:500+index}));}
    push(tcp(chunk,{seq:9001+at,ack:1001+clientStream.length,id:700+index}));
    if(index%7===0)push(tcp(chunk,{seq:9001+at,ack:1001+clientStream.length,id:900+index}));
    at+=chunk.length;index++;
  }
  return {'wire.pcapng':pcapng(packets,[{linkType:1,snaplen:65535},{linkType:1,snaplen:65535}]),'capture.json':JSON.stringify({interfaces:[{id:0,name:'br-service',filter:'tcp port 443'},{id:1,name:'br-resolver',filter:'udp port 53'}],clock:'CLOCK_REALTIME',precision:'us',application:'h2',export:'pcapng/1.0'},null,2)};
}
