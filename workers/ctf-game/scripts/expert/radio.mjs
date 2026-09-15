import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { crc32, seal } from '../core.mjs';

const ACTIVE = Array.from({ length: 53 }, (_, i) => i - 26).filter(k => k), PILOTS = [-21, -7, 7, 21];
const DATA = ACTIVE.filter(k => !PILOTS.includes(k)), PUNCTURE = [1, 1, 1, 0, 0, 1];
const axis = gray => (2 * (gray ^ gray >> 1 ^ gray >> 2) - 7) / Math.sqrt(42);
const parity = value => { let bit = 0; for (; value; value >>>= 1) bit ^= value & 1; return bit; };
export function radioConvolution(bits) {
  let register = 0; const result = [];
  for (const bit of bits) { register = (register << 1 | bit) & 127; result.push(parity(register & 0o133), parity(register & 0o171)); }
  return result;
}
export function radioCrc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) { crc ^= byte << 8; for (let i = 0; i < 8; i++) crc = (crc << 1 ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff; } return crc;
}
const bitsOf = bytes => [...bytes].flatMap(byte => Array.from({ length: 8 }, (_, bit) => byte >> bit & 1));
function interleave(bits, bpsc) {
  const size = bits.length, s = Math.max(bpsc / 2, 1), out = new Array(size);
  for (let k = 0; k < size; k++) { const i = size / 16 * (k % 16) + Math.floor(k / 16), j = s * Math.floor(i / s) + (i + size - Math.floor(16 * i / size)) % s; out[j] = bits[k]; }
  return out;
}
function pilot(index) {
  let state = 127, bit;
  for (let i = 0; i <= index; i++) { bit = (state >> 6 ^ state >> 3) & 1; state = (state << 1 | bit) & 127; }
  return 1 - 2 * bit;
}
// Unitary inverse DFT, deliberately separate from the receiver's radix-2 FFT.
function modulate(bins) {
  const out = new Float64Array(128);
  for (let n = 0; n < 64; n++) for (let k = 0; k < 64; k++) {
    const a = 2 * Math.PI * k * n / 64, c = Math.cos(a) / 8, s = Math.sin(a) / 8;
    out[n * 2] += bins[k * 2] * c - bins[k * 2 + 1] * s; out[n * 2 + 1] += bins[k * 2] * s + bins[k * 2 + 1] * c;
  }
  return out;
}
function training() {
  const bytes = Buffer.alloc(128), sequence = Buffer.from('98e738d36bc24a9f13a6984e63f1741d', 'hex');
  ACTIVE.forEach((k, i) => bytes.writeInt8(sequence[i >> 3] >> (i & 7) & 1 ? -1 : 1, ((k + 64) % 64) * 2)); return bytes;
}
function packetWave(payload, reference, random) {
  const output = [], append = samples => output.push(...samples), known = Float64Array.from(reference, value => value > 127 ? value - 256 : value), long = modulate(known);
  append(long.subarray(64)); append(long); append(long);
  const emit = (coded, bpsc, ordinal) => {
    const bits = interleave(coded, bpsc), bins = new Float64Array(128);
    DATA.forEach((k, i) => {
      const at = (k + 64) % 64 * 2;
      if (bpsc === 1) bins[at] = 1 - 2 * bits[i];
      else { bins[at] = axis(bits[i * 6] * 4 + bits[i * 6 + 1] * 2 + bits[i * 6 + 2]); bins[at + 1] = axis(bits[i * 6 + 3] * 4 + bits[i * 6 + 4] * 2 + bits[i * 6 + 5]); }
    });
    PILOTS.forEach((k, i) => bins[(k + 64) % 64 * 2] = pilot(ordinal) * (i === 3 ? -1 : 1));
    const wave = modulate(bins); append(wave.subarray(96)); append(wave);
  };
  const header = Buffer.alloc(8); header.write('O6'); header[2] = 1; header.writeUInt16LE(payload.length, 4); header.writeUInt16LE(radioCrc16(header.subarray(0, 6)), 6);
  const headerBits = radioConvolution([...bitsOf(header), ...Array(8).fill(0)]);
  for (let i = 0; i < 3; i++) emit(headerBits.slice(i * 48, (i + 1) * 48), 1, i);
  const count = Math.ceil((16 + payload.length * 8 + 6) / 216), bits = [...Array(16).fill(0), ...bitsOf(payload)];
  while (bits.length < count * 216 - 6) bits.push(0);
  let state = 1 + random(1)[0] % 127;
  for (let i = 0; i < bits.length; i++) { const value = (state >> 6 ^ state >> 3) & 1; state = (state << 1 | value) & 127; bits[i] ^= value; }
  bits.push(...Array(6).fill(0));
  const coded = radioConvolution(bits).filter((_, i) => PUNCTURE[i % 6]);
  for (let i = 0; i < count; i++) emit(coded.slice(i * 288, (i + 1) * 288), 6, i + 3);
  const shift = random(1)[0] % 7 - 3 + (random(2).readUInt16LE() / 65536 - .5) * .8;
  const phase = random(2).readUInt16LE() / 65536 * Math.PI * 2, gain = .8 + random(1)[0] / 255 * .4, conjugate = Boolean(random(1)[0] & 1);
  const notch = DATA.filter(k => Math.abs(k) >= 9 && Math.abs(k) <= 17)[random(1)[0] % 18], theta = 2 * Math.PI * notch / 64;
  const h1 = [-.86 * Math.cos(theta), -.86 * Math.sin(theta)], h3 = [.027, -.021], entropy = random((output.length / 2 + 8) * 4), received = new Float64Array(output.length + 16);
  for (let i = 0; i < received.length / 2; i++) {
    let re = output[i * 2] || 0, im = output[i * 2 + 1] || 0;
    for (const [delay, h] of [[1, h1], [3, h3]]) if (i >= delay) { const a = output[(i - delay) * 2] || 0, b = output[(i - delay) * 2 + 1] || 0; re += a * h[0] - b * h[1]; im += a * h[1] + b * h[0]; }
    const angle = phase + 2 * Math.PI * shift * i / 64, r = gain * (re * Math.cos(angle) - im * Math.sin(angle)), s = gain * (re * Math.sin(angle) + im * Math.cos(angle));
    const amplitude = .020 * Math.sqrt(-2 * Math.log((entropy.readUInt16LE(i * 4) + 1) / 65537)), noisePhase = 2 * Math.PI * entropy.readUInt16LE(i * 4 + 2) / 65536;
    received[i * 2] = r + amplitude * Math.cos(noisePhase) + .003; received[i * 2 + 1] = (conjugate ? -s : s) + amplitude * Math.sin(noisePhase) - .002;
  }
  return received;
}

export function radioEvidence(code, random) {
  const authority = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), random(32)]), type: 'pkcs8', format: 'der' });
  const epoch = 9007199254740992n + BigInt(random(2).readUInt16LE()) * 4n, reference = training(), material = random(32), capture = [];
  const quiet = count => { const noise = random(count * 2); for (const byte of noise) capture.push((byte / 255 - .5) * .05); };
  quiet(96 + random(1)[0]);
  for (const index of [2, 0, 3, 1]) {
    const body = random(256); body.write('RF34'); body.writeBigUInt64LE(epoch + BigInt(index), 4); body[12] = index === 2 ? 0 : 1; body.fill(0, 13, 16); body.set(index === 1 ? material : random(32), 16);
    const signature = sign(null, Buffer.concat([Buffer.from('archive/radio/frame\0'), body]), authority); if (index === 3) signature[39] ^= 1;
    const packet = Buffer.concat([body, signature, Buffer.alloc(4)]); packet.writeUInt32LE(crc32(packet.subarray(0, -4)), packet.length - 4);
    capture.push(...packetWave(packet, reference, random)); quiet(160 + random(1)[0]);
  }
  const bytes = Buffer.alloc(capture.length * 4); capture.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
  return {
    'receiver.sigmf-data': bytes,
    'receiver.sigmf-meta': JSON.stringify({ global: { 'core:datatype': 'cf32_le', 'core:sample_rate': 2000000, 'core:version': '1.2.6', 'core:description': 'Complex baseband acquisition; custom OFDM64 telemetry PHY, not an IEEE 802.11 packet capture.' }, captures: [{ 'core:sample_start': 0, 'core:frequency': 915000000 }], annotations: [] }, null, 2) + '\n',
    'training.i8': reference,
    'attestor.pub.der': createPublicKey(authority).export({ type: 'spki', format: 'der' }),
    'modem.json': JSON.stringify({ format: 'ofdm64-telemetry-v1', fft: 64, prefix: 16, active: ACTIVE, pilots: PILOTS, data: DATA,
      preamble: '32-sample cyclic prefix + two identical 64-sample long symbols. training.i8 contains [real:int8, imag:int8] for unshifted FFT bins 0..63. Unitary inverse DFT.',
      capture: 'SigMF cf32_le: I float32 then Q float32. Burst locations are not annotated. Oscillator error is within +/-3.5 FFT bins. The receiver may conjugate I/Q per burst. Short multipath includes a deep spectral notch; no equalizer or timing state was saved.',
      header: 'Three BPSK OFDM symbols, rate 1/2. Deinterleaved / Viterbi-decoded bits: 8-byte header LSB-first, then eight zeros. Header: O6, version:u8=1, reserved:u8=0, payload_bytes:u16le, CRC16/CCITT-FALSE:u16le(first six bytes).',
      dataCoding: '64-QAM rate 3/4, 48 data carriers, 288 coded / 216 uncoded bits per symbol. SERVICE[16]=0, payload bytes LSB-first, zero padding, six zero tail bits. Pad to an integral number of symbols BEFORE appending the six tail bits. All except tail are scrambled.',
      convolution: 'Constraint length 7, initial/final state zero. r=((r<<1)|bit)&127; emit parity(r&0133), parity(r&0171), where constants are OCTAL. Header unpunctured; data keep mask [1,1,1,0,0,1] repeats over mother-code bits.',
      interleave: 'For N=48(header) or 288(data), s=1 or 3: i=(N/16)*(k mod 16)+floor(k/16); j=s*floor(i/s)+(i+N-floor(16*i/N)) mod s. Transmit input[k] at output[j].',
      constellation: 'Header bit b -> 1-2*b. Data group b0..b5: gI=4*b0+2*b1+b2, gQ=4*b3+2*b4+b5. gray axis a(g)=(2*(g XOR (g>>1) XOR (g>>2))-7)/sqrt(42). No differential encoding.',
      lfsr: 'feedback=((state>>6) XOR (state>>3))&1; state=((state<<1)|feedback)&127. Scrambler XORs feedback with each bit; initial nonzero 7-bit state is not in the header. Pilot state starts 127, advances once per OFDM symbol starting with header symbol 0; values [1,1,1,-1]*(1-2*feedback).',
      payload: '256-byte body, Ed25519 signature[64], CRC32/IEEE:u32le(first 320). Body: RF34, epoch:u64le, committed:u8, reserved[3]=0, material[32], opaque remainder. Signature over UTF8("archive/radio/frame") || 00 || body. FEC and CRC are not authentication. Select the highest authenticated committed epoch.',
      capsuleMaterial: 'The 32 raw material bytes of the selected authenticated body.',
    }, null, 2) + '\n',
    'capsule.json': JSON.stringify(seal({ code }, material, 'archive/radio/ofdm', random), null, 2) + '\n',
  };
}
