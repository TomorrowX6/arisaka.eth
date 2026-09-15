// VCD / SPI tools, deliberately independent of the maintenance puzzle decoder.
const units = { s: 1000000000000000n, ms: 1000000000000n, us: 1000000000n, ns: 1000000n, ps: 1000n, fs: 1n };
export function parseVcd(source) {
  if (typeof source !== 'string' || source.length > 16 * 1024 * 1024) throw Error('VCD 超过 16 MiB 限制');
  const tokens = source.match(/\S+/g) || [], signals = [], ids = new Map(), scopes = [];
  let at = 0, defined = false, timescale, time = 0n, changes = 0, declarations = 0, expanded = 0;
  const block = () => { const values = []; while (at < tokens.length && tokens[at] !== '$end') values.push(tokens[at++]); if (tokens[at++] !== '$end') throw Error('VCD 指令未结束'); return values; };
  while (at < tokens.length && !defined) {
    const op = tokens[at++], fields = block();
    if (op === '$scope') { if (fields.length !== 2 || scopes.length >= 32) throw Error('VCD scope 无效'); scopes.push(fields[1]); }
    else if (op === '$upscope') { if (!scopes.length) throw Error('VCD scope 不匹配'); scopes.pop(); }
    else if (op === '$timescale') {
      const match = /^(1|10|100)(s|ms|us|ns|ps|fs)$/.exec(fields.join(''));
      if (!match || timescale) throw Error('VCD timescale 无效');
      timescale = { magnitude: Number(match[1]), unit: match[2], femtoseconds: BigInt(match[1]) * units[match[2]] };
    } else if (op === '$var') {
      if (++declarations > 1024) throw Error('VCD 声明超过 1024 项');
      const [type, widthText, id, reference, ...range] = fields, width = Number(widthText);
      if (!['wire', 'reg', 'logic', 'tri', 'integer', 'parameter', 'supply0', 'supply1'].includes(type) || !Number.isInteger(width) || width < 1 || width > 4096 || !id || !reference || range.length > 2) throw Error('不支持或无效的 VCD 信号');
      const name = [...scopes, reference + range.join('')].join('.');
      if (signals.some(signal => signal.name === name || signal.aliases.includes(name))) throw Error('重复的 VCD 信号名称');
      if (ids.has(id)) {
        if (ids.get(id).width !== width) throw Error('VCD 别名位宽不一致');
        ids.get(id).aliases.push(name);
      } else {
        if (signals.length >= 256) throw Error('VCD 信号超过 256 路');
        const signal = { id, name, width, aliases: [], changes: [] }; signals.push(signal); ids.set(id, signal);
      }
    } else if (op === '$enddefinitions') { if (scopes.length) throw Error('VCD scope 未关闭'); defined = true; }
    else if (!['$date', '$version', '$comment'].includes(op)) throw Error('未知 VCD 声明：' + op);
  }
  if (!defined || !signals.length || !timescale) throw Error('VCD 缺少声明或时间单位');
  while (at < tokens.length) {
    const token = tokens[at++];
    if (/^#\d+$/.test(token)) {
      if (token.length > 20) throw Error('VCD 时间戳超出范围');
      const next = BigInt(token.slice(1)); if (next < time || next > 0x7fffffffffffffffn) throw Error('VCD 时间戳倒退或超出范围'); time = next; continue;
    }
    if (token === '$comment') { block(); continue; }
    if (['$dumpvars', '$dumpall', '$dumpon', '$dumpoff', '$end'].includes(token)) continue;
    let id, value;
    if (/^[bB][01xzXZ]+$/.test(token)) { id = tokens[at++]; value = token.slice(1).toLowerCase(); }
    else if (/^[01xzXZ].+$/.test(token)) { id = token.slice(1); value = token[0].toLowerCase(); }
    else throw Error('未知 VCD 值：' + token.slice(0, 32));
    const signal = ids.get(id);
    if (!signal || value.length > signal.width) throw Error('VCD 信号标识或值宽度无效');
    value = value.padStart(signal.width, /^[xz]/.test(value) ? value[0] : '0');
    if (++changes > 500000) throw Error('VCD 变化超过 500000 次');
    const previous = signal.changes.at(-1);
    if (previous?.time === time) previous.value = value;
    else if (previous?.value !== value) {
      if ((expanded += signal.width) > 16 * 1024 * 1024) throw Error('VCD 展开数据超过 16 MiB');
      signal.changes.push({ time, value });
    }
  }
  return { signals, timescale, end: time, changes };
}

export function valueAt(signal, time) {
  let low = 0, high = signal.changes.length;
  while (low < high) { const mid = (low + high) >>> 1; if (signal.changes[mid].time <= time) low = mid + 1; else high = mid; }
  return { index: low - 1, value: low ? signal.changes[low - 1].value : 'x'.repeat(signal.width) };
}

export function decodeSpi(capture, options) {
  const { clock, select, mosi, miso, mode = 0, lsb = false } = options;
  if (![0, 1, 2, 3].includes(mode) || typeof lsb !== 'boolean' || new Set([clock, select, mosi, miso]).size !== 4) throw Error('SPI 需要四路不同信号和有效模式');
  const chosen = [clock, select, mosi, miso].map(id => capture.signals.find(signal => signal.id === id));
  if (chosen.some(signal => !signal || signal.width !== 1)) throw Error('SPI 信号必须是已声明的 1 位信号');
  const events = chosen.flatMap(signal => signal.changes.map(change => ({ ...change, id: signal.id }))).sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  const state = new Map(chosen.map(signal => [signal.id, 'x'])), transfers = [], rising = (mode >> 1) === (mode & 1);
  let active;
  const finish = (end, issue) => {
    if (!active) return;
    const { txBits, rxBits } = active;
    if (issue) active.issues.add(issue);
    if (txBits.length % 8) active.issues.add('不完整字节');
    const bytes = bits => Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => {
      const chunk = bits.slice(i * 8, i * 8 + 8);
      if (chunk.some(bit => bit !== '0' && bit !== '1')) return null;
      return parseInt((lsb ? chunk.toReversed() : chunk).join(''), 2);
    });
    if (transfers.length >= 10000) throw Error('SPI 传输超过 10000 段');
    transfers.push({ start: active.start, end, tx: bytes(txBits), rx: bytes(rxBits), bits: txBits.length, complete: !active.issues.size, issues: [...active.issues] });
    active = undefined;
  };
  for (let i = 0; i < events.length;) {
    const time = events[i].time, previousClock = state.get(clock), previousSelect = state.get(select), changed = new Set();
    while (i < events.length && events[i].time === time) { changed.add(events[i].id); state.set(events[i].id, events[i].value); i++; }
    const current = state.get(clock), edge = rising ? previousClock === '0' && current === '1' : previousClock === '1' && current === '0';
    if (active && changed.has(clock) && ![previousClock, current].every(bit => bit === '0' || bit === '1')) active.issues.add('未知时钟状态');
    if (active && edge && changed.has(select)) active.issues.add('片选与采样沿同时变化');
    if (state.get(select) !== previousSelect) {
      if (state.get(select) === '0') active = { start: time, txBits: [], rxBits: [], issues: new Set(previousSelect === '1' ? [] : ['片选开始状态未知']) };
      else finish(time, state.get(select) === '1' ? undefined : '未知片选状态');
    }
    if (!active || !edge) continue;
    if (changed.has(select)) { active.issues.add('片选与采样沿同时变化'); continue; }
    const a = state.get(mosi), b = state.get(miso);
    if (changed.has(mosi) || changed.has(miso)) active.issues.add('数据与采样沿同时变化');
    if (![a, b].every(bit => bit === '0' || bit === '1')) active.issues.add('未知数据位');
    active.txBits.push(a); active.rxBits.push(b);
  }
  finish(capture.end, '片选未结束');
  return transfers;
}
