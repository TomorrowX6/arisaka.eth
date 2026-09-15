import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecovery, createRecovery } from '../public/recovery.js';

const code = 'a1b2c3d4e5f6g7h8i9j0';
const other = '0123456789abcdefghij';
const receipt = '01-' + 'ab'.repeat(16);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness(submit) {
  let state = { started: true, player: 'first', edition: 'same', stage: 1 };
  const accepted = [], errors = [], calls = [];
  const recovery = createRecovery({
    state: () => state,
    submit: async (...args) => { calls.push(args); return submit(...args); },
    accept(result, payload) { state = { ...state, ...result.state }; accepted.push(payload); },
    error(error) { errors.push(error.message); },
  });
  return { recovery, calls, accepted, errors, state: () => state, change(patch) { state = { ...state, ...patch }; } };
}

test('recovery recognizes whole decoded payloads and ignores source, noise and binary data', () => {
  assert.deepEqual(parseRecovery(JSON.stringify({ code, receipt, letter: 'Recovered', unrelated: 1 })), { code, receipt, letter: 'Recovered' });
  assert.deepEqual(parseRecovery(new TextEncoder().encode('ARSK6\n' + code + '\n' + receipt + '\n')), { code, receipt });
  assert.deepEqual(parseRecovery('ARSK2\r\n' + code + '\r\n'), { code });
  assert.deepEqual(parseRecovery('  ' + code + '\n'), { code });
  for (const value of ['ordinary output', 'const value = ' + JSON.stringify({ code }), 'echo ' + code, code + 'extra', JSON.stringify([code]), new Uint8Array([255, 0, 1]), { code: code.toUpperCase() }]) {
    assert.equal(parseRecovery(value), null);
  }
  assert.deepEqual(parseRecovery({ code, receipt: 'invalid', letter: 'x'.repeat(8001) }), { code });
  assert.equal(parseRecovery(JSON.stringify({ code, padding: 'x'.repeat(65536) })), null);
  assert.equal(parseRecovery(Object.create({ code })), null);
});

test('duplicate app output and a saved copy produce one verified recovery', async () => {
  const request = deferred(); const h = harness(() => request.promise);
  const context = h.recovery.capture();
  const first = h.recovery.observe({ code, receipt }, context);
  const duplicate = h.recovery.observe(JSON.stringify({ code, receipt }), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, [[1, code]]);
  request.resolve({ result: 'correct', state: { stage: 2 } });
  await Promise.all([first, duplicate]);
  assert.equal(h.state().stage, 2);
  assert.deepEqual(h.accepted, [{ code, receipt }]);
  await h.recovery.observe({ code }, context);
  assert.equal(h.calls.length, 1);
  await h.recovery.observe({ code, receipt });
  assert.equal(h.calls.length, 1, 'saving a recovered document again is not an attempt on the next case');
});

test('queued output cannot advance a later case using an earlier operation', async () => {
  const request = deferred(); const h = harness(() => request.promise);
  const context = h.recovery.capture();
  const first = h.recovery.observe({ code }, context);
  const queued = h.recovery.observe({ code: other }, context);
  await new Promise(resolve => setImmediate(resolve));
  request.resolve({ result: 'correct', state: { stage: 2 } });
  await Promise.all([first, queued]);
  assert.deepEqual(h.calls, [[1, code]]);
  assert.equal(h.accepted.length, 1);
});

test('old player, edition and reset callbacks cannot change the current desktop', async () => {
  for (const change of [h => h.change({ player: 'second' }), h => h.change({ edition: 'new' }), h => h.recovery.reset()]) {
    const request = deferred(); const h = harness(() => request.promise);
    const pending = h.recovery.observe({ code });
    await new Promise(resolve => setImmediate(resolve));
    change(h);
    request.resolve({ result: 'correct', state: { stage: 2 } });
    await pending;
    assert.equal(h.state().stage, 1);
    assert.deepEqual(h.accepted, []);
    assert.deepEqual(h.errors, []);
  }
});

test('ordinary and incorrect results cannot unlock a case or flood identical attempts', async () => {
  const h = harness(async () => ({ result: 'incorrect', state: { stage: 1 } }));
  await h.recovery.observe('ordinary output');
  assert.deepEqual(h.calls, []);
  await h.recovery.observe({ code });
  await h.recovery.observe({ code });
  assert.equal(h.state().stage, 1);
  assert.deepEqual(h.accepted, []);
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors.length, 1);
});

test('a transient failure can be retried by repeating the operation', async () => {
  let attempts = 0;
  const h = harness(async () => {
    if (!attempts++) throw new Error('Network unavailable');
    return { result: 'correct', state: { stage: 2 } };
  });
  await h.recovery.observe({ code });
  assert.equal(h.state().stage, 1);
  await h.recovery.observe({ code });
  assert.equal(h.state().stage, 2);
  assert.equal(h.calls.length, 2);
  assert.equal(h.accepted.length, 1);
});

test('an already-solved response synchronizes progress without trusting unverified receipt metadata', async () => {
  const h = harness(async stage => ({ result: stage === 1 ? 'already-solved' : 'correct', state: { stage: stage + 1 } }));
  await h.recovery.observe({ code, receipt });
  assert.equal(h.state().stage, 2);
  assert.deepEqual(h.accepted, [{}], 'the server does not digest-check already-solved payloads');
  await h.recovery.observe({ code, receipt });
  assert.deepEqual(h.calls, [[1, code], [2, code]], 'an unverified token must not be remembered as recovered');
  assert.deepEqual(h.accepted[1], { code, receipt });
});
