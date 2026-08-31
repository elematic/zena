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
`async.zena`. Neither is the right shape. A prefix match accepts anything
under a path, so `zena:async-experiments` would satisfy it, and it encodes
the file layout in the compiler rather than the library boundary.

### Matching a declaration by name alone

A larger version of the same problem sits alongside it. Sixteen sites
match a stdlib declaration by name with no location check at all, so a
user declaration that happens to share the name is treated as the stdlib
one:

| Names matched | Site |
| ------------- | ---- |
| `Iterator`, `Iterable` | `checker.zena:4696`, `codegen/ir/control-flow.zena:2098` |
| `Iterator`, `Iterable`, `Array`, `MutableArray` | `checker.zena:8602` |
| `Array`, `GrowableArray`, `FixedArray`, `ImmutableArray` | `codegen/ir/control-flow.zena:2246-2249` |
| `FixedArray`, `ImmutableArray` | `codegen/ir/lowering.zena:6421` |
| `FixedArray` | `checker.zena:10053`, `checker.zena:14706` |
| `Error` | `checker.zena:10316` |
| `String` | `codegen/ir/templates.zena:153` |
| `ByteArray` | `codegen/type-mapping.zena:1311` |
| `Own`, `Borrow`, `Unmanaged` | `types.zena:1158`, `checker.zena:5550` |

Some of these decide code generation. `control-flow.zena:2246` selects
indexed-loop lowering for a `for`-in over anything whose canonical class is
named `Array`, `GrowableArray`, `FixedArray` or `ImmutableArray`, and
`checker.zena:10316` walks a superclass chain accepting any class named
`Error` as throwable. A user class with one of those names gets stdlib
lowering applied to a layout that does not match it.

### One strict pattern

Replace all of the above — the located checks, the prefix match, and the
name-only matches — with a single registry that maps a well-known
declaration to its **canonical location: the published library plus the
local declaration name**. Requirements:

- Exact comparison on both halves. No prefix, suffix or substring matching
  anywhere.
- Keyed on the library, not the file. A declaration's `sourcePath` is a
  module id such as `zena:string` or `zena:async/future.zena`; the registry
  resolves that to its owning library through the manifest, so moving a
  file inside its library changes nothing. `Future` at `(async, Future)`
  needs no prefix match to survive living in `async/future.zena`.
- A miss is an error. Every lookup either returns the declaration or
  reports which well-known declaration was not found where the registry
  said it would be.
- One call shape for every consumer, so a new special-cased declaration has
  exactly one place to be registered.

Moving a declaration between libraries still changes its key, which is why
the registry accepts a second exact location for the length of a migration
and the pull request that finishes the move deletes it. That transitional
entry is an exact pair like any other, not a relaxation of the match.

## Bootstrap sequencing

The checked-in bootstrap resolves stdlib modules from the list baked into
the compiler it was built from, and carries the couplings above baked in
too. Two consequences set the shape of the migration:

- A newly published module name cannot be imported by compiler sources, or
  by any stdlib file the compiler's import closure reaches, until after a
  reseed.
- A file move that changes a coupled `sourcePath` cannot land in one step
  at all. The bootstrap compiles the new stdlib with its old checks and
  fails, as the spike above shows. The registry must first carry the new
  location alongside the old, the compiler must be reseeded, and only then
  can the file move.

Every phase below is ordered around those two rules.

## Migration

Each numbered item is a pull request. Phases are sequential; items within a
phase are independent unless stated.

### Phase 0 — make the lookups safe to move against

No new module names, no file moves, no import-site changes. Reviewable on
its own merits.

1. Delete the `sequence` entry from both manifests.
2. Add the well-known declaration registry: a canonical location
   `(library, declaration name)` per entry, a `libraryOf` that maps a
   module id to its published library through the manifest, and an
   error on any miss. Convert the six sites that already check a location
   — `String`, `TemplateStringsArray`, `Box`, `Future`, `CancelScope` —
   and delete the `startsWith('zena:async')` prefix match.
3. Convert the sixteen name-only sites to the registry. This changes
   behaviour: a user declaration named `Array`, `Error`, `FixedArray`,
   `Iterator`, `String` or `ByteArray` stops being treated as the stdlib
   one.
4. Make `queueStdlibFunction` throw on an unresolved module or export
   instead of returning silently, and route its module names through the
   registry.
5. Replace the filename-suffix fallback in
   `reachability/import-resolver.zena` with manifest-driven resolution,
   and make a miss an error.
6. Reseed. This is the point at which the bootstrap gains the registry,
   and it must be its own pull request.

### Phase 1 — regroup files without renaming modules

For each target library, create the directory, move the implementation
files in, rewrite their intra-library imports to relative form, and leave
each existing top-level `X.zena` as a one-line
`export * from './<dir>/X.zena';`.

No manifest entry changes, no import site outside the stdlib changes, and
no new module name is introduced, so none of these needs a reseed. Order
from least to most coupled so the plumbing is proven before it reaches
`String`:

7. `component/` — `component-abi`, `component-async`, `component-stream`,
   `component-memory`. Update the `runtimeEntry` literal in
   `component-runtime.zena`.
8. `bench/` — absorb `benchmark`.
9. `async/` — absorb `stream`. Already a directory; this is one file plus
   the re-export.
10. `collections/` — move `map`, `ordered-map`, `set` implementations in.
    Already a directory.
11. `core/`, non-prelude members — `byte-array`, `byte-buffer`, `result`,
    `string-builder`, `string-reader`, `string-convert`,
    `template-strings-array`, `ownership`.
12. `core/`, prelude members — `string`, `error`, `error-stack`, `option`,
    `box`, `range`, `hashable`, `iterator`, `iterable-utils`, and the
    array family. These are the declarations the registry names, so each
    needs its transitional second location added and then removed; this is
    the step the spike exercised.

Each of 7–12 is verifiable by `npm test` alone, since nothing outside the
stdlib directory changes.

### Phase 2 — publish the new entrypoints

13. Add `core`, `component` and the widened `collections` to both
    manifests, each pointing at its directory's `index.zena`, which
    re-exports the library's public surface. Old names keep resolving
    through their shims.
14. Reseed, so compiler sources and stdlib may import the new names.

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

15–19. One pull request per new entrypoint (`core`, `collections`,
`component`, `async`, `bench`), each rewriting every site across all
areas. After step 14 there is no bootstrap restriction, so a rewrite can
cover compiler sources and tests together.

### Phase 4 — retire the old names

20. Point the prelude at the new modules. Measure compile time on a
    representative build before and after, and record it.
21. Delete the shim files and their manifest entries, and drop every
    transitional location from the registry.
22. Reseed.

## Open decisions

- **`fetch`.** Not in the target library list and not obviously part of
  any library in it. Recommended: leave it published until `http` exists.
- **Compatibility shims.** The plan deletes the old entrypoints in step
  21. If any consumer outside this repository should keep working, the
  shims stay instead, and each becomes a one-line
  `export * from 'zena:core';` — which over-exports, and is only
  acceptable as a temporary measure.
- **`time`'s name.** `timers` or `clocks` were both suggested. The module
  provides sleeping and a monotonic clock, so `clock` fits what is there
  now, and a future `date` library takes the calendar half.
- **`core` in the prelude.** Whether the prelude names `zena:core` at all,
  or keeps naming narrower modules, should follow the step 20
  measurement rather than being decided up front.

## Follow-on libraries

`date`, `net`, `http`, `worker`, `random` and `path` each want their own
issue. All six fit the target structure without further reorganization:
`date` and `random` are leaves, `path` depends only on `core`, and `net`,
`http` and `worker` sit alongside `fs` and `process` above `async`.
