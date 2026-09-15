import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { calculate, modpow, inverse } from '../public/calculator.js';
import { hex, unhex, findBytes, entropy, parseCapture, reassembleTcp, zipIndex, decodeDns } from '../public/binary.js';
import { diffLines, mergeThreeWay, renderMerge } from '../public/diff.js';
import { floodFill, rotatePixels } from '../public/pixels.js';
import { parseColorScheme, serializeColorScheme, normalizeShortcut, validateShortcuts, matchesShortcut } from '../public/desktop-config.js';
import { parseCallgrind, rgbToHsv, hsvToRgb } from '../public/profiler.js';

test('KDE color schemes round-trip standard RGB groups and reject invalid channels', () => {
  const colors = { bg:'#232629',panel:'#31363b',raised:'#3b4045',sidebar:'#2a2e32',ink:'#eff0f1',muted:'#a1a9b1',line:'#4d5257',accent:'#3daee9' };
  const text=serializeColorScheme(colors,'Breeze\nUnsafe=Name');
  assert.deepEqual(parseColorScheme(text).colors,colors);
  assert.equal(parseColorScheme(text.replaceAll('\n','\r\n')).name,'Breeze Unsafe Name');
  assert.throws(()=>parseColorScheme(text.replace('35,38,41','256,38,41')),/范围/);
  assert.throws(()=>parseColorScheme(text.replace('35,38,41','url(https://example.invalid)')),/RGB/);
  assert.throws(()=>parseColorScheme('[General]\nName=Empty'),/缺少/);
});

test('desktop shortcuts normalize modifiers, reject conflicts, and do not intercept IME or dialogs', () => {
  assert.equal(normalizeShortcut(' Alt + Ctrl + T , Alt + F2 '),'Ctrl+Alt+T, Alt+F2');
  assert.equal(normalizeShortcut(''),'');assert.equal(validateShortcuts({}),true);
  assert.throws(()=>normalizeShortcut('Ctrl+Ctrl+X'));assert.throws(()=>normalizeShortcut('A'));
  assert.throws(()=>normalizeShortcut('Shift+Z'));assert.throws(()=>validateShortcuts({shortcuts:{files:'Ctrl+Alt+T'}}),/Konsole/);
  const event={key:'t',code:'KeyT',ctrlKey:true,altKey:true};
  assert.equal(matchesShortcut(event,{},'console'),true);
  assert.equal(matchesShortcut({...event,shiftKey:true},{},'console'),false);
  assert.equal(matchesShortcut({...event,isComposing:true},{},'console'),false);
  assert.equal(matchesShortcut({...event,target:{closest:()=>true}},{},'console'),false);
});

test('KCachegrind decodes compressed names, relative costs and recursion without double counting', () => {
  const text=['version: 1','positions: line instr','events: Ir Dr','ob=(1) program','fl=(1) main.c','fn=(1) main','10 0x1000 9007199254740993 2','+1 +4 12 4','cfn=(2) worker','calls=3 20 0x1100','* * 30 8','fn=(2)','20 0x1100 10 3','cfn=(2)','calls=1 20 0x1100','* * 20 5'].join('\n');
  const parsed=parseCallgrind(text),main=parsed.functions.find(item=>item.name==='main'),worker=parsed.functions.find(item=>item.name==='worker');
  assert.equal(parsed.functions.length,2);assert.equal(main.self[0],9007199254741005n);assert.equal(main.inclusive[0],9007199254741035n);
  assert.deepEqual(main.lines[1].position,[11n,4100n]);assert.equal(worker.calls,4n);assert.equal(worker.self[0],10n);assert.equal(worker.inclusive[0],30n);
  assert.equal(parsed.total[0],9007199254741015n);assert.equal(parsed.edges.length,2);
  assert.throws(()=>parseCallgrind(text.replace('fn=(1) main','fn=(1)')),/压缩名称/);
  assert.throws(()=>parseCallgrind(text+'\ncalls=1 1'),/不完整/);
  assert.throws(()=>parseCallgrind(text+'\n-100 * 1 2'),/范围/);
});

test('KColorChooser conversions preserve RGB colors including achromatic endpoints', () => {
  for(const rgb of [[0,0,0],[255,255,255],[255,0,0],[61,174,233],[32,32,32],[255,255,0],[17,3,245]])assert.deepEqual(hsvToRgb(rgbToHsv(rgb)),rgb);
  assert.deepEqual(hsvToRgb([360,100,100]),[255,0,0]);assert.throws(()=>rgbToHsv([-1,0,0]));assert.throws(()=>hsvToRgb([0,101,100]));
});

test('KolourPaint flood fill respects connected regions and rotation preserves RGBA pixels', () => {
  const image = { width: 3, height: 2, data: Uint8ClampedArray.from([255,0,0,255, 0,0,0,255, 255,0,0,255, 255,0,0,255, 0,0,0,255, 255,0,0,255]) };
  assert.equal(floodFill(image, 0, 0, [0, 255, 0, 255]), 2);
  assert.deepEqual([...image.data.slice(8, 12)], [255,0,0,255]);
  assert.equal(floodFill(image, 0, 0, [0, 255, 0, 255]), 0);
  const rotated = rotatePixels(image);
  assert.equal(rotated.width, 2); assert.equal(rotated.height, 3);
  assert.deepEqual(rotatePixels(rotated, false), image);
  assert.throws(() => floodFill(image, -1, 0, [1, 2, 3, 4]));
});

test('KDiff3 preserves line endings, non-overlapping edits, insertions, and explicit conflicts', () => {
  for (const [a, b] of [['', 'a\n'], ['a\n', ''], ['a\r\nb', 'a\nb\n'], ['a\nb\nc\n', 'a\nx\nc\n'], ['same', 'same']]) {
    const operations = diffLines(a, b);
    assert.equal(operations.filter(item => item.type !== 'insert').map(item => item.value).join(''), a);
    assert.equal(operations.filter(item => item.type !== 'delete').map(item => item.value).join(''), b);
  }
  assert.equal(renderMerge(mergeThreeWay('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n')), 'A\nb\nC\n');
  assert.equal(renderMerge(mergeThreeWay('a\nb\n', 'x\na\nb\n', 'A\nb\n')), 'x\nA\nb\n');
  assert.equal(renderMerge(mergeThreeWay('a\nb\n', 'a\nB\n', 'A\nb\n')), 'A\nB\n');
  assert.equal(renderMerge(mergeThreeWay('a\n', 'A\n', 'A\n')), 'A\n');
  const conflict = mergeThreeWay('base\n', 'left\n', 'right\n');
  assert.equal(conflict.filter(segment => segment.type === 'conflict').length, 1);
  assert.match(renderMerge(conflict), /<<<<<<< A/);
  assert.equal(renderMerge(conflict, new Map([[0, 'a']])), 'left\n');
  assert.equal(renderMerge(conflict, new Map([[0, 'b']])), 'right\n');
  const large = diffLines('left\n'.repeat(3000), 'right\n'.repeat(3000));
  assert.equal(large.filter(item => item.type === 'delete').length, 3000);
  assert.equal(large.filter(item => item.type === 'insert').length, 3000);
});

test('calculator preserves integer precision, operator precedence and modular arithmetic', () => {
  const integer = { integer: true };
  assert.equal(calculate('2**128+1', integer), 340282366920938463463374607431768211457n);
  assert.equal(calculate('-2**2', integer), -4n);
  assert.equal(calculate('2**3**2', integer), 512n);
  assert.equal(calculate('0xff & (0b101010 << 2)', integer), 168n);
  assert.equal(calculate('modpow(123456789, 987654321, 1000000007)', integer), 652541198n);
  assert.equal(calculate('gcd(120,84)', integer), 12n);
  assert.equal(calculate('inv(17,3120)', integer), 2753n);
  assert.equal(calculate('5!', integer), 120n);
  assert.ok(Math.abs(calculate('sin(30)', { degrees: true }) - .5) < 1e-12);
  assert.equal(calculate('max(4,2,7)-sqrt(9)'), 4);
  assert.equal(modpow(10n, 0n, 1n), 0n);
  assert.throws(() => inverse(6n, 12n), /不可逆/);
});

test('calculator rejects executable source, huge exponents and malformed expressions', () => {
  for (const input of ['globalThis.fetch(1)', '1;2', 'alert(1)', '1/0', 'sqrt(-1)', 'sin(1,2)', '(1+2', '1..2', '2 3']) assert.throws(() => calculate(input));
  for (const input of ['2**999999999', '1 << 999999', '1 >> -1', '0xff + 1.5', 'inv(2,0)']) assert.throws(() => calculate(input, { integer: true }));
  assert.throws(() => calculate('('.repeat(70)+'1'+')'.repeat(70)), /嵌套/);
});

test('binary helpers are reversible and handle byte values at the edges', () => {
  const bytes=Uint8Array.from({length:256},(_,i)=>i);
  assert.deepEqual(unhex(hex(bytes)),bytes);
  assert.equal(entropy(bytes),8);
  assert.equal(entropy(new Uint8Array(100)),0);
  assert.equal(findBytes(bytes,new Uint8Array([253,254,255])),253);
  assert.equal(findBytes(bytes,new Uint8Array([255,0])),-1);
  assert.equal(findBytes(bytes,new Uint8Array()),-1);
  for(const input of ['a','gg','0x01','00_01'])assert.throws(()=>unhex(input));
});

function tcpFrame(payload, sequence=1) {
  const frame=Buffer.alloc(54+payload.length);frame.writeUInt16BE(0x0800,12);frame[14]=0x45;frame.writeUInt16BE(40+payload.length,16);frame[22]=64;frame[23]=6;frame.set([192,0,2,1],26);frame.set([192,0,2,2],30);frame.writeUInt16BE(44000,34);frame.writeUInt16BE(443,36);frame.writeUInt32BE(sequence,38);frame[46]=0x50;frame[47]=0x18;frame.set(payload,54);return frame;
}
function pcap(frame,little,nano) {
  const bytes=Buffer.alloc(40+frame.length),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);
  view.setUint32(0,nano?0xa1b23c4d:0xa1b2c3d4,little);view.setUint16(4,2,little);view.setUint16(6,4,little);view.setUint32(16,65535,little);view.setUint32(20,1,little);view.setUint32(24,1234,little);view.setUint32(28,nano?500000000:500000,little);view.setUint32(32,frame.length,little);view.setUint32(36,frame.length,little);bytes.set(frame,40);return bytes;
}
test('capture reader supports both endian variants and timestamp precisions', () => {
  for(const little of [false,true])for(const nano of [false,true]){
    const {packets,streams}=parseCapture(pcap(tcpFrame(Buffer.from('hello')),little,nano));
    assert.equal(packets.length,1);assert.equal(packets[0].timestamp,1234.5);assert.equal(packets[0].protocol,'TCP');assert.equal(packets[0].source,'192.0.2.1');assert.equal(packets[0].destinationPort,443);assert.equal(Buffer.from(packets[0].payload).toString(),'hello');assert.equal(streams.length,1);
  }
  const bytes=pcap(tcpFrame(Buffer.from('hello')),true,false);bytes.writeUInt32LE(0xfffffffe,32);assert.throws(()=>parseCapture(bytes),/截断/);
});

test('TCP reconstruction handles sequence wrap, retransmissions and missing bytes', () => {
  const packet=(sequence,text,flags=0x18)=>({protocol:'TCP',source:'192.0.2.1',sourcePort:1,sequence,flags,payload:Buffer.from(text)});
  const packets=[packet(0xfffffffc,'',2),packet(0xfffffffd,'ABC'),packet(0,'DEF'),packet(0xffffffff,'xy')];
  assert.equal(Buffer.from(reassembleTcp(packets).bytes).toString(),'ABCDEF');
  assert.equal(Buffer.from(reassembleTcp(packets,undefined,{lastWins:true}).bytes).toString(),'ABxyEF');
  assert.equal(reassembleTcp(packets).overlaps,2);
  assert.deepEqual(reassembleTcp([packet(0,'AB'),packet(4,'E')]).gaps,[[2,4]]);
  assert.throws(()=>reassembleTcp([packet(0,'A'),packet(100000000,'B')]),/大小/);
});

test('ZIP index validates directory bounds and expansion limits before extraction', () => {
  const bytes=zipSync({'nested/item.txt':Buffer.from('archive fixture')},{level:6});
  const index=zipIndex(bytes);assert.equal(index[0].name,'nested/item.txt');assert.equal(index[0].size,15);
  const bomb=bytes.slice(),view=new DataView(bomb.buffer);const end=bomb.length-22,central=view.getUint32(end+16,true);view.setUint32(central+24,0x7fffffff,true);assert.throws(()=>zipIndex(bomb),/大小/);
  assert.throws(()=>zipIndex(bytes.subarray(0,bytes.length-1)));
});

test('DNS parser rejects compression pointer cycles', () => {
  const bytes=Buffer.alloc(18);bytes.writeUInt16BE(1,4);bytes[12]=0xc0;bytes[13]=12;bytes.writeUInt16BE(1,14);bytes.writeUInt16BE(1,16);assert.throws(()=>decodeDns(bytes),/循环/);
});
