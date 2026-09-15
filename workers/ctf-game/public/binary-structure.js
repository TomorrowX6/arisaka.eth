export const STRUCTURE_LIMIT = 8 * 1024 * 1024;
const NODE_LIMIT = 20000, DEPTH_LIMIT = 48, PREVIEW = 512;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const integer = bytes => { let n = 0n; for (const byte of bytes) n = n << 8n | BigInt(byte); return n; };
const universal = { 1: 'BOOLEAN', 2: 'INTEGER', 3: 'BIT STRING', 4: 'OCTET STRING', 5: 'NULL', 6: 'OBJECT IDENTIFIER', 10: 'ENUMERATED', 12: 'UTF8String', 16: 'SEQUENCE', 17: 'SET', 18: 'NumericString', 19: 'PrintableString', 22: 'IA5String', 23: 'UTCTime', 24: 'GeneralizedTime', 26: 'VisibleString', 28: 'UniversalString', 30: 'BMPString' };

/** Offset-preserving syntax inspection, not certificate/signature validation.
 * Large scalar values are explicitly previewed; source spans remain lossless.
 */
export function inspectStructure(input, format = 'der') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > STRUCTURE_LIMIT) throw Error('结构文件超过 8 MiB 限制');
  if (!['der', 'cbor'].includes(format)) throw Error('请选择 DER 或 CBOR');
  if (!bytes.length) throw Error('文件为空');
  let at = 0, count = 0;
  const fail = message => { throw Error(format.toUpperCase() + ' @0x' + at.toString(16) + ': ' + message); };
  const take = (length, end = bytes.length) => {
    if (!Number.isSafeInteger(length) || length < 0 || at + length > end) fail('数据截断或长度越界');
    const data = bytes.subarray(at, at + length); at += length; return data;
  };
  function begin(depth) {
    if (depth > DEPTH_LIMIT || ++count > NODE_LIMIT) fail('最多 48 层 / 20000 个节点');
    return { id: count, offset: at, headerLength: 0, length: 0, payloadOffset: 0, payloadLength: 0, value: '', valueTruncated: false, warnings: [], children: [] };
  }
  function preview(node, data, asText = false) {
    if (asText) {
      let text; try { text = utf8.decode(data); } catch { fail('无效 UTF-8'); }
      node.valueTruncated = text.length > PREVIEW; node.value = text.slice(0, PREVIEW) + (node.valueTruncated ? '…' : '');
    } else { node.valueTruncated = data.length > PREVIEW / 2; node.value = hex(data.subarray(0, PREVIEW / 2)) + (node.valueTruncated ? '…' : ''); }
  }
  const finish = node => { node.length = at - node.offset; return node; };
  function der(depth, end) {
    const node = begin(depth), first = take(1, end)[0], cls = first >> 6, constructed = Boolean(first & 32);
    let tag = first & 31;
    if (tag === 31) {
      tag = 0; let octet, width = 0;
      do { octet = take(1, end)[0]; if (!width && !(octet & 127)) fail('非最短 high-tag 编码'); if (++width > 5) fail('tag 过大'); tag = tag * 128 + (octet & 127); } while (octet & 128);
      if (tag < 31) fail('非最短 tag 编码');
    }
    let length = take(1, end)[0];
    if (length === 128) fail('DER 不允许不定长编码');
    if (length & 128) {
      const width = length & 127; if (!width || width > 4) fail('DER 长度过大');
      const encoded = take(width, end); if (!encoded[0]) fail('非最短 length 编码');
      length = Number(integer(encoded)); if (length < 128) fail('非最短 length 编码');
    }
    node.kind = 'der'; node.tagClass = ['universal', 'application', 'context', 'private'][cls]; node.tag = tag; node.constructed = constructed;
    node.label = (cls === 0 ? universal[tag] || 'UNIVERSAL ' + tag : '[' + node.tagClass + ' ' + tag + ']') + (constructed ? ' ◇' : '');
    node.payloadOffset = at; node.payloadLength = length; node.headerLength = at - node.offset;
    if (at + length > end) fail('子对象越过父对象边界'); const limit = at + length;
    if (cls === 0 && tag === 0) fail('DER 不允许 EOC');
    if (cls === 0 && [16, 17].includes(tag) && !constructed) fail('SEQUENCE / SET 必须是构造类型');
    if (constructed) {
      if (cls === 0 && ![8, 11, 16, 17, 29].includes(tag)) fail('DER 基本类型不能使用构造编码');
      while (at < limit) node.children.push(der(depth + 1, limit));
      node.value = node.children.length + ' 个子对象';
      if (cls === 0 && tag === 17) node.warnings.push('SET / SET OF 排序与字段语义需要 ASN.1 schema；本工具只检查通用结构');
    } else {
      const data = take(length, end); preview(node, data);
      if (cls === 0) {
        if (tag === 1) { if (length !== 1 || ![0, 255].includes(data[0])) fail('DER BOOLEAN 必须为 00 或 ff'); node.value = data[0] ? 'true' : 'false'; }
        else if (tag === 2 || tag === 10) {
          if (!length || length > 1 && (data[0] === 0 && !(data[1] & 128) || data[0] === 255 && data[1] & 128)) fail('非最短有符号整数');
          if (length <= 256) node.value = String(integer(data) - (data[0] & 128 ? 1n << BigInt(length * 8) : 0n));
          else { node.value = (data[0] & 128 ? 'negative' : 'positive') + ' · hex ' + node.value; node.valueTruncated = true; }
        } else if (tag === 3) {
          if (!length || data[0] > 7 || length === 1 && data[0] || length > 1 && data.at(-1) & (1 << data[0]) - 1) fail('BIT STRING 未使用位无效');
          node.value = 'unused=' + data[0] + ' · ' + hex(data.subarray(1, PREVIEW / 2)); node.valueTruncated = length - 1 > PREVIEW / 2;
        } else if (tag === 5) { if (length) fail('NULL 长度必须为 0'); node.value = 'null'; }
        else if (tag === 6) {
          if (!length || length > 4096) fail('OID 为空或超过限制');
          const arcs = []; let arc = 0n, firstByte = true;
          for (const byte of data) {
            if (firstByte && byte === 128) fail('OID 子标识符非最短编码');
            arc = arc << 7n | BigInt(byte & 127); firstByte = !(byte & 128);
            if (firstByte) { arcs.push(arc); arc = 0n; }
          }
          if (!firstByte) fail('OID 子标识符截断');
          const lead = arcs.shift(), head = lead < 40n ? 0n : lead < 80n ? 1n : 2n;
          const text = [head, lead - head * 40n, ...arcs].join('.'); node.valueTruncated = text.length > PREVIEW; node.value = text.slice(0, PREVIEW) + (node.valueTruncated ? '…' : '');
        } else if (tag === 12) preview(node, data, true);
        else if ([18, 19, 22, 23, 24, 26].includes(tag)) {
          if (data.some(byte => byte > 127)) fail('非 ASCII 字符'); preview(node, data, true);
          const full = new TextDecoder().decode(data);
          if (tag === 18 && !/^[0-9 ]*$/.test(full) || tag === 19 && !/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(full)
            || tag === 26 && data.some(byte => byte < 32 || byte > 126)) fail('字符串超出 ASN.1 字符集');
          if (tag === 23 || tag === 24) node.warnings.push('时间显示保留原值；不进行证书有效期或时钟信任判断');
        } else if (tag === 30 || tag === 28) {
          const width = tag === 30 ? 2 : 4; if (length % width) fail('宽字符长度无效'); let text = '';
          for (let i = 0; i < length; i += width) {
            const code = Number(integer(data.subarray(i, i + width))); if (code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) fail('无效 Unicode 码点');
            if (text.length < PREVIEW) text += String.fromCodePoint(code);
          }
          node.valueTruncated = length / width > [...text].length; node.value = text + (node.valueTruncated ? '…' : '');
        }
      }
    }
    return finish(node);
  }
  function cbor(depth) {
    const node = begin(depth), first = take(1)[0], major = first >> 5, additional = first & 31;
    node.kind = 'cbor'; node.major = major;
    if ([28, 29, 30].includes(additional)) fail('保留的 additional information');
    const indefinite = additional === 31;
    if (indefinite && ![2, 3, 4, 5].includes(major)) fail('此类型不能不定长；break 只能结束不定长容器');
    let argument = BigInt(additional), argumentBytes;
    if (additional >= 24 && additional <= 27) {
      argumentBytes = take(1 << (additional - 24)); argument = integer(argumentBytes);
      if (major !== 7 && argument < [24n, 256n, 65536n, 4294967296n][additional - 24]) node.warnings.push('非 preferred length / integer 编码');
    }
    node.headerLength = at - node.offset; node.payloadOffset = at; node.indefinite = indefinite;
    const length = () => { if (argument > BigInt(STRUCTURE_LIMIT)) fail('容器计数或长度超过限制'); return Number(argument); };
    if (major <= 1) { node.label = major ? 'negative integer' : 'unsigned integer'; node.value = String(major ? -1n - argument : argument); }
    else if (major === 2 || major === 3) {
      node.label = major === 2 ? 'byte string' : 'text string';
      if (indefinite) {
        let payloadBytes = 0;
        while (bytes[at] !== 255) {
          const child = cbor(depth + 1); if (child.major !== major || child.indefinite) fail('不定长字符串必须由同类定长块组成');
          payloadBytes += child.payloadLength; node.children.push(child);
        }
        node.payloadLength = at - node.payloadOffset; take(1); node.contentBytes = payloadBytes;
        node.value = node.children.length + ' 块 · ' + payloadBytes + ' 内容字节'; node.warnings.push('不定长字符串的原始负载含分块头，不是拼接后的内容');
      } else { const data = take(length()); node.payloadLength = data.length; preview(node, data, major === 3); }
    } else if (major === 4 || major === 5) {
      node.label = major === 4 ? 'array' : 'map'; const n = indefinite ? null : length() * (major === 5 ? 2 : 1);
      if (n !== null && (n > NODE_LIMIT - count || n > bytes.length - at)) fail('容器计数超过节点或文件范围');
      while (n === null ? bytes[at] !== 255 : node.children.length < n) node.children.push(cbor(depth + 1));
      if (major === 5 && node.children.length % 2) fail('map 缺少 value');
      node.payloadLength = at - node.payloadOffset; if (indefinite) take(1);
      node.value = (major === 5 ? node.children.length / 2 + ' 对（保留全部键）' : node.children.length + ' 项');
      if (major === 5) {
        const keys = new Set();
        node.children.forEach((child, index) => {
          child.role = (index % 2 ? 'value ' : 'key ') + Math.floor(index / 2);
          if (!(index % 2)) {
            const key = child.major <= 1 || child.major === 3 && !child.valueTruncated && !child.indefinite
              ? child.major + ':' + child.value : hex(bytes.subarray(child.offset, child.offset + child.length));
            if (keys.has(key)) node.warnings.push('重复 map key；所有条目均已保留，未覆盖'); keys.add(key);
          }
        });
      }
    } else if (major === 6) { node.label = 'tag ' + argument; node.value = String(argument); node.children.push(cbor(depth + 1)); node.payloadLength = at - node.payloadOffset; }
    else {
      node.label = 'simple';
      if (additional < 20) node.value = 'simple(' + additional + ')';
      else if (additional < 24) node.value = ['false', 'true', 'null', 'undefined'][additional - 20];
      else if (additional === 24) { if (argument < 32n) fail('无效的两字节 simple 编码'); node.value = 'simple(' + argument + ')'; }
      else {
        node.label = 'float' + (argumentBytes.length * 8); let value;
        if (additional === 25) {
          const word = Number(argument), sign = word & 32768 ? -1 : 1, exponent = word >> 10 & 31, mantissa = word & 1023;
          value = exponent === 31 ? mantissa ? NaN : sign * Infinity : sign * (exponent ? 1 + mantissa / 1024 : mantissa / 1024) * 2 ** (exponent ? exponent - 15 : -14);
        } else { const view = new DataView(argumentBytes.buffer, argumentBytes.byteOffset, argumentBytes.byteLength); value = additional === 26 ? view.getFloat32(0) : view.getFloat64(0); }
        node.value = Object.is(value, -0) ? '-0' : String(value);
      }
    }
    return finish(node);
  }
  const roots = [];
  while (at < bytes.length) roots.push(format === 'der' ? der(0, bytes.length) : cbor(0));
  return { format, byteLength: bytes.length, nodeCount: count, roots,
    scope: format === 'der' ? 'Generic DER TLV syntax; schema, certificate trust and signatures are not verified.' : 'CBOR sequence; tags are structural, duplicate map entries are preserved, deterministic encoding is not assumed.' };
}

export function structureRows(tree, collapsed = new Set()) {
  const rows = [];
  function visit(node, depth, parent) { rows.push({ node, depth, parent }); if (!collapsed.has(node.id)) for (const child of node.children) visit(child, depth + 1, node.id); }
  for (const root of tree.roots) visit(root, 0, null); return rows;
}
