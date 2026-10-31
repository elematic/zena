// Generates zena/core/case-tables.zena, the Unicode case data the byte
// targets' `String.toLowerCase` and `String.toUpperCase` read through
// zena/core/case-mapping.zena. (On the js target those are the host's own.)
//
//   cd packages/stdlib
//   for f in UnicodeData.txt SpecialCasing.txt DerivedCoreProperties.txt; do
//     curl -sSO https://www.unicode.org/Public/17.0.0/ucd/$f
//   done
//   node scripts/generate-case-tables.js UnicodeData.txt SpecialCasing.txt DerivedCoreProperties.txt
//   rm UnicodeData.txt SpecialCasing.txt DerivedCoreProperties.txt
//
// It writes the whole file. When the running Node's ICU implements the same
// Unicode version, it first checks every code point's mapping against
// JavaScript's own `toLowerCase` and `toUpperCase`, and fails on a
// difference.
//
// What is generated, from the Default Case Algorithms (Unicode 3.13):
//
// - CASE_RANGES: each code point's one-to-one upper- and lowercase mapping,
//   from UnicodeData.txt, as ranges of code points sharing one pair of
//   deltas, or alternating upper/lower pairs (U+0100 Ā, U+0101 ā, ...).
// - UPPER_SPECIALS and LOWER_SPECIALS: SpecialCasing.txt's unconditional
//   mappings to several code points (ß → SS, İ → i̇). The conditional ones are
//   Final_Sigma, which `toLowerCase` implements, and language-specific ones,
//   which JavaScript's `toLowerCase` does not apply either.
// - CASED and CASE_IGNORABLE: the two properties Final_Sigma reads, from
//   DerivedCoreProperties.txt.
//
// Each table is a stream of integers in printable ASCII, as
// url/idna-table.zena is, so it is a plain string literal; the generated
// file's header describes the encoding.

import {readFileSync, writeFileSync} from 'node:fs';

const [unicodeDataPath, specialCasingPath, derivedPath] = process.argv.slice(2);
if (!derivedPath) {
  console.error(
    'usage: node scripts/generate-case-tables.js UnicodeData.txt SpecialCasing.txt DerivedCoreProperties.txt',
  );
  process.exit(1);
}

const versionOf = (text, name) => {
  const m = text.match(new RegExp(`${name}-(\\d+\\.\\d+\\.\\d+)\\.txt`));
  if (!m) throw new Error(`no version line in ${name}.txt`);
  return m[1];
};
const specialCasing = readFileSync(specialCasingPath, 'utf8');
const derived = readFileSync(derivedPath, 'utf8');
const version = versionOf(specialCasing, 'SpecialCasing');
if (versionOf(derived, 'DerivedCoreProperties') !== version) {
  throw new Error(
    'SpecialCasing.txt and DerivedCoreProperties.txt differ in version',
  );
}

const hex = (s) => parseInt(s, 16);
const fields = (line) => {
  const hash = line.indexOf('#');
  return (hash >= 0 ? line.slice(0, hash) : line)
    .split(';')
    .map((f) => f.trim());
};

// --- Mappings --------------------------------------------------------------

/** Code point → its full upper- or lowercase mapping, where it changes. */
const upper = new Map();
const lower = new Map();
for (const line of readFileSync(unicodeDataPath, 'utf8').split('\n')) {
  if (!line) continue;
  const f = line.split(';');
  const cp = hex(f[0]);
  if (f[12]) upper.set(cp, [hex(f[12])]);
  if (f[13]) lower.set(cp, [hex(f[13])]);
}
for (const line of specialCasing.split('\n')) {
  const f = fields(line);
  // code; lower; title; upper; (condition list;) — five fields with the
  // trailing empty one, six with a condition.
  if (f.length < 5 || f[0] === '' || f[4] !== '') continue;
  const cp = hex(f[0]);
  const seq = (s) => s.split(/\s+/).filter(Boolean).map(hex);
  const lo = seq(f[1]);
  const up = seq(f[3]);
  if (lo.length === 1 && lo[0] === cp) lower.delete(cp);
  else lower.set(cp, lo);
  if (up.length === 1 && up[0] === cp) upper.delete(cp);
  else upper.set(cp, up);
}

// Against JavaScript's own, when it implements the same Unicode version.
if (process.versions.unicode && `${process.versions.unicode}.0` === version) {
  let differences = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const s = String.fromCodePoint(cp);
    for (const [map, js] of [
      [upper, s.toUpperCase()],
      [lower, s.toLowerCase()],
    ]) {
      const want = String.fromCodePoint(...(map.get(cp) ?? [cp]));
      if (want !== js && ++differences <= 10) {
        console.error(
          `U+${cp.toString(16)}: ${JSON.stringify(want)} vs JavaScript ${JSON.stringify(js)}`,
        );
      }
    }
  }
  if (differences > 0)
    throw new Error(`${differences} mappings differ from JavaScript's`);
  console.log(
    `checked every code point against JavaScript (Unicode ${process.versions.unicode})`,
  );
} else {
  console.log(
    `Node implements Unicode ${process.versions.unicode}, not ${version}: not checked against JavaScript`,
  );
}

// --- Encoding --------------------------------------------------------------

const BASE = 0x30;
const CONTINUE = 0x20;
const zigzag = (n) => (n < 0 ? -2 * n - 1 : 2 * n);

const encoder = () => {
  const bytes = [];
  return {
    bytes,
    varint(value) {
      if (value < 0) throw new Error(`negative varint ${value}`);
      let v = value;
      for (;;) {
        const chunk = v & 0x1f;
        v = Math.floor(v / 32);
        bytes.push(BASE + chunk + (v > 0 ? CONTINUE : 0));
        if (v === 0) break;
      }
    },
  };
};

const literal = (bytes) => {
  const text = String.fromCharCode(...bytes);
  if (!/^[\x30-\x6F]*$/.test(text))
    throw new Error('byte outside the printable window');
  return `'${text.replaceAll('\\', '\\\\')}'`;
};

// CASE_RANGES: count, then per range the start (from the previous start), its
// length less one, and the zigzag upper and lower deltas. Deltas of 0 and 0,
// which no range of mappings has, mark alternating pairs instead: an even
// offset from the start is the uppercase letter of a pair, and the next code
// point its lowercase.
const single = (map, cp) => {
  const m = map.get(cp);
  return m && m.length === 1 ? m[0] - cp : 0;
};
const ranges = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  const du = single(upper, cp);
  const dl = single(lower, cp);
  if (du === 0 && dl === 0) continue;
  const r = ranges[ranges.length - 1];
  const contiguous = r && r.end === cp - 1;
  if (contiguous && !r.alternating && r.du === du && r.dl === dl) {
    r.end = cp;
    continue;
  }
  const evenOffset = r && (cp - r.start) % 2 === 0;
  const pairUpper = du === 0 && dl === 1;
  const pairLower = du === -1 && dl === 0;
  if (contiguous && r.alternating && (evenOffset ? pairUpper : pairLower)) {
    r.end = cp;
    continue;
  }
  if (
    contiguous &&
    !r.alternating &&
    r.start === r.end &&
    r.du === 0 &&
    r.dl === 1 &&
    pairLower
  ) {
    r.alternating = true;
    r.end = cp;
    continue;
  }
  ranges.push({start: cp, end: cp, du, dl, alternating: false});
}
const caseRanges = encoder();
caseRanges.varint(ranges.length);
{
  let previous = 0;
  for (const r of ranges) {
    caseRanges.varint(r.start - previous);
    previous = r.start;
    caseRanges.varint(r.end - r.start);
    caseRanges.varint(r.alternating ? 0 : zigzag(r.du));
    caseRanges.varint(r.alternating ? 0 : zigzag(r.dl));
  }
}

// UPPER_SPECIALS and LOWER_SPECIALS: count, then per mapping the code point
// (from the previous one), the number of code points it maps to, and each as
// a zigzag delta from the source.
const specials = (map) => {
  const e = encoder();
  const entries = [...map]
    .filter(([, m]) => m.length > 1)
    .sort(([a], [b]) => a - b);
  e.varint(entries.length);
  let previous = 0;
  for (const [cp, m] of entries) {
    e.varint(cp - previous);
    previous = cp;
    e.varint(m.length);
    for (const t of m) e.varint(zigzag(t - cp));
  }
  return {encoder: e, count: entries.length};
};
const upperSpecials = specials(upper);
const lowerSpecials = specials(lower);

// CASED and CASE_IGNORABLE: count, then per range its start (from the
// previous start) and its length less one, as CASE_RANGES begins.
const propertyRanges = (name) => {
  const list = [];
  for (const line of derived.split('\n')) {
    const f = fields(line);
    if (f.length < 2 || f[1] !== name) continue;
    const [lo, hi] = f[0].split('..').map(hex);
    list.push([lo, hi ?? lo]);
  }
  list.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [lo, hi] of list) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  const e = encoder();
  e.varint(merged.length);
  let previousStart = 0;
  for (const [lo, hi] of merged) {
    e.varint(lo - previousStart);
    e.varint(hi - lo);
    previousStart = lo;
  }
  return {encoder: e, count: merged.length};
};
const cased = propertyRanges('Cased');
const caseIgnorable = propertyRanges('Case_Ignorable');

// --- Output ----------------------------------------------------------------

const codePoints = (n) => `${n} code point${n === 1 ? '' : 's'}`;

const file = `// Generated by packages/stdlib/scripts/generate-case-tables.js from the
// Unicode ${version} UnicodeData.txt, SpecialCasing.txt and
// DerivedCoreProperties.txt. Do not edit: run the script.

/*
 * Unicode's case data, which core/case-mapping.zena reads for the byte
 * targets' \`String.toLowerCase\` and \`toUpperCase\`.
 *
 * Each table is a string of printable ASCII holding a stream of unsigned
 * integers. A byte less 0x30 carries five bits of an integer in its low
 * bits, least significant first, and has 0x20 set when another byte of
 * the same integer follows; so every byte is in 0x30..0x6F, and a value
 * under 32 takes one. A signed value is stored zigzagged: n >= 0 as 2n,
 * n < 0 as -2n - 1.
 *
 * Each table is its entry count, then its entries. A code point that
 * starts an entry is stored as its distance from the one that starts the
 * entry before (from 0, for the first).
 *
 * - CASE_RANGES: a range of code points with the same one-to-one
 *   mappings, as four integers: its first code point, the number of code
 *   points after the first, and the zigzag distances from each code point
 *   to its uppercase and to its lowercase. Distances of 0 and 0, which no
 *   range of mappings has, mark a range of alternating pairs instead: a
 *   code point at an even offset from the first is an uppercase letter
 *   whose lowercase is the next code point.
 * - UPPER_SPECIALS, LOWER_SPECIALS: a code point whose uppercase or
 *   lowercase is several code points, as its code point, the number of
 *   code points it maps to, and each of them as a zigzag distance from it.
 * - CASED, CASE_IGNORABLE: a range of code points with the property, as
 *   two integers: its first code point and the number after the first.
 */

/** ${ranges.length} ranges of one-to-one upper- and lowercase mappings. */
export let CASE_RANGES =
  ${literal(caseRanges.bytes)};

/** ${codePoints(upperSpecials.count)} whose uppercase is several code points. */
export let UPPER_SPECIALS =
  ${literal(upperSpecials.encoder.bytes)};

/** ${codePoints(lowerSpecials.count)} whose lowercase is several code points. */
export let LOWER_SPECIALS =
  ${literal(lowerSpecials.encoder.bytes)};

/** ${cased.count} ranges of the Cased property. */
export let CASED =
  ${literal(cased.encoder.bytes)};

/** ${caseIgnorable.count} ranges of the Case_Ignorable property. */
export let CASE_IGNORABLE =
  ${literal(caseIgnorable.encoder.bytes)};
`;

writeFileSync(new URL('../zena/core/case-tables.zena', import.meta.url), file);

const total =
  caseRanges.bytes.length +
  upperSpecials.encoder.bytes.length +
  lowerSpecials.encoder.bytes.length +
  cased.encoder.bytes.length +
  caseIgnorable.encoder.bytes.length;
console.log(
  `Unicode ${version}: ${ranges.length} case ranges (${caseRanges.bytes.length} B), ` +
    `${upperSpecials.count} + ${lowerSpecials.count} special mappings ` +
    `(${upperSpecials.encoder.bytes.length + lowerSpecials.encoder.bytes.length} B), ` +
    `${cased.count} Cased ranges (${cased.encoder.bytes.length} B), ` +
    `${caseIgnorable.count} Case_Ignorable ranges (${caseIgnorable.encoder.bytes.length} B); ${total} B in all`,
);
