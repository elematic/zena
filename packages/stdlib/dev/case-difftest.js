// Differential test of the byte targets' `String.toLowerCase` and
// `toUpperCase` against JavaScript's, which the js target's `String` calls.
//
// The corpus is every code point on its own, and strings that put a capital
// sigma among letters, case-ignorable characters and neither, which is
// where Final_Sigma decides between σ and ς. A Zena program on the default
// (byte) target maps each line both ways, and the output is compared with
// JavaScript's, line by line.
//
//   npm run build -w @zena-lang/zena-cli
//   node packages/stdlib/dev/case-difftest.js [sigmaCaseCount]
//
// Requires a Node whose ICU implements the Unicode version the tables in
// zena/core/string.zena were generated from.

import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';

const N = Number(process.argv[2] || 20000);
const root = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

let seed = 0x2545f491;
const random = (n) => {
  // xorshift32, so the corpus is reproducible run to run.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) % n;
};

const lines = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  // Lone surrogates have no UTF-8 encoding, and the line and field
  // separators would split the corpus.
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  if (cp === 0x0a || cp === 0x0d || cp === 0x09) continue;
  lines.push(String.fromCodePoint(cp));
}
// Final_Sigma: Σ between characters that are cased, case-ignorable, both
// (ʰ, ᵃ) or neither.
const around = [
  'Α',
  'a',
  'Z',
  'ǅ',
  'ʰ',
  'ᵃ',
  'ͅ',
  '.',
  "'",
  '·',
  '́',
  '­',
  '‍',
  ' ',
  '1',
  '日',
  '-',
  'Σ',
  '',
  '',
];
for (let i = 0; i < N; i++) {
  let s = '';
  const before = random(4);
  for (let k = 0; k < before; k++) s += around[random(around.length)];
  s += 'Σ';
  const after = random(4);
  for (let k = 0; k < after; k++) s += around[random(around.length)];
  lines.push(s);
}

mkdirSync(`${root}/scratch`, {recursive: true});
writeFileSync(`${root}/scratch/case-corpus.txt`, lines.join('\n') + '\n');
writeFileSync(
  `${root}/scratch/case-runner.zena`,
  `
import { StringBuilder } from 'zena:core';
import { readFile, writeFile } from 'zena:fs';

export async function main(): Future<i32> {
  let corpus = await readFile("scratch/case-corpus.txt");
  let out = new StringBuilder();
  for (let line in corpus.split("\\n")) {
    out.append(line.toLowerCase());
    out.append("\\t");
    out.append(line.toUpperCase());
    out.append("\\n");
  }
  await writeFile("scratch/case-actual.txt", out.toString());
  return 0;
}
`,
);

console.log(`corpus: ${lines.length} strings`);
execFileSync(
  './target/release/zena-cli',
  ['run', '--no-cache', '--dir=.', 'scratch/case-runner.zena'],
  {cwd: root, stdio: ['ignore', 'inherit', 'inherit']},
);
const actual = readFileSync(`${root}/scratch/case-actual.txt`, 'utf8').split(
  '\n',
);

const codePoints = (s) =>
  [...s]
    .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`)
    .join(' ');
let failures = 0;
lines.forEach((s, i) => {
  const want = `${s.toLowerCase()}\t${s.toUpperCase()}`;
  if (actual[i] === want) return;
  if (++failures <= 25) {
    console.log(
      `  FAIL ${codePoints(s)}: zena ${JSON.stringify(actual[i])}, JavaScript ${JSON.stringify(want)}`,
    );
  }
});
console.log(
  failures === 0
    ? `\nALL ${lines.length} STRINGS MATCH JAVASCRIPT (Unicode ${process.versions.unicode})`
    : `\n${failures}/${lines.length} FAILURES`,
);
process.exit(failures === 0 ? 0 : 1);
