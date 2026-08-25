// Checks the reference implementation in fp-reference.js against
// JavaScript's own correctly-rounded conversions.
import {
  parse, short, log2Pow10, log10Pow2, skewed, uscale, uscaleRef,
  prescale, unpack64, bitLen,
} from './fp-reference.js';

let failures = 0;
const fail = (msg) => {
  if (++failures <= 20) console.log('  FAIL ' + msg);
};

// --- the exponent estimates -------------------------------------------------
{
  let bad = 0;
  for (let p = -400; p <= 400; p++) {
    const want = BigInt(p) >= 0n
      ? BigInt(bitLen(10n ** BigInt(p)) - 1)
      : null;
    if (p >= 0 && BigInt(log2Pow10(p)) !== want) bad++;
  }
  // negative p: floor(log2(10^p)) = -ceil(log2(10^-p))
  for (let p = -400; p < 0; p++) {
    const n = 10n ** BigInt(-p);
    const l = bitLen(n) - 1;
    const exact = (1n << BigInt(l)) === n;
    const want = exact ? -l : -(l + 1);
    if (log2Pow10(p) !== want) bad++;
  }
  console.log(bad === 0 ? 'log2Pow10: exact over [-400,400]' : `log2Pow10: ${bad} wrong`);
  if (bad) failures += bad;
}
{
  let bad = 0;
  for (let e = -1200; e <= 1100; e++) {
    const want = e >= 0
      ? (10n ** BigInt(log10Pow2(e))) <= (1n << BigInt(e)) &&
        (10n ** BigInt(log10Pow2(e) + 1)) > (1n << BigInt(e))
      : true;
    if (e >= 0 && !want) bad++;
  }
  console.log(bad === 0 ? 'log10Pow2: exact over [0,1100]' : `log10Pow2: ${bad} wrong`);
  if (bad) failures += bad;
}

// --- uscale vs. exact arithmetic -------------------------------------------
// The claim under test: rounding 10^p to 128 bits never moves the
// unrounded result. Sampled across the whole (x, e, p) domain the
// conversions use.
{
  let bad = 0, n = 0;
  for (let p = -344; p <= 324; p += 1) {
    for (let t = 0; t < 40; t++) {
      // x normalized to bit 63
      let x = (BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n) |
              BigInt(Math.floor(Math.random() * 2 ** 32));
      x |= 1n << 63n;
      const lp = log2Pow10(p);
      const e = -11 - lp;                   // the parse path's exponent
      const pre = prescale(e, p);
      if (pre.s < 0 || pre.s > 64) { continue; }
      n++;
      const got = uscale(x, pre);
      const want = uscaleRef(x, e, p);
      if (got !== want) {
        bad++;
        if (bad <= 3) console.log(`  uscale p=${p} x=${x.toString(16)} got ${got.toString(16)} want ${want.toString(16)}`);
      }
    }
  }
  console.log(bad === 0
    ? `uscale: matches exact arithmetic on ${n} samples`
    : `uscale: ${bad}/${n} disagree with exact arithmetic`);
  failures += bad;
}

// --- parse ------------------------------------------------------------------
{
  let bad = 0, n = 0;
  const cases = [];
  for (let i = 0; i < 40000; i++) {
    const digits = 1 + Math.floor(Math.random() * 19);
    let m = '';
    for (let k = 0; k < digits; k++) m += Math.floor(Math.random() * 10);
    m = m.replace(/^0+(?=\d)/, '');
    const p = Math.floor(Math.random() * 660) - 340;
    cases.push([BigInt(m), p]);
  }
  // The classic hard ones.
  for (const [ds, p] of [
    ['5', -324], ['4', -324], ['17976931348623157', 292],
    ['22250738585072011', -324], ['22250738585072014', -324],
    ['9007199254740993', 0], ['1', 309], ['1', -400], ['1', 400],
    ['123456789012345678', 0], ['8988465674311580', 292],
  ]) cases.push([BigInt(ds), p]);

  for (const [d, p] of cases) {
    if (d === 0n) continue;
    const text = d.toString() + 'e' + p;
    const want = Number(text);
    if (!Number.isFinite(want) && Math.abs(p) < 400) { /* still compare */ }
    n++;
    let got;
    try { got = parse(d, p); } catch (err) { fail(`parse(${text}) threw ${err.message}`); bad++; continue; }
    if (!Object.is(got, want)) {
      bad++;
      if (bad <= 10) console.log(`  parse ${text}: got ${got} want ${want}`);
    }
  }
  console.log(bad === 0 ? `parse: ${n}/${n} match Number()` : `parse: ${bad}/${n} WRONG`);
  failures += bad;
}

// --- short ------------------------------------------------------------------
{
  const rnd = new DataView(new ArrayBuffer(8));
  const randDouble = () => {
    let v;
    do {
      for (let k = 0; k < 8; k++) rnd.setUint8(k, Math.floor(Math.random() * 256));
      v = rnd.getFloat64(0);
    } while (!Number.isFinite(v) || v === 0);
    return Math.abs(v);
  };
  let bad = 0, n = 0;
  const vals = [];
  for (let i = 0; i < 40000; i++) vals.push(randDouble());
  for (const v of [
    0.1, 0.3, 1 / 3, 5e-324, 1e-323, 2.2250738585072014e-308,
    1.7976931348623157e308, 9007199254740992, 9007199254740994,
    1e23, 1e22, 4, 0.5, 1024, 3, 1e-5, 123456789012345678,
  ]) vals.push(v);

  for (const v of vals) {
    n++;
    let d, p;
    try { [d, p] = short(v); } catch (err) { fail(`short(${v}) threw ${err.message}`); bad++; continue; }
    const back = Number(d.toString() + 'e' + p);
    if (back !== v) {
      bad++;
      if (bad <= 10) console.log(`  short(${v}) = ${d}e${p} -> ${back} (no round-trip)`);
      continue;
    }
    // Shortest: JS's own toString is shortest, so digit counts must match.
    const jsDigits = v.toExponential().replace(/e.*/, '').replace(/[.\-]/g, '')
      .replace(/0+$/, '').length || 1;
    const ourDigits = d.toString().replace(/0+$/, '').length || 1;
    if (ourDigits > jsDigits) {
      bad++;
      if (bad <= 10) console.log(`  short(${v}) = ${d}e${p}: ${ourDigits} digits, JS uses ${jsDigits}`);
    }
  }
  console.log(bad === 0 ? `short: ${n}/${n} round-trip and are shortest` : `short: ${bad}/${n} WRONG`);
  failures += bad;
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
