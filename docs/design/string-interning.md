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

## Measurements

`packages/zena-compiler/zena/bench/interning.zena`, via `zena:bench`, over
the compiler's own `zena/lib` — 20 files, 936KB, 43,616 identifier tokens,
2,518 distinct. That ratio of 17:1 is the premise: interning is worth exactly
as much as it is far from 1:1.

Run from `packages/zena-compiler`:

```sh
zena-cli run zena/bench/interning.zena --dir .
```

Numbers below are from one run on an otherwise idle 32-core machine.
`zena:bench` samples variants round-robin and reports the CI of the
difference, so a claim appears only when that interval excludes zero.

**Tokenizing costs more.** Interning 43,616 identifiers costs about 2.2ms on
a 44ms tokenize — roughly 50ns per identifier.

| variant       | mean     | 95% CI             |
| ------------- | -------- | ------------------ |
| no-intern     | 44.394ms | [43.132, 45.655]   |
| intern-shared | 46.560ms | [45.513, 47.608]   |

intern-shared slower by 1.2%–8.6%.

**Two map operations per identifier already repay it.**

| variant       | mean     | 95% CI             |
| ------------- | -------- | ------------------ |
| no-intern     | 40.136ms | [39.629, 40.643]   |
| intern-shared | 39.008ms | [38.492, 39.525]   |

intern-shared faster by 1.0%–4.6%. The workload does exactly two `HashMap`
operations per identifier, which is a floor on what a checker does — so the
break-even is at about two, and a real check should land further ahead than
this. That last step is an inference from the shape of the cost, not
something measured here.

**Full parse cannot see the difference.** Interning is within ±5% and
unresolved after 150 samples per variant: parsing allocates an AST an order
of magnitude larger than the token stream, and GC variance (sd ≈ 14ms on a
129ms mean) is far wider than the effect.

**Turning it off costs nothing.** `internRange` on a reader with no table
against `sliceRange`, the call it replaced, over the same 43,616 ranges:
0.681ms vs 0.698ms — no cost, and the small measured difference in
interning's favour is code layout, not a speedup.

## Status

The capability is in place and off by default; the Zena tokenizer and parser
take an optional table, which is what the benchmark drives. The JSON and WIT
parsers can already opt in by passing a table to their `StringReader` —
neither has been wired to a flag of its own, because on this evidence that
should be justified per parser by measurement rather than assumed. For JSON
the target would be object keys only, not string values, which are mostly
distinct.

`StringTable` lives in `packages/stdlib/zena/string-table.zena` but is
exported from `zena:string-reader` rather than as `zena:string-table`: a new
stdlib module name is a change the checked-in bootstrap compiler cannot
compile, since its module list is baked in, and would cost a re-baseline of
that artifact (see [bootstrapping.md](bootstrapping.md)). Promoting it is a
manifest entry plus a reseed whenever that is worth doing.
