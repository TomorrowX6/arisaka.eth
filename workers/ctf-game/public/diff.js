const lines = text => String(text).match(/[^\n]*\n|[^\n]+$/g) || [];

// Bounded LCS with exact prefix/suffix preservation. Large unmatched regions
// become one replacement rather than allocating an unbounded quadratic table.
export function diffLines(left, right, { ignoreWhitespace = false } = {}) {
  const a = lines(left), b = lines(right);
  const key = value => ignoreWhitespace ? value.replace(/\s+/g, '') : value;
  const ak = a.map(key), bk = b.map(key), result = [];
  let start = 0, ae = a.length, be = b.length;
  const emit = (type, value) => result.push({ type, value });
  while (start < ae && start < be && ak[start] === bk[start]) { emit('equal', a[start]); start++; }
  while (ae > start && be > start && ak[ae - 1] === bk[be - 1]) { ae--; be--; }
  const n = ae - start, m = be - start;
  if ((n + 1) * (m + 1) <= 4_000_000) {
    const stride = m + 1, table = new Uint32Array((n + 1) * stride);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      table[i * stride + j] = ak[start + i] === bk[start + j]
        ? table[(i + 1) * stride + j + 1] + 1
        : Math.max(table[(i + 1) * stride + j], table[i * stride + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ak[start + i] === bk[start + j]) { emit('equal', a[start + i++]); j++; }
      else if (j < m && (i === n || table[i * stride + j + 1] > table[(i + 1) * stride + j])) emit('insert', b[start + j++]);
      else emit('delete', a[start + i++]);
    }
  } else {
    for (let i = start; i < ae; i++) emit('delete', a[i]);
    for (let j = start; j < be; j++) emit('insert', b[j]);
  }
  for (let i = ae; i < a.length; i++) emit('equal', a[i]);
  return result;
}

function changes(base, branch) {
  const changes = []; let position = 0, current;
  for (const operation of diffLines(base, branch)) {
    if (operation.type === 'equal') { current = null; position++; continue; }
    if (!current) { current = { start: position, end: position, lines: [] }; changes.push(current); }
    if (operation.type === 'delete') { position++; current.end = position; }
    else current.lines.push(operation.value);
  }
  return changes;
}
function overlaps(a, b) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

export function mergeThreeWay(baseText, aText, bText) {
  const base = lines(baseText);
  const pending = [...changes(baseText, aText).map(change => ({ ...change, side: 'a' })), ...changes(baseText, bText).map(change => ({ ...change, side: 'b' }))]
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const segments = []; let cursor = 0;
  while (pending.length) {
    const group = [pending.shift()];
    let growing = true;
    while (growing) {
      growing = false;
      for (let i = 0; i < pending.length; i++) if (group.some(item => overlaps(item, pending[i]))) {
        group.push(pending.splice(i--, 1)[0]); growing = true;
      }
    }
    const start = Math.min(...group.map(item => item.start)), end = Math.max(...group.map(item => item.end));
    if (start > cursor) segments.push({ type: 'equal', text: base.slice(cursor, start).join('') });
    const original = base.slice(start, end).join('');
    const apply = side => {
      const relevant = group.filter(item => item.side === side).sort((a, b) => a.start - b.start);
      let value = '', at = start;
      for (const change of relevant) { value += base.slice(at, change.start).join('') + change.lines.join(''); at = change.end; }
      return value + base.slice(at, end).join('');
    };
    const a = apply('a'), b = apply('b');
    if (a === b || a === original || b === original) segments.push({ type: 'change', text: a === original ? b : a });
    else segments.push({ type: 'conflict', a, b, base: original, start: start + 1 });
    cursor = end;
  }
  if (cursor < base.length) segments.push({ type: 'equal', text: base.slice(cursor).join('') });
  return segments;
}

export function renderMerge(segments, choices = new Map()) {
  const terminated = text => text && !text.endsWith('\n') ? text + '\n' : text;
  return segments.map((segment, index) => {
    if (segment.type !== 'conflict') return segment.text;
    const choice = choices.get(index);
    if (choice === 'a' || choice === 'b') return segment[choice];
    if (choice === 'both') return segment.a + segment.b;
    return '<<<<<<< A\n' + terminated(segment.a) + '||||||| BASE\n' + terminated(segment.base) + '=======\n' + terminated(segment.b) + '>>>>>>> B\n';
  }).join('');
}
