# Standard Library Organization

A plan for collapsing the standard library's 50 entrypoints into a smaller
set of libraries, each a facade over private implementation files, and for
carrying out the moves in steps that each leave the tree building.

This document covers structure and sequencing. `standard-library.md` is the
older MVP roadmap for *what* the library contains and is not superseded by
this one.

## Current shape

The library is 69 `.zena` files under `packages/stdlib/zena/`, published as
50 modules. Every module is declared twice, in manifests that carry a
"keep in sync" comment:

- `packages/stdlib/stdlib-manifest.json`, read at runtime by the
  TypeScript module loader.
- `buildStdlibConfig` in
  `packages/zena-compiler/zena/lib/package-manifest.zena`, compiled into
  the self-hosted compiler.

A manifest entry takes one of three forms. A bare `"name": {}` resolves to
`name.zena`. A `"path"` entry points at an entry file inside a directory,
and the directory's other files become private: they have no module name
and are reachable only by relative import from stdlib sources. A `"virtual"`
entry maps each compilation target to its own entry file. Nine modules are
virtual and four are directories (`bench`, `collections`, `simd`, `url`);
`async` is a fifth in effect, an entry file at the top level over an
`async/` directory.

`export * from` works and is already used in eight places across seven
files, both for private siblings (`./stats.zena`) and across published
modules (`map.zena` re-exports `zena:hashable`). Facades therefore need no
new language feature.

Two manifest entries are dead. `sequence` is listed in both manifests with
no file behind it. `component-memory.zena` is the reverse: a file in
neither manifest, named as a string literal by
`codegen/component-runtime.zena` and injected into the build.

## Dependency structure

Imports between the 50 modules form a directed acyclic graph with no
strongly connected components, so any grouping that respects the layering
below is cycle-free. Peeling modules whose dependencies are all already
placed gives eleven layers:

| Layer | Modules |
| ----- | ------- |
| 0 | `box`, `byte-array`, `hashable`, `iterator`, `math`, `option`, `ownership`, `process`, `range`, `result`, `simd` |
| 1 | `array`, `array-iterator`, `iterable-utils` |
| 2 | `fixed-array`, `immutable-array` |
| 3 | `growable-array-iterator`, `string` |
| 4 | `error-stack`, `string-convert`, `string-reader`, `template-strings-array` |
| 5 | `error`, `string-builder` |
| 6 | `growable-array`, `map`, `memory`, `ordered-map`, `regex`, `set`, `test`, `url` |
| 7 | `async`, `benchmark`, `byte-buffer`, `cli`, `collections`, `component-abi`, `fs`, `json` |
| 8 | `assert`, `bench`, `component-async`, `js`, `stream` |
| 9 | `component-stream`, `fetch`, `time` |
| 10 | `console` |

`scripts/stdlib-deps.py` regenerates this table. It walks each module's
entry file plus the private siblings it reaches, strips comments, and
follows `import`/`export ... from`. The `sequence` entry is left out of the
table above because it has no file.

## Target libraries

Each entrypoint below is a facade: a single published module whose
implementation lives in private files under a directory of the same name.
A type may be exported by more than one entrypoint.

| Entrypoint | Absorbs | Notes |
| ---------- | ------- | ----- |
| `core` | `array`, `array-iterator`, `box`, `byte-array`, `byte-buffer`, `error`, `error-stack`, `fixed-array`, `growable-array`, `growable-array-iterator`, `hashable`, `immutable-array`, `iterable-utils`, `iterator`, `option`, `ownership`, `range`, `result`, `string`, `string-builder`, `string-convert`, `string-reader`, `template-strings-array` | see below |
| `collections` | `map`, `ordered-map`, `set` | also re-exports the array types and `Hashable` from `core` |
| `component` | `component-abi`, `component-async`, `component-stream`, `component-memory` | component target only |
| `async` | `stream` | keeps its own name; see "Libraries the target list omits" |
| `bench` | `benchmark` | `benchmark` is the older WASI-clock harness |
| `assert`, `cli`, `console`, `fs`, `js`, `json`, `math`, `memory`, `process`, `regex`, `simd`, `test`, `time`, `url` | — | unchanged apart from moving implementation files into directories |

`fetch` is unresolved; see "Open decisions".

### What `core` contains

Two candidate principles for `core` membership were raised: "anything
there's syntax for, or that syntax uses", and "the irreducible set that
depends on nothing else". Neither survives contact with the graph.

The syntax principle admits `array` and `map`, because array and map
literals lower onto them, but those two belong in `collections` by any
reading of the name.

The irreducible-set principle is stricter than it sounds. `String` is a
`Hashable` and `String.split` returns a `FixedArray<String>`, so
`string` depends on `fixed-array`. `error` depends on `string`. `map`,
`set` and `ordered-map` all depend on `error`. Putting the array types in
`collections` therefore puts `collections` below `string` and above
`error`, which is a cycle between `core` and `collections`. The
alternatives are to remove `FixedArray` from `String`'s surface, to merge
the two libraries, or to separate ownership from export.

The last is what the facade model already gives. The array types are
implemented in `core/`, which nothing else depends on, and `collections`
re-exports them. `Array` is importable from `zena:collections`, where a
reader looks for it, without `collections` becoming a dependency of
`string`. `collections/index.zena` re-exports `zena:hashable` this way
today.

So `core` is the transitive closure of the prelude plus the string and
byte utilities, and the membership rule is "everything below the first
library that has a namespace worth having".

### `core` and the prelude

`core` and the prelude are separate lists that happen to overlap. The
prelude is an ordinary import list, per target, built by
`getStandardPrelude` in `prelude.zena`; it currently names 16 modules and
binds a chosen subset of names from each. After the reorganization it names
`zena:core`, `zena:collections`, and (target-permitting) `zena:console`,
still binding an explicit name list rather than everything those libraries
export.

Loading a facade loads everything it re-exports, so `zena:core` in the
prelude means every compilation parses and checks all of `core`. That is a
smaller change than it appears: the prelude already pulls `zena:async`
(for `Future`), `zena:string-convert`, `zena:ownership` and the array
family, so the added files are `string-builder`, `string-reader`,
`template-strings-array`, `byte-buffer`, `byte-array` and `result` —
roughly 1,500 lines. Measure compile time before and after the prelude
switch anyway, and if it regresses, keep the implementation grouping and
have the prelude name a narrower module.

There is a second cost, noted already on `console`'s manifest entry: a
prelude module loads with the entry point and shifts symbol ids for every
component build, which breaks "the component embeds the same core module a
hostless build emits" for programs that never use the module. Widening the
prelude makes that worse, and is another reason to switch the prelude last
and separately.

### Libraries the target list omits

The proposed 17-library list has no place for `async`, `stream`, `bench`,
`benchmark` or `fetch`. Recommendations:

- Keep `async` as its own entrypoint rather than folding it into `core`.
  It is about 1,500 lines with two design documents behind it, its
  surface is still growing, and it sits cleanly above `core` in the
  graph. `zena:async` is a better import to read than `zena:core`.
- Fold `stream` into `async`. It is 1 import site and depends only on
  `async`, `error` and `fixed-array`.
- Fold `benchmark` into `bench`. `bench` is the newer harness; `benchmark`
  is a WASI monotonic clock and an i64 formatter, 3 import sites.
- Leave `fetch` alone until `http` lands, then merge it in.

## Compiler couplings that a file move breaks

The compiler identifies particular stdlib declarations by the module they
are declared in. A facade does not change where a class is declared, so
moving `string.zena` to `core/string.zena` changes its `sourcePath` from
`zena:string` to `zena:core/string.zena` and unbinds every check keyed on
the old value.

This is not theoretical. Moving `string.zena` behind a one-line
`export * from './core/string.zena'` shim, changing nothing else, fails the
build:

```
Error message: string_hash_helper discovery: String class struct not found!
    0: ReachabilityVisitor.registerStringHashHelper
```

`wasm.stringClass` is never assigned, because the assignment is guarded on
`classType.name == "String" && classType.sourcePath == "zena:string"`.

The full inventory:

| Coupling | Site |
| -------- | ---- |
| `String` at `zena:string` | `reachability/visitor.zena:272`, `reachability/analysis.zena:789`, `analysis.zena:2205` |
| `TemplateStringsArray` at `zena:template-strings-array` | `visitor.zena:274`, `analysis.zena:791` |
| `Box` at `zena:box` | `analysis.zena:793` |
| `Future` at a `zena:async` prefix | `types.zena:1324` |
| `CancelScope` at exactly `zena:async` | `checker.zena:17154` |
| `__concat<N>` in `zena:string` | `visitor.zena:1373`, `ir/templates.zena:91` |
| `zena:string-convert` conversion functions | `visitor.zena:1369` |
| `currentScope` in `zena:async`; `scheduleTask`, `drainMicrotasks` in `zena:async/executor.zena` | `visitor.zena:1084,1138,1205,1232` |
| `component-memory.zena` as the injected component runtime entry | `codegen/component-runtime.zena:35` |
| `awaitPacked` from `zena:component-async` in synthesized source | `wit-module-synth.zena:179` |
| 16 prelude module names, plus `zena:component-abi` as a target runtime module | `prelude.zena` |

Two of these fail quietly rather than loudly. `queueStdlibFunction` looks
its module up with `program.unitsByPath.has(modulePath)` and returns
without complaint on a miss, so a moved `__concat` would leave string
concatenation unrooted with no diagnostic. And when `unitsByPath` misses,
`reachability/import-resolver.zena:55` falls back to matching a compilation
unit by filename suffix — `zena:string` becomes `endsWith("string.zena")`,
which matches both a shim and its implementation once they share a
basename, and picks whichever comes first in `program.units`.

`Future`'s check survived the `async/` split because it uses
`startsWith('zena:async')`, while `CancelScope`'s neighbouring check
compares for equality and would break the moment `CancelScope` left
`async.zena`. A prefix match is the shape of the fix but still a guess.
Prefer resolving "which library declares this module" through the
manifest, and making the lookups fail loudly.

## Bootstrap sequencing

The checked-in bootstrap resolves stdlib modules from the list baked into
the compiler it was built from, and carries the couplings above baked in
too. Two consequences set the shape of the migration:

- A newly published module name cannot be imported by compiler sources, or
  by any stdlib file the compiler's import closure reaches, until after a
  reseed.
- A file move that changes a coupled `sourcePath` cannot land in one step
  at all. The bootstrap compiles the new stdlib with its old checks and
  fails, as the spike above shows. The compiler must first learn to accept
  both the old and new locations, then be reseeded, and only then can the
  file move.

Every phase below is ordered around those two rules.

## Migration

Each numbered item is a pull request. Phases are sequential; items within a
phase are independent unless stated.

### Phase 0 — make the lookups safe to move against

No new module names, no file moves, no import-site changes. Reviewable on
its own merits.

1. Delete the `sequence` entry from both manifests.
2. Make `queueStdlibFunction` throw on an unresolved module or export
   instead of returning silently.
3. Replace the filename-suffix fallback in
   `reachability/import-resolver.zena` with manifest-driven resolution,
   and make a miss an error.
4. Route the `(name, sourcePath)` checks for `String`,
   `TemplateStringsArray`, `Box` and `Future`, and the
   `queueStdlibFunction` call sites, through one table that maps a
   well-known declaration to its module. Accept both the current and the
   planned location for each entry.
5. Reseed. This is the point at which the bootstrap gains the tolerant
   lookups, and it must be its own pull request.

### Phase 1 — regroup files without renaming modules

For each target library, create the directory, move the implementation
files in, rewrite their intra-library imports to relative form, and leave
each existing top-level `X.zena` as a one-line
`export * from './<dir>/X.zena';`.

No manifest entry changes, no import site outside the stdlib changes, and
no new module name is introduced, so none of these needs a reseed. Order
from least to most coupled so the plumbing is proven before it reaches
`String`:

6. `component/` — `component-abi`, `component-async`, `component-stream`,
   `component-memory`. Update the `runtimeEntry` literal in
   `component-runtime.zena`.
7. `bench/` — absorb `benchmark`.
8. `async/` — absorb `stream`. Already a directory; this is one file plus
   the re-export.
9. `collections/` — move `map`, `ordered-map`, `set` implementations in.
   Already a directory.
10. `core/`, non-prelude members — `byte-array`, `byte-buffer`, `result`,
    `string-builder`, `string-reader`, `string-convert`,
    `template-strings-array`, `ownership`.
11. `core/`, prelude members — `string`, `error`, `error-stack`, `option`,
    `box`, `range`, `hashable`, `iterator`, `iterable-utils`, and the
    array family. Verify against the well-known-declaration table from
    step 4; this is the step the spike exercised.

Each of 6–11 is verifiable by `npm test` alone, since nothing outside the
stdlib directory changes.

### Phase 2 — publish the new entrypoints

12. Add `core`, `component` and the widened `collections` to both
    manifests, each pointing at its directory's `index.zena`, which
    re-exports the library's public surface. Old names keep resolving
    through their shims.
13. Reseed, so compiler sources and stdlib may import the new names.

### Phase 3 — migrate import sites

Mechanical rewrites, one library at a time, each independently revertible.
The current site counts, by area:

| Area | Files importing `zena:` |
| ---- | ----------------------- |
| `tests/` | 193 |
| `packages/zena-compiler/` | 125 |
| `packages/stdlib/` | 111 |
| `packages/wit-parser/` | 13 |
| `benchmarks/` | 6 |
| `packages/zena-formatter/` | 6 |
| `examples/` | 2 |

14–18. One pull request per new entrypoint (`core`, `collections`,
`component`, `async`, `bench`), each rewriting every site across all
areas. After step 13 there is no bootstrap restriction, so a rewrite can
cover compiler sources and tests together.

### Phase 4 — retire the old names

19. Point the prelude at the new modules. Measure compile time on a
    representative build before and after, and record it.
20. Delete the shim files and their manifest entries, and drop the
    old locations from the well-known-declaration table.
21. Reseed.

## Open decisions

- **`fetch`.** Not in the target library list and not obviously part of
  any library in it. Recommended: leave it published until `http` exists.
- **Compatibility shims.** The plan deletes the old entrypoints in step
  20. If any consumer outside this repository should keep working, the
  shims stay instead, and each becomes a one-line
  `export * from 'zena:core';` — which over-exports, and is only
  acceptable as a temporary measure.
- **`time`'s name.** `timers` or `clocks` were both suggested. The module
  provides sleeping and a monotonic clock, so `clock` fits what is there
  now, and a future `date` library takes the calendar half.
- **`core` in the prelude.** Whether the prelude names `zena:core` at all,
  or keeps naming narrower modules, should follow the step 19
  measurement rather than being decided up front.

## Follow-on libraries

`date`, `net`, `http`, `worker`, `random` and `path` each want their own
issue. All six fit the target structure without further reorganization:
`date` and `random` are leaves, `path` depends only on `core`, and `net`,
`http` and `worker` sit alongside `fs` and `process` above `async`.
