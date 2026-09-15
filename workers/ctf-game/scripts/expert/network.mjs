import { u16be, u32be } from './formats.mjs';
export function internetChecksum(bytes){let sum=0;for(let i=0;i<bytes.length;i+=2)sum+=(bytes[i]<<8)|(bytes[i+1]||0);while(sum>>>16)sum=(sum&65535)+(sum>>>16);return ~sum&65535;}
const ip=address=>Buffer.from(address.split('.').map(Number));
export function ethernetIPv4(payload,protocol,source,destination,id=1){
  const header=Buffer.concat([Buffer.from([0x45,0]),u16be(payload.length+20),u16be(id&65535),u16be(0x4000),Buffer.from([64,protocol]),u16be(0),ip(source),ip(destination)]);
  header.writeUInt16BE(internetChecksum(header),10);
  return Buffer.concat([Buffer.from('0200000000020200000000010800','hex'),header,payload]);
}
export function tcp(payload,{source='192.0.2.10',destination='192.0.2.20',sport=443,dport=49152,seq=1,ack=1,flags=0x18,id=1}={}){
  payload=Buffer.from(payload);
  const header=Buffer.concat([u16be(sport),u16be(dport),u32be(seq),u32be(ack),Buffer.from([0x50,flags]),u16be(65535),u16be(0),u16be(0)]);
  const pseudo=Buffer.concat([ip(source),ip(destination),Buffer.from([0,6]),u16be(header.length+payload.length),header,payload]);
  header.writeUInt16BE(internetChecksum(pseudo),16);
  return ethernetIPv4(Buffer.concat([header,payload]),6,source,destination,id);
}
export function udp(payload,{source='198.51.100.53',destination='198.51.100.10',sport=53,dport=53000,id=1}={}){
  const header=Buffer.concat([u16be(sport),u16be(dport),u16be(payload.length+8),u16be(0)]);
  const pseudo=Buffer.concat([ip(source),ip(destination),Buffer.from([0,17]),u16be(payload.length+8),header,payload]);
  header.writeUInt16BE(internetChecksum(pseudo)||65535,6);
  return ethernetIPv4(Buffer.concat([header,payload]),17,source,destination,id);
}
