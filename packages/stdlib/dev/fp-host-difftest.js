// Differential test of the js target's number formatting against the
// byte targets'.
//
// On `--target js`, `core/number-format-js.zena` asks the host to format
// numbers, and `@zena-lang/runtime` answers (`numberImports`, in
// packages/runtime/src/number-format.ts). The output must be the same
// text the byte targets' `core/string-convert.zena` produces. This runs a
// corpus through a Zena program on the default (byte) target and through
// the runtime's functions, and compares the strings exactly.
//
// `f64ToString` and the integers are JavaScript's own conversions there;
// `f32ToString` and `f64ToPrecision` are computed by the runtime, so they
// get most of the corpus, including exact ties, which Zena rounds to even.
//
//   npm run build -w @zena-lang/runtime
//   node packages/stdlib/dev/fp-host-difftest.js [caseCount]

import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';

const N = Number(process.argv[2] || 20000);
const root = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const {numberImports} = await import(`${root}/packages/runtime/index.js`);

const dv = new DataView(new ArrayBuffer(8));
const bitsToF64 = (b) => {
  dv.setBigUint64(0, b);
  return dv.getFloat64(0);
};
const f64ToBits = (f) => {
  dv.setFloat64(0, f);
  return dv.getBigUint64(0);
};
const bitsToF32 = (b) => {
  dv.setUint32(0, b);
  return dv.getFloat32(0);
};

let seed = 0x2545f491n;
const rand64 = () => {
  // xorshift64*, so the corpus is reproducible run to run.
  seed ^= seed << 13n;
  seed &= (1n << 64n) - 1n;
  seed ^= seed >> 7n;
  seed ^= seed << 17n;
  seed &= (1n << 64n) - 1n;
  return seed;
};
const randInt = (n) => Number(rand64() % BigInt(n));

// ---------------------------------------------------------------------------
// The corpus. Each line is "<kind> <args>", and each answer one line.
// ---------------------------------------------------------------------------

const cases = [];
const f32 = (bits) => cases.push(['f32', String(bits >>> 0)]);
// Bits as a signed i64, which is what the runner's parseI64 reads.
const signedBits = (v) => BigInt.asIntN(64, f64ToBits(v)).toString();
const f64 = (v) => cases.push(['f64', signedBits(v)]);
const prec = (v, n) => cases.push(['prec', `${signedBits(v)} ${n}`]);

for (let i = 0; i < N; i++) f32(Number(rand64() & 0xffffffffn));
for (let e = 0; e < 256; e++) {
  f32((e << 23) >>> 0);
  f32(((e << 23) | 1) >>> 0);
  f32(((e << 23) | 0x7fffff) >>> 0);
  f32(((e << 23) | 0x400000) >>> 0);
}
for (let i = 1; i <= 2000; i++) f32(i);
// Halfway between two short decimals: 440878.625 sits between 440878.62
// and 440878.63, and so do numbers like it in every decade.
for (let k = -10; k <= 10; k++) {
  for (let i = 0; i < 200; i++) {
    dv.setFloat32(0, (randInt(1 << 24) + 0.5) * 2 ** k);
    f32(dv.getUint32(0));
  }
}

for (const v of [
  0,
  -0,
  NaN,
  Infinity,
  -Infinity,
  1e21,
  1e-7,
  123456789012345680000,
])
  f64(v);
for (let i = 0; i < Math.min(N, 5000); i++)
  f64(bitsToF64(rand64() & 0xffffffffffffffffn));

for (let i = 0; i < N; i++)
  prec(bitsToF64(rand64() & 0xffffffffffffffffn), randInt(19));
// Exact ties at the rounding digit: integers and binary fractions whose
// decimal expansion ends in 5 one place past the requested precision.
for (let i = 0; i < N; i++) {
  const digits = 1 + randInt(15);
  const v = (randInt(10 ** Math.min(digits, 15)) * 10 + 5) / 10 ** randInt(4);
  const n = Math.max(1, String(Math.trunc(v)).length + randInt(3) - 1);
  prec(randInt(2) ? -v : v, n);
}
for (const [v, n] of [
  [2.5, 1],
  [0.125, 2],
  [0.5, 1],
  [1.5, 1],
  [9.5, 1],
  [99.5, 2],
  [0.99999, 3],
  [9.999, 2],
  [123456, 2],
  [1e21, 3],
  [1.5e-7, 2],
  [-0, 5],
  [NaN, 3],
  [5e-324, 3],
  [Number.MAX_VALUE, 17],
])
  prec(v, n);

// ---------------------------------------------------------------------------
// The Zena side, on the byte target
// ---------------------------------------------------------------------------

mkdirSync(`${root}/scratch`, {recursive: true});
writeFileSync(
  `${root}/scratch/fp-host-corpus.txt`,
  cases.map(([kind, args]) => `${kind} ${args}`).join('\n') + '\n',
);
writeFileSync(
  `${root}/scratch/fp-host-runner.zena`,
  `
import { f32ToString, f64ToPrecision, StringBuilder } from 'zena:core';
import { f64_reinterpret_i64, f32_reinterpret_i32 } from 'zena:math';
import { readFile, writeFile } from 'zena:fs';

let bitsOf = (text: String): i64 => match (parseI64(text)) {
  case (true, let bits): bits
  case (false, _): 0 as i64
};

export async function main(): Future<i32> {
  let out = new StringBuilder();
  let corpus = await readFile("scratch/fp-host-corpus.txt");
  for (let line in corpus.split("\\n")) {
    if (line.length == 0) { continue; }
    let parts = line.split(" ");
    let kind = parts[0];
    if (kind == "f32") {
      out.append(f32ToString(f32_reinterpret_i32(bitsOf(parts[1]) as i32)));
    } else if (kind == "f64") {
      out.append(f64ToString(f64_reinterpret_i64(bitsOf(parts[1]))));
    } else {
      let n = bitsOf(parts[2]) as i32;
      out.append(f64ToPrecision(f64_reinterpret_i64(bitsOf(parts[1])), n));
    }
    out.append("\\n");
  }
  await writeFile("scratch/fp-host-actual.txt", out.toString());
  return 0;
}
`,
);

console.log(`corpus: ${cases.length} cases`);
execFileSync(
  './target/release/zena-cli',
  ['run', '--no-cache', '--dir=.', 'scratch/fp-host-runner.zena'],
  {cwd: root, stdio: ['ignore', 'inherit', 'inherit']},
);
const zena = readFileSync(`${root}/scratch/fp-host-actual.txt`, 'utf8').split(
  '\n',
);

// ---------------------------------------------------------------------------
// The host side, and the comparison
// ---------------------------------------------------------------------------

const host = ([kind, args]) => {
  const [a, b] = args.split(' ');
  if (kind === 'f32') return numberImports.f32ToString(bitsToF32(Number(a)));
  const v = bitsToF64(BigInt.asUintN(64, BigInt(a)));
  if (kind === 'f64') return numberImports.f64ToString(v);
  return numberImports.f64ToPrecision(v, Number(b));
};

let failures = 0;
const perKind = new Map();
cases.forEach((c, i) => {
  const got = host(c);
  if (got === zena[i]) return;
  perKind.set(c[0], (perKind.get(c[0]) || 0) + 1);
  if (++failures <= 25) {
    console.log(`  FAIL ${c[0]} ${c[1]}: host ${got}, zena ${zena[i]}`);
  }
});
for (const [kind, n] of perKind) console.log(`  ${kind}: ${n} failures`);
console.log(
  failures === 0
    ? `\nALL ${cases.length} CASES MATCH`
    : `\n${failures}/${cases.length} FAILURES`,
);
process.exit(failures === 0 ? 0 : 1);
