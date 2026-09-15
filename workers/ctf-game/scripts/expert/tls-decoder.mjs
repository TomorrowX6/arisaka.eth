import { createDecipheriv, createHmac, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { openSeal } from '../decoders.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest();
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^(crc&1?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function packets(pcap){
  const result=[];let little=true;
  for(let at=0;at+12<=pcap.length;){
    if(pcap.readUInt32LE(at)===0x0a0d0d0a)little=pcap.readUInt32LE(at+8)===0x1a2b3c4d;
    const read=offset=>little?pcap.readUInt32LE(offset):pcap.readUInt32BE(offset),type=read(at),length=read(at+4);
    if(length<12||length%4||at+length>pcap.length||read(at+length-4)!==length)throw Error('Malformed PCAPNG block');
    if(type===6){const size=read(at+20);if(size>length-32)throw Error('Truncated packet');result.push(pcap.subarray(at+28,at+28+size));}
    at+=length;
  }
  return result;
}
function skipName(bytes,start){let at=start;while(at<bytes.length){const n=bytes[at++];if(!n)return at;if((n&192)===192)return at+1;if(n>63||at+n>bytes.length)throw Error('DNS name');at+=n;}throw Error('Truncated DNS name');}
function traffic(pcap,policy){
  const fragments=new Map(),segments=[];
  for(const frame of packets(pcap)){
    if(frame.length<34||frame.readUInt16BE(12)!==0x0800)continue;
    const ip=frame.subarray(14),header=(ip[0]&15)*4,body=ip.subarray(header,ip.readUInt16BE(2));
    if(ip[9]===6&&body.readUInt16BE(0)===443){const offset=(body[12]>>>4)*4;if(body.length>offset)segments.push({sequence:body.readUInt32BE(4),data:body.subarray(offset)});}
    if(ip[9]!==17||body.readUInt16BE(0)!==53)continue;
    const dns=body.subarray(8);let at=12;
    for(let i=0;i<dns.readUInt16BE(4);i++)at=skipName(dns,at)+4;
    for(let i=0;i<dns.readUInt16BE(6);i++){
      at=skipName(dns,at);const type=dns.readUInt16BE(at),length=dns.readUInt16BE(at+8);at+=10;
      if(type===28&&length===16)fragments.set(dns.readUInt16BE(at),dns.subarray(at+2,at+16));at+=length;
    }
  }
  const hidden=Buffer.concat([...fragments].sort((a,b)=>a[0]-b[0]).map(([,data])=>data));
  if(hidden.toString('ascii',0,4)!=='DLOG')throw Error('No resolver stream');
  const length=hidden.readUInt32BE(4),compressed=hidden.subarray(8,8+length);
  if(8+length+4>hidden.length||crc32(compressed)!==hidden.readUInt32BE(8+length))throw Error('Resolver stream checksum');
  const secrets=new Map(gunzipSync(compressed).toString('utf8').trim().split('\n').map(line=>{const [name,,secret]=line.trim().split(/\s+/);return [name,Buffer.from(secret,'hex')];}));
  const start=Math.min(...segments.map(s=>s.sequence)),size=Math.max(...segments.map(s=>s.sequence+s.data.length))-start;
  const stream=Buffer.alloc(size),present=Buffer.alloc(size);
  for(const segment of segments)for(let i=0;i<segment.data.length;i++){const position=segment.sequence-start+i;if(policy==='last'||!present[position])stream[position]=segment.data[i];present[position]=1;}
  if(present.some(value=>!value))throw Error('Missing TCP bytes');return {stream,secrets};
}
function expand(secret,label,length){
  const labelBytes=Buffer.from('tls13 '+label),info=Buffer.from([length>>>8,length&255,labelBytes.length,...labelBytes,0]);
  const blocks=[];let previous=Buffer.alloc(0);
  for(let counter=1;Buffer.concat(blocks).length<length;counter++){previous=createHmac('sha256',secret).update(Buffer.concat([previous,info,Buffer.from([counter])])).digest();blocks.push(previous);}
  return Buffer.concat(blocks).subarray(0,length);
}
function unprotect(record,state){
  const iv=expand(state.secret,'iv',12);for(let i=0;i<8;i++)iv[iv.length-1-i]^=Number(state.sequence>>BigInt(i*8)&255n);
  const decipher=createDecipheriv('aes-128-gcm',expand(state.secret,'key',16),iv);decipher.setAAD(record.subarray(0,5));decipher.setAuthTag(record.subarray(-16));
  const clear=Buffer.concat([decipher.update(record.subarray(5,-16)),decipher.final()]);
  let last=clear.length-1;while(last>=0&&!clear[last])last--;if(last<0)throw Error('Empty TLS inner record');
  state.sequence++;return {type:clear[last],data:clear.subarray(0,last)};
}
function decryptRecords(stream,secrets){
  const hs={secret:secrets.get('SERVER_HANDSHAKE_TRAFFIC_SECRET'),sequence:0n},application={secret:secrets.get('SERVER_TRAFFIC_SECRET_0'),sequence:0n},chunks=[];
  if(!hs.secret||!application.secret)throw Error('Missing traffic secret');
  for(let at=0;at<stream.length;){
    if(at+5>stream.length)throw Error('Truncated TLS header');const length=stream.readUInt16BE(at+3);
    if(at+5+length>stream.length)throw Error('Truncated TLS record');const record=stream.subarray(at,at+5+length);at+=record.length;
    if(record[0]!==23)continue;
    let opened;
    try{opened=unprotect(record,hs);}catch{opened=unprotect(record,application);}
    if(opened.type===23)chunks.push(opened.data);
    else if(opened.type===22&&opened.data[0]===24){application.secret=expand(application.secret,'traffic upd',32);application.sequence=0n;}
  }
  return Buffer.concat(chunks);
}
function hpackDecoder(){
  const dynamic=[],statics={8:[':status','200'],31:['content-type','']};
  const indexed=index=>index<=61?statics[index]||['static-'+index,'']:dynamic[index-62];
  return block=>{
    let at=0;const headers=[];
    function integer(prefix){const maximum=(1<<prefix)-1;let value=block[at++]&maximum;if(value<maximum)return value;let shift=0,byte;do{if(at>=block.length||shift>28)throw Error('HPACK integer');byte=block[at++];value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;}
    function string(){if(block[at]&128)throw Error('Unexpected Huffman field');const length=integer(7);if(at+length>block.length)throw Error('HPACK bounds');const text=block.toString('utf8',at,at+length);at+=length;return text;}
    while(at<block.length){const op=block[at];if(op&128){const field=indexed(integer(7));if(!field)throw Error('Unknown HPACK index');headers.push(field);}else if(op&64){const name=integer(6),field=[name?indexed(name)?.[0]:string(),string()];if(!field[0])throw Error('Unknown HPACK name');headers.push(field);dynamic.unshift(field);}else if(op&32){integer(5);}else{const name=integer(4);headers.push([name?indexed(name)?.[0]:string(),string()]);}}
    return headers;
  };
}
function proto(bytes){
  let at=0;const values=new Map();const integer=()=>{let value=0,shift=0,byte;do{if(at>=bytes.length||shift>49)throw Error('Protobuf varint');byte=bytes[at++];value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;};
  while(at<bytes.length){const tag=integer(),wire=tag&7;if(wire===0)values.set(tag>>>3,integer());else if(wire===2){const length=integer();if(at+length>bytes.length)throw Error('Protobuf bounds');values.set(tag>>>3,bytes.subarray(at,at+length));at+=length;}else throw Error('Unsupported protobuf wire type');}
  return values;
}
export function decodeTlsEvidence(pcap,policy='last'){
  const {stream,secrets}=traffic(pcap,policy),http=decryptRecords(stream,secrets),decodeHeaders=hpackDecoder(),streams=new Map();
  for(let at=0;at+9<=http.length;){
    const size=http.readUIntBE(at,3),type=http[at+3],id=http.readUInt32BE(at+5)&0x7fffffff;if(at+9+size>http.length)throw Error('HTTP/2 frame bounds');
    const data=http.subarray(at+9,at+9+size);at+=9+size;const entry=streams.get(id)||{headers:new Map(),chunks:[]};streams.set(id,entry);
    if(type===1)for(const [name,value]of decodeHeaders(data))entry.headers.set(name,value);
    if(type===0)entry.chunks.push(data);
  }
  for(const entry of streams.values()){
    if(entry.headers.get('grpc-status')!=='0')continue;const bytes=Buffer.concat(entry.chunks);
    if(bytes.length<5||bytes.readUInt32BE(1)!==bytes.length-5)throw Error('gRPC length');
    const fields=proto(bytes[0]?gunzipSync(bytes.subarray(5)):bytes.subarray(5)),key=Buffer.from(entry.headers.get('x-session-key')||'','hex');
    if(!hash(key).equals(fields.get(2)))throw Error('Envelope recipient mismatch');
    return openSeal(JSON.parse(fields.get(3).toString('utf8')),key);
  }
  throw Error('No completed RPC');
}
