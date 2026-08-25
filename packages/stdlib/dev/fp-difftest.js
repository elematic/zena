// Differential test of Zena's float conversions against JavaScript's.
//
// Generates a corpus, runs it through a Zena program that prints one
// answer per line, and compares. JavaScript's conversions are
// correctly rounded and shortest, so any disagreement is a bug here.
//
//   node packages/stdlib/dev/fp-difftest.js [caseCount]
//
// Requires packages/zena-compiler/zena/out/cli.wasm to be current.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const N = Number(process.argv[2] || 20000);
const root = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

const dv = new DataView(new ArrayBuffer(8));
const bitsToF64 = (b) => { dv.setBigUint64(0, b); return dv.getFloat64(0); };
const f64ToBits = (f) => { dv.setFloat64(0, f); return dv.getBigUint64(0); };
const fv = new DataView(new ArrayBuffer(4));
const bitsToF32 = (b) => { fv.setUint32(0, b); return fv.getFloat32(0); };

let seed = 0x2545f491n;
const rand64 = () => {
  // xorshift64*, so the corpus is reproducible run to run.
  seed ^= seed << 13n; seed &= (1n << 64n) - 1n;
  seed ^= seed >> 7n;
  seed ^= seed << 17n; seed &= (1n << 64n) - 1n;
  return seed;
};
const randInt = (n) => Number(rand64() % BigInt(n));

// ---------------------------------------------------------------------------
// The corpus: printing cases (a float, given as its bits) and parsing
// cases (a decimal string).
// ---------------------------------------------------------------------------

const printCases = [];   // [bitsString, expectedText]
const parseCases = [];   // [text, expectedBitsString]
const f32Cases = [];     // [bitsString(u32), expectedText]

const addPrint = (v) => {
  if (!Number.isFinite(v)) return;
  printCases.push([f64ToBits(v).toString(), String(v)]);
};
const addParse = (text) => {
  const v = Number(text);
  if (Number.isNaN(v)) return;
  parseCases.push([text, f64ToBits(v).toString()]);
};
// JavaScript has no float32 printing, so the f32 contract is checked
// rather than string-compared: the output must read back as the same
// float32, and must use no more significant digits than the shortest
// decimal that does. Both are searched for here. (Equal-length
// candidates can tie — 440878.62 and 440878.63 are equidistant from
// 440878.625 — and either is a correct answer.)
const sigDigitsOf = (t) => {
  // Significant digits: leading and trailing zeros do not count, since
  // plain notation pads an 8-digit value out to the decimal point.
  const s = t.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '')
             .replace(/^0+/, '').replace(/0+$/, '');
  return s.length || 1;
};
const shortestF32Digits = (v) => {
  for (let k = 1; k <= 9; k++) {
    if (Math.fround(Number(v.toPrecision(k))) === v) return k;
    // toPrecision rounds one way; the neighbour at the same length can
    // be the one that round-trips.
    const t = Number(v.toPrecision(k));
    const bump = Number(t.toExponential(k - 1).replace(/^(-?\d)\.?(\d*)e/, (_, a, b) =>
      (BigInt(a + b) + (v > t ? 1n : -1n)).toString().replace(/^(-?\d)/, '$1.') + 'e'));
    if (Number.isFinite(bump) && Math.fround(bump) === v) return k;
  }
  return 9;
};
const addF32 = (bits) => {
  const v = bitsToF32(bits);
  if (!Number.isFinite(v)) return;
  f32Cases.push([String(bits >>> 0), String(shortestF32Digits(v)), String(v)]);
};

for (let i = 0; i < N; i++) addPrint(bitsToF64(rand64() & 0x7fffffffffffffffn));
// Every binade, at its edges.
for (let e = 0; e < 2047; e++) {
  addPrint(bitsToF64(BigInt(e) << 52n));
  addPrint(bitsToF64((BigInt(e) << 52n) | 1n));
  addPrint(bitsToF64((BigInt(e) << 52n) | ((1n << 52n) - 1n)));
  addPrint(bitsToF64((BigInt(e) << 52n) | (1n << 51n)));
}
for (let i = 1n; i <= 2000n; i++) addPrint(bitsToF64(i));                 // subnormals
for (let i = 0n; i < 2000n; i++) addPrint(bitsToF64(((1n << 52n) - 1n) - i));
for (let k = -30; k <= 30; k++) addPrint(10 ** k);
for (let k = 0; k < 200; k++) addPrint(k / 10);
addPrint(Number.MAX_VALUE); addPrint(Number.MIN_VALUE);

for (let i = 0; i < N; i++) {
  const digits = 1 + randInt(20);
  let m = '';
  for (let k = 0; k < digits; k++) m += randInt(10);
  m = m.replace(/^0+(?=\d)/, '');
  addParse(m + 'e' + (randInt(700) - 350));
}
// Long inputs: more significant digits than a u64 can hold.
for (let i = 0; i < Math.min(N, 20000); i++) {
  const digits = 20 + randInt(25);
  let m = '';
  for (let k = 0; k < digits; k++) m += randInt(10);
  m = m.replace(/^0+(?=\d)/, '');
  addParse(m + 'e' + (randInt(660) - 340));
}
// Shortest forms must parse back exactly.
for (let i = 0; i < Math.min(N, 20000); i++) {
  const v = bitsToF64(rand64() & 0x7fffffffffffffffn);
  if (Number.isFinite(v)) addParse(String(v));
}
for (const t of [
  '5e-324', '4e-324', '2.4703282292062327e-324', '2.4703282292062328e-324',
  '1.7976931348623157e308', '1.7976931348623159e308', '1e309', '1e-400',
  '2.2250738585072011e-308', '2.2250738585072012e-308', '2.2250738585072014e-308',
  '9007199254740993', '18446744073709551615', '9999999999999999999',
  '0.1', '0.3', '1e21', '1e-7', '0', '-0', '0.000', '1234567890123456789012345678901234567890',
  '1.00000000000000000000000000000000000001', '0.0000000000000000000000000000000000001',
]) addParse(t);

for (let i = 0; i < Math.min(N, 30000); i++) addF32(Number(rand64() & 0x7fffffffn));
for (let e = 0; e < 255; e++) {
  addF32((e << 23) >>> 0);
  addF32(((e << 23) | 1) >>> 0);
  addF32(((e << 23) | 0x7fffff) >>> 0);
}
for (let i = 1; i <= 2000; i++) addF32(i);

// ---------------------------------------------------------------------------
// The Zena side
// ---------------------------------------------------------------------------

mkdirSync(`${root}/scratch`, { recursive: true });
writeFileSync(`${root}/scratch/fp-corpus-print.txt`, printCases.map((c) => c[0]).join('\n') + '\n');
writeFileSync(`${root}/scratch/fp-corpus-parse.txt`, parseCases.map((c) => c[0]).join('\n') + '\n');
writeFileSync(`${root}/scratch/fp-corpus-f32.txt`, f32Cases.map((c) => c[0]).join('\n') + '\n');

writeFileSync(`${root}/scratch/fp-runner.zena`, `
import { f64ToString, f32ToString, parseF64, parseI64, u64ToString } from 'zena:string-convert';
import { f64_reinterpret_i64, i64_reinterpret_f64, f32_reinterpret_i32 } from 'zena:math';
import { readFile, writeFile } from 'zena:fs';
import { StringBuilder } from 'zena:string-builder';
import { FixedArray } from 'zena:fixed-array';

let runPrint = (lines: FixedArray<String>, out: StringBuilder): void => {
  for (let line in lines) {
    if (line.length == 0) { continue; }
    if (let (true, bits) = parseI64(line)) {
      out.append(f64ToString(f64_reinterpret_i64(bits)));
    } else {
      out.append("BADINPUT");
    }
    out.append("\\n");
  }
};

let runParse = (lines: FixedArray<String>, out: StringBuilder): void => {
  for (let line in lines) {
    if (line.length == 0) { continue; }
    out.append(u64ToString(i64_reinterpret_f64(parseF64(line)) as u64));
    out.append("\\n");
  }
};

let runF32 = (lines: FixedArray<String>, out: StringBuilder): void => {
  for (let line in lines) {
    if (line.length == 0) { continue; }
    if (let (true, bits) = parseI64(line)) {
      out.append(f32ToString(f32_reinterpret_i32(bits as i32)));
    } else {
      out.append("BADINPUT");
    }
    out.append("\\n");
  }
};

export let main = (): i32 => {
  let out = new StringBuilder();
  runPrint(readFile("scratch/fp-corpus-print.txt").split("\\n"), out);
  runParse(readFile("scratch/fp-corpus-parse.txt").split("\\n"), out);
  runF32(readFile("scratch/fp-corpus-f32.txt").split("\\n"), out);
  writeFile("scratch/fp-actual.txt", out.toString());
  return 0;
};
`);

console.log(`corpus: ${printCases.length} print, ${parseCases.length} parse, ${f32Cases.length} f32`);

// ZENA_WIDE_ARITHMETIC passes through, so the same corpus can be run
// against both lowerings of the 128-bit multiply.
const wide = process.env.ZENA_WIDE_ARITHMETIC ? 'ZENA_WIDE_ARITHMETIC=1 ' : '';
execFileSync('nix', ['develop', '--command', 'bash', '-c',
  `${wide}ZENA_GC_RESERVE_MB=2048 ZENA_COMPILER_WASM=packages/zena-compiler/zena/out/cli.wasm ` +
  `./target/release/zena-cli run --no-cache --dir=. scratch/fp-runner.zena`,
], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });

const actual = (await import('node:fs')).readFileSync(`${root}/scratch/fp-actual.txt`, 'utf8').split('\n');

let failures = 0;
const perKind = new Map();
const report = (kind, input, got, want) => {
  perKind.set(kind, (perKind.get(kind) || 0) + 1);
  if (++failures <= 25) console.log(`  FAIL ${kind} ${input}: got ${got}, want ${want}`);
};

let k = 0;
for (const [bits, want] of printCases) {
  const got = actual[k++];
  if (got !== want) report('print', bits, got, want);
}
let shortInputs = 0, longInputs = 0;
for (const [text, want] of parseCases) {
  const got = actual[k++];
  const sig = text.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '')
                  .replace(/^0+/, '').replace(/0+$/, '').length;
  const long = sig > 19;
  if (long) longInputs++; else shortInputs++;
  if (got !== want) report(long ? 'parse>19digits' : 'parse', text, got, want);
}
for (const [bits, wantDigits, exact] of f32Cases) {
  const got = actual[k++];
  const back = Math.fround(Number(got));
  if (!(back === Number(exact))) {
    report('f32', bits, got, `something that frounds to ${exact}`);
  } else if (sigDigitsOf(got) > Number(wantDigits)) {
    report('f32', bits, `${got} (${sigDigitsOf(got)} digits)`, `${wantDigits} digits`);
  }
}

console.log(`\nparse corpus: ${shortInputs} inputs of <=19 significant digits, ${longInputs} longer`);
for (const [kind, n] of perKind) console.log(`  ${kind}: ${n} failures`);
const total = printCases.length + parseCases.length + f32Cases.length;
console.log(failures === 0
  ? `\nALL ${total} CASES MATCH JAVASCRIPT`
  : `\n${failures}/${total} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
