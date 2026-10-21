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
  // `core/number-parse-js.zena` checks the start of the string and leaves
  // the rest to the host's own `parseFloat`.
  parseFloat,
};
