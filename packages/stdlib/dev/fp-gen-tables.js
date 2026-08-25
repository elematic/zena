// Generates the compressed power-of-ten cache for zena:string-convert
// and PROVES it correct: for every p in range, the recovery procedure
// the Zena code runs must reproduce, bit for bit, the entry a full
// 128-bit table would have held.
//
// The full table would be 669 entries x 16 bytes = 10,704 bytes. This
// stores 26 anchors at 24 bytes and 27 shifted powers of five at 8,
// which the runtime combines with one 192x64 multiply.
//
//   node packages/stdlib/dev/fp-gen-tables.js          # verify + print the Zena source
//   node packages/stdlib/dev/fp-gen-tables.js --check  # verify only

import { log2Pow10, pow10Mantissa } from './fp-reference.js';

const U64 = (1n << 64n) - 1n;
const bitLen = (x) => { let n = 0; while (x > 0n) { x >>= 1n; n++; } return n; };

// The union of what printing (p in [-292, 324]) and parsing
// (p in [-344, 309], outside which the answer is 0 or Infinity) index.
export const P_MIN = -344;
export const P_MAX = 324;

/** Anchors sit every STRIDE powers apart; 5^(STRIDE-1) must fit in 63 bits. */
export const STRIDE = 27;
export const Q_MIN = Math.floor(P_MIN / STRIDE);          // -13
export const Q_MAX = Math.floor(P_MAX / STRIDE);          // 12

const floorDiv = (a, b) => Math.floor(a / b);

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

/** 10^(STRIDE*q) truncated to 192 bits, as [w2, w1, w0] high to low. */
export function anchor(q) {
  const p = STRIDE * q;
  const ae = BigInt(log2Pow10(p) - 191);
  let num = p >= 0 ? 10n ** BigInt(p) : 1n;
  let den = p >= 0 ? 1n : 10n ** BigInt(-p);
  if (ae >= 0n) den <<= ae; else num <<= -ae;
  const a = num / den;                       // truncated, not rounded
  if (a < 1n << 191n || a >= 1n << 192n) {
    throw new Error(`anchor(${q}): not 192-bit normalized`);
  }
  return [(a >> 128n) & U64, (a >> 64n) & U64, a & U64];
}

/** 5^r shifted left so its high bit is bit 63; exact, since 5^26 < 2^61. */
export function pow5Shifted(r) {
  const v = 5n ** BigInt(r);
  const t = 64 - bitLen(v);
  return v << BigInt(t);
}

// ---------------------------------------------------------------------------
// The recovery the Zena runtime performs, in exact u64-word arithmetic.
// Every operation here maps to one Zena statement.
// ---------------------------------------------------------------------------

const mulWide = (a, b) => { const t = a * b; return [t >> 64n, t & U64]; };
/** a + b + carryIn as (sum, carryOut). */
const addc = (a, b, c) => { const t = a + b + c; return [t & U64, t >> 64n]; };

/**
 * The 128-bit rounded-up significand of 10^p, in BORROW form
 * (pm = hi*2^64 - lo), rebuilt from the anchor for its stride block.
 */
export function recover(p) {
  const q = floorDiv(p, STRIDE);
  const r = p - STRIDE * q;
  const [a2, a1, a0] = anchor(q);
  const f = pow5Shifted(r);

  // P = anchor * f, a 256-bit value. anchor >= 2^191 and f >= 2^63, so
  // P >= 2^254: its top bit is bit 255 or bit 254, never lower.
  const [h2, l2] = mulWide(a2, f);
  const [h1, l1] = mulWide(a1, f);
  const [h0, l0] = mulWide(a0, f);
  const w0 = l0;
  const [w1, c1] = addc(l1, h0, 0n);
  const [w2, c2] = addc(l2, h1, c1);
  const w3 = (h2 + c2) & U64;

  // Normalize to exactly 256 bits: a shift by one, or none at all.
  let pmHi, pmLo, restHi, restLo;
  if (w3 >> 63n) {
    pmHi = w3; pmLo = w2; restHi = w1; restLo = w0;
  } else {
    pmHi = ((w3 << 1n) | (w2 >> 63n)) & U64;
    pmLo = ((w2 << 1n) | (w1 >> 63n)) & U64;
    restHi = ((w1 << 1n) | (w0 >> 63n)) & U64;
    restLo = (w0 << 1n) & U64;
  }
  // Round the 128-bit significand UP.
  if (restHi !== 0n || restLo !== 0n) {
    pmLo = (pmLo + 1n) & U64;
    if (pmLo === 0n) {
      pmHi = (pmHi + 1n) & U64;
      if (pmHi === 0n) throw new Error(`recover(${p}): round-up overflowed 128 bits`);
    }
  }
  // Borrow form.
  if (pmLo === 0n) return [pmHi, 0n];
  return [(pmHi + 1n) & U64, (1n << 64n) - pmLo];
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function verify() {
  let bad = 0;
  for (let p = P_MIN; p <= P_MAX; p++) {
    const pm = pow10Mantissa(p);
    const lo = pm % (1n << 64n) === 0n ? 0n : (1n << 64n) - (pm % (1n << 64n));
    const hi = (pm + lo) >> 64n;
    if (hi >= 1n << 64n) throw new Error(`p=${p}: borrow form overflowed`);
    const [gh, gl] = recover(p);
    if (gh !== hi || gl !== lo) {
      if (++bad <= 10) {
        console.log(`  p=${p}: recovered ${gh.toString(16)}:${gl.toString(16)}, ` +
                    `full table ${hi.toString(16)}:${lo.toString(16)}`);
      }
    }
  }
  const n = P_MAX - P_MIN + 1;
  console.log(bad === 0
    ? `compressed cache: all ${n} entries p in [${P_MIN}, ${P_MAX}] match the full table exactly`
    : `compressed cache: ${bad}/${n} entries WRONG`);
  return bad === 0;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

// Decimal, not hex: a hex literal above 0x7FFF... would have to be
// read as a negative i64 before the `as u64`, and the decimal form of
// u64 values is what the rest of the stdlib already uses.
const lit = (v) => v.toString() + ' as u64';

export function emit() {
  const out = [];
  out.push(`// GENERATED by packages/stdlib/dev/fp-gen-tables.js — do not edit by hand.`);
  out.push(`//`);
  out.push(`// The compressed power-of-ten cache. A full 128-bit table over`);
  out.push(`// p in [${P_MIN}, ${P_MAX}] would be ${(P_MAX - P_MIN + 1) * 16} bytes; these two hold`);
  out.push(`// ${(Q_MAX - Q_MIN + 1) * 24 + STRIDE * 8} and rebuild any entry with one 192x64 multiply.`);
  out.push(`// The generator verifies the rebuild reproduces every entry of the`);
  out.push(`// full table exactly, so this is a size trade and nothing else.`);
  out.push('');
  out.push(`/** 10^(${STRIDE}q) truncated to 192 bits, three words high to low, q from ${Q_MIN}. */`);
  out.push('let POW10_ANCHORS: FixedArray<u64> = [');
  for (let q = Q_MIN; q <= Q_MAX; q++) {
    const [w2, w1, w0] = anchor(q);
    out.push(`  ${lit(w2)}, ${lit(w1)}, ${lit(w0)},   // 10^${STRIDE * q}`);
  }
  out.push('];');
  out.push('');
  out.push(`/** 5^r normalized to bit 63 (exact: 5^${STRIDE - 1} < 2^61), r in [0, ${STRIDE - 1}]. */`);
  out.push('let POW5_SHIFTED: FixedArray<u64> = [');
  for (let r = 0; r < STRIDE; r++) {
    out.push(`  ${lit(pow5Shifted(r))},   // 5^${r}`);
  }
  out.push('];');
  return out.join('\n');
}

const ok = verify();
if (!ok) process.exit(1);
if (!process.argv.includes('--check')) console.log('\n' + emit());
