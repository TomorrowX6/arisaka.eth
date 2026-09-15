import initSqlJs from 'sql.js';
import { fileURLToPath } from 'node:url';
import { seal, sha256 } from '../core.mjs';
import { u32be } from './formats.mjs';
let engine;
const sqlEngine=()=>engine??=initSqlJs({locateFile:()=>fileURLToPath(new URL('../../node_modules/sql.js/dist/sql-wasm.wasm',import.meta.url))});
function checksum(bytes,previous=[0,0]){let [a,b]=previous;for(let at=0;at<bytes.length;at+=8){a=(a+bytes.readUInt32LE(at)+b)>>>0;b=(b+bytes.readUInt32LE(at+4)+a)>>>0;}return [a,b];}
export async function walEvidence(code,receipt,random){
  const SQL=await sqlEngine(),db=new SQL.Database();
  const capture=()=>{const bytes=Buffer.from(db.export());bytes[18]=bytes[19]=2;return bytes;};
  try{
    db.run('PRAGMA page_size=1024; PRAGMA secure_delete=ON; VACUUM; CREATE TABLE key_parts(generation INTEGER,slot INTEGER,payload BLOB NOT NULL,material BLOB NOT NULL,PRIMARY KEY(generation,slot)) WITHOUT ROWID; CREATE TABLE events(seq INTEGER PRIMARY KEY,action TEXT,generation INTEGER); CREATE VIEW key_sets AS SELECT generation,count(*) AS segments FROM key_parts GROUP BY generation;');
    const insert=db.prepare('INSERT INTO key_parts VALUES(?,?,?,?)');
    for(let generation=1;generation<=16;generation++)for(let slot=0;slot<3;slot++)insert.run([generation,slot,random(500+slot*73),random(32)]);
    insert.free();db.run("INSERT INTO events VALUES(1,'checkpoint',16)");
    const base=capture(),snapshots=[];
    const generation=23,parts=[random(32),random(32),random(32)],material=Buffer.concat(parts);
    for(let slot=0;slot<parts.length;slot++)db.run('INSERT INTO key_parts VALUES(?,?,?,?)',[generation,slot,random(8192+slot*67),parts[slot]]);
    db.run("INSERT INTO events VALUES(2,'activate',23)");snapshots.push(capture());
    for(let slot=0;slot<parts.length;slot++)db.run('UPDATE key_parts SET material=? WHERE generation=23 AND slot=?',[random(32),slot]);
    db.run("INSERT INTO events VALUES(3,'rotate',23)");snapshots.push(capture());
    db.run("DELETE FROM key_parts WHERE generation=23; INSERT INTO events VALUES(4,'revoke',23); VACUUM;");snapshots.push(capture());
    const pageSize=1024,salt=random(8),head=Buffer.concat([u32be(0x377f0682),u32be(3007000),u32be(pageSize),u32be(17),salt]);
    let rolling=checksum(head),previous=base;
    const output=[head,...rolling.map(u32be)];
    for(const snapshot of snapshots){
      const changed=[];
      for(let at=0;at<snapshot.length;at+=pageSize)if(!snapshot.subarray(at,at+pageSize).equals(previous.subarray(at,at+pageSize)))changed.push(at/pageSize+1);
      for(let i=changed.length-1;i>0;i--){const j=random(2).readUInt16BE(0)%(i+1);[changed[i],changed[j]]=[changed[j],changed[i]];}
      for(let i=0;i<changed.length;i++){
        const page=changed[i],content=snapshot.subarray((page-1)*pageSize,page*pageSize),prefix=Buffer.concat([u32be(page),u32be(i===changed.length-1?snapshot.length/pageSize:0)]);
        rolling=checksum(Buffer.concat([prefix,content]),rolling);output.push(prefix,salt,...rolling.map(u32be),content);
      }
      previous=snapshot;
    }
    // This final transaction never committed. Its last physical frame was torn.
    for(let page=1;page<=4;page++){
      const data=random(pageSize),prefix=Buffer.concat([u32be(page),u32be(0)]);rolling=checksum(Buffer.concat([prefix,data]),rolling);
      output.push(prefix,salt,...rolling.map(u32be),page===4?data.subarray(0,391):data);
    }
    return {'catalog.db':base,'journal.segment':Buffer.concat(output),'capsule.json':JSON.stringify({...seal({code,receipt},material,'afterglow/database',random),recipient:sha256(material).toString('hex'),keyset:{segments:3,encoding:'raw',order:'slot'}},null,2)};
  }finally{db.close();}
}
