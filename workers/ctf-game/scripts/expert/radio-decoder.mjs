import { createPublicKey, verify } from 'node:crypto';
import { openSeal } from '../decoders.mjs';

// Maintenance-only receiver. It does not import the transmitter or its coding,
// transform, constellation, synchronization or checksum implementation.
const ACTIVE = Array.from({ length: 53 }, (_, i) => i - 26).filter(Boolean);
const PILOTS = [-21, -7, 7, 21], DATA = ACTIVE.filter(k => !PILOTS.includes(k));
const bin = k => (k + 64) % 64;
const parity = n => { n ^= n >>> 4; n ^= n >>> 2; n ^= n >>> 1; return n & 1; };

export function radioFft(input, inverse = false) {
  if (input.length !== 128) throw Error('OFDM FFT requires 64 complex samples');
  const out = Float64Array.from(input);
  for (let i = 1, j = 0; i < 64; i++) {
    let bit = 32;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) for (let part = 0; part < 2; part++) [out[2 * i + part], out[2 * j + part]] = [out[2 * j + part], out[2 * i + part]];
  }
  for (let width = 2; width <= 64; width *= 2) {
    for (let start = 0; start < 64; start += width) for (let j = 0; j < width / 2; j++) {
      const angle = (inverse ? 2 : -2) * Math.PI * j / width, c = Math.cos(angle), s = Math.sin(angle);
      const a = 2 * (start + j), b = a + width;
      const re = out[b] * c - out[b + 1] * s, im = out[b] * s + out[b + 1] * c;
      out[b] = out[a] - re; out[b + 1] = out[a + 1] - im;
      out[a] += re; out[a + 1] += im;
    }
  }
  for (let i = 0; i < 128; i++) out[i] /= 8;
  return out;
}

export function radioChecksums(bytes) {
  let ieee = -1, ccitt = 65535;
  for (const byte of bytes) {
    ieee ^= byte; ccitt ^= byte * 256;
    for (let i = 0; i < 8; i++) {
      ieee = ieee >>> 1 ^ (-(ieee & 1) & 0xedb88320);
      ccitt = ((ccitt * 2) ^ (ccitt & 32768 ? 0x1021 : 0)) & 65535;
    }
  }
  return { crc32: ~ieee >>> 0, crc16: ccitt };
}

const transition = Array.from({ length: 128 }, (_, register) => [parity(register & 91), parity(register & 121)]);

// Positive LLR means bit 0; zero is an erasure. Initial and final states are
// zero. The survivor store is bounded and no arbitrary traceback depth is used.
export function radioViterbi(llrs) {
  if (!llrs.length || llrs.length % 2 || llrs.length > 100000 || llrs.some(n => !Number.isFinite(n))) throw Error('OFDM Viterbi input bounds');
  const length = llrs.length / 2, survivors = new Uint8Array(length * 64);
  let scores = new Float64Array(64).fill(-Infinity); scores[0] = 0;
  for (let t = 0; t < length; t++) {
    const next = new Float64Array(64);
    for (let state = 0; state < 64; state++) {
      const low = state >>> 1, high = low | 32, bit = state & 1;
      const a = transition[low * 2 + bit], b = transition[high * 2 + bit];
      const sa = scores[low] + (1 - 2 * a[0]) * llrs[2 * t] + (1 - 2 * a[1]) * llrs[2 * t + 1];
      const sb = scores[high] + (1 - 2 * b[0]) * llrs[2 * t] + (1 - 2 * b[1]) * llrs[2 * t + 1];
      next[state] = Math.max(sa, sb); survivors[t * 64 + state] = sb > sa ? 1 : 0;
    }
    scores = next;
  }
  if (!Number.isFinite(scores[0])) throw Error('OFDM Viterbi has no terminated path');
  const bits = new Uint8Array(length); let state = 0;
  for (let t = length - 1; t >= 0; t--) { bits[t] = state & 1; state = (state >>> 1) | survivors[t * 64 + state] * 32; }
  if (state !== 0) throw Error('OFDM Viterbi initial state');
  let hardErrors = 0, register = 0;
  bits.forEach((bit, t) => {
    register = (register * 2 + bit) % 128;
    transition[register].forEach((expected, j) => { if (llrs[t * 2 + j] && (llrs[t * 2 + j] < 0 ? 1 : 0) !== expected) hardErrors++; });
  });
  return { bits, hardErrors, score: scores[0] };
}

export function radioDeinterleave(values, bpsc) {
  const n = bpsc === 1 ? 48 : bpsc === 6 ? 288 : 0;
  if (!n || values.length !== n) throw Error('OFDM interleaver size');
  const out = new Float64Array(n), stride = Math.max(1, bpsc / 2);
  for (let k = 0; k < n; k++) {
    const first = n / 16 * (k % 16) + Math.floor(k / 16);
    const second = stride * Math.floor(first / stride) + (first + n - Math.floor(first * 16 / n)) % stride;
    out[k] = values[second];
  }
  return out;
}

function sigmf(files) {
  const meta = JSON.parse(files['receiver.sigmf-meta']), profile = JSON.parse(files['modem.json']);
  if (meta.global?.['core:datatype'] !== 'cf32_le' || meta.global?.['core:sample_rate'] !== 2000000) throw Error('OFDM SigMF datatype / sample rate');
  if (profile.format !== 'ofdm64-telemetry-v1' || profile.fft !== 64 || profile.prefix !== 16
    || JSON.stringify(profile.active) !== JSON.stringify(ACTIVE) || JSON.stringify(profile.pilots) !== JSON.stringify(PILOTS)
    || JSON.stringify(profile.data) !== JSON.stringify(DATA)) throw Error('OFDM modem profile');
  const bytes = Buffer.from(files['receiver.sigmf-data']), training = Buffer.from(files['training.i8']);
  if (bytes.length % 8 || bytes.length < 1024 || bytes.length > 4000000) throw Error('OFDM SigMF length');
  if (training.length !== 128) throw Error('OFDM training length');
  const reference = Float64Array.from(training, n => n > 127 ? n - 256 : n);
  for (let k = 0; k < 64; k++) {
    const active = ACTIVE.some(n => bin(n) === k);
    if (reference[2 * k + 1] !== 0 || (active ? Math.abs(reference[2 * k]) !== 1 : reference[2 * k] !== 0)) throw Error('OFDM training bins');
  }
  const samples = new Float64Array(bytes.length / 4);
  for (let at = 0; at < samples.length; at++) {
    samples[at] = bytes.readFloatLE(at * 4);
    if (!Number.isFinite(samples[at]) || Math.abs(samples[at]) > 100) throw Error('OFDM non-finite or excessive sample');
  }
  return { samples, reference };
}

// Lag-64 normalized correlation detects the repeated long symbols without any
// annotations, magic file offsets or transmitter-side timing state.
export function radioTrainingRuns(samples) {
  const count = samples.length / 2, runs = [];
  let pr = 0, pi = 0, e1 = 0, e2 = 0, current;
  const accumulate = (n, sign) => {
    const ar = samples[2 * n], ai = samples[2 * n + 1], br = samples[2 * (n + 64)], bi = samples[2 * (n + 64) + 1];
    pr += sign * (ar * br + ai * bi); pi += sign * (ar * bi - ai * br);
    e1 += sign * (ar * ar + ai * ai); e2 += sign * (br * br + bi * bi);
  };
  for (let i = 0; i < 64; i++) accumulate(i, 1);
  for (let n = 0; n + 128 <= count; n++) {
    const coherence = Math.hypot(pr, pi) / Math.sqrt(Math.max(1e-20, e1 * e2));
    if (coherence >= .90 && Math.min(e1, e2) > 2) {
      if (!current) current = { start: n, end: n, peak: 0, fractional: 0 };
      current.end = n;
      if (coherence > current.peak) { current.peak = coherence; current.fractional = Math.atan2(pi, pr) / (2 * Math.PI); }
    } else if (current) { if (current.end - current.start >= 7) runs.push(current); current = undefined; }
    if (n + 128 < count) { accumulate(n, -1); accumulate(n + 64, 1); }
  }
  if (current && current.end - current.start >= 7) runs.push(current);
  if (runs.length > 32) throw Error('OFDM acquisition burst bound');
  return runs;
}

function spectrum(samples, start, frequency, orientation) {
  if (start < 0 || (start + 64) * 2 > samples.length) throw Error('Truncated OFDM symbol');
  const time = new Float64Array(128);
  for (let i = 0; i < 64; i++) {
    const n = start + i, angle = 2 * Math.PI * frequency * n / 64, c = Math.cos(angle), s = Math.sin(angle);
    const re = samples[2 * n], im = samples[2 * n + 1] * orientation;
    time[2 * i] = re * c + im * s; time[2 * i + 1] = im * c - re * s;
  }
  return radioFft(time);
}

function hypotheses(samples, reference, run) {
  const candidates = [];
  for (const orientation of [1, -1]) for (let integer = -3; integer <= 3; integer++) {
    const frequency = integer + orientation * run.fractional;
    for (let start = Math.max(0, run.end - 40); start <= run.end + 4; start++) {
      if ((start + 128) * 2 > samples.length) continue;
      const first = spectrum(samples, start, frequency, orientation), second = spectrum(samples, start + 64, frequency, orientation), channel = new Float64Array(128);
      for (const k of ACTIVE) { const p = 2 * bin(k); channel[p] = (first[p] + second[p]) / (2 * reference[p]); channel[p + 1] = (first[p + 1] + second[p + 1]) / (2 * reference[p]); }
      const taps = radioFft(channel, true); let causal = 0, total = 0;
      for (let i = 0; i < 64; i++) { const power = taps[2 * i] ** 2 + taps[2 * i + 1] ** 2; total += power; if (i < 16) causal += power; }
      const concentration = causal / total;
      if (concentration > .55) candidates.push({ start, frequency, orientation, integer, channel, concentration });
    }
  }
  return candidates.sort((a, b) => b.concentration - a.concentration).slice(0, 32);
}

const levels = Array.from({ length: 8 }, (_, gray) => {
  let binary = gray;
  for (let shifted = gray >>> 1; shifted; shifted >>>= 1) binary ^= shifted;
  return (binary * 2 - 7) / Math.sqrt(42);
});
function pilotPolarity(index) {
  let state = 127, feedback = 0;
  for (let i = 0; i <= index; i++) { feedback = ((state & 64) !== 0) ^ ((state & 8) !== 0); state = ((state * 2) + feedback) % 128; }
  return feedback ? -1 : 1;
}

function demap(samples, candidate, ordinal, bpsc) {
  const { start, frequency, orientation, channel } = candidate;
  const received = spectrum(samples, start + 128 + 16 + ordinal * 80, frequency, orientation);
  let phaseRe = 0, phaseIm = 0;
  PILOTS.forEach((k, i) => {
    const p = 2 * bin(k), sign = pilotPolarity(ordinal) * (i === 3 ? -1 : 1);
    phaseRe += sign * (received[p] * channel[p] + received[p + 1] * channel[p + 1]);
    phaseIm += sign * (received[p + 1] * channel[p] - received[p] * channel[p + 1]);
  });
  const phase = Math.atan2(phaseIm, phaseRe), c = Math.cos(phase), s = Math.sin(phase), llrs = new Float64Array(48 * bpsc);
  DATA.forEach((k, index) => {
    const p = 2 * bin(k), hr = channel[p], hi = channel[p + 1], weight = hr * hr + hi * hi;
    const yr = received[p] * c + received[p + 1] * s, yi = received[p + 1] * c - received[p] * s;
    if (bpsc === 1) { llrs[index] = 4 * (yr * hr + yi * hi); return; }
    if (weight < 1e-12) return; // A nulled carrier is an erasure, not a confident hard bit.
    const components = [(yr * hr + yi * hi) / weight, (yi * hr - yr * hi) / weight];
    components.forEach((value, component) => {
      for (let bit = 0; bit < 3; bit++) {
        let zero = Infinity, one = Infinity;
        levels.forEach((level, label) => {
          const distance = (value - level) ** 2;
          if (label & (1 << (2 - bit))) one = Math.min(one, distance); else zero = Math.min(zero, distance);
        });
        llrs[index * 6 + component * 3 + bit] = (one - zero) * weight;
      }
    });
  });
  return radioDeinterleave(llrs, bpsc);
}

const toBytes = bits => {
  if (bits.length % 8) throw Error('OFDM non-byte payload');
  const bytes = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, i) => { bytes[i >>> 3] |= bit << (i % 8); }); return bytes;
};

function decodeCandidate(samples, candidate) {
  const headerLlrs = Float64Array.from(Array.from({ length: 3 }, (_, i) => [...demap(samples, candidate, i, 1)]).flat());
  const headerPath = radioViterbi(headerLlrs), header = toBytes(headerPath.bits.subarray(0, 64));
  if (header.toString('ascii', 0, 2) !== 'O6' || header[2] !== 1 || header[3] || headerPath.bits.subarray(64).some(Boolean)
    || radioChecksums(header.subarray(0, 6)).crc16 !== header.readUInt16LE(6)) throw Error('OFDM header CRC / schema');
  const length = header.readUInt16LE(4);
  if (length !== 324) throw Error('OFDM telemetry frame length');
  const symbols = Math.ceil((16 + length * 8 + 6) / 216), coded = Float64Array.from(Array.from({ length: symbols }, (_, i) => [...demap(samples, candidate, i + 3, 6)]).flat());
  const mother = new Float64Array(symbols * 432), mask = [1, 1, 1, 0, 0, 1]; let at = 0;
  for (let i = 0; i < mother.length; i++) if (mask[i % 6]) mother[i] = coded[at++];
  const decoded = radioViterbi(mother), bits = decoded.bits;
  if (bits.subarray(-6).some(Boolean)) throw Error('OFDM tail bits');
  const states = [];
  for (let initial = 1; initial < 128; initial++) {
    let state = initial, valid = true;
    for (let i = 0; i < 16; i++) { const feedback = parity(state & 72); state = (state * 2 + feedback) % 128; if (feedback !== bits[i]) valid = false; }
    if (valid) states.push(initial);
  }
  if (states.length !== 1) throw Error('OFDM service / scrambler state');
  let state = states[0];
  for (let i = 0; i < bits.length - 6; i++) { const feedback = parity(state & 72); state = (state * 2 + feedback) % 128; bits[i] ^= feedback; }
  if (bits.subarray(0, 16).some(Boolean) || bits.subarray(16 + length * 8, -6).some(Boolean)) throw Error('OFDM service / padding bits');
  const packet = toBytes(bits.subarray(16, 16 + length * 8));
  if (radioChecksums(packet.subarray(0, -4)).crc32 !== packet.readUInt32LE(packet.length - 4)) throw Error('OFDM payload CRC');
  return { packet, hardErrors: decoded.hardErrors, headerHardErrors: headerPath.hardErrors, scramblerState: states[0] };
}

export function receiveRadio(files) {
  const { samples, reference } = sigmf(files), runs = radioTrainingRuns(samples), frames = [], rejected = [];
  for (const run of runs) {
    let accepted, lastError = 'no causal channel hypothesis';
    for (const candidate of hypotheses(samples, reference, run)) {
      try {
        const decoded = decodeCandidate(samples, candidate);
        accepted = { ...decoded, sampleStart: candidate.start, frequencyBins: candidate.frequency, integerBins: candidate.integer, conjugated: candidate.orientation === -1, concentration: candidate.concentration };
        break;
      } catch (error) { lastError = error.message; }
    }
    if (accepted) frames.push(accepted); else rejected.push({ start: run.start, error: lastError });
  }
  return { frames, rejected, bursts: runs.length, samples: samples.length / 2 };
}

export function recoverRadioMaterial(files) {
  const reception = receiveRadio(files), authority = createPublicKey({ key: files['attestor.pub.der'], format: 'der', type: 'spki' }), commits = new Map();
  let authenticated = 0, forged = 0, prepared = 0;
  for (const frame of reception.frames) {
    const body = frame.packet.subarray(0, 256), signature = frame.packet.subarray(256, 320);
    if (!verify(null, Buffer.concat([Buffer.from('archive/radio/frame\0'), body]), authority, signature)) { forged++; continue; }
    if (body.toString('ascii', 0, 4) !== 'RF34' || body[12] > 1 || body.subarray(13, 16).some(Boolean)) throw Error('Authenticated radio body schema');
    authenticated++;
    if (!body[12]) { prepared++; continue; }
    const epoch = body.readBigUInt64LE(4);
    if (commits.has(epoch) && !commits.get(epoch).equals(body)) throw Error('Conflicting authenticated radio epoch');
    commits.set(epoch, body);
  }
  const epoch = [...commits.keys()].sort((a, b) => a > b ? -1 : a < b ? 1 : 0)[0];
  if (epoch === undefined) throw Error('No authenticated radio commit');
  return { ...reception, material: commits.get(epoch).subarray(16, 48), epoch, authenticated, forged, prepared };
}

export function decodeRadioEvidence(files) {
  return openSeal(JSON.parse(files['capsule.json']), recoverRadioMaterial(files).material);
}
