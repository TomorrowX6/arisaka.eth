// Operator-only inverse interpreter for the generated device image.
const rotl=(x,n)=>(x<<n|x>>>(32-n))>>>0;
function inverse32(value){let x=1;for(let i=0;i<5;i++)x=Math.imul(x,2-Math.imul(value,x));return x>>>0;}
export async function recoverMachineInput(binary){
  const {instance}=await WebAssembly.instantiate(binary),memory=Buffer.from(instance.exports.memory.buffer);
  const header=memory.indexOf(Buffer.from('DVM3'));if(header<0)throw Error('Missing device descriptor');
  const length=memory.readUInt32LE(header+4),initial=memory.readUInt32LE(header+8),programAt=memory.readUInt32LE(header+12),targetAt=memory.readUInt32LE(header+16),opcodeAt=memory.readUInt32LE(header+20),tableAt=memory.readUInt32LE(header+24);
  if(length%8||programAt+length>memory.length||opcodeAt+256>memory.length||tableAt+256>memory.length)throw Error('Invalid device descriptor');
  const program=Buffer.alloc(length);let stream=initial;
  for(let at=0;at<length;at++){stream=(Math.imul(stream,1664525)+1013904223)>>>0;program[at]=memory[programAt+at]^(stream>>>24);}
  const state=Array.from({length:5},(_,i)=>memory.readUInt32LE(targetAt+i*4)),table=memory.subarray(tableAt,tableAt+256);
  for(let at=program.length-8;at>=0;at-=8){
    const operation=memory[opcodeAt+program[at]],dst=program[at+1],src=program[at+2];
    if(dst>=5||src>=5||src===dst)throw Error('Invalid register index');
    if(operation===4){[state[dst],state[src]]=[state[src],state[dst]];continue;}
    const operand=(program.readUInt32LE(at+4)^rotl(state[src],((dst+src)*3+operation)%31+1))>>>0;
    if(operation===1)state[dst]=(state[dst]-state[src])>>>0;
    else if(operation===2)state[dst]=(state[dst]^state[src])>>>0;
    else if(operation===3)state[dst]=rotl(state[dst],(32-(operand&31))&31);
    else if(operation===5)state[dst]=(state[dst]-operand)>>>0;
    else if(operation===6)state[dst]=(state[dst]^operand)>>>0;
    else if(operation===7)state[dst]=Math.imul(state[dst],inverse32(operand|1))>>>0;
    else if(operation===8){const input=(state[src]+operand)>>>0;const substituted=(table[input&255]|table[input>>>8&255]<<8|table[input>>>16&255]<<16|table[input>>>24]<<24)>>>0;state[dst]=(state[dst]^rotl((substituted+0x9e3779b9)>>>0,7))>>>0;}
    else throw Error('Invalid instruction');
  }
  const result=Buffer.alloc(20);state.forEach((value,i)=>result.writeUInt32LE(value,i*4));memory.set(result,0);
  if(instance.exports.verify(0,20)!==1)throw Error('Inverse program fails device verification');
  return result;
}
