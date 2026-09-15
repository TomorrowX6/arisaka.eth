import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { generate } from '../scripts/build-challenges.mjs';
import { seededRandom } from '../scripts/core.mjs';
import { bpfEvidence } from '../scripts/expert/bpf.mjs';
import { decodeBpfEvidence, recoverBpfMaterial } from '../scripts/expert/bpf-decoder.mjs';
import { recoverFrostMaterial } from '../scripts/expert/frost-decoder.mjs';
import { recoverRs16Material } from '../scripts/expert/rs16-decoder.mjs';
import { loadBpf } from '../public/bpf-elf.js';
import { BpfMachine } from '../public/bpf-core.js';

test('BPF convergence independently inverts the ARX program and requires both authenticated upstream materials', () => {
  for (let i = 0; i < 12; i++) {
    const seed = randomBytes(32), upstream = [randomBytes(32), randomBytes(32)], code = 'synthetic-bpf-' + i;
    const files = bpfEvidence(code, upstream, seededRandom(seed, 'bpf-test'));
    const { material, rounds, instructions } = recoverBpfMaterial(files);
    assert.ok(rounds >= 48 && rounds <= 63); assert.ok(instructions > 3000 && instructions < 10000);
    assert.deepEqual(decodeBpfEvidence(files, ...upstream), { code });
    const program = loadBpf(files['filter.bpf.o']);
    assert.ok(program.relocations.every(row => row.applied));
    assert.deepEqual(program.relocations.map(row => row.type), ['R_BPF_64_64', 'R_BPF_64_32']);
    const run = packet => {
      const machine = new BpfMachine(program, packet); machine.run();
      assert.equal(machine.status, 'halted', machine.reason); return machine.registers[0];
    };
    const packet = Buffer.concat([Buffer.from('R32\0'), material]);
    assert.equal(run(packet), 2n); assert.equal(run(files['probe.bin']), 1n);
    assert.equal(run(packet.subarray(0, -1)), 1n); assert.equal(run(Buffer.concat([packet, Buffer.from([0])])), 1n);
    for (const offset of [0, 4, 11, 19]) { const altered = Buffer.from(packet); altered[offset] ^= 1; assert.equal(run(altered), 1n); }
    for (const content of Object.values(files)) assert.equal(Buffer.from(content).includes(Buffer.from(code)), false);
    assert.throws(() => decodeBpfEvidence(files, ...upstream.toReversed()));
    assert.throws(() => decodeBpfEvidence(files, Buffer.alloc(32), upstream[1]));
    assert.throws(() => decodeBpfEvidence(files, upstream[0], Buffer.alloc(32)));
    assert.throws(() => decodeBpfEvidence(files, upstream[0]), /Both authenticated/);
    const capsule = JSON.parse(files['capsule.json']); capsule.tag = Buffer.alloc(16).toString('base64');
    assert.throws(() => decodeBpfEvidence({ ...files, 'capsule.json': JSON.stringify(capsule) }, ...upstream));
    assert.throws(() => recoverBpfMaterial({ ...files, 'filter.bpf.o': files['filter.bpf.o'].subarray(0, -1) }), /section|ELF/);
    // Data recovery alone is insufficient: verification must execute the object.
    const changed = Buffer.from(files['filter.bpf.o']), loaded = loadBpf(changed);
    const accept = loaded.instructions.find(ins => ins.mnemonic === 'mov64' && ins.dst === 0 && ins.imm === 2);
    changed.writeInt32LE(1, accept.fileOffset + 4);
    assert.throws(() => recoverBpfMaterial({ ...files, 'filter.bpf.o': changed }), /not accepted/);
  }
});

test('the convergence release preserves all 31 earlier artifacts and derives custody only from their evidence', async () => {
  const { artifacts, answers, manifest } = await generate(Buffer.alloc(32, 0x42)), hash = createHash('sha256');
  for (const [stage, files] of Object.entries(artifacts)) if (Number(stage) <= 31) {
    for (const [name, content] of Object.entries(files)) hash.update(stage + '/' + name + '\0').update(content);
  }
  assert.equal(hash.digest('hex'), 'c99cbfeed308a7d1958faca9c158bcab45061fa7d36f3e65dc6992eb7234afc2');
  assert.deepEqual(manifest.compatibleEditions.find(item => item.cases === 31), { version: 'eeccc8adb68510a1', cases: 31 });
  const frost = recoverFrostMaterial(artifacts[30]).material, custody = recoverRs16Material(artifacts[31]).material;
  assert.deepEqual(decodeBpfEvidence(artifacts[32], frost, custody), { code: answers.codes[31] });
});
