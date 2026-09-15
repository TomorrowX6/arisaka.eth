import { openSeal } from '../decoders.mjs';

const mod = x => ((x % 257) + 257) % 257;
function inverse(x) {
  let out = 1, power = 255;
  for (; power; power >>= 1, x = mod(x * x)) if (power & 1) out = mod(out * x);
  return out;
}
function samples(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'MThd' || bytes.readUInt16BE(12) !== 960) throw Error('Invalid MIDI header');
  let cursor = 8 + bytes.readUInt32BE(4);
  const output = [];
  while (cursor < bytes.length) {
    if (cursor + 8 > bytes.length || bytes.toString('ascii', cursor, cursor + 4) !== 'MTrk') throw Error('Invalid MIDI track');
    const end = cursor + 8 + bytes.readUInt32BE(cursor + 4); cursor += 8;
    if (end > bytes.length) throw Error('Truncated MIDI track');
    let tick = 0, status = 0;
    const active = new Map();
    const variable = () => {
      let value = 0;
      for (let i = 0; i < 4 && cursor < end; i++) {
        const byte = bytes[cursor++]; value = value * 128 + (byte & 127);
        if (!(byte & 128)) return value;
      }
      throw Error('Invalid MIDI delta');
    };
    while (cursor < end) {
      tick += variable();
      if (bytes[cursor] & 128) status = bytes[cursor++];
      if (!status) throw Error('Missing running status');
      if (status === 255) { cursor++; const length = variable(); cursor += length; status = 0; }
      else if (status === 240 || status === 247) { const length = variable(); cursor += length; status = 0; }
      else {
        const pitch = bytes[cursor++], value = (status & 0xe0) === 0xc0 ? 0 : bytes[cursor++];
        if (status === 0x9b && value) active.set(pitch, tick);
        else if ((status === 0x8b || status === 0x9b && !value) && active.has(pitch)) {
          const start = active.get(pitch); active.delete(pitch);
          const x = (start - 32) / 960, y = tick - start - 64;
          if (!Number.isInteger(x) || x < 1 || x > 96 || y < 0 || y > 256) throw Error('Invalid sequencer sample');
          output.push([x, y]);
        }
      }
      if (cursor > end) throw Error('Truncated MIDI event');
    }
  }
  if (new Set(output.map(([x]) => x)).size !== output.length) throw Error('Duplicate sequencer position');
  return output;
}

export function recoverSequencerState(bytes) {
  const points = samples(bytes), width = 32, errors = Math.floor((points.length - width) / 2);
  if (errors < 0) throw Error('Insufficient sequencer samples');
  const count = width + errors * 2;
  const rows = points.map(([x, y]) => {
    const powers = [1];
    for (let i = 1; i < width + errors; i++) powers.push(mod(powers.at(-1) * x));
    return [...powers, ...powers.slice(0, errors).map(v => mod(-y * v)), mod(y * powers[errors])];
  });
  let pivot = 0;
  const columns = [];
  for (let col = 0; col < count && pivot < rows.length; col++) {
    const index = rows.findIndex((row, i) => i >= pivot && row[col]);
    if (index < 0) continue;
    [rows[pivot], rows[index]] = [rows[index], rows[pivot]];
    const row = rows[pivot], scale = inverse(row[col]);
    for (let i = col; i <= count; i++) row[i] = mod(row[i] * scale);
    for (let j = 0; j < rows.length; j++) if (j !== pivot && rows[j][col]) {
      const factor = rows[j][col];
      for (let i = col; i <= count; i++) rows[j][i] = mod(rows[j][i] - factor * row[i]);
    }
    columns.push(col); pivot++;
  }
  if (rows.some(row => row.slice(0, count).every(v => !v) && row[count])) throw Error('Inconsistent sequencer samples');
  const solution = Array(count).fill(0);
  for (let i = 0; i < columns.length; i++) solution[columns[i]] = rows[i][count];
  const numerator = solution.slice(0, width + errors), denominator = [...solution.slice(width + errors), 1];
  const result = Array(width).fill(0);
  for (let degree = numerator.length - 1; degree >= errors; degree--) {
    const coefficient = numerator[degree]; result[degree - errors] = coefficient;
    for (let j = 0; j <= errors; j++) numerator[degree - errors + j] = mod(numerator[degree - errors + j] - coefficient * denominator[j]);
  }
  if (numerator.some(Boolean) || result.some(v => v > 255)) throw Error('Invalid sequencer state');
  const disagreements = points.filter(([x, y]) => {
    let value = 0;
    for (let i = width - 1; i >= 0; i--) value = mod(value * x + result[i]);
    return value !== y;
  }).length;
  if (disagreements > errors) throw Error('Too many sequencer errors');
  return Buffer.from(result);
}

export function decodeSequencerEvidence(files) {
  return openSeal(JSON.parse(files['capsule.json']), recoverSequencerState(files['afterimage.mid']));
}
