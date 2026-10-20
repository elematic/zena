/**
 * `zena:host:number`: the number-to-string conversions a `--target js`
 * module imports (stdlib `core/number-format-js.zena`).
 *
 * Each returns exactly what the byte targets' implementation in
 * `core/string-convert.zena` returns, so a program prints the same text on
 * every target. JavaScript's own conversions give that directly for the
 * integers and for `f64ToString`, except that Zena prints negative zero as
 * `-0`. JavaScript has no f32 printing, and `toPrecision` rounds a tie away
 * from zero where Zena rounds it to even, so `f32ToString` and
 * `f64ToPrecision` are computed here, exactly, with BigInt arithmetic.
 *
 * `parseF64` (stdlib `core/number-parse-js.zena`) is here too. It reads
 * Zena's grammar, which `Number()` does not, and leaves the correctly
 * rounded conversion to `Number()`.
 */

const view = new DataView(new ArrayBuffer(8));

/** NaN, the infinities and the zeros, which have no digits to compute. */
const special = (x: number): string | null => {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  return null;
};

/**
 * `digits * 10^(exp - digits.length + 1)` in ECMAScript's layout, as
 * `formatDecimal` writes it: plain notation when `exp`, the decimal exponent
 * of the first digit, is in [-6, 21), scientific otherwise.
 */
const layout = (negative: boolean, digits: string, exp: number): string => {
  let out: string;
  if (exp >= 0 && exp < 21) {
    out =
      digits.length <= exp + 1
        ? digits + '0'.repeat(exp + 1 - digits.length)
        : `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  } else if (exp < 0 && exp >= -6) {
    out = `0.${'0'.repeat(-exp - 1)}${digits}`;
  } else {
    out = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    out += `e${exp > 0 ? '+' : '-'}${Math.abs(exp)}`;
  }
  return negative ? `-${out}` : out;
};

/**
 * `|x|`, a finite nonzero float, as (m, e) with `|x| = m * 2^e` exactly.
 */
const decompose = (x: number, isF32: boolean): [bigint, number] => {
  if (isF32) {
    view.setFloat32(0, Math.abs(x));
    const bits = view.getUint32(0);
    const biased = bits >>> 23;
    const fraction = BigInt(bits & 0x7fffff);
    return biased === 0
      ? [fraction, -149]
      : [fraction | (1n << 23n), biased - 150];
  }
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n);
  const fraction = bits & ((1n << 52n) - 1n);
  return biased === 0
    ? [fraction, -1074]
    : [fraction | (1n << 52n), biased - 1075];
};

/** `c * 2^e / 10^q` as an exact fraction (numerator, denominator). */
const scaled = (c: bigint, e: number, q: number): [bigint, bigint] => {
  let num = c;
  let den = 1n;
  if (e >= 0) num <<= BigInt(e);
  else den <<= BigInt(-e);
  if (q >= 0) den *= 10n ** BigInt(q);
  else num *= 10n ** BigInt(-q);
  return [num, den];
};

/** `num / den` rounded to the nearest integer, a tie to even. */
const roundHalfEven = (num: bigint, den: bigint): bigint => {
  const d = num / den;
  const twiceRest = (num % den) * 2n;
  return twiceRest > den || (twiceRest === den && (d & 1n) === 1n) ? d + 1n : d;
};

/** A first estimate of floor(log10(m * 2^e)); the callers correct it. */
const estimateExp = (m: bigint, e: number): number =>
  Math.floor(Math.log10(Number(m)) + e * Math.LOG10E * Math.LN2);

/**
 * The shortest decimal that reads back as the f32 `x` (finite, nonzero), as
 * (digits, exponent of the first digit). Among the shortest, the nearest to
 * `x`, a tie going to the even one, which is what `shortestDigits` in
 * `string-convert.zena` returns.
 *
 * The rounding interval is half an ulp each way, except at the bottom of a
 * binade above the smallest, where the binade below has half the spacing and
 * the interval runs a quarter ulp down. With an even significand a tie
 * rounds to `x`, so the endpoints belong to it. In units of a quarter ulp,
 * `x` is `4m` and the interval is `[4m - down, 4m + 2]`.
 */
const shortestF32 = (x: number): [string, number] => {
  const [m, e] = decompose(x, true);
  const atBinadeBottom = m === 1n << 23n && e > -149;
  const center = m * 4n;
  const lo = center - (atBinadeBottom ? 1n : 2n);
  const hi = center + 2n;
  const inclusive = (m & 1n) === 0n;
  // Coarsest scale first: the first scale with a candidate has the fewest
  // digits. Starting one above the estimate covers its being one low.
  for (let q = estimateExp(m, e) + 1; ; q--) {
    const [loNum, den] = scaled(lo, e - 2, q);
    const [hiNum] = scaled(hi, e - 2, q);
    const ceilLo = (loNum + den - 1n) / den;
    const ceilHi = (hiNum + den - 1n) / den;
    const dMin = inclusive ? ceilLo : loNum / den + 1n;
    const dMax = inclusive ? hiNum / den : ceilHi - 1n;
    if (dMin > dMax) continue;
    const [centerNum] = scaled(center, e - 2, q);
    let d = roundHalfEven(centerNum, den);
    if (d < dMin) d = dMin;
    if (d > dMax) d = dMax;
    const digits = d.toString();
    return [digits.replace(/0+$/, ''), q + digits.length - 1];
  }
};

/**
 * `x` (finite, nonzero) rounded to `n` significant digits, a tie to even,
 * as (digits, exponent of the first digit); `fixedDigits` in
 * `string-convert.zena`.
 */
const fixedDigits = (x: number, n: number): [string, number] => {
  const [m, e] = decompose(x, false);
  const low = 10n ** BigInt(n - 1);
  const high = low * 10n;
  let exp = estimateExp(m, e);
  for (;;) {
    const [num, den] = scaled(m, e, exp - n + 1);
    const truncated = num / den;
    if (truncated >= high) {
      exp += 1;
      continue;
    }
    if (truncated < low) {
      exp -= 1;
      continue;
    }
    const d = roundHalfEven(num, den);
    // Rounding up can carry into an extra digit: 99.96 to 3 digits is 100.
    return d === high ? [low.toString(), exp + 1] : [d.toString(), exp];
  }
};

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/**
 * The value of a hex digit, or -1. Zena's `parseF64` accumulates hex in an
 * f64, a digit at a time, which rounds once 53 bits are exceeded; this does
 * the same operations, so it rounds the same way.
 */
const hexDigit = (c: number): number =>
  isDigit(c)
    ? c - 48
    : c >= 97 && c <= 102
      ? c - 87
      : c >= 65 && c <= 70
        ? c - 55
        : -1;

/**
 * `parseF64` from `string-convert.zena`: an optional sign, then either `0x`
 * and hex digits, or decimal digits with an optional fraction and exponent.
 * Parsing stops at the first character that does not fit, and the text
 * before it is the number; no digits at all is 0. `Number()` differs on
 * each of these (it trims whitespace, rejects a trailing character, reads
 * `Infinity`), so the grammar is read here.
 *
 * The decimal case collects what Zena's version keeps: the first 19
 * significant digits, which fix the exponent, and every later digit as a
 * fraction of the last of them. The exponent saturates and is clamped at
 * the same bounds. `Number()` then rounds the exact value they spell, as
 * Zena's version does.
 */
const parseF64 = (s: string): number => {
  const len = s.length;
  let i = 0;
  let negative = false;
  if (i < len && s.charCodeAt(i) === 45) {
    negative = true;
    i += 1;
  } else if (i < len && s.charCodeAt(i) === 43) {
    i += 1;
  }

  if (i + 1 < len && s.charCodeAt(i) === 48) {
    const x = s.charCodeAt(i + 1);
    if (x === 120 || x === 88) {
      i += 2;
      let value = 0;
      for (; i < len; i++) {
        const d = hexDigit(s.charCodeAt(i));
        if (d < 0) break;
        value = value * 16 + d;
      }
      return negative ? 0 - value : value;
    }
  }

  const maxDigits = 19;
  let significant = '';
  let rest = '';
  let exp10 = 0;
  let sawDigit = false;
  for (; i < len && isDigit(s.charCodeAt(i)); i++) {
    sawDigit = true;
    const c = s[i];
    if (significant.length < maxDigits) {
      if (!(significant === '' && c === '0')) significant += c;
    } else {
      exp10 += 1;
      rest += c;
    }
  }
  if (i < len && s.charCodeAt(i) === 46) {
    i += 1;
    for (; i < len && isDigit(s.charCodeAt(i)); i++) {
      sawDigit = true;
      const c = s[i];
      if (significant.length < maxDigits) {
        // A leading zero after the point only moves the exponent.
        if (!(significant === '' && c === '0')) significant += c;
        exp10 -= 1;
      } else {
        rest += c;
      }
    }
  }
  if (!sawDigit) return 0;

  if (i < len && (s.charCodeAt(i) === 101 || s.charCodeAt(i) === 69)) {
    i += 1;
    let expNegative = false;
    if (i < len && s.charCodeAt(i) === 45) {
      expNegative = true;
      i += 1;
    } else if (i < len && s.charCodeAt(i) === 43) {
      i += 1;
    }
    let expValue = 0;
    for (; i < len && isDigit(s.charCodeAt(i)); i++) {
      if (expValue < 100000) expValue = expValue * 10 + (s.charCodeAt(i) - 48);
    }
    exp10 += expNegative ? -expValue : expValue;
  }
  exp10 = Math.min(Math.max(exp10, -100000), 100000);

  const digits = significant === '' ? '0' : significant;
  const fraction = rest === '' ? '' : `.${rest}`;
  return Number(`${negative ? '-' : ''}${digits}${fraction}e${exp10}`);
};

/** The imports, by name, for the `zena:host:number` import module. */
export const numberImports = {
  i32ToString: (value: number): string => String(value),
  u32ToString: (value: number): string => String(value >>> 0),
  i64ToString: (value: bigint): string => String(value),
  u64ToString: (value: bigint): string => String(BigInt.asUintN(64, value)),
  f64ToString: (value: number): string => special(value) ?? String(value),
  f32ToString: (value: number): string => {
    const text = special(value);
    if (text !== null) return text;
    const [digits, exp] = shortestF32(value);
    return layout(value < 0, digits, exp);
  },
  f64ToPrecision: (value: number, sigDigits: number): string => {
    const text = special(value);
    if (text !== null) return text;
    const n = Math.min(Math.max(sigDigits, 1), 17);
    const [digits, exp] = fixedDigits(value, n);
    return layout(value < 0, digits, exp);
  },
  parseF64,
};
