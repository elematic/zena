// A large differential sweep of the reference implementation against
// JavaScript's own conversions. Run with an optional case count:
//   node packages/stdlib/dev/fp-sweep.js 2000000
import {parse, short, unpack64, bitLen} from './fp-reference.js';

const N = Number(process.argv[2] || 300000);
let failures = 0;
const note = (msg) => {
  if (++failures <= 15) console.log('  FAIL ' + msg);
};

const dv = new DataView(new ArrayBuffer(8));
const bitsToF64 = (b) => {
  dv.setBigUint64(0, b);
  return dv.getFloat64(0);
};
const f64ToBits = (f) => {
  dv.setFloat64(0, f);
  return dv.getBigUint64(0);
};

const randU64 = () => {
  let b = 0n;
  for (let i = 0; i < 4; i++)
    b = (b << 16n) | BigInt(Math.floor(Math.random() * 65536));
  return b;
};

// --- short(): every finite positive double must print shortest and round-trip
{
  let n = 0,
    bad = 0;
  const check = (v) => {
    if (!Number.isFinite(v) || v <= 0) return;
    n++;
    let d, p;
    try {
      [d, p] = short(v);
    } catch (e) {
      note(`short(${v}) threw ${e.message}`);
      bad++;
      return;
    }
    const text = d.toString() + 'e' + p;
    if (Number(text) !== v) {
      note(`short(${v}) = ${text} does not round-trip`);
      bad++;
      return;
    }
    const jsMant = v
      .toExponential()
      .replace(/e.*/, '')
      .replace(/[.\-]/g, '')
      .replace(/0+$/, '');
    const jsLen = jsMant.length || 1;
    const ourLen = (d.toString().replace(/0+$/, '') || '0').length;
    if (ourLen > jsLen) {
      note(`short(${v}) = ${text} uses ${ourLen} digits, JS ${jsLen}`);
      bad++;
      return;
    }
    // Shortest-and-correct: among equal-length candidates ours must be
    // the closest, which JS's own digits already are.
    if (
      ourLen === jsLen &&
      BigInt(d.toString().replace(/0+$/, '') || '0') !== BigInt(jsMant || '0')
    ) {
      note(`short(${v}) = ${text}, JS digits ${jsMant}`);
      bad++;
    }
  };

  for (let i = 0; i < N; i++) check(bitsToF64(randU64() & 0x7fffffffffffffffn));
  // Structured corners: subnormals, powers of two, binade edges, the
  // largest and smallest of everything.
  for (let e = 0; e < 2047; e++) {
    check(bitsToF64(BigInt(e) << 52n)); // powers of two
    check(bitsToF64((BigInt(e) << 52n) | 1n)); // just above
    check(bitsToF64((BigInt(e) << 52n) | ((1n << 52n) - 1n))); // just below the next
  }
  for (let i = 1n; i < 3000n; i++) check(bitsToF64(i)); // small subnormals
  for (let i = 0n; i < 3000n; i++) check(bitsToF64((1n << 52n) - 1n - i)); // largest subnormals
  for (let k = 0; k <= 22; k++) {
    check(10 ** k);
    check(1 / 10 ** k);
  }
  check(Number.MAX_VALUE);
  check(Number.MIN_VALUE);
  check(2.2250738585072014e-308);
  check(2.225073858507201e-308);
  console.log(bad === 0 ? `short: ${n} values OK` : `short: ${bad}/${n} WRONG`);
}

// --- parse(): d * 10^p must equal what Number() produces
{
  let n = 0,
    bad = 0;
  const check = (d, p) => {
    if (d === 0n) return;
    n++;
    const text = d.toString() + 'e' + p;
    const want = Number(text);
    let got;
    try {
      got = parse(d, p);
    } catch (e) {
      note(`parse(${text}) threw ${e.message}`);
      bad++;
      return;
    }
    if (!Object.is(got, want)) {
      note(`parse(${text}) = ${got}, want ${want}`);
      bad++;
    }
  };

  for (let i = 0; i < N; i++) {
    // d must be < 2^64; the article's caps it at 10^19 digits.
    const digits = 1 + Math.floor(Math.random() * 19);
    let m = '';
    for (let k = 0; k < digits; k++) m += Math.floor(Math.random() * 10);
    m = m.replace(/^0+(?=\d)/, '');
    check(BigInt(m), Math.floor(Math.random() * 700) - 350);
  }
  // Round-trip closure: every shortest form must parse back exactly.
  for (let i = 0; i < Math.min(N, 100000); i++) {
    const v = bitsToF64(randU64() & 0x7fffffffffffffffn);
    if (!Number.isFinite(v) || v <= 0) continue;
    const [d, p] = short(v);
    n++;
    const got = parse(d, p);
    if (!Object.is(got, v)) {
      note(`parse(short(${v})) = ${got}`);
      bad++;
    }
  }
  // Extremes and the classic traps.
  for (const [ds, p] of [
    ['5', -324],
    ['4', -324],
    ['24703282292062327', -324],
    ['24703282292062328', -324],
    ['17976931348623158', 292],
    ['17976931348623159', 292],
    ['22250738585072011', -324],
    ['22250738585072012', -324],
    ['22250738585072014', -324],
    ['9007199254740993', 0],
    ['1', 309],
    ['1', 310],
    ['1', -400],
    ['1', 400],
    ['18446744073709551615', 0],
    ['9999999999999999999', 0],
    ['1', -323],
    ['1', -324],
    ['1', -325],
    ['7', -324],
    ['8', -324],
  ])
    check(BigInt(ds), p);
  for (let p = -350; p <= 350; p++) {
    check(1n, p);
    check(9n, p);
    check(5n, p);
    check(18446744073709551615n, p);
  }
  console.log(bad === 0 ? `parse: ${n} cases OK` : `parse: ${bad}/${n} WRONG`);
}

console.log(failures === 0 ? '\nSWEEP CLEAN' : `\n${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
