import { createHash } from 'node:crypto';
export const hash = (algorithm, value) => createHash(algorithm).update(value).digest();
export const u16le = value => { const b=Buffer.alloc(2); b.writeUInt16LE(value); return b; };
export const u16be = value => { const b=Buffer.alloc(2); b.writeUInt16BE(value); return b; };
export const u32le = value => { const b=Buffer.alloc(4); b.writeUInt32LE(value>>>0); return b; };
export const u32be = value => { const b=Buffer.alloc(4); b.writeUInt32BE(value>>>0); return b; };
export const pad4 = bytes => Buffer.concat([bytes, Buffer.alloc((4-bytes.length%4)%4)]);

export function tar(entries) {
  const output=[];
  for(const [name, value] of Object.entries(entries)) {
    const item=Buffer.isBuffer(value)||typeof value==='string'?{data:Buffer.from(value)}:value;
    const data=Buffer.from(item.data||''), header=Buffer.alloc(512);
    let path=name,prefix='';
    if(Buffer.byteLength(path)>100) { const i=path.lastIndexOf('/'); prefix=path.slice(0,i); path=path.slice(i+1); }
    if(Buffer.byteLength(path)>100 || Buffer.byteLength(prefix)>155) throw Error('USTAR path too long');
    header.write(path,0,100); header.write((item.mode||0o644).toString(8).padStart(7,'0')+'\0',100);
    header.write('0000000\0',108); header.write('0000000\0',116);
    header.write(data.length.toString(8).padStart(11,'0')+'\0',124);
    header.write('14552661400\0',136); header.fill(32,148,156);
    header[156]=(item.type||'0').charCodeAt(0); header.write(item.link||'',157,100);
    header.write('ustar\0',257); header.write('00',263); header.write('root',265); header.write('root',297); header.write(prefix,345,155);
    const sum=header.reduce((n,b)=>n+b,0); header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
    output.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  return Buffer.concat([...output,Buffer.alloc(1024)]);
}

export function pcapng(packets, interfaces=[{linkType:1,snaplen:65535}]) {
  const block=(type,body)=>{const padded=pad4(body),length=padded.length+12;return Buffer.concat([u32le(type),u32le(length),padded,u32le(length)]);};
  const output=[block(0x0a0d0d0a,Buffer.concat([u32le(0x1a2b3c4d),u16le(1),u16le(0),Buffer.alloc(8,255)]))];
  for(const item of interfaces) output.push(block(1,Buffer.concat([u16le(item.linkType),u16le(0),u32le(item.snaplen)])));
  for(const packet of packets) {
    const stamp=BigInt(packet.time??0),bytes=Buffer.from(packet.bytes);
    output.push(block(6,Buffer.concat([u32le(packet.interface??0),u32le(Number(stamp>>32n)),u32le(Number(stamp&0xffffffffn)),u32le(bytes.length),u32le(bytes.length),pad4(bytes)])));
  }
  return Buffer.concat(output);
}
export function wave(samples, rate=48000, channels=2) {
  const data=Buffer.alloc(samples.length*2);
  for(let i=0;i<samples.length;i++) data.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(samples[i]))),i*2);
  return Buffer.concat([Buffer.from('RIFF'),u32le(data.length+36),Buffer.from('WAVEfmt '),u32le(16),u16le(1),u16le(channels),u32le(rate),u32le(rate*channels*2),u16le(channels*2),u16le(16),Buffer.from('data'),u32le(data.length),data]);
}
