import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { seededRandom } from '../scripts/core.mjs';
import { logicEvidence } from '../scripts/expert/logic.mjs';
import { runPipeline, validateRecipe, hexBytes, base64Bytes, bytesBase64, PIPELINE_LIMIT } from '../public/data-pipeline.js';
import { parseVcd, decodeSpi, valueAt } from '../public/logic-data.js';

const recipe = (...steps) => ({ format: 'arisaka-data-recipe-v1', steps: steps.map(step => typeof step === 'string' ? { op: step } : step) });
const text = value => new TextEncoder().encode(value);

test('data recipes round-trip exact bytes and retain a per-step size audit', async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (const steps of [['toHex', 'fromHex'], ['toBase64', 'fromBase64'], ['toBase64url', 'fromBase64url'], ['toBits', 'fromBits'], ['gzip', 'gunzip'], ['deflate', 'inflate'], ['reverse', 'reverse'], ['reverseBits', 'reverseBits'], [{ op: 'swap', arg: '8' }, { op: 'swap', arg: '8' }], [{ op: 'xor', arg: 'abc012' }, { op: 'xor', arg: 'abc012' }]]) {
    const result = await runPipeline(bytes, recipe(...steps));
    assert.deepEqual(result.bytes, bytes); assert.equal(result.history.length, 2); assert.equal(result.history[0].inputBytes, 256);
  }
  assert.equal(bytesBase64(base64Bytes('-_8', true), true), '-_8');
  assert.equal(Buffer.from((await runPipeline(text('abc'), recipe('sha256', 'toHex'))).bytes).toString(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.deepEqual((await runPipeline(bytes, recipe({ op: 'slice', arg: '0xfe:' }))).bytes, Uint8Array.of(254, 255));
  assert.deepEqual((await runPipeline(bytes, recipe())).bytes, bytes);
});

test('data recipes reject ambiguous encodings, partial words, unsupported operations and expansion bombs', async () => {
  for (const value of ['a', 'ag', '0x10', 'aa-z']) assert.throws(() => hexBytes(value), /Hex/);
  for (const value of ['A', 'ab==', 'ab=cd', 'YWJj=', 'YWJj===', 'YQ=', 'YQ===', '!!!']) assert.throws(() => base64Bytes(value), /Base64/);
  assert.equal(Buffer.from(base64Bytes('YQ')).toString(), 'a');
  assert.throws(() => validateRecipe(recipe('eval')), /无效/);
  assert.throws(() => validateRecipe(recipe(...Array(33).fill('reverse'))), /32/);
  await assert.rejects(runPipeline(text('f'), recipe('fromHex')), /第 1 步/);
  await assert.rejects(runPipeline(text('001'), recipe('fromBits')), /8 位/);
  await assert.rejects(runPipeline(text('abc'), recipe({ op: 'swap', arg: '2' })), /整数倍/);
  await assert.rejects(runPipeline(text('abc'), recipe({ op: 'slice', arg: '1:4' })), /范围/);
  await assert.rejects(runPipeline(text('abc'), recipe({ op: 'xor', arg: '' })), /不能为空/);
  await assert.rejects(runPipeline(new Uint8Array(PIPELINE_LIMIT + 1), recipe()), /8 MiB/);
  await assert.rejects(runPipeline(gzipSync(Buffer.alloc(PIPELINE_LIMIT + 1)), recipe('gunzip')), /8 MiB/);
});

const header = '$timescale 10 ps $end\n$scope module top $end\n$var wire 1 ! clk $end\n$var wire 1 " cs $end\n$var wire 1 # mosi $end\n$var wire 1 $ miso $end\n$var wire 8 % bus [7:0] $end\n$var wire 8 % alias [7:0] $end\n$upscope $end\n$enddefinitions $end\n';

test('VCD preserves 64-bit timestamps, aliases, vector extension and last delta-cycle assignment', () => {
  const data = parseVcd(header + '#0\n0!\n1"\n0#\n0$\nbx %\n#9007199254740993\nb10 %\n1!\n#9007199254740993\n0!\n#9007199254740994\n1!\n');
  assert.equal(data.timescale.femtoseconds, 10000n);
  assert.equal(data.end, 9007199254740994n);
  assert.equal(data.signals.length, 5);
  const bus = data.signals.find(signal => signal.id === '%');
  assert.deepEqual(bus.aliases, ['top.alias[7:0]']);
  assert.equal(valueAt(bus, 0n).value, 'xxxxxxxx');
  assert.equal(valueAt(bus, 9007199254740993n).value, '00000010');
  assert.equal(valueAt(data.signals[0], 9007199254740993n).value, '0');
  for (const source of [header + '#10\n#9', header + '#1\n0missing', header + '#1\nb111111111 %', header.replace('$enddefinitions $end', ''), header + '#18446744073709551616']) assert.throws(() => parseVcd(source), /VCD/);
});

function spiFixture(mode, lsb = false, uncertain = false) {
  const idle = mode >> 1, cpha = mode & 1, bits = value => Array.from({ length: 8 }, (_, i) => value >> (lsb ? i : 7 - i) & 1);
  const lines = [header, '#0', idle + '!', '1"', '0#', '0$', '#5', '0"'];
  const tx = bits(0x9f), rx = bits(0xa5); let tick = 10;
  for (let i = 0; i < 8; i++) {
    if (cpha) lines.push('#' + tick++, (1 - idle) + '!');
    lines.push('#' + tick++, tx[i] + '#', (uncertain && i === 3 ? 'x' : rx[i]) + '$');
    lines.push('#' + tick++, (cpha ? idle : 1 - idle) + '!');
    if (!cpha) lines.push('#' + tick++, idle + '!');
  }
  lines.push('#' + tick, '1"'); return lines.join('\n');
}
const pins = { clock: '!', select: '"', mosi: '#', miso: '$' };

test('SPI decodes all four modes and both bit orders without fabricating unknown or truncated bytes', () => {
  for (const mode of [0, 1, 2, 3]) for (const lsb of [false, true]) {
    const decoded = decodeSpi(parseVcd(spiFixture(mode, lsb)), { ...pins, mode, lsb });
    assert.equal(decoded.length, 1); assert.deepEqual(decoded[0].tx, [0x9f]); assert.deepEqual(decoded[0].rx, [0xa5]); assert.equal(decoded[0].complete, true);
  }
  const uncertain = decodeSpi(parseVcd(spiFixture(3, false, true)), { ...pins, mode: 3 });
  assert.equal(uncertain[0].complete, false); assert.deepEqual(uncertain[0].rx, [null]);
  const partial = decodeSpi(parseVcd(spiFixture(3).replace(/1"$/, '')), { ...pins, mode: 3 });
  assert.equal(partial[0].complete, false); assert.ok(partial[0].issues.includes('片选未结束'));
  assert.throws(() => decodeSpi(parseVcd(spiFixture(0)), { ...pins, miso: '#' }), /不同信号/);
});

test('the desktop logic decoder handles the full acquisition but does not select firmware or solve cases', () => {
  const files = logicEvidence('test-only', seededRandom(Buffer.alloc(32, 0x7e), 'logic-tool'));
  const capture = parseVcd(files['bus.vcd']);
  const decoded = decodeSpi(capture, { ...pins, mode: 3 });
  assert.deepEqual(decoded[0].tx, [0x9f, 0, 0, 0]);
  assert.deepEqual(decoded[0].rx, [0, 0xef, 0x40, 0x19]);
  assert.equal(decoded[1].complete, false);
  assert.ok(decoded.filter(item => item.complete).length > 100);
  assert.ok(decoded.some(item => item.tx[0] === 0xb7));
  assert.ok(decoded.some(item => item.tx[0] === 0xe9));
  assert.equal(JSON.stringify(decoded, (_, value) => typeof value === 'bigint' ? String(value) : value).includes('test-only'), false);
});
