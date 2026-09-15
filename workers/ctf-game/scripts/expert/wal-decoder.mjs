import initSqlJs from 'sql.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openSeal } from '../decoders.mjs';
let engine;
function checksum(bytes,little,initial=[0,0]){
  const read=offset=>little?bytes.readUInt32LE(offset):bytes.readUInt32BE(offset);let s0=initial[0],s1=initial[1];
  for(let i=0;i<bytes.length;i+=8){s0=(s0+read(i)+s1)>>>0;s1=(s1+read(i+4)+s0)>>>0;}return [s0,s1];
}
export function walSnapshots(base,wal){
  if(base.toString('ascii',0,16)!=='SQLite format 3\0'||wal.length<32)throw Error('Invalid database material');
  const magic=wal.readUInt32BE(0);if(magic!==0x377f0682&&magic!==0x377f0683)throw Error('Invalid WAL magic');
  const little=magic===0x377f0682,pageSize=wal.readUInt32BE(8),salt=wal.subarray(16,24);
  if(pageSize<512||pageSize>65536||pageSize&(pageSize-1))throw Error('Invalid WAL page size');
  let rolling=checksum(wal.subarray(0,24),little);
  if(rolling[0]!==wal.readUInt32BE(24)||rolling[1]!==wal.readUInt32BE(28))throw Error('WAL header checksum');
  const pages=new Map(),snapshots=[];let pending=new Map();
  for(let page=1;page<=base.length/pageSize;page++)pages.set(page,base.subarray((page-1)*pageSize,page*pageSize));
  for(let offset=32;offset+24+pageSize<=wal.length;offset+=24+pageSize){
    const prefix=wal.subarray(offset,offset+8),number=prefix.readUInt32BE(0),commit=prefix.readUInt32BE(4),data=wal.subarray(offset+24,offset+24+pageSize);
    if(!number||number>100000||!wal.subarray(offset+8,offset+16).equals(salt))break;
    const expected=checksum(Buffer.concat([prefix,data]),little,rolling);
    if(expected[0]!==wal.readUInt32BE(offset+16)||expected[1]!==wal.readUInt32BE(offset+20))break;
    rolling=expected;pending.set(number,data);
    if(!commit)continue;
    for(const [page,data]of pending)pages.set(page,data);pending=new Map();
    const restored=Buffer.alloc(commit*pageSize);
    for(let page=1;page<=commit;page++){const data=pages.get(page);if(!data)throw Error('Missing committed page');data.copy(restored,(page-1)*pageSize);}
    for(const page of pages.keys())if(page>commit)pages.delete(page);
    snapshots.push(restored);
  }
  return snapshots;
}
export async function decodeWalEvidence(base,wal,sealed){
  const SQL=await(engine??=initSqlJs({locateFile:()=>fileURLToPath(new URL('../../node_modules/sql.js/dist/sql-wasm.wasm',import.meta.url))}));
  for(const snapshot of walSnapshots(base,wal)){
    const portable=Buffer.from(snapshot);portable[18]=portable[19]=1;
    const db=new SQL.Database(portable);
    try{
      const rows=db.exec('SELECT generation,slot,material FROM key_parts ORDER BY generation,slot')[0]?.values||[],groups=new Map();
      for(const [generation,,part]of rows){const group=groups.get(generation)||[];group.push(Buffer.from(part));groups.set(generation,group);}
      for(const parts of groups.values()){
        if(parts.length!==sealed.keyset.segments)continue;const material=Buffer.concat(parts);
        if(createHash('sha256').update(material).digest('hex')===sealed.recipient)return openSeal(sealed,material);
      }
    }finally{db.close();}
  }
  throw Error('Recipient absent from committed history');
}
