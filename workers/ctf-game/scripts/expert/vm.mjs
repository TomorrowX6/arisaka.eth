import initWabt from 'wabt';
import { seal } from '../core.mjs';
const rol=(x,n)=>(x<<n|x>>>(32-n))>>>0;
const watBytes=bytes=>[...bytes].map(x=>'\\'+x.toString(16).padStart(2,'0')).join('');
function shuffle(random){const a=Uint8Array.from({length:256},(_,i)=>i);for(let i=255;i>0;i--){const j=random(2).readUInt16LE(0)%(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
const substitute=(x,box)=>(box[x&255]|box[x>>>8&255]<<8|box[x>>>16&255]<<16|box[x>>>24]<<24)>>>0;
export async function virtualMachine(code,receipt,random){
  const opcodeBytes=shuffle(random),opcodes=Buffer.alloc(256,255),box=shuffle(random);
  for(let i=1;i<=8;i++)opcodes[opcodeBytes[i]]=i;
  const state=Array.from({length:5},(_,i)=>Buffer.from(code).readUInt32LE(i*4)),program=[];
  for(let step=0;step<640;step++){
    const op=random(1)[0]%8+1,dst=random(1)[0]%5;let src=random(1)[0]%4;if(src>=dst)src++;
    const immediate=random(4).readUInt32LE(0),mask=rol(state[src],((dst+src)*3+op)%31+1),encoded=Buffer.alloc(8);
    encoded[0]=opcodeBytes[op];encoded[1]=dst;encoded[2]=src;encoded[3]=random(1)[0];encoded.writeUInt32LE((immediate^mask)>>>0,4);program.push(encoded);
    if(op===1)state[dst]=(state[dst]+state[src])>>>0;
    if(op===2)state[dst]=(state[dst]^state[src])>>>0;
    if(op===3)state[dst]=rol(state[dst],immediate&31);
    if(op===4)[state[dst],state[src]]=[state[src],state[dst]];
    if(op===5)state[dst]=(state[dst]+immediate)>>>0;
    if(op===6)state[dst]=(state[dst]^immediate)>>>0;
    if(op===7)state[dst]=Math.imul(state[dst],immediate|1)>>>0;
    if(op===8)state[dst]=(state[dst]^rol((substitute((state[src]+immediate)>>>0,box)+0x9e3779b9)>>>0,7))>>>0;
  }
  const target=Buffer.alloc(20);state.forEach((value,i)=>target.writeUInt32LE(value,i*4));
  const clear=Buffer.concat(program),encrypted=Buffer.alloc(clear.length),initial=random(4).readUInt32LE(0);let stream=initial;
  for(let i=0;i<clear.length;i++){stream=(Math.imul(stream,1664525)+1013904223)>>>0;encrypted[i]=clear[i]^(stream>>>24);}
  const descriptor=Buffer.alloc(32);descriptor.write('DVM3');[clear.length,initial,8192,2048,2304,2560,32768].forEach((value,i)=>descriptor.writeUInt32LE(value,(i+1)*4));
  const operations=[
    '(if (i32.eq (local.get $op) (i32.const 1)) (then (local.set $x (i32.add (local.get $x) (local.get $y)))))',
    '(if (i32.eq (local.get $op) (i32.const 2)) (then (local.set $x (i32.xor (local.get $x) (local.get $y)))))',
    '(if (i32.eq (local.get $op) (i32.const 3)) (then (local.set $x (i32.rotl (local.get $x) (local.get $imm)))))',
    '(if (i32.eq (local.get $op) (i32.const 4)) (then (i32.store (local.get $sp) (local.get $x)) (local.set $x (local.get $y))))',
    '(if (i32.eq (local.get $op) (i32.const 5)) (then (local.set $x (i32.add (local.get $x) (local.get $imm)))))',
    '(if (i32.eq (local.get $op) (i32.const 6)) (then (local.set $x (i32.xor (local.get $x) (local.get $imm)))))',
    '(if (i32.eq (local.get $op) (i32.const 7)) (then (local.set $x (i32.mul (local.get $x) (i32.or (local.get $imm) (i32.const 1))))))',
    '(if (i32.eq (local.get $op) (i32.const 8)) (then (local.set $x (i32.xor (local.get $x) (i32.rotl (i32.add (call $sub (i32.add (local.get $y) (local.get $imm))) (i32.const -1640531527)) (i32.const 7))))))',
  ];
  const source=`(module
    (memory (export "memory") 1 1)
    (data (i32.const 1024) "${watBytes(descriptor)}")
    (data (i32.const 2048) "${watBytes(target)}")
    (data (i32.const 2304) "${watBytes(opcodes)}")
    (data (i32.const 2560) "${watBytes(box)}")
    (data (i32.const 8192) "${watBytes(encrypted)}")
    (func $sub (param $v i32) (result i32) (local $i i32) (local $out i32)
      (loop $bytes
        (local.set $out (i32.or (local.get $out) (i32.shl
          (i32.load8_u (i32.add (i32.const 2560) (i32.and (i32.shr_u (local.get $v) (i32.mul (local.get $i) (i32.const 8))) (i32.const 255))))
          (i32.mul (local.get $i) (i32.const 8)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br_if $bytes (i32.lt_u (local.get $i) (i32.const 4)))) (local.get $out))
    (func (export "verify") (param $p i32) (param $length i32) (result i32)
      (local $i i32) (local $stream i32) (local $pc i32) (local $op i32) (local $dst i32) (local $src i32)
      (local $dp i32) (local $sp i32) (local $x i32) (local $y i32) (local $imm i32) (local $bad i32)
      (if (i32.or (i32.ne (local.get $length) (i32.const 20)) (i32.gt_u (local.get $p) (i32.const 65516))) (then (return (i32.const 0))))
      (loop $input (i32.store (i32.add (i32.const 512) (local.get $i)) (i32.load (i32.add (local.get $p) (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 4))) (br_if $input (i32.lt_u (local.get $i) (i32.const 20))))
      (local.set $i (i32.const 0)) (local.set $stream (i32.load (i32.const 1032)))
      (loop $decrypt
        (local.set $stream (i32.add (i32.mul (local.get $stream) (i32.const 1664525)) (i32.const 1013904223)))
        (i32.store8 (i32.add (i32.const 32768) (local.get $i)) (i32.xor (i32.load8_u (i32.add (i32.const 8192) (local.get $i))) (i32.shr_u (local.get $stream) (i32.const 24))))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br_if $decrypt (i32.lt_u (local.get $i) (i32.const ${clear.length}))))
      (loop $run
        (local.set $pc (i32.add (i32.const 32768) (local.get $pc)))
        (local.set $op (i32.load8_u (i32.add (i32.const 2304) (i32.load8_u (local.get $pc)))))
        (local.set $dst (i32.load8_u (i32.add (local.get $pc) (i32.const 1))))
        (local.set $src (i32.load8_u (i32.add (local.get $pc) (i32.const 2))))
        (if (i32.or (i32.ge_u (local.get $src) (i32.const 5)) (i32.ge_u (local.get $dst) (i32.const 5))) (then (return (i32.const 0))))
        (local.set $dp (i32.add (i32.const 512) (i32.mul (local.get $dst) (i32.const 4))))
        (local.set $sp (i32.add (i32.const 512) (i32.mul (local.get $src) (i32.const 4))))
        (local.set $x (i32.load (local.get $dp))) (local.set $y (i32.load (local.get $sp)))
        (local.set $imm (i32.xor (i32.load (i32.add (local.get $pc) (i32.const 4)))
          (i32.rotl (local.get $y) (i32.add (i32.rem_u (i32.add (i32.mul (i32.add (local.get $dst) (local.get $src)) (i32.const 3)) (local.get $op)) (i32.const 31)) (i32.const 1)))))
        ${operations.join('\n        ')}
        (i32.store (local.get $dp) (local.get $x))
        (local.set $pc (i32.add (i32.sub (local.get $pc) (i32.const 32768)) (i32.const 8)))
        (br_if $run (i32.lt_u (local.get $pc) (i32.const ${clear.length}))))
      (local.set $i (i32.const 0))
      (loop $compare (local.set $bad (i32.or (local.get $bad) (i32.xor (i32.load (i32.add (i32.const 512) (local.get $i))) (i32.load (i32.add (i32.const 2048) (local.get $i))))))
        (local.set $i (i32.add (local.get $i) (i32.const 4))) (br_if $compare (i32.lt_u (local.get $i) (i32.const 20))))
      (i32.eqz (local.get $bad))))`;
  const wabt=await initWabt(),module=wabt.parseWat('device.wat',source);let binary;
  try{module.validate();binary=Buffer.from(module.toBinary({write_debug_names:false}).buffer);}finally{module.destroy();}
  return {'glass.wasm':binary,'sealed-receipt.json':JSON.stringify(seal({code,receipt},Buffer.from(code),'afterglow/case-09',random),null,2),'interface.txt':'memory: 64 KiB\nverify(pointer:i32, length:i32) -> i32\n'};
}
