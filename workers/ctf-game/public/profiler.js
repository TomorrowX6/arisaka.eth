// A bounded reader for the Callgrind profile format, including compressed names
// and relative positions. Costs remain integers; call costs are not recursively
// summed (a profile can contain recursive cycles).
export function parseCallgrind(source) {
  if (typeof source !== 'string' || source.length > 8 * 1024 * 1024) throw Error('性能数据超过大小限制');
  const names = { object: new Map(), file: new Map(), function: new Map() };
  const functions = new Map(), edges = [], metadata = {};
  let events = [], positions = ['line'], lastPosition = [0n], object = '', file = '', name = '', current;
  let targetObject = '', targetFile = '', targetName = '', calls = null, lineNumber = 0;
  const integer = value => {
    if (!/^(?:\d{1,39}|0x[\da-f]{1,32})$/i.test(value)) throw Error('无效整数');
    return BigInt(value);
  };
  function compressed(kind, value) {
    const match = /^\((\d+)\)(?:\s+(.*))?$/.exec(value);
    if (!match) return value;
    if (match[2] !== undefined) names[kind].set(match[1], match[2]);
    if (!names[kind].has(match[1])) throw Error('未定义的压缩名称');
    return names[kind].get(match[1]);
  }
  function entry(ob, fl, fn) {
    const id = JSON.stringify([ob, fl, fn]);
    if (!functions.has(id)) {
      if (functions.size >= 20000) throw Error('函数数量超过限制');
      functions.set(id, { id, object: ob, file: fl, name: fn, self: events.map(() => 0n), inclusive: events.map(() => 0n), calls: 0n, lines: [] });
    }
    return functions.get(id);
  }
  try {
    for (const raw of source.split(/\r?\n/)) {
      lineNumber++;
      if (lineNumber > 250000) throw Error('记录数量超过限制');
      const line = raw.trim(); if (!line || line.startsWith('#')) continue;
      const header = /^([a-z][a-z0-9_-]*):\s*(.*)$/i.exec(line);
      if (header) {
        const [, key, value] = header;
        if (key === 'events') {
          const next = value.trim().split(/\s+/);
          if (!next.length || next.length > 16 || next.some(item => !/^[\w-]{1,30}$/.test(item)) || new Set(next).size !== next.length) throw Error('无效事件定义');
          if (events.length && next.join() !== events.join()) throw Error('事件定义发生变化');
          events = next;
        } else if (key === 'positions') {
          positions = value.split(/\s+/);
          if (positions.length > 4 || positions.some(position => !['line', 'instr'].includes(position))) throw Error('无效位置定义');
          lastPosition = positions.map(() => 0n);
        } else if (!['summary', 'totals'].includes(key)) metadata[key] = value.slice(0, 1000);
        continue;
      }
      const field = /^(\w+)=(.*)$/.exec(line);
      if (field) {
        const [, key, rawValue] = field, value = rawValue.trim();
        if (key === 'ob') object = compressed('object', value);
        else if (['fl', 'fi', 'fe'].includes(key)) file = compressed('file', value);
        else if (key === 'fn') {
          if (!events.length || calls !== null) throw Error('函数定义顺序无效');
          name = compressed('function', value); current = entry(object, file, name);
          targetObject = object; targetFile = file; targetName = ''; lastPosition = positions.map(() => 0n);
        } else if (key === 'cob') targetObject = compressed('object', value);
        else if (['cfl', 'cfi'].includes(key)) targetFile = compressed('file', value);
        else if (key === 'cfn') targetName = compressed('function', value);
        else if (key === 'calls') {
          if (calls !== null || !targetName || !current) throw Error('无效调用记录');
          const values = value.split(/\s+/); calls = integer(values[0]);
          for (const position of values.slice(1)) if (position !== '*') integer(position.replace(/^[+-]/, ''));
        }
        continue;
      }
      if (/^[*+\-\d]/.test(line)) {
        if (!current) throw Error('缺少函数定义');
        const fields = line.split(/\s+/);
        if (fields.length < positions.length + 1 || fields.length > positions.length + events.length) throw Error('无效成本记录');
        const location = fields.slice(0, positions.length).map((field, index) => {
          const value = field === '*' ? lastPosition[index] : /^[+-]/.test(field) ? lastPosition[index] + (field[0] === '-' ? -1n : 1n) * integer(field.slice(1)) : integer(field);
          if (value < 0n) throw Error('位置超出范围'); return value;
        });
        lastPosition = location;
        const costs = events.map((_, index) => integer(fields[positions.length + index] || '0'));
        costs.forEach((cost, index) => { current.inclusive[index] += cost; });
        if (calls !== null) {
          const target = entry(targetObject, targetFile, targetName); target.calls += calls;
          if (edges.length >= 100000) throw Error('调用数量超过限制');
          edges.push({ from: current.id, to: target.id, count: calls, costs, position: location }); calls = null;
        } else {
          costs.forEach((cost, index) => { current.self[index] += cost; });
          current.lines.push({ position: location, costs });
        }
      }
    }
    if (calls !== null || !events.length || !functions.size) throw Error('不完整的性能数据');
    const total = events.map((_, index) => [...functions.values()].reduce((sum, item) => sum + item.self[index], 0n));
    return { metadata, events, positions, functions: [...functions.values()], edges, total };
  } catch (error) { throw Error('Callgrind 第 ' + lineNumber + ' 行：' + error.message); }
}

export function rgbToHsv(rgb) {
  if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some(value => !Number.isFinite(value) || value < 0 || value > 255)) throw Error('无效 RGB 颜色');
  const [r, g, b] = rgb.map(value => value / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = !delta ? 0 : max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return [hue, max ? delta / max * 100 : 0, max * 100];
}
export function hsvToRgb(hsv) {
  if (!Array.isArray(hsv) || hsv.length !== 3 || hsv.some(value => !Number.isFinite(value)) || hsv[0] < 0 || hsv[0] > 360 || hsv.slice(1).some(value => value < 0 || value > 100)) throw Error('无效 HSV 颜色');
  const [h, s, v] = [hsv[0] / 60 % 6, hsv[1] / 100, hsv[2] / 100], c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c;
  const parts = h < 1 ? [c,x,0] : h < 2 ? [x,c,0] : h < 3 ? [0,c,x] : h < 4 ? [0,x,c] : h < 5 ? [x,0,c] : [c,0,x];
  return parts.map(value => Math.round((value + m) * 255));
}
