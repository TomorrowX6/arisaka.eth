import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, test } from 'vitest';
import answers from '../.private/answers.json';
import { forgeGcmToken } from '../scripts/expert/gcm-decoder.mjs';
import { forgePaddingToken } from '../scripts/expert/padding-decoder.mjs';
import { recoverCurveProof } from '../scripts/expert/curve-decoder.mjs';
import { forgeWotsSignature } from '../scripts/expert/wots-decoder.mjs';

afterEach(async () => { await reset(); });
async function player(stage) {
  let cookie = '';
  async function request(path, body) {
    const response = await exports.default.fetch(new Request('https://archive.example' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, Origin: 'https://archive.example', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Afterglow': '1' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    if (response.headers.has('Set-Cookie')) cookie = response.headers.get('Set-Cookie').split(';')[0];
    return response;
  }
  const json = async (path, body) => { const response = await request(path, body); return { status: response.status, ...await response.json() }; };
  await json('/api/start', { entry: answers.entryToken });
  for (let i = 1; i < stage; i++) {
    const result = await json('/api/answer', { stage: i, code: answers.codes[i - 1] });
    expect(result.result).toBe('correct');
  }
  return {
    request, json,
    stub: () => env.GAME_SESSIONS.getByName(cookie.slice(cookie.indexOf('=') + 1).split('.')[0]),
    file: async name => Buffer.from(await (await request('/api/files/' + stage + '/' + name)).arrayBuffer()),
  };
}

test('all interactive lab bindings survive concurrent initialization and eviction, but not a restart', async () => {
  const alice = await player(24);
  const stages = [17, 18, 19, 24];
  const before = new Map();
  for (const stage of stages) {
    const states = await Promise.all(Array.from({ length: 4 }, () => alice.json('/api/labs/' + stage)));
    expect(states[0].status).toBe(200);
    for (const state of states) {
      expect(state).toEqual(states[0]);
      for (const privateField of ['key', 'scalar', 'seed', 'reward', 'code']) expect(state).not.toHaveProperty(privateField);
    }
    before.set(stage, states[0]);
  }
  await evictDurableObject(alice.stub());
  for (const stage of stages) expect(await alice.json('/api/labs/' + stage)).toEqual(before.get(stage));
  expect((await alice.json('/api/restart', {})).stage).toBe(1);
  for (const stage of stages) expect((await alice.json('/api/labs/' + stage)).status).toBe(403);
  for (let stage = 1; stage < 24; stage++) {
    expect((await alice.json('/api/answer', { stage, code: answers.codes[stage - 1] })).result).toBe('correct');
  }
  for (const stage of stages) {
    const state = await alice.json('/api/labs/' + stage);
    expect(state.status).toBe(200);
    expect(state.binding ?? state.nonce).not.toBe(before.get(stage).binding ?? before.get(stage).nonce);
  }
}, 30000);

test('WOTS recovery combines reused chains, respects checksum digits, and binds the release to its session', async () => {
  const alice = await player(24), bob = await player(24);
  const device = JSON.parse((await alice.file('device.json')).toString());
  const captures = JSON.parse((await alice.file('capture.json')).toString());
  const state = await alice.json('/api/labs/24');
  expect(await alice.json('/api/labs/24')).toEqual(state);
  const signature = forgeWotsSignature(device, captures, state.binding);
  expect(await alice.json('/api/labs/24', { action: 'redeem', ...signature })).toMatchObject({ status: 200, code: answers.codes[23] });
  expect((await bob.json('/api/labs/24', { action: 'redeem', ...signature })).status).toBe(403);
  const altered = structuredClone(signature);
  altered.chains[0] = '00'.repeat(16);
  expect((await alice.json('/api/labs/24', { action: 'redeem', ...altered })).status).toBe(403);
  expect((await alice.json('/api/labs/24', { action: 'redeem', ...signature, nonce: '4294967296' })).status).toBe(400);
  expect((await alice.json('/api/labs/24', { action: 'redeem', ...signature, index: 64 })).status).toBe(400);
}, 30000);

test('GCM forgery derives the authentication polynomial from public captures and binds to the player', async () => {
  const alice = await player(17), bob = await player(17);
  const record = await alice.json('/api/labs/17'), other = await bob.json('/api/labs/17');
  expect(other.binding).not.toBe(record.binding);
  expect(await alice.json('/api/labs/17')).toEqual(record);
  const capture = JSON.parse((await alice.file('capture.json')).toString());
  const token = forgeGcmToken(capture, record.binding);
  expect(await alice.json('/api/labs/17', { action: 'redeem', token })).toMatchObject({ status: 200, code: answers.codes[16] });
  expect((await bob.json('/api/labs/17', { action: 'redeem', token })).status).toBe(403);
  const corrupt = Buffer.from(token, 'hex'); corrupt[10] ^= 1;
  expect((await alice.json('/api/labs/17', { action: 'redeem', token: corrupt.toString('hex') })).status).toBe(403);
  expect((await alice.json('/api/labs/18')).status).toBe(403);
}, 20000);

test('CBC-R constructs every block from the bounded oracle and cannot reuse another player token', async () => {
  const alice = await player(18), bob = await player(18);
  const record = await alice.json('/api/labs/18');
  expect((await alice.json('/api/labs/18', { action: 'redeem', token: record.token })).status).toBe(403);
  let calls = 0;
  const token = await forgePaddingToken(record, async tokens => {
    calls++;
    const result = await alice.json('/api/labs/18', { action: 'probe', tokens });
    expect(result.status, JSON.stringify({ error: result.error, count: tokens.length, sizes: [...new Set(tokens.map(token => token.length))] })).toBe(200); return result.results;
  });
  expect(calls).toBeGreaterThan(80);
  expect(await alice.json('/api/labs/18', { action: 'redeem', token })).toMatchObject({ status: 200, code: answers.codes[17] });
  expect((await bob.json('/api/labs/18', { action: 'redeem', token })).status).toBe(422);
  expect((await alice.json('/api/labs/18', { action: 'probe', tokens: Array(65).fill('00') })).status).toBe(400);
}, 60000);

test('curve recovery derives unknown subgroup orders and validates the complete recovered scalar', async () => {
  const alice = await player(19), bob = await player(19);
  const parameters = JSON.parse((await alice.file('parameters.json')).toString()), peers = await alice.file('peers.bin');
  const record = await alice.json('/api/labs/19');
  const proof = await recoverCurveProof(parameters, peers, record, async point => {
    const result = await alice.json('/api/labs/19', { action: 'exchange', ...point });
    expect(result.status).toBe(200); return result;
  });
  expect(await alice.json('/api/labs/19', { action: 'redeem', proof })).toMatchObject({ status: 200, code: answers.codes[18] });
  expect((await bob.json('/api/labs/19', { action: 'redeem', proof })).status).toBe(403);
  expect((await alice.json('/api/labs/19', { action: 'exchange', x: 'ff'.repeat(16), y: '00'.repeat(16) })).status).toBe(422);
}, 30000);
