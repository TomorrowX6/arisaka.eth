// General-purpose byte transformations. No challenge metadata, network or eval.
export const PIPELINE_LIMIT = 8 * 1024 * 1024;
export const pipelineOperations = Object.freeze([
  ['fromHex', 'Hex → 字节', ''], ['toHex', '字节 → Hex', ''],
  ['fromBase64', 'Base64 → 字节', ''], ['toBase64', '字节 → Base64', ''],
  ['fromBase64url', 'Base64url → 字节', ''], ['toBase64url', '字节 → Base64url', ''],
  ['fromBits', '二进制文本 → 字节', ''], ['toBits', '字节 → 二进制文本', ''],
  ['xor', '循环 XOR', '十六进制密钥'], ['swap', '交换字节序', '字宽：2 / 4 / 8'],
  ['slice', '截取字节', '起点:终点（不含终点）'], ['reverse', '逆转字节顺序', ''], ['reverseBits', '反转每字节的位', ''],
  ['gzip', 'Gzip 压缩', ''], ['gunzip', 'Gzip 解压', ''], ['deflate', 'Zlib 压缩', ''], ['inflate', 'Zlib 解压', ''],
  ['sha256', 'SHA-256', ''], ['sha512', 'SHA-512', ''], ['sha1', 'SHA-1', ''],
]);
const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const bounded = bytes => { if (bytes.byteLength > PIPELINE_LIMIT) throw Error('数据超过 8 MiB 限制'); return bytes; };

export function hexBytes(text) {
  const value = text.replace(/\s+/g, '');
  if (value.length % 2 || /[^\da-f]/i.test(value)) throw Error('Hex 必须是完整的十六进制字节');
  if (value.length > PIPELINE_LIMIT * 2) throw Error('数据超过 8 MiB 限制');
  return Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16));
}

export function base64Bytes(text, url = false) {
  let value = text.replace(/\s+/g, '');
  if (url) { if (/[^\w=\-]/.test(value)) throw Error('无效的 Base64url'); value = value.replaceAll('-', '+').replaceAll('_', '/'); }
  const unpadded = value.replace(/=+$/, ''), padding = value.length - unpadded.length;
  if (/[^A-Za-z0-9+/]/.test(unpadded) || unpadded.length % 4 === 1 || padding > 2
    || padding && (value.length % 4 || padding !== (4 - unpadded.length % 4) % 4)) throw Error('无效的 Base64');
  if (unpadded.length * 3 / 4 > PIPELINE_LIMIT) throw Error('数据超过 8 MiB 限制');
  const binary = atob(value);
  // Reject non-canonical unused bits instead of silently changing malformed data.
  if (btoa(binary).replace(/=+$/, '') !== value.replace(/=+$/, '')) throw Error('Base64 含非零填充位');
  return bounded(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

export function bytesBase64(bytes, url = false) {
  let text = '';
  for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  const value = btoa(text);
  return url ? value.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') : value;
}

export function validateRecipe(value) {
  if (!value || value.format !== 'arisaka-data-recipe-v1' || !Array.isArray(value.steps) || value.steps.length > 32) throw Error('无效的配方（最多 32 步）');
  return { format: value.format, steps: value.steps.map((step, index) => {
    if (!step || !pipelineOperations.some(([op]) => op === step.op) || typeof (step.arg ?? '') !== 'string' || (step.arg || '').length > 4096) throw Error('配方第 ' + (index + 1) + ' 步无效');
    return { op: step.op, arg: step.arg || '' };
  }) };
}

async function compress(bytes, format, decompress) {
  const stream = new Blob([bytes]).stream().pipeThrough(decompress ? new DecompressionStream(format) : new CompressionStream(format));
  const reader = stream.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > PIPELINE_LIMIT) throw Error('解压/压缩结果超过 8 MiB 限制');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const output = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
  return output;
}

async function transform(input, { op, arg }) {
  if (op === 'fromHex') return hexBytes(decode(input));
  if (op === 'toHex') { if (input.length * 2 > PIPELINE_LIMIT) throw Error('Hex 输出超过 8 MiB'); return encode(Array.from(input, byte => byte.toString(16).padStart(2, '0')).join('')); }
  if (op === 'fromBase64' || op === 'fromBase64url') return base64Bytes(decode(input), op.endsWith('url'));
  if (op === 'toBase64' || op === 'toBase64url') { if (Math.ceil(input.length / 3) * 4 > PIPELINE_LIMIT) throw Error('Base64 输出超过 8 MiB'); return encode(bytesBase64(input, op.endsWith('url'))); }
  if (op === 'fromBits') {
    const value = decode(input).replace(/\s+/g, '');
    if (value.length % 8 || /[^01]/.test(value)) throw Error('二进制文本必须由完整的 8 位字节组成');
    return Uint8Array.from(value.match(/.{8}/g) || [], byte => parseInt(byte, 2));
  }
  if (op === 'toBits') { if (input.length * 8 > PIPELINE_LIMIT) throw Error('位文本输出超过 8 MiB'); return encode(Array.from(input, byte => byte.toString(2).padStart(8, '0')).join('')); }
  if (op === 'xor') {
    const key = hexBytes(arg); if (!key.length) throw Error('XOR 密钥不能为空');
    return input.map((byte, i) => byte ^ key[i % key.length]);
  }
  if (op === 'reverse') return input.slice().reverse();
  if (op === 'reverseBits') return input.map(byte => { let value = 0; for (let i = 0; i < 8; i++) { value = value * 2 + (byte & 1); byte >>= 1; } return value; });
  if (op === 'swap') {
    const width = Number(arg);
    if (![2, 4, 8].includes(width) || input.length % width) throw Error('字宽须为 2 / 4 / 8，且数据长度须为其整数倍');
    const output = input.slice();
    for (let at = 0; at < output.length; at += width) output.subarray(at, at + width).reverse();
    return output;
  }
  if (op === 'slice') {
    const match = /^(0x[\da-f]+|\d+):(0x[\da-f]+|\d+)?$/i.exec(arg.trim());
    if (!match) throw Error('截取参数格式为 起点:终点（十进制或 0x 十六进制）');
    const start = Number(match[1]), end = match[2] === undefined ? input.length : Number(match[2]);
    if (![start, end].every(Number.isSafeInteger) || start > end || end > input.length) throw Error('截取范围超出数据');
    return input.slice(start, end);
  }
  if (['gzip', 'gunzip', 'deflate', 'inflate'].includes(op)) return compress(input, op.includes('zip') ? 'gzip' : 'deflate', op === 'gunzip' || op === 'inflate');
  if (['sha256', 'sha512', 'sha1'].includes(op)) return new Uint8Array(await crypto.subtle.digest({ sha256: 'SHA-256', sha512: 'SHA-512', sha1: 'SHA-1' }[op], input));
  throw Error('未知操作');
}

export async function runPipeline(bytes, recipe) {
  const { steps } = validateRecipe(recipe); let output = bounded(new Uint8Array(bytes)); const history = [];
  for (const [index, step] of steps.entries()) {
    const inputBytes = output.length;
    try { output = bounded(await transform(output, step)); }
    catch (error) { throw Error('第 ' + (index + 1) + ' 步：' + error.message); }
    history.push({ operation: step.op, inputBytes, outputBytes: output.length });
  }
  return { bytes: output, history };
}
