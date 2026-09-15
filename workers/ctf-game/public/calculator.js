const functions = {
  abs: Math.abs, sqrt: Math.sqrt, cbrt: Math.cbrt, ln: Math.log, log: Math.log10,
  exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
};
const precedence = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '**': 8 };
const mod = (value, modulus) => ((value % modulus) + modulus) % modulus;
export function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; }
export function modpow(a, b, n) {
  if (n <= 0n || b < 0n || b.toString(2).length > 16384) throw new Error('范围错误');
  let result = 1n % n;
  for (a = mod(a, n); b; b >>= 1n, a = a * a % n) if (b & 1n) result = result * a % n;
  return result;
}
export function inverse(a, n) {
  if (n <= 1n) throw new Error('范围错误');
  let b = n, x = 1n, y = 0n;
  a = mod(a, n);
  while (b) { const q = a / b; [a, b] = [b, a % b]; [x, y] = [y, x - q * y]; }
  if (a !== 1n) throw new Error('不可逆');
  return mod(x, n);
}

/** A bounded expression parser. It never evaluates JavaScript source. */
export function calculate(source, { integer = false, degrees = false, answer = 0 } = {}) {
  if (typeof source !== 'string' || source.length > 4096) throw new Error('表达式过长');
  const tokens = [];
  const pattern = /\s*(0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-zA-Z_]+|\*\*|<<|>>|[()+\-*/%&|^~!,])/gy;
  let position = 0;
  while (position < source.trimEnd().length) {
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match) throw new Error('无效表达式');
    tokens.push(match[1]); position = pattern.lastIndex;
    if (tokens.length > 768) throw new Error('表达式过长');
  }
  if (!tokens.length) return integer ? 0n : 0;
  let cursor = 0, depth = 0;
  const num = (value) => {
    if (integer) {
      if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('需要精确整数');
      return BigInt(value);
    }
    return Number(value);
  };
  function checked(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('范围错误');
    if (typeof value === 'bigint' && value.toString(2).length > 32768) throw new Error('范围错误');
    return value;
  }
  function invoke(name, values) {
    const arities = { gcd: [2,2], inv: [2,2], modpow: [3,3], min:[1,32], max:[1,32], pow:[2,2], hypot:[1,32], atan2:[2,2] };
    const [min, max] = arities[name] || [1,1];
    if (values.length < min || values.length > max) throw new Error('参数数量错误');
    if (['gcd','inv','modpow'].includes(name)) {
      const result = ({gcd,inv:inverse,modpow}[name])(...values.map((value) => {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('需要精确整数');
        return BigInt(value);
      }));
      return integer ? result : checked(Number(result));
    }
    if (integer) {
      if (name === 'abs') return values[0] < 0n ? -values[0] : values[0];
      if (name === 'min' || name === 'max') return values.reduce((a,b) => (name === 'min' ? a < b : a > b) ? a : b);
      if (name === 'pow') return operation('**', ...values);
      throw new Error('此函数需要科学模式');
    }
    if (['sin','cos','tan'].includes(name)) return Math[name](degrees ? values[0] * Math.PI / 180 : values[0]);
    if (['asin','acos','atan','atan2'].includes(name)) return Math[name](...values) * (degrees ? 180 / Math.PI : 1);
    if (functions[name]) return functions[name](...values);
    throw new Error('未知函数');
  }
  function primary() {
    if (++depth > 64) throw new Error('表达式嵌套过深');
    let value, token = tokens[cursor++];
    if (token === '(') { value = expression(0); if (tokens[cursor++] !== ')') throw new Error('缺少右括号'); }
    else if (['+', '-', '~'].includes(token)) {
      value = expression(7);
      if (token === '-') value = -value;
      if (token === '~') { if (!integer) throw new Error('需要整数模式'); value = ~value; }
    } else if (/^[\d.]/.test(token || '')) { try { value = num(token); } catch { throw new Error('无效数值'); } }
    else if (/^[a-zA-Z_]+$/.test(token || '')) {
      const name = token.toLowerCase();
      if (tokens[cursor] === '(') {
        cursor++; const args = [];
        if (tokens[cursor] !== ')') {
          do { args.push(expression(0)); if (args.length > 32) throw new Error('参数过多'); } while (tokens[cursor] === ',' && ++cursor);
        }
        if (tokens[cursor++] !== ')') throw new Error('缺少右括号');
        value = invoke(name, args);
      } else if (name === 'ans') value = num(answer);
      else if (!integer && name === 'pi') value = Math.PI;
      else if (!integer && name === 'e') value = Math.E;
      else throw new Error('未知常量');
    } else throw new Error('缺少数值');
    while (tokens[cursor] === '!') {
      cursor++;
      if (value < 0 || value > (integer ? 1000 : 170) || !integer && !Number.isInteger(value)) throw new Error('范围错误');
      let result = num(1);
      for (let index = num(2); index <= value; index++) result *= index;
      value = result;
    }
    depth--; return checked(value);
  }
  function operation(op, a, b) {
    if (op === '**' && (integer && (b < 0n || b > 32768n || a !== 0n && a !== 1n && a !== -1n && BigInt(a.toString(2).length) * b > 32768n))) throw new Error('范围错误');
    if (['<<','>>'].includes(op) && (!integer || b < 0n || b > 32768n)) throw new Error('移位范围错误');
    if (['&','|','^'].includes(op) && !integer) throw new Error('需要整数模式');
    if ((op === '/' || op === '%') && b === num(0)) throw new Error('除数为零');
    const ops = { '+':()=>a+b, '-':()=>a-b, '*':()=>a*b, '/':()=>a/b, '%':()=>a%b, '**':()=>a**b, '&':()=>a&b, '|':()=>a|b, '^':()=>a^b, '<<':()=>a<<b, '>>':()=>a>>b };
    return checked(ops[op]());
  }
  function expression(minimum) {
    let left = primary();
    while (precedence[tokens[cursor]] >= minimum) {
      const op = tokens[cursor++], level = precedence[op];
      left = operation(op, left, expression(op === '**' ? level : level + 1));
    }
    return left;
  }
  const result = expression(0);
  if (cursor !== tokens.length) throw new Error('无效表达式');
  return checked(result);
}
