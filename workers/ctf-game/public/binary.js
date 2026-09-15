export const hex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
export function unhex(text) {
  const value = String(text).replace(/\s+/g, '');
  if (!/^(?:[a-f\d]{2})*$/i.test(value)) throw new Error('十六进制格式无效');
  return Uint8Array.from(value.match(/../g) || [], (byte) => parseInt(byte, 16));
}
export function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export function fromBase64(value) { return Uint8Array.from(atob(value.replace(/\s/g, '')), (char) => char.charCodeAt(0)); }
export function concat(...parts) { const out = new Uint8Array(parts.reduce((n,part)=>n+part.length,0)); let offset=0; for(const part of parts){out.set(part,offset);offset+=part.length;} return out; }
export function hexdump(bytes, offset = 0, count = bytes.length, columns = 16) {
  const lines = [];
  for (let at = offset; at < Math.min(bytes.length, offset + count); at += columns) {
    const row = bytes.subarray(at, Math.min(at + columns, offset + count));
    lines.push(at.toString(16).padStart(8, '0') + '  ' + [...row].map((n)=>n.toString(16).padStart(2,'0')).join(' ').padEnd(columns*3-1,' ') + '  |' + [...row].map((n)=>n>=32&&n<127?String.fromCharCode(n):'.').join('') + '|');
  }
  return lines.join('\n');
}
export function entropy(bytes) {
  if (!bytes.length) return 0;
  const counts = new Uint32Array(256); for (const byte of bytes) counts[byte]++;
  return counts.reduce((sum,n)=>n?sum-n/bytes.length*Math.log2(n/bytes.length):sum,0);
}
export function findBytes(bytes, query, start = 0) {
  if (!query.length) return -1;
  const skip = new Uint32Array(256); skip.fill(query.length);
  for(let index=0;index<query.length-1;index++) skip[query[index]]=query.length-1-index;
  for(let index=Math.max(0,start);index<=bytes.length-query.length;){let at=query.length-1;while(at>=0&&bytes[index+at]===query[at])at--;if(at<0)return index;index+=skip[bytes[index+query.length-1]];}
  return -1;
}
const decoder = new TextDecoder();
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function within(bytes, offset, length) { if (!Number.isSafeInteger(length) || length < 0 || offset < 0 || offset + length > bytes.length) throw new Error('文件已截断'); }
const ip4 = (bytes) => [...bytes].join('.');
const ip6 = (bytes) => Array.from({length:8},(_,i)=>((bytes[i*2]<<8)|bytes[i*2+1]).toString(16)).join(':');

export function decodePacket(bytes, linkType = 1) {
  const packet = { source:'', destination:'', protocol:'DATA', info:'', payload:bytes, linkType };
  const view = viewOf(bytes);
  let offset=0, protocol=0;
  if(linkType===1){within(bytes,0,14);protocol=view.getUint16(12);offset=14;
    while(protocol===0x8100||protocol===0x88a8){within(bytes,offset,4);packet.vlan=view.getUint16(offset)&4095;protocol=view.getUint16(offset+2);offset+=4;}
    packet.macSource=hex(bytes.subarray(6,12)).match(/../g).join(':');packet.macDestination=hex(bytes.subarray(0,6)).match(/../g).join(':');
  }else if(linkType===101||linkType===228||linkType===229){within(bytes,0,1);protocol=bytes[0]>>4===6?0x86dd:0x0800;}
  else if(linkType===113){within(bytes,0,16);protocol=view.getUint16(14);offset=16;}
  else return packet;
  let end=bytes.length, transport;
  if(protocol===0x0800){within(bytes,offset,20);const ihl=(bytes[offset]&15)*4,total=view.getUint16(offset+2);if(ihl<20||total<ihl||bytes[offset]>>4!==4)throw new Error('IPv4 长度无效');within(bytes,offset,ihl);end=Math.min(bytes.length,offset+total);transport=bytes[offset+9];packet.source=ip4(bytes.subarray(offset+12,offset+16));packet.destination=ip4(bytes.subarray(offset+16,offset+20));packet.ipId=view.getUint16(offset+4);packet.fragmentOffset=(view.getUint16(offset+6)&8191)*8;packet.moreFragments=Boolean(view.getUint16(offset+6)&8192);offset+=ihl;packet.protocol='IPv4';
    if(packet.fragmentOffset){packet.payload=bytes.subarray(offset,end);packet.info='Fragment offset='+packet.fragmentOffset;return packet;}
  }else if(protocol===0x86dd){within(bytes,offset,40);end=Math.min(bytes.length,offset+40+view.getUint16(offset+4));transport=bytes[offset+6];packet.source=ip6(bytes.subarray(offset+8,offset+24));packet.destination=ip6(bytes.subarray(offset+24,offset+40));offset+=40;packet.protocol='IPv6';let extensions=0;
    while([0,43,44,60,51].includes(transport)){if(++extensions>12)throw new Error('IPv6 扩展头过多');within(bytes,offset,8);const next=bytes[offset],length=transport===44?8:transport===51?(bytes[offset+1]+2)*4:(bytes[offset+1]+1)*8;within(bytes,offset,length);if(transport===44){packet.fragmentOffset=view.getUint16(offset+2)&0xfff8;packet.moreFragments=Boolean(bytes[offset+3]&1);}offset+=length;transport=next;if(packet.fragmentOffset)break;}
    if(packet.fragmentOffset){packet.payload=bytes.subarray(offset,end);return packet;}
  }else if(protocol===0x0806){packet.protocol='ARP';packet.info='ARP';return packet;}
  else {packet.protocol='Ethernet';packet.info='0x'+protocol.toString(16);return packet;}
  if(transport===6){within(bytes.subarray(0,end),offset,20);const length=(bytes[offset+12]>>4)*4;if(length<20)throw new Error('TCP 头长度无效');within(bytes.subarray(0,end),offset,length);packet.protocol='TCP';packet.sourcePort=view.getUint16(offset);packet.destinationPort=view.getUint16(offset+2);packet.sequence=view.getUint32(offset+4);packet.acknowledgment=view.getUint32(offset+8);packet.flags=bytes[offset+13];packet.window=view.getUint16(offset+14);packet.payload=bytes.subarray(offset+length,end);packet.info=packet.sourcePort+' → '+packet.destinationPort+' ['+['FIN','SYN','RST','PSH','ACK','URG','ECE','CWR'].filter((_,i)=>packet.flags&(1<<i)).join(', ')+'] Seq='+packet.sequence+' Ack='+packet.acknowledgment+' Len='+packet.payload.length;
  }else if(transport===17){within(bytes.subarray(0,end),offset,8);const length=view.getUint16(offset+4);if(length<8)throw new Error('UDP 长度无效');packet.protocol='UDP';packet.sourcePort=view.getUint16(offset);packet.destinationPort=view.getUint16(offset+2);packet.payload=bytes.subarray(offset+8,Math.min(end,offset+length));packet.info=packet.sourcePort+' → '+packet.destinationPort+' Len='+packet.payload.length;
    if(packet.sourcePort===53||packet.destinationPort===53){packet.protocol='DNS';try{const dns=decodeDns(packet.payload);packet.dns=dns;packet.info=(dns.response?'Response ':'Query ')+dns.id.toString(16)+' '+dns.questions.map((q)=>q.name).join(' ');}catch{packet.info+=' [malformed DNS]';}}
  }else{packet.protocol=transport===1?'ICMP':transport===58?'ICMPv6':'IP/'+transport;packet.payload=bytes.subarray(offset,end);packet.info='Len='+packet.payload.length;}
  return packet;
}

export function decodeDns(bytes) {
  within(bytes,0,12);const view=viewOf(bytes);const result={id:view.getUint16(0),response:Boolean(bytes[2]&0x80),rcode:bytes[3]&15,questions:[],answers:[]};
  function name(start){let at=start,end=start,labels=[],jumped=false;const seen=new Set();for(let step=0;step<128;step++){within(bytes,at,1);if(seen.has(at))throw new Error('DNS 压缩循环');seen.add(at);const n=bytes[at++];if(!n){if(!jumped)end=at;return {name:labels.join('.'),end};}if((n&0xc0)===0xc0){within(bytes,at,1);if(!jumped)end=at+1;at=((n&63)<<8)|bytes[at];jumped=true;continue;}if(n>63)throw new Error('DNS 标签长度无效');within(bytes,at,n);labels.push(decoder.decode(bytes.subarray(at,at+n)));at+=n;if(!jumped)end=at;}throw new Error('DNS 名称过长');}
  let offset=12;const qd=view.getUint16(4),an=view.getUint16(6);if(qd+an>1024)throw new Error('DNS 记录过多');
  for(let i=0;i<qd;i++){const q=name(offset);offset=q.end;within(bytes,offset,4);result.questions.push({name:q.name,type:view.getUint16(offset),class:view.getUint16(offset+2)});offset+=4;}
  for(let i=0;i<an;i++){const q=name(offset);offset=q.end;within(bytes,offset,10);const type=view.getUint16(offset),ttl=view.getUint32(offset+4),length=view.getUint16(offset+8);offset+=10;within(bytes,offset,length);const raw=bytes.subarray(offset,offset+length);result.answers.push({name:q.name,type,ttl,data:type===1&&length===4?ip4(raw):type===16?decoder.decode(raw.subarray(1,1+raw[0])):hex(raw)});offset+=length;}
  return result;
}

export function parseCapture(bytes, maximum = 100000) {
  const view=viewOf(bytes),packets=[];within(bytes,0,4);
  function add(data,linkType,timestamp,originalLength,interfaceId=0){if(packets.length>=maximum)throw new Error('数据包数量超过限制');let decoded;try{decoded=decodePacket(data,linkType);}catch(error){decoded={protocol:'Malformed',source:'',destination:'',payload:data,info:error.message};}packets.push({number:packets.length+1,timestamp,originalLength,interfaceId,bytes:data,...decoded});}
  if(view.getUint32(0)===0x0a0d0d0a){
    let offset=0,little=true,interfaces=[],section=0;
    while(offset<bytes.length){within(bytes,offset,12);const isSection=view.getUint32(offset)===0x0a0d0d0a;
      if(isSection){within(bytes,offset,28);const magic=view.getUint32(offset+8);if(magic!==0x1a2b3c4d&&magic!==0x4d3c2b1a)throw new Error('PCAPNG 字节序无效');little=magic===0x4d3c2b1a;interfaces=[];section++;}
      const type=view.getUint32(offset,little),length=view.getUint32(offset+4,little);if(length<12||length%4)throw new Error('PCAPNG 块长度无效');within(bytes,offset,length);if(view.getUint32(offset+length-4,little)!==length)throw new Error('PCAPNG 块尾无效');
      if(type===1){if(length<20)throw new Error('PCAPNG 接口无效');const entry={linkType:view.getUint16(offset+8,little),snaplen:view.getUint32(offset+12,little),resolution:1e-6,timeOffset:0,section};let at=offset+16;while(at+4<=offset+length-4){const code=view.getUint16(at,little),size=view.getUint16(at+2,little);at+=4;if(!code)break;within(bytes.subarray(0,offset+length-4),at,size);if(code===9&&size===1)entry.resolution=bytes[at]&128?2**-(bytes[at]&127):10**-bytes[at];if(code===14&&size===8)entry.timeOffset=Number(view.getBigInt64(at,little));at+=Math.ceil(size/4)*4;}interfaces.push(entry);}
      if(type===6){if(length<32)throw new Error('PCAPNG 数据包无效');const id=view.getUint32(offset+8,little),entry=interfaces[id];if(!entry)throw new Error('PCAPNG 接口不存在');const captured=view.getUint32(offset+20,little),original=view.getUint32(offset+24,little);if(captured>length-32)throw new Error('PCAPNG 捕获长度无效');const stamp=(BigInt(view.getUint32(offset+12,little))<<32n)|BigInt(view.getUint32(offset+16,little));add(bytes.subarray(offset+28,offset+28+captured),entry.linkType,Number(stamp)*entry.resolution+entry.timeOffset,original,id);}
      if(type===3){if(length<16||!interfaces[0])throw new Error('PCAPNG 简单数据包无效');const original=view.getUint32(offset+8,little),captured=Math.min(original,interfaces[0].snaplen||original);if(captured>length-16)throw new Error('PCAPNG 捕获长度无效');add(bytes.subarray(offset+12,offset+12+captured),interfaces[0].linkType,0,original);}
      offset+=length;
    }
  }else{
    within(bytes,0,24);const magic=view.getUint32(0),little=[0xd4c3b2a1,0x4d3cb2a1].includes(magic),nano=[0xa1b23c4d,0x4d3cb2a1].includes(magic);if(![0xa1b2c3d4,0xd4c3b2a1,0xa1b23c4d,0x4d3cb2a1].includes(magic))throw new Error('不是 PCAP/PCAPNG 文件');const linkType=view.getUint32(20,little)&0xffff;let offset=24;
    while(offset<bytes.length){within(bytes,offset,16);const stamp=view.getUint32(offset,little)+view.getUint32(offset+4,little)/(nano?1e9:1e6),captured=view.getUint32(offset+8,little),original=view.getUint32(offset+12,little);within(bytes,offset+16,captured);add(bytes.subarray(offset+16,offset+16+captured),linkType,stamp,original);offset+=16+captured;}
  }
  const streams=new Map();
  for(const packet of packets){if(packet.protocol!=='TCP')continue;const endpoints=[packet.source+':'+packet.sourcePort,packet.destination+':'+packet.destinationPort].sort(),key=endpoints.join(' ↔ ');if(!streams.has(key))streams.set(key,streams.size);packet.stream=streams.get(key);}
  return {packets,streams:[...streams.keys()]};
}

export function reassembleTcp(packets, direction, { lastWins = false, limit = 32 * 1024 * 1024 } = {}) {
  const parts=packets.filter((p)=>p.protocol==='TCP'&&(!direction||p.source+':'+p.sourcePort===direction));
  const anchor=parts.find((p)=>p.flags&2)||parts.find((p)=>p.payload.length);
  if(!anchor)return {bytes:new Uint8Array(),gaps:[],overlaps:0};
  const origin=(anchor.sequence+(anchor.flags&2?1:0))>>>0;
  const offsets=parts.filter((p)=>p.payload.length).map((p)=>({packet:p,offset:((p.sequence+(p.flags&2?1:0))>>>0)-origin})).map((part)=>({...part,offset:part.offset>0x7fffffff?part.offset-0x100000000:part.offset<-0x80000000?part.offset+0x100000000:part.offset}));
  if(!offsets.length)return {bytes:new Uint8Array(),gaps:[],overlaps:0};
  const start=Math.min(0,...offsets.map((p)=>p.offset)),end=Math.max(...offsets.map((p)=>p.offset+p.packet.payload.length));
  if(end-start>limit)throw new Error('TCP 流超过大小限制');
  const bytes=new Uint8Array(end-start),seen=new Uint8Array(bytes.length);let overlaps=0;
  for(const part of offsets)for(let i=0;i<part.packet.payload.length;i++){const at=part.offset-start+i;if(seen[at])overlaps++;if(!seen[at]||lastWins)bytes[at]=part.packet.payload[i];seen[at]=1;}
  const gaps=[];for(let i=0;i<seen.length;i++)if(!seen[i]){const begin=i;while(i<seen.length&&!seen[i])i++;gaps.push([begin,i]);}
  return {bytes,gaps,overlaps};
}

export function zipIndex(bytes) {
  const view=viewOf(bytes);let end=-1;
  for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--)if(view.getUint32(at,true)===0x06054b50&&at+22+view.getUint16(at+20,true)===bytes.length){end=at;break;}
  if(end<0)throw new Error('ZIP 目录不存在');
  if(view.getUint16(end+4,true)||view.getUint16(end+6,true))throw new Error('不支持分卷 ZIP');
  const count=view.getUint16(end+10,true),size=view.getUint32(end+12,true),start=view.getUint32(end+16,true);within(bytes,start,size);let at=start,total=0;const entries=[];
  if(count>4096||count===0xffff)throw new Error('ZIP 条目过多');
  for(let i=0;i<count;i++){within(bytes,at,46);if(view.getUint32(at,true)!==0x02014b50)throw new Error('ZIP 目录无效');const flags=view.getUint16(at+8,true),method=view.getUint16(at+10,true),compressed=view.getUint32(at+20,true),length=view.getUint32(at+24,true),nameLength=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true);within(bytes,at+46,nameLength+extra+comment);const name=decoder.decode(bytes.subarray(at+46,at+46+nameLength));total+=length;if(length>32*1024*1024||total>64*1024*1024)throw new Error('ZIP 解压大小超过限制');entries.push({name,size:length,compressed,method,encrypted:Boolean(flags&1),directory:name.endsWith('/'),offset:view.getUint32(at+42,true)});at+=46+nameLength+extra+comment;}
  if(at>start+size)throw new Error('ZIP 目录长度无效');
  return entries;
}
export function tarIndex(bytes) {
  const entries=[];let at=0;
  while(at+512<=bytes.length){const header=bytes.subarray(at,at+512);if(header.every((byte)=>byte===0))break;const str=(a,b)=>decoder.decode(header.subarray(a,b)).replace(/\0.*$/s,'').trim();const size=parseInt(str(124,136)||'0',8),checksum=parseInt(str(148,156),8);let actual=0;for(let i=0;i<512;i++)actual+=i>=148&&i<156?32:header[i];if(checksum!==actual||!Number.isSafeInteger(size)||size<0)throw new Error('TAR 头无效');within(bytes,at+512,size);const prefix=str(345,500),name=(prefix?prefix+'/':'')+str(0,100);const type=String.fromCharCode(header[156]);entries.push({name,size,compressed:size,directory:type==='5',type,bytes:bytes.subarray(at+512,at+512+size)});if(entries.length>4096)throw new Error('TAR 条目过多');at+=512+Math.ceil(size/512)*512;}
  if(!entries.length)throw new Error('TAR 目录为空或格式无效');return entries;
}
