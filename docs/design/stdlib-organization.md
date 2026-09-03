# Standard Library Organization

A plan for collapsing the standard library's 50 entrypoints into a smaller
set of libraries, each a facade over private implementation files, and for
carrying out the moves in steps that each leave the tree building.

This document covers structure and sequencing. `standard-library.md` is the
older MVP roadmap for _what_ the library contains and is not superseded by
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

| Layer | Modules                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| 0     | `box`, `byte-array`, `hashable`, `iterator`, `math`, `option`, `ownership`, `process`, `range`, `result`, `simd` |
| 1     | `array`, `array-iterator`, `iterable-utils`                                                                      |
| 2     | `fixed-array`, `immutable-array`                                                                                 |
| 3     | `growable-array-iterator`, `string`                                                                              |
| 4     | `error-stack`, `string-convert`, `string-reader`, `template-strings-array`                                       |
| 5     | `error`, `string-builder`                                                                                        |
| 6     | `growable-array`, `map`, `memory`, `ordered-map`, `regex`, `set`, `test`, `url`                                  |
| 7     | `async`, `benchmark`, `byte-buffer`, `cli`, `collections`, `component-abi`, `fs`, `json`                         |
| 8     | `assert`, `bench`, `component-async`, `js`, `stream`                                                             |
| 9     | `component-stream`, `fetch`, `time`                                                                              |
| 10    | `console`                                                                                                        |

`scripts/stdlib-deps.py` regenerates this table. It walks each module's
entry file plus the private siblings it reaches, strips comments, and
follows `import`/`export ... from`. The `sequence` entry is left out of the
table above because it has no file.

## Target libraries

Each entrypoint below is a facade: a single published module whose
implementation lives in private files under a directory of the same name.
A type may be exported by more than one entrypoint.

| Entrypoint                                                                                                          | Absorbs                                                                                                                                                                                                                                                                                                                                           | Notes                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`                                                                                                              | `array`, `array-iterator`, `box`, `byte-array`, `byte-buffer`, `error`, `error-stack`, `fixed-array`, `growable-array`, `growable-array-iterator`, `hashable`, `immutable-array`, `iterable-utils`, `iterator`, `option`, `ownership`, `range`, `result`, `string`, `string-builder`, `string-convert`, `string-reader`, `template-strings-array` | see below                                                                                                                                   |
| `collections`                                                                                                       | `map`, `ordered-map`, `set`                                                                                                                                                                                                                                                                                                                       | also re-exports the array types and `Hashable` from `core`; the prelude names it, so weigh `ordered-map` and `set` against the prelude rule |
| `component`                                                                                                         | `component-abi`, `component-async`, `component-stream`, `component-memory`                                                                                                                                                                                                                                                                        | component target only                                                                                                                       |
| `async`                                                                                                             | —                                                                                                                                                                                                                                                                                                                                                 | absorbs nothing; the prelude names it, so it holds only what `Future` needs                                                                 |
| `stream`                                                                                                            | —                                                                                                                                                                                                                                                                                                                                                 | its own entrypoint, for the same reason; see "Libraries the target list omits"                                                              |
| `bench`                                                                                                             | `benchmark`                                                                                                                                                                                                                                                                                                                                       | done; `benchmark`'s clock and formatter duplicated `bench`'s, so only `runTest` moved                                                       |
| `assert`, `cli`, `console`, `fs`, `js`, `json`, `math`, `memory`, `process`, `regex`, `simd`, `test`, `time`, `url` | —                                                                                                                                                                                                                                                                                                                                                 | unchanged apart from moving implementation files into directories                                                                           |

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
roughly 1,500 lines. Measure both compile time and emitted size before and
after the prelude switch — see "What a facade costs", where a much smaller
facade change cost every binary 9.5% — and if either regresses, keep the
implementation grouping and have the prelude name a narrower module.

There is a second cost, noted already on `console`'s manifest entry: a
prelude module loads with the entry point and shifts symbol ids for every
component build, which breaks "the component embeds the same core module a
hostless build emits" for programs that never use the module. Widening the
prelude makes that worse, and is another reason to switch the prelude last
and separately.

Both costs give a membership rule of their own, and it is the one that
decides most of the awkward cases:

> **A library the prelude names should hold only what programs that never
> mention it still need.** Everything in such a library is parsed and
> checked for every compilation, whether or not a line of it is used.

This is independent of the dependency rule above, and cuts the other way.
The dependency rule says what a library _must_ contain; this one says what
it should decline to contain. The prelude names `zena:async` for `Future`
and `zena:map` for `Map`, so folding `stream` into `async`, or piling
`ordered-map` and `set` into `collections`, makes every hello-world carry
them. Neither is wrong on dependency grounds; both are wrong on this one.

### What a facade costs

Re-exporting a module from a facade emits that module's **generic
instantiations** into every program the facade reaches, even when none of
its own code is reachable.

Measured by folding `stream` into `zena:async`, which is prelude-bound, and
compiling the `timer` component test: 14,701 bytes to 16,101, a 9.5%
increase on a program that never mentions `Stream`. None of `Stream`'s or
`StreamWriter`'s functions were emitted. The 22 added functions were
`Completer<i32>`, `Completer<bool>`, `Future<i32>`, `Future<bool>`,
`Box<i32>` and `Box<bool>` — the instantiations `stream.zena` itself uses.
Reachability prunes unreached _code_; it does not prune the instantiations
a loaded module's types create.

The same measurement with `stream.zena` moved under `async/` but left as
its own module is byte-identical to the baseline, so the cost is the
re-export, not the file's location.

Two consequences:

- The `core` facade is the worst case in this plan: it re-exports around
  twenty modules, several of them generic. Whatever it costs is paid by
  every Zena program. Measure the emitted size of a hello-world before and
  after wiring the prelude to it, and be prepared to have the prelude keep
  naming narrower modules even after `core` exists as an import.
- A library only worth having as a namespace is not worth folding into a
  prelude-bound facade. Grouping files in a directory costs nothing;
  re-exporting them does.

The mechanism is narrower than "re-exporting emits the re-exported
module", and is filed as a compiler bug (Forgejo #447): once a generic is
reached at some type, an unreachable module's instantiation of it _at
another type_ is specialized and emitted too. A user-level facade over a
module using `Completer<i32>` grows 51 bytes to 64 with no added
functions, because nothing there reaches `Completer`; the same re-export
added to `zena:fs` costs 29 bytes for the same reason. `timer.zena`
reaches both generics at other types, which is why it pays 1,400.

If #447 is fixed, the _emitted-size_ half of this stops applying:
re-exporting becomes as free as grouping, and `core` can be the facade
this document assumes. The parse-and-check half does not go away, so the
prelude rule above still governs what a prelude-named library should
hold — which is why `stream` stays separate either way. Until #447 lands,
treat every re-export from a prelude-bound module as a per-binary cost to
be measured.

### Libraries the target list omits

The proposed 17-library list has no place for `async`, `stream`, `bench`,
`benchmark` or `fetch`. Recommendations:

- Keep `async` as its own entrypoint, and keep `Future` in it rather than
  moving it to `core`. That `async`/`await` is syntax argues for `core`
  only under the syntax principle this document has already discarded:
  `Array` backs a literal and still is not in `core` on those grounds — it
  is there because `String` uses `FixedArray` and nothing else would
  break the cycle. No such cycle reaches `Future`. Nothing below `async`
  depends on it, so by the rule above it belongs in `async`.

  Being prelude-bound and compiler-rooted does not change that. The
  prelude is an import list and can name `zena:async`, as it does today;
  and the well-known registry keys on `(library, name)`, so
  `(async, Future)` is exactly as stable a location as `(core, Future)`.

- Keep `stream` as its own entrypoint. This document originally
  recommended folding it into `async`, and that was wrong for two separate
  reasons. The immediate one is a compiler bug: `zena:async` is
  prelude-bound, and re-exporting `stream` from it costs every binary
  1,400 bytes (see "What a facade costs"). The durable one outlives the
  fix — the prelude names `zena:async`, so anything folded in is parsed
  and checked by every compilation forever, and `Stream` is 281 lines
  today with WASI 0.3 interop and an `AsyncIterator` layer still to come.
  Node draws the same line, keeping `stream` a library while `Promise` is
  global.
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

| Coupling                                                                                        | Site                                                                                    |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `String` at `zena:string`                                                                       | `reachability/visitor.zena:272`, `reachability/analysis.zena:789`, `analysis.zena:2205` |
| `TemplateStringsArray` at `zena:template-strings-array`                                         | `visitor.zena:274`, `analysis.zena:791`                                                 |
| `Box` at `zena:box`                                                                             | `analysis.zena:793`                                                                     |
| `Future` at a `zena:async` prefix                                                               | `types.zena:1324`                                                                       |
| `CancelScope` at exactly `zena:async`                                                           | `checker.zena:17154`                                                                    |
| `__concat<N>` in `zena:string`                                                                  | `visitor.zena:1373`, `ir/templates.zena:91`                                             |
| `zena:string-convert` conversion functions                                                      | `visitor.zena:1369`                                                                     |
| `currentScope` in `zena:async`; `scheduleTask`, `drainMicrotasks` in `zena:async/executor.zena` | `visitor.zena:1084,1138,1205,1232`                                                      |
| `component-memory.zena` as the injected component runtime entry                                 | `codegen/component-runtime.zena:35`                                                     |
| `awaitPacked` from `zena:component-async` in synthesized source                                 | `wit-module-synth.zena:179`                                                             |
| 16 prelude module names, plus `zena:component-abi` as a target runtime module                   | `prelude.zena`                                                                          |

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

| Names matched                                            | Site                                                     |
| -------------------------------------------------------- | -------------------------------------------------------- |
| `Iterator`, `Iterable`                                   | `checker.zena:4696`, `codegen/ir/control-flow.zena:2098` |
| `Iterator`, `Iterable`, `Array`, `MutableArray`          | `checker.zena:8602`                                      |
| `Array`, `GrowableArray`, `FixedArray`, `ImmutableArray` | `codegen/ir/control-flow.zena:2246-2249`                 |
| `FixedArray`, `ImmutableArray`                           | `codegen/ir/lowering.zena:6421`                          |
| `FixedArray`                                             | `checker.zena:10053`, `checker.zena:14706`               |
| `Error`                                                  | `checker.zena:10316`                                     |
| `String`                                                 | `codegen/ir/templates.zena:153`                          |
| `ByteArray`                                              | `codegen/type-mapping.zena:1311`                         |
| `Own`, `Borrow`, `Unmanaged`                             | `types.zena:1158`, `checker.zena:5550`                   |

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

This is `lib/well-known.zena`, over the module-id-to-library mapping in
`lib/stdlib-manifest.zena`. Four name comparisons remain, for reasons given
under "Matches that remain, and why".

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

1. Delete the `sequence` entry from both manifests. **Done.**
2. Add `stdlibLibraryOf`, mapping a canonical module id to the library
   that owns it, and move `buildStdlibConfig` into `stdlib-manifest.zena`
   so `types.zena` can reach it without an import cycle. **Done.**
3. Add the well-known declaration registry: a canonical location
   `(library, declaration name)` per entry, an error on any miss, and one
   call shape for classes, interfaces and type aliases. Convert the six
   sites that already check a location, and delete the
   `startsWith('zena:async')` prefix match. **Done.**
4. Convert the name-only sites to the registry. Fourteen of the sixteen
   converted; the two exceptions are recorded below. **Done.**
5. Make `queueStdlibFunction` throw on an unresolved module or export
   instead of returning silently. **Done.** It found one: the template
   join rooted a `__concatN` helper the standard library has never
   declared, and returned before rooting the `String.fromParts` that
   lowering emits in its place. Helpers whose absence lowering handles
   now go through a separate call that reports whether it rooted, so the
   two take the same branch.
6. Replace the filename-suffix fallback in
   `reachability/import-resolver.zena` with manifest-driven resolution.
   **Done.** The fallback was covering for `Program`'s index, which
   derived a module's `zena:` alias from its file name and so produced
   `zena:zena:component-stream` for a canonical path id. The alias now
   comes from the manifest, and the search is gone.
7. Reseed. This is the point at which the bootstrap gains the registry,
   and it must be its own pull request.

### Matches that remain, and why

Four name comparisons survive Phase 0 on purpose.

`array` and `ByteArray` in `codegen/type-mapping.zena` name compiler
builtins rather than standard library declarations, so no library owns
them and the registry does not apply. `ByteArray` is the odder of the
two: the checker registers it as an `ArrayType` of `u8`, deliberately not
as a stdlib declaration, so real compilation never produces a `ClassType`
named `ByteArray`. The branch that handles one is reachable only from
`dce_test`, whose mock standard library declares a stand-in
`class ByteArray {}`. Correcting the fixture is what would let the branch
go.

The two `currentClass.name == "FixedArray"` guards at the array-literal
sites in `checker.zena` ask a different question than the registry
answers — see the next section.

### One file under two module ids

A file reachable under two canonical ids is checked twice and produces two
nominal types with the same name. `checker-real-files_test` checks
`packages/stdlib/zena/fixed-array.zena` as an entry point by filesystem
path while the prelude loads the same file as `zena:fixed-array`, and the
result is two `FixedArray` classes. It surfaces as a type error whose two
sides print identically:

```
Type mismatch: cannot return 'FixedArray<T>' from function expecting 'FixedArray<T>'
```

The array-literal guards named above absorb this by matching on the name,
which is why they cannot become location comparisons: a location
comparison correctly reports the two copies as different, and the literal
is then typed as the other one.

This bears on the migration rather than only on those two guards. Facades
and shims are what let one file be reached two ways, so the phases below
should expect this failure and read the signature above as its
fingerprint rather than as a checker bug. A file must have exactly one
canonical id at any moment: a shim re-exports an implementation file, and
nothing should import both the shim and the file it re-exports.

### Phase 1 — create each library and publish it

For each target library, create the directory, move its implementation
files in, rewrite their intra-library imports to relative form, and add
the library to both manifests pointing at its `index.zena`. Each existing
top-level `X.zena` stays as a one-line `export * from './<dir>/X.zena';`,
so no import site outside the stdlib changes and both the old and new
names resolve.

Creating the directory and publishing the library are one step rather than
two, because `stdlibLibraryOf` attributes a private file to a library only
if that library is published. Move `string.zena` to `core/string.zena`
while `core` is unpublished and the file belongs to no library, so the
registry stops recognizing `String` — which is the same failure the spike
produced, arriving a step earlier.

Every library the compiler names therefore lands in three parts: add its
new location alongside the old, reseed, then move the files and drop the
old location. That is not only the registry's libraries. `string-convert`
and `string` have functions `queueStdlibFunction` roots by module id, and
`ownership` declares `Own`, `Borrow` and `Unmanaged`, so all three move
with the registry group rather than ahead of it. What is left over —
`byte-array`, `byte-buffer`, `result`, `string-builder`, `string-reader`
— is what the compiler names nowhere and can move in one step.

Order from least to most coupled, so the plumbing is proven before it
reaches `String`:

8. `component/` — `component-abi`, `component-async`, `component-stream`,
   `component-memory`. Six compiler literals name these modules, and which
   ones move depends on what they name. Three name a **file**, and move:
   `runtimeEntry` in `component-runtime.zena`, and the two
   `'zena:component-async.zena'` path ids in `component-adapters.zena` and
   `reachability/analysis.zena`. Three name a **module**, and do not:
   `componentAbiModule` in `component-emitter.zena`, the synthesized
   `from 'zena:component-async'` in `wit-module-synth.zena`, and
   `zena:component-abi` in `getTargetRuntimeModules`. None is a bootstrap
   hazard, because building the compiler targets no component.

   The library's modules keep their published names here and their
   manifest entries point straight at the new files. No shim is left at
   the old path: `analysis.zena` roots `zena:component-abi` by walking the
   unit's `globalDeclarations`, and a re-export shim is an empty module to
   that walk — which, since `queueStdlibFunction` became strict, fails
   loudly rather than quietly. That the name-id literals keep working at
   all is `Program` indexing a stdlib unit under its manifest module name
   as well as its canonical path.

   Publishing `zena:component` itself is a later step. The rule that a
   library must be published before its files move applies to private
   siblings, and every file here is named by a manifest entry.

9. `bench/` — absorb `benchmark`. **Done**, and it was a merge rather than
   a move. Two of `benchmark`'s three exports already existed in `bench`:
   `getMonotonicTimeMs` is `readClockMs(1)`, the same WASI call
   unparameterized, and `formatFloat` is `formatFixed(value, 2)` except
   that it truncates instead of rounding and mishandles negatives. Only
   `runTest` was missing, so it moved into `bench/index.zena` over
   `nowMs` and `formatFixed`, and `benchmark.zena` was deleted rather
   than relocated. Timings now round rather than truncate.
10. `collections/` — move `map`, `ordered-map`, `set` implementations in,
    and re-export the array types from `core` once it exists. Already a
    directory. No registry entries.
11. `stream/` — `stream` becomes a directory library of its own rather
    than being absorbed into `async`. It stays a separate entrypoint
    permanently, under the prelude rule, so its files belong in their own
    directory rather than inside `async/`. `async` absorbs nothing and
    needs no step.
12. `core/`, the members nothing in the compiler names — `byte-array`,
    `byte-buffer`, `result`, `string-builder`, `string-reader`.
    Publishing `core` here is what makes the next step possible.
13. Add the `core` locations for `String`, `TemplateStringsArray`, `Box`,
    `Error`, `Iterator`, `Iterable`, `Array`, `MutableArray`,
    `FixedArray`, `ImmutableArray`, `GrowableArray`, `Own`, `Borrow` and
    `Unmanaged` to the registry, alongside their current ones, and the
    `core` module ids for the functions `queueStdlibFunction` roots by
    module — `__concat<N>` in `zena:string` and the conversion helpers in
    `zena:string-convert`.
14. Reseed.
15. Move the remaining files into `core/` — the array family, `string`,
    `string-convert`, `error`, `error-stack`, `option`, `box`, `range`,
    `hashable`, `iterator`, `iterable-utils`, `template-strings-array`
    and `ownership` — and drop their old registry locations. This is the
    step the spike exercised.

Steps 8–12 and 15 are verifiable by `npm test` alone, since nothing
outside the stdlib directory changes.

### Phase 2 — migrate import sites

Mechanical rewrites, one library at a time, each independently revertible.
The current site counts, by area:

| Area                       | Files importing `zena:` |
| -------------------------- | ----------------------- |
| `tests/`                   | 193                     |
| `packages/zena-compiler/`  | 125                     |
| `packages/stdlib/`         | 111                     |
| `packages/wit-parser/`     | 13                      |
| `benchmarks/`              | 6                       |
| `packages/zena-formatter/` | 6                       |
| `examples/`                | 2                       |

16–20. One pull request per new entrypoint (`core`, `collections`,
`component`, `async`, `bench`), each rewriting every site across all
areas. The libraries are published by the end of Phase 1, so a rewrite can
cover compiler sources and tests together.

### Phase 3 — retire the old names

21. Point the prelude at the new modules. Measure compile time on a
    representative build before and after, and record it.
22. Delete the shim files and their manifest entries.
23. Reseed.

## Open decisions

- **`fetch`.** Not in the target library list and not obviously part of
  any library in it. Recommended: leave it published until `http` exists.
- **Compatibility shims.** The plan deletes the old entrypoints in step 22. If any consumer outside this repository should keep working, the
  shims stay instead, and each becomes a one-line
  `export * from 'zena:core';` — which over-exports, and is only
  acceptable as a temporary measure.
- **`time`'s name.** `timers` or `clocks` were both suggested. The module
  provides sleeping and a monotonic clock, so `clock` fits what is there
  now, and a future `date` library takes the calendar half.
- **`core` in the prelude.** Whether the prelude names `zena:core` at all,
  or keeps naming narrower modules, should follow the step 21
  measurement rather than being decided up front.

## Follow-on libraries

`date`, `net`, `http`, `worker`, `random` and `path` each want their own
issue. All six fit the target structure without further reorganization:
`date` and `random` are leaves, `path` depends only on `core`, and `net`,
`http` and `worker` sit alongside `fs` and `process` above `async`.
