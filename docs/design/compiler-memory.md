# Compiler Memory

What the self-hosted compiler keeps in the wasm GC heap, how to measure
it, and the changes made for issue #199, where garbage collection was
24% of a large compile.

## Object layout in wasmtime

The compiler runs on wasmtime's copying collector, and its layout rules
decide which changes pay (`wasmtime-environ`'s `common_struct_layout`,
`gc/copying.rs`, version 48):

- Every object has a 16-byte header.
- Fields are laid out in declaration order at their natural alignment:
  references, `i32`, `f32` and `boolean` take 4 bytes; `i64` and `f64`
  take 8; `u8`/`i8` take 1 and `u16`/`i16` take 2, packed.
- The object size is rounded up to a multiple of 16.

So an object of `n` 4-byte fields occupies `ceil16(16 + 4n)` bytes: 32
bytes up to four fields, 48 up to eight, and so on. Removing a field
saves nothing unless it crosses one of those boundaries, and a narrow
field type only helps in the same way. Deleting whole objects always
pays: a two-field object that exists once per AST node is 32 bytes per
node.

A `Map` entry is a 32-byte `MapEntry` plus its share of the bucket
array, about 37 bytes per entry; an ordered map's entry is 48 plus the
share. A side table with an entry per node of a large program is tens
of MiB that every collection copies.

The heap is two semi-spaces capped at 4 GiB together, and the copying
collector grows the heap only when an allocation still does not fit
after a full collection. Peak RSS at `ZENA_GC_RESERVE_MB=0` therefore
tracks the live set, but in coarse steps: a compile whose live set
crosses a doubling threshold shows twice the RSS of one just under it.

## Measuring

`ZENA_CENSUS=1` on any compile prints what the finished compile
retains, from `zena/lib/census.zena`: AST nodes by kind with their
bytes under the layout above, the semantic-model side tables by entry
count, locations, comments and source text, and counters for the
types minted over the process, the cached type-key strings and the
instantiation caches. The AST and side-table rows are exact counts
from walking the program; the type counters are totals, which for
interned types is nearly the live count.

`scripts/mem-bench.sh [workload ...]` times a compile at the reserve
its build script uses and records peak RSS at reserve 0, for `hello`,
`cli-module` (the `zena` command's module, the largest step on the
build's critical path), `self-hosted` (the compiler at `-O2`) and
`lsp`. It keeps one copy of the compiler per collector under
`perf-out/`, because the `.cwasm` cache key does not include the
collector and switching `ZENA_GC` would otherwise recompile the
module on every run, at a peak RSS of its own that swamps the
measurement.

`ZENA_GC=null` would measure total allocation (the null collector
never frees), but its heap is capped at 4 GiB and the `cli-module`
compile allocates more than that, so it only works for small inputs.

## Where the bytes were

The census of the `cli-module` compile before any change, 236
libraries and 557K AST nodes:

| retained                       | objects | MiB  |
| ------------------------------ | ------- | ---- |
| AST nodes                      | 557,549 | 20.9 |
| `SourceLocation`, one per node | 556,576 | 25.4 |
| `ModelIndex.nodeToModel`       | 561,168 | 19.8 |
| `SemanticModel.parents`        | 553,656 | 19.5 |
| `SemanticModel.nodeTypes`      | 344,302 | 12.1 |
| type key strings               | 343,268 | 23.2 |
| module source text             | 236     | 5.2  |
| comments and their strings     | 15,869  | 1.4  |

And over the process, 2,559,668 `Type` objects were minted: 771K
`FunctionType`, 524K `ClassType`, 387K `InterfaceType`. At 96 to 176
bytes each before their arrays and maps, these outweigh everything in
the table. The instantiation caches on generic classes (`ClassType.
instantiations`) were hit 36K times and missed 2K; 610K of the class
and interface types came from `substituteInType`, which built a fresh
instantiation, with a fresh constructor `FunctionType`, lists and
maps, for every mention of a generic class in a signature.

Half of the AST's bytes were its locations. Every node carried a
five-field `SourceLocation` — line, column, start, end, path — at 48
bytes, more than the median node, for two numbers that are read only
when a diagnostic is printed.

## Changes

Each is independent; together they pass the compiler suite including
the stage-1/stage-2 fixpoint check.

### Empty collections cost one slot

`HashMap`, `HashSet` and `OrderedMap` defaulted to 16 buckets and
`GrowableArray` to 8 slots: 96 and 64 bytes for an empty table. Most
maps a program builds hold nothing or a few entries — `ClassType`
alone carries four maps and two arrays, and `staticSymbols` is
documented as always empty on a class — so the defaults are now 1
bucket and 0 slots. A one-bucket table needs no special case, since
`h & 0` is a valid index; it doubles on the first resize like any
other. Callers that know a size pass it.

### Dense per-node tables

`SemanticModel.nodeTypes` and `parents`, and the scope builder's
parent map they come from, are `DenseNodeMap`s (`node-map.zena`):
one 4-byte slot per node id of the module, present or not, instead of
a hash map entry per node. A module's node ids are one contiguous
range, because the parser assigns them in one walk after parsing and
records the last one on `Module.lastNodeId`; a node the scope builder
or checker mints later falls outside the range and goes in an overflow
map created on first use.

`ModelIndex`, which answers which model owns a node, used one map
entry per node in the program. It now records one range per module
and binary-searches, with the same overflow map for later nodes:
11K entries where there were 561K.

Side tables for the `cli-module` compile went from 56.9 MiB to 10.1.

### Locations without line and column

`SourceLocation` is `start`, `end` and `path`: 32 bytes. Lines and
columns are computed from `start` on demand by `line-index.zena`,
which keeps a table of line starts per path, built the first time
something asks about that file — for a clean build, never. The parser
registers each module's source under its path when it parses it;
`DiagnosticBag`, the compiler's goto-definition spans, the language
service and zenadoc go through `spanOf`/`lineAt`/`columnAt`. Function
value wrappers, which were named by line and column, are named by
byte offset.

Locations went from 25.4 MiB to 17.0 in the `cli-module` compile.

### Substitution cache for generic mentions

`substituteInType`'s class and interface cases cache their result on
the mention (`ClassType.substitutionCache`), keyed by the arguments'
identities, so a generic class substituted repeatedly through one
signature is instantiated once per argument list. Two conditions keep
it correct:

- The cache is on the mention, which may itself be an instance, rather
  than on the class's template. A class's own constructor parameter
  that names the class (`MapEntry<K, V>` inside `MapEntry`) resolves to
  a self-instantiation the checker made before the constructor was
  registered, whose `constructorType` stays null; copying from that
  object ends the chain, where copying from the template gives the
  copy a constructor whose parameter is the copy itself. Codegen's
  `substituteTypeParamsInCodegen` memoizes only after recursing into
  supertypes and constructor parameters, so a cyclic input overflows
  the stack (reproduced on `hello_test.zena` in six seconds).
- Only closed argument lists are cached. An argument containing a type
  parameter — a bare `Foo<T>` inside a generic body — would make the
  cached object its own descendant through a self-mentioning
  supertype, for the same reason. Those are built fresh per mention as
  before, 113K of them in the `cli-module` compile, keyed for
  re-entrancy by the structural key they always used.

The checker fills a class in phases, so a mention substituted before
the class's constructor or supertypes are set must not fix the
instantiation in that state. Each cached instantiation records a
`shapeStamp` of its source (supertype, interfaces, mixins,
constructors, `on` type and flags, by identity), and a hit whose stamp
no longer matches is rebuilt in place.

Types minted in the `cli-module` compile went from 2,559,668 to
1,654,309: `ClassType` 524K to 300K, `InterfaceType` 387K to 142K,
`FunctionType` 771K to 553K.

## Results

`scripts/mem-bench.sh`, two runs each, on a 16-core VM with nothing
else running; wall time at the reserve the build script uses
(1536 MiB for both):

| workload      | peak RSS at reserve 0 | wall time     |
| ------------- | --------------------- | ------------- |
| `cli-module`  | 4154 → 2108 MiB       | 28.5 → 27.5 s |
| `self-hosted` | 2108 → 2108 MiB       | 69.5 → 65.5 s |

The `cli-module` RSS halved because its live set fell below a heap
doubling threshold; `self-hosted` stayed in the same step. The census
counts the retained set it can see at 78 MiB where it was 133, and
the types minted at 1.65M where they were 2.56M. Wall time moved less
than the live set did, so most of what the collector copies is still
outside what the census itemizes: the minted types and codegen's own
structures, which the list below starts with.

## What is left

In descending order of expected payoff, from the census after these
changes:

- **Type key strings**, 24 MiB: `uniqueKeyCache` and
  `specializationKeyCache` on every `Type` hold a structural string
  per type for the life of the compile. Keying those tables by a
  composite of uids would remove both the strings and the two fields.
- **Parametric substitutions**, 113K per `cli-module` compile, built
  fresh each time. Caching them needs codegen's substitution to be
  safe on cyclic inputs (register the result before recursing, as the
  checker's `substitutionFrames` do).
- **`FunctionType`**, 553K minted, 18 fields: `parameterNames`,
  `parameterInitializers`, `parameterSymbols` and `optionalParameters`
  are per-declaration facts copied onto every instantiation and could
  live on the declaration.
- **Comments**, 1.4 MiB: the compiler proper never reads
  `Module.comments`; only the formatter, zenadoc and the language
  service do, and all three go through the same loader, so dropping
  them is a `CompilerOptions` flag.
- **Strings**, 48 bytes each: `data`, `start`, `end`, `encoding`,
  `hashCode`. Folding the encoding into a bit of another field takes
  every string to 32 bytes.
