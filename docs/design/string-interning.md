# String interning

`StringTable` gives a parser canonical instances for the text it scans: two
identifiers with the same bytes become the same `String` object. It is
exported from `zena:string-reader`, and a `StringReader` given one returns
interned strings from `internFrom`/`internRange`.

Interning is opt-in and off by default. A reader, tokenizer or parser
constructed without a table behaves exactly as before.

## What interning is for

Not for the parser. Zena's `String` is a view — a `(ByteArray, start, end)`
triple — so `sliceFrom` already costs one small object and copies no bytes.
There is no allocation storm in the lexer to eliminate.

What interning changes is what happens to those strings afterwards:

- **Hashing once instead of per lookup.** `String` caches its FNV hash in a
  field, and `HashMap` deliberately recomputes `hash(key)` on every probe
  rather than caching it in the entry (see the note in `zena:map`). A
  canonical instance is therefore hashed once for the life of the table; a
  fresh slice per occurrence is hashed once per occurrence.
- **Comparing by pointer.** `String.operator ==` returns early on `===`, so
  two interned strings compare in one instruction instead of a byte loop.
- **One live `String` per distinct identifier** instead of one per token.

A compiler is the archetypal beneficiary: it puts every identifier into scope
maps and looks it up repeatedly. A parser that emits a token stream and drops
it is not, and should not turn interning on.

## Cost model, and why the table is shaped as it is

### The bucket hash is O(1), not FNV

A probe must compare bytes to confirm a hit no matter what the hash was, so
hashing every byte makes a lookup two passes over the text where one would
do. `bucketHashRange` instead mixes four constant-time features — length and
the first, middle and last bytes — which separates short identifiers well
enough that collisions are rare, and a collision costs only an extra compare.

Measured against a structurally identical table using FNV-1a over the whole
string (`FnvStringTable` in the benchmark), interning 43,616 identifiers:

| variant     | mean    | 95% CI           |
| ----------- | ------- | ---------------- |
| bucket-hash | 2.735ms | [2.493, 2.978]   |
| fnv         | 3.212ms | [2.888, 3.535]   |

bucket-hash faster by 2.5%–27.2%.

This hash is never stored on the `String` and never leaves the module.
`HashMap` keeps using FNV, which it must: four features are far too weak to
key a general-purpose map, where a colliding pair costs a chain walk on every
future lookup rather than one byte compare.

### Matching against the source range in place

The first implementation sliced the scanned text out and called
`table.intern(slice)`. Its cost turned out to be neither the hash nor the
probe but the per-probe `candidate == s`: a virtual call to
`String.operator ==` that re-derives the length and consults the hash cache
before reaching the byte compare, plus the throwaway view allocated to have
something to pass it.

`internRange(source, start, end)` and `String.regionEqualsBytes` remove all of
that from the hit path — which is every occurrence after the first.

### One table per compilation, owned by the loader

A table scoped to a file would re-intern `String`, `length` and `this` once
per file and throw the canonical instances away between them. `LibraryLoader`
therefore holds one for every file it parses, built in its constructor and
primed with the keywords — the same reason it owns the node id generator: the
useful scope is exactly the set of files it caches.

That is also the only arrangement in which interning can pay. The cost is
charged in the tokenizer, per file; the benefit is collected in the checker,
across the whole module graph, where a name introduced in one file is looked
up while checking another. `CompilerOptions.internStrings` selects it, and
`ZENA_INTERN=1` turns it on — which is what makes the A/B below possible, and
what `zena/test/interning_test.zena` pins in both directions.

### Declining long strings

`StringTable.maxLength` (128 bytes by default) is the length past which the
table stores nothing and returns an equal string uninterned. Interning is a
bet that a string will be seen again, paid up front with a copy that then
lives as long as the table. The bet is good for identifiers and keys and bad
for the long strings in the same input — a JSON document's text values, a
Zena string literal, a WIT doc comment — which are mostly distinct, so each
one interned is a permanent copy of bytes never looked up again plus a byte
compare on every collision with it.

`prime` declines too, so no key in the table is longer than `maxLength` and
`intern` can never miss one that is. Callers need no new handling: interning
is best-effort and `===` is only ever a fast path for equality.

### `intern` copies; `prime` does not

Interning a three-byte identifier sliced out of a source file would otherwise
keep that whole file alive for as long as the table, and a table shared
across a compilation would accumulate every file it ever read. `intern`
copies, once per *distinct* string, and the canonical instance then sits on
tight storage that its own byte loops walk.

`prime` skips the copy for strings that already own their storage
permanently. Priming a table with a language's keywords is the motivating
case, and it buys more than the avoided copies: a keyword lexed out of source
interns to the very object `KEYWORDS` is keyed by, so the lookup that follows
hits `==`'s reference-equal fast path against an already-hashed key.
`primeKeywords` in the tokenizer does this for Zena.

## The corpus

`packages/zena-compiler/zena/bench/interning.zena`, via `zena:bench`, over
the compiler's own `zena/lib`:

```
20 files, 937,824 bytes, 148,389 tokens
  through the intern path: 64,569 (43% of tokens) = 43,640 identifiers + 20,929 keywords
  scanned as before:       83,820 (punctuation, operators, literals)
  distinct identifiers:    2,520 (17:1 reuse)
```

Two things in that shape matter. Interning charges its cost to 43% of the
token stream and to no more: every brace, operator, number and string literal
is scanned exactly as before, so a per-identifier cost is diluted by more than
half before it reaches a tokenize time. Keywords count in the 43% because they
take the same path — the scanner interns the text first and only then asks
whether it is a keyword. And the 17:1 reuse is the premise: interning is worth
exactly as much as that ratio is far from 1:1.

## Measurements

Run from the repository root:

```sh
zena-cli run packages/zena-compiler/zena/bench/interning.zena --dir .
```

`zena:bench` samples variants round-robin and reports the CI of the
difference, so a claim appears only when that interval excludes zero.

**Three runs, because two of the results do not survive a repeat.** A first
round of measurements was taken while another process was intermittently
using the machine; several of its intervals were wide enough to point the
wrong way, and one did. What follows is three consecutive runs of the same
benchmark, reported in full.

| runner | run 1 | run 2 | run 3 |
| ------ | ----- | ----- | ----- |
| tokenize | intern slower 1.3%–11.3% | slower 1.1%–8.1% | slower 1.2%–8.1% |
| parse | unresolved | unresolved | intern slower 1.0%–4.7% |
| tokenize + 2 map ops | intern **slower** 7.6%–17.2% | intern **faster** 0.5%–2.8% | unresolved |
| front end (load+parse+scope+check) | unresolved ±20% | intern **faster** 0.8%–5.2% | unresolved ±8% |
| flag off: `internRange` vs `sliceRange` | intern path slower 15.9%–20.3% | 20.4%–23.9% | 18.8%–20.5% |
| bucket hash vs FNV | bucket faster 11.4%–16.7% | 11.7%–12.2% | 11.1%–13.6% |

What reproduces:

- **Interning costs 1%–8% of tokenizing**, in all three runs, and 1%–4.7% of
  parsing in the one run that resolved it. No run put either in interning's
  favour.
- **The bucket hash beats FNV by 11%–13%**, in all three. This is the design
  question from the top of the file, and it is settled.
- **The flag-off path costs about 20% of the call it replaced** — the null
  test and extra frame in `internFrom`. In absolute terms that is 0.08ms per
  43,640 identifiers, about 0.4% of a tokenize. Real, and small. An earlier
  measurement that called this free was noise.

What does not reproduce:

- **The downstream saving.** The proxy workload (two `HashMap` operations per
  identifier) came out slower, then faster, then unresolved. The real front
  end came out unresolved, faster, unresolved. One clean-looking result in
  three is not a result — it is the one draw from three where the interval
  happened to exclude zero.

**Compiling the compiler is neither measurably faster nor slower.** Twenty
alternating pairs of `zena-cli build zena/cli/main.zena --time`, paired
differences with 95% CIs:

| phase | baseline | difference with interning | |
| ----- | -------- | ------------------------- | - |
| parse | 225.2ms | −12.88 [−30.33, +4.56] | unresolved |
| scope | 238.8ms | −2.42 [−32.62, +27.77] | unresolved |
| check | 535.1ms | −28.73 [−60.47, +3.00] | unresolved |
| front end | 999.2ms | −44.04 [−100.61, +12.53] | unresolved |
| codegen | 4857.1ms | −58.93 [−370.57, +252.71] | unresolved |
| total | 5919.6ms | −120.72 [−460.23, +218.79] | unresolved |

Every point estimate leans toward interning and no interval excludes zero.
Two things stand between this measurement and an answer: process-level noise
was running at sd ≈ 120ms on the front-end difference, and codegen is 82% of
a build and cannot be touched by interning at all. Resolving a 4% front-end
effect through a whole build would take on the order of 150 pairs, and would
still be reporting 0.7% of build time.

## Status

The capability is in place, and **off by default everywhere** — a
`StringReader`, tokenizer or parser built without a table behaves exactly as
before, and `CompilerOptions.internStrings` is false unless `ZENA_INTERN=1`
is set.

Off by default because the evidence does not justify on. The cost is
reproducible and the benefit is not. That could change, and the experiment
that would change it has not been run: every measurement here builds a
compiler, uses it once and drops it, which is interning's worst case — the
table is paid for in full and collected from only within a single
compilation. A long-lived compiler that re-checks as files change (the LSP,
`Compiler.invalidate`, the incremental check path) amortizes one table across
many checks and never runs codegen at all, so the ratio that matters there is
nothing like 13% front end to 82% codegen. That is the next thing to measure.

The JSON and WIT parsers can already opt in by passing a table to their
`StringReader`. Neither is wired to a flag of its own, for the same reason:
on this evidence it should be justified per parser by measurement. For JSON
the target would be object keys only, not string values, which are mostly
distinct — and `maxLength` already declines the long ones.

`StringTable` lives in `packages/stdlib/zena/string-table.zena` but is
exported from `zena:string-reader` rather than as `zena:string-table`: a new
stdlib module name is a change the checked-in bootstrap compiler cannot
compile, since its module list is baked in, and would cost a re-baseline of
that artifact (see [bootstrapping.md](bootstrapping.md)). Promoting it is a
manifest entry plus a reseed whenever that is worth doing.
