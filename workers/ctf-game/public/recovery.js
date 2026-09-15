const LIMIT = 64 * 1024;
const token = /^[a-z0-9]{20}$/;
const receipt = /^0[1-4]-[0-9a-f]{32}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// Recognize a complete result, never an answer-shaped substring of source or data.
export function parseRecovery(input) {
  try {
    let value = input;
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      if (value.byteLength > LIMIT) return null;
      value = decoder.decode(value);
    }
    if (typeof value === 'string') {
      if (value.length > LIMIT || encoder.encode(value).length > LIMIT) return null;
      const text = value.trim();
      if (token.test(text)) return { code: text };
      const frame = /^ARSK(?:2|6|7)\r?\n([a-z0-9]{20})(?:\r?\n(0[1-4]-[0-9a-f]{32}))?$/.exec(text);
      if (frame) return { code: frame[1], ...(frame[2] ? { receipt: frame[2] } : {}) };
      value = JSON.parse(text);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'code') || typeof value.code !== 'string' || !token.test(value.code)) return null;
    if (encoder.encode(JSON.stringify(value)).length > LIMIT) return null;
    const result = { code: value.code };
    if (Object.hasOwn(value, 'receipt') && typeof value.receipt === 'string' && receipt.test(value.receipt)) result.receipt = value.receipt;
    if (Object.hasOwn(value, 'letter') && typeof value.letter === 'string' && value.letter.length <= 8000) result.letter = value.letter;
    return result;
  } catch { return null; }
}

export function createRecovery({ state, submit, accept, error }) {
  let generation = 0, pending = 0, queue = Promise.resolve();
  const seen = new Map();
  const recovered = new Set();
  const capture = (stage = state().stage) => Object.freeze({ player: state().player, edition: state().edition, stage, generation });
  function current(context) {
    const value = state();
    return context && value.started && !value.outdated && context.generation === generation && context.player === value.player && context.edition === value.edition && Number.isInteger(context.stage) && context.stage > 0 && context.stage === value.stage;
  }
  function report(cause, context) {
    if (!current(context)) return;
    try { error?.(cause, context); } catch {}
  }
  function observe(value, context = capture()) {
    const payload = parseRecovery(value);
    if (!payload || !current(context)) return Promise.resolve();
    const recoveredKey = JSON.stringify([context.generation, context.player, context.edition, payload.code]);
    if (recovered.has(recoveredKey)) return Promise.resolve();
    const key = JSON.stringify([context.generation, context.player, context.edition, context.stage, payload.code]);
    const previous = seen.get(key);
    if (previous) { Object.assign(previous.payload, payload); return previous.promise; }
    if (pending >= 8) return Promise.resolve();
    pending++;
    const entry = { payload, settled: false };
    entry.promise = queue.then(async () => {
      if (!current(context)) return;
      try {
        const result = await submit(context.stage, payload.code);
        if (!current(context)) return;
        if (result.result === 'incorrect') {
          report(new Error('恢复结果与当前档案不匹配。'), context);
        } else if (['correct', 'already-solved'].includes(result.result) && result.state?.stage > context.stage) {
          // The legacy idempotent response does not verify the submitted digest.
          // It may reconcile a stale tab, but cannot attest to receipt metadata.
          await accept(result, result.result === 'correct' ? entry.payload : {}, context);
          if (result.result === 'correct') {
            recovered.add(recoveredKey);
            if (recovered.size > 128) recovered.delete(recovered.values().next().value);
          }
        } else throw new Error('恢复结果暂时无法确认，请重试。');
      } catch (cause) {
        // A failed connection is retryable; repeatedly seeing the same incorrect
        // output is not a new attempt. Never leak a stale operation into another save.
        if (seen.get(key) === entry) seen.delete(key);
        report(cause, context);
      }
    }).catch((cause) => report(cause, context)).finally(() => {
      entry.settled = true;
      if (context.generation === generation) pending--;
      while (seen.size > 128) {
        const first = [...seen].find(([, item]) => item.settled);
        if (!first) break;
        seen.delete(first[0]);
      }
    });
    seen.set(key, entry);
    queue = entry.promise;
    return entry.promise;
  }
  return { capture, observe, reset() { generation++; pending = 0; seen.clear(); recovered.clear(); queue = Promise.resolve(); } };
}
