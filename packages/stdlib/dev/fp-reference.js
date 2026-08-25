// A BigInt reference for the float printing/parsing algorithm from
// https://research.swtch.com/fp.
//
// This exists to de-risk the Zena port: the algorithm is written here
// first, checked against JavaScript's own (correctly rounded)
// conversions over millions of cases, and only then translated. The
// Zena code mirrors this file function for function.

const mask = (n) => (1n << BigInt(n)) - 1n;

// ---------------------------------------------------------------------------
// Exponent estimates, exact over the ranges used.
// ---------------------------------------------------------------------------

/** floor(log2(10^p)). */
export const log2Pow10 = (p) => Math.floor((p * 108853) / 32768);

/** floor(log10(2^e)). */
export const log10Pow2 = (e) => Math.floor((e * 78913) / 262144);

/**
 * floor(log10(3 * 2^(e-2))) — the variant for exact powers of two,
 * whose rounding interval is not 1 ulp wide but 3/4 of one: the binade
 * below has half the spacing, so the interval runs a quarter ulp down
 * and a half ulp up. 125076 is round(log10(3) * 262144).
 */
export const skewed = (e) => Math.floor(((e - 2) * 78913 + 125076) / 262144);

// ---------------------------------------------------------------------------
// The unrounded number: 4*value, with bit 1 = "fraction >= 1/2" and
// bit 0 = sticky. Every rounding mode is an add and a shift.
// ---------------------------------------------------------------------------

export const uFloor = (u) => u >> 2n;
export const uCeil = (u) => (u + 3n) >> 2n;
export const uRound = (u) => (u + 1n + ((u >> 2n) & 1n)) >> 2n;
export const uNudge = (u, d) => u + BigInt(d);
/** Right shift keeping the sticky bit. */
export const uRsh = (u, s) =>
  (u >> BigInt(s)) | (u & mask(s) ? 1n : 0n);

// ---------------------------------------------------------------------------
// Powers of ten: 10^p's significand rounded UP to 128 bits, so that
//   10^p <= pm * 2^pe,  pm in [2^127, 2^128),  pe = log2Pow10(p) - 127.
// ---------------------------------------------------------------------------

export function pow10Mantissa(p) {
  const pe = BigInt(log2Pow10(p) - 127);
  let num = p >= 0 ? 10n ** BigInt(p) : 1n;
  let den = p >= 0 ? 1n : 10n ** BigInt(-p);
  if (pe >= 0n) den <<= pe; else num <<= -pe;
  const q = num / den;
  const pm = num % den === 0n ? q : q + 1n;
  if (pm < 1n << 127n || pm >= 1n << 128n) {
    throw new Error(`pow10Mantissa(${p}) not normalized: ${pm.toString(16)}`);
  }
  return pm;
}

// ---------------------------------------------------------------------------
// uscale
// ---------------------------------------------------------------------------

/**
 * The scaling constants for one (e, p): they depend only on the
 * exponents, so a conversion computes them once and scales several
 * values through them.
 *
 * `pm` is kept in BORROW form — pm = hi*2^64 - lo — because that is
 * what lets uscale decide exactness. Rounding 10^p UP to 128 bits
 * means the stored value exceeds the true one by some d in [0,1), so
 * x*pm exceeds x*10^p*2^-pe by x*d < 2^64: at most one unit of the
 * middle word. A residue of 0 or 1 there is therefore indistinguishable
 * from an exact zero, and the article's precision argument is exactly
 * the claim that the true value is never merely-close to exact — it is
 * exact, or it is more than a middle-word unit away.
 */
// The union of what printing and parsing index; packages/stdlib/dev/fp-gen-tables.js
// verifies the compressed cache over exactly this range.
export const P_MIN = -344;
export const P_MAX = 324;

export function prescale(e, p) {
  if (p < P_MIN || p > P_MAX) throw new Error(`prescale: p=${p} outside the table`);
  const lp = log2Pow10(p);
  const pm = pow10Mantissa(p);
  const lo = pm % (1n << 64n) === 0n ? 0n : (1n << 64n) - (pm % (1n << 64n));
  const hi = (pm + lo) >> 64n;
  if (hi >= 1n << 64n) throw new Error(`prescale(${p}): hi overflowed`);
  return { hi, lo, s: -(e + lp + 3), p, lp };
}

const U64 = (1n << 64n) - 1n;
/** The 128-bit product of two u64s, as [high, low]. */
const mulWide = (a, b) => { const t = a * b; return [t >> 64n, t & U64]; };

/**
 * An unrounded x * 2^e * 10^p, for x with its high bit set.
 *
 * Only the top word survives the shift, so the low word of x*pm.lo is
 * never needed — and when any discarded bit of the top word is set,
 * neither is the rest: the result is inexact no matter what, and the
 * table's error cannot have carried that far.
 */
export function uscale(x, pre) {
  const { hi: pmHi, lo: pmLo, s } = pre;
  if (s < 0) throw new Error(`uscale: negative shift ${s}`);
  // Everything shifts out: x >= 2^63 and pm >= 2^127 make the product
  // nonzero, and 4*value < 1, so the answer is "zero, but not exactly".
  if (s >= 64) return 1n;
  let [h, mid] = mulWide(x, pmHi);
  let sticky = 1n;
  if ((h & mask(s)) === 0n) {
    const [mid2] = mulWide(x, pmLo);
    sticky = ((mid - mid2) & U64) > 1n ? 1n : 0n;
    if (mid < mid2) h -= 1n;
  }
  return (h >> BigInt(s)) | sticky;
}

/** What uscale would return with no table error at all. */
export function uscaleRef(x, e, p) {
  let num = 4n * x;
  let den = 1n;
  if (e >= 0) num <<= BigInt(e); else den <<= BigInt(-e);
  if (p >= 0) num *= 10n ** BigInt(p); else den *= 10n ** BigInt(-p);
  const q = num / den;
  return q | (num % den ? 1n : 0n);
}

// ---------------------------------------------------------------------------
// float64 bit surgery
// ---------------------------------------------------------------------------

const buf = new DataView(new ArrayBuffer(8));
export const f64Bits = (f) => { buf.setFloat64(0, f); return buf.getBigUint64(0); };
export const bitsF64 = (b) => { buf.setBigUint64(0, b & mask(64)); return buf.getFloat64(0); };

export function bitLen(x) {
  let n = 0;
  while (x > 0n) { x >>= 1n; n++; }
  return n;
}

/**
 * A positive finite float64 as (m, e) with f = m * 2^e and m
 * normalized to bit 63 — the form uscale wants.
 */
export function unpack64(f) {
  const bits = f64Bits(f);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let m = bits & mask(52);
  let e;
  if (biased === 0) { e = -1074; } else { m |= 1n << 52n; e = biased - 1075; }
  const shift = 64 - bitLen(m);
  return [m << BigInt(shift), e - shift];
}

/**
 * The float64 with significand `mant` and value mant * 2^-e.
 * Handles subnormals (mant simply comes out smaller) and overflow.
 */
export function pack64(mant, e) {
  // value = mant * 2^-e, and IEEE writes a normal as
  // significand * 2^(biased-1075) with significand in [2^52, 2^53).
  if (mant >= 1n << 53n) { mant >>= 1n; e -= 1; }
  let be = 1075 - e;
  if (mant < 1n << 52n) be = 0;            // subnormal: no implicit bit
  if (be >= 0x7ff) return Infinity;
  return bitsF64((BigInt(be) << 52n) | (mant & mask(52)));
}

// ---------------------------------------------------------------------------
// Parse: the float64 nearest to d * 10^p.
// ---------------------------------------------------------------------------

export function parse(d, p) {
  if (d === 0n) return 0;
  // Outside these the answer needs no table: d >= 1 forces overflow,
  // and d < 2^64 forces underflow to zero.
  if (p > 309) return Infinity;
  if (p < -344) return 0;
  const b = bitLen(d);
  const lp = log2Pow10(p);
  const e = Math.min(1074, 53 - b - lp);
  const pre = prescale(e - (64 - b), p);
  let u = uscale(d << BigInt(64 - b), pre);
  // A value that will round to 2^53 or more needs one more halving:
  // `4*2^53 - 2` is the unrounded encoding of exactly 2^53 - 1/2.
  const s = u >= (1n << 55n) - 2n ? 1 : 0;
  if (s) u = uRsh(u, 1);
  return pack64(uRound(u), e - s);
}

// ---------------------------------------------------------------------------
// Short: the shortest decimal that reads back as f.
// ---------------------------------------------------------------------------

export function trimZeros(d, p) {
  while (d % 10n === 0n && d !== 0n) { d /= 10n; p += 1; }
  return [d, p];
}

export function short(f) {
  const minExp = -1085;
  const [m, e] = unpack64(f);
  let z = 11;
  let p, min;
  if (m === 1n << 63n && e > minExp) {
    // A power of two: the gap below is half the gap above.
    p = -skewed(e + z);
    min = m - (1n << BigInt(z - 2));
  } else {
    if (e < minExp) z = 11 + (minExp - e);
    p = -log10Pow2(e + z);
    min = m - (1n << BigInt(z - 1));
  }
  const max = m + (1n << BigInt(z - 1));
  const odd = Number((m >> BigInt(z)) & 1n);

  const pre = prescale(e, p);
  const dmin = uCeil(uNudge(uscale(min, pre), +odd));
  const dmax = uFloor(uNudge(uscale(max, pre), -odd));

  let d = dmax / 10n;
  if (d * 10n >= dmin) return trimZeros(d, -(p - 1));
  d = dmin;
  if (d < dmax) d = uRound(uscale(m, pre));
  return [d, -p];
}
