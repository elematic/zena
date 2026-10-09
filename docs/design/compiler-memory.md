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

### Empty collections, measured and left alone

`HashMap`, `HashSet` and `OrderedMap` default to 16 buckets and
`GrowableArray` to 8 slots: 96 and 64 bytes for an empty table, and
`ClassType` carries four maps and two arrays, so 300K instantiations
allocate about 115 MB of empty tables. Defaults of 1 bucket and 0
slots were tried and measured against the originals with two
compilers built from the same bootstrap: the `cli-module` compile
took 19.9 s against 20.2 s at the build's reserve, and peaked at the
same RSS with no reserve. The empty tables are allocation, and nearly
all of it is garbage by the next collection; at a 1.5 GB reserve
115 MB is a fraction of one collection. Against that, a map that does
fill would pay four extra rehashes (1→2→4→8→16), each re-creating
every entry, in every Zena program. The defaults stay as they were.

What the measurement says to do instead is in the compiler: a map a
class rarely uses should not exist until it does. `staticSymbols` is
always empty on a class, `instantiations` is used only by generic
templates, `constructors` only by classes with named constructors,
and `substitutionCache` is already a nullable field created on first
use.

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

## Where the types come from

1.65M types for a 557K-node program is three per node, and the census
says which phase mints them (`markTypes` at each phase boundary; the
`zena` module is a component target, so a small nested compile of the
runtime memory module runs first):

| phase                         | types     | class   | function | interface |
| ----------------------------- | --------- | ------- | -------- | --------- |
| check                         | 50,168    | 6,119   | 14,253   | 3,602     |
| nested runtime-module compile | 29,650    | 5,387   | 7,804    | 2,463     |
| reachability (discovery)      | 1,492,837 | 280,423 | 524,436  | 126,892   |
| layout, generators, async     | 157       | 23      | 10       | 44        |
| lower, optimize               | 83,021    | 8,394   | 6,776    | 9,288     |

Checking a 236-library program mints 50K types. Reachability mints 30
times that, because it re-substitutes a member's signature for every
reached (function, specialization) pair through
`substituteTypeParamsInCodegen`, and that function's caches
(`ClassSubstitutions.substCache` and `instantiations`, keyed by the
input object's identity) miss whenever the input is a different mention
of the same type, which is most of the time. Of the 524K
`FunctionType`s, 136K come from that function's own `FunctionType`
case, 51K from the constructor it copies onto each class
instantiation, 81K from `eraseTypeParameters` and its constructor
copy, and most of the rest from the constructor copies in the
checker's `substituteInType` when reachability calls it. A type here
is a plain value: nothing hash-conses a union, an array type or a
substituted signature, so equal types are built again at every site
that needs them.

Two more counters say how much of that is repeated work. Of the
376K outermost calls to `substituteTypeParamsInCodegen`, 205K hand
back their input unchanged (and still allocate the argument arrays
they built to find that out), and only 248K distinct (input,
arguments) pairs occur — so a cache keyed on input identity, as the
class case has, would save a third at most, because the inputs are
themselves fresh copies. Among the 342K types codegen gave a
structural key, 28K are distinct: twelve copies of each type, on
average. The duplication is in the inputs, and a cache on the
outputs cannot remove it.

Where the collector's time goes follows from the same compile timed
with no reserve against the build's 1536 MiB (`--time`, ms):

| phase                          | reserve 1536 | reserve 0 |
| ------------------------------ | ------------ | --------- |
| load, parse, scope, check      | 1,118        | 2,056     |
| discovery: queues              | 11,764       | 30,886    |
| discovery: class/vtable layout | 4,304        | 80,026    |
| lower, optimize                | 4,434        | 5,503     |
| emit code                      | 5,701        | 8,866     |

All of the 100 s of collection cost is in reachability, 76 s of it
in the class-linking and vtable passes between the queue drains,
which run while everything discovered is live.

## Interning types

Four changes, each measured on the `zena` module compile (types
minted; wall time interleaved against `main`, three runs each):

1. Unions are interned (`internUnion`): one object per member list,
   keyed by member identity in a trie, with field-less primitives
   mapped to singletons so that two `T | null` can match. Only unions
   whose members all have stable identity are interned; a union over
   a substitution copy is built fresh, since interned it would pin the
   copy for the compile and never match. Alone this did nothing:
   313 unions interned, 335K built fresh, 314K of them because the
   first member was a class instantiation that was a fresh copy at
   every mention.
2. Codegen's `substituteTypeParamsInCodegen` registers a class
   instantiation before substituting its supertypes and constructor,
   and interfaces get the same per-source table. This is what lets
   the checker hand codegen an instantiation whose constructor
   parameter names itself (the checker's self-instantiation of
   `MapEntry<K, V>` has no constructor; one built from the template
   does), which codegen's walk previously recursed on without end.
   `eraseTypeParameters` memoizes per module for the same reason.
3. The checker's `substituteInType` caches one instantiation per
   (template, argument identities) and builds it from the template.
   Types minted 1.62M to 745K: ClassType 301K to 48K, InterfaceType
   111K to 46K. Union hits 9.8K to 52.7K.
4. Outermost codegen substitution results are memoized per module by
   (input, parameters, arguments) identity, and `instantiateClassType`
   returns a cached instantiation as is when its source's shape stamp
   still matches. Types minted 745K to 536K.

Wall time over the four: 20.5–20.8 s against 20.5–20.9 s. Three
times fewer type objects bought no time at the build's 1.5 GB
reserve, so the type objects were not what the collector's time went
to; what reachability retains, and allocates other than types, is
the next measurement — a census that walks `WasmModule` (functions,
structs, `classInfos`, vtables) and the type graph reachable from it.

## Heap snapshots under V8

The census counts what the compiler knows to count. A heap snapshot
counts everything, with retainers, and V8 writes one on request:
`scripts/heap-snapshot.mjs` runs the `js`-target compiler build
(`lsp.wasm`, whose `compileToWasm` runs the whole pipeline) under
Node, compiles an entry, and calls `v8.writeHeapSnapshot` — after the
compile, which is the retained set after a full collection, or at the
N-th read of the clock, which the phase timer takes at every phase
boundary, so a snapshot can be aimed inside discovery (`clocks` lists
the reads with timestamps). Wasm GC objects appear by type, labeled
through the name section's type-name subsection, which the binary
emitter writes under `-g`; `analyze` sums a snapshot by class and
`retainers <class>` sums the holders of every object of one class,
by distinct target and by edge. V8's sizes differ from wasmtime's (no
16-byte rounding, a different header), so counts are exact and bytes
are proportions. Node's default stack is too small for the compiler's
recursion: `--stack-size=200000` with `ulimit -s unlimited`.

The workload is the language service's own entry,
`packages/language-service/zena/lsp.zena`: a `js`-target program that
pulls in the whole compiler. It takes 6.6 s under V8 and 14.8 s
under wasmtime with the same module and inputs.

### The live set inside discovery

6.48M objects, 394 MiB, compiling `lsp.zena`, snapshot 60% of the way
through the run:

| class                                              | live        | MiB | held by                                                                                                                                                                                      |
| -------------------------------------------------- | ----------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `String` + `ByteArray`                             | 773K + 573K | 78  | 570K strings own a store: map keys, the type-key caches (~125K), `PendingStaticTarget.memberName` (133K distinct), function names. 154K are identifier names, one `String` per `Identifier`. |
| `WasmFunction`                                     | 41K         | 17  | 432 bytes each                                                                                                                                                                               |
| `SourceLocation`                                   | 437K        | 17  | one per node                                                                                                                                                                                 |
| `MapEntry<i32, Symbol>`                            | 294K        | 14  | the scope builder's `SymbolMap`, by node and by source offset                                                                                                                                |
| `FunctionType`                                     | 94K         | 13  | `Map<String, Type>` tables 43K, the codegen `substCache` 41K, class constructors 16K                                                                                                         |
| `PendingStaticTarget`                              | 202K        | 10  | a push-only list on the reachability pass                                                                                                                                                    |
| `GrowableArray<Type>` + `Array<Type>` fat pointers | 186K + 152K | 12  | `FunctionType.parameters` is interface-typed, so each signature carries a fat pointer around its array                                                                                       |
| `MapEntry<Type, Type>`                             | 81K         | 4   | `substCache`                                                                                                                                                                                 |

The type graph is a tenth of it. Strings are a fifth, and most of
them are keys and caches rather than source text.

## What the snapshot bought first

Three retained structures the snapshot ranked, each a few lines:

- The reachability pass's `#pendingStaticTargets` list marked an
  entry resolved and kept it; the drain now keeps only the entries it
  has to retry. 202K objects and their 133K mangled-name strings were
  live for the rest of the compile.
- `SymbolMap.#byNode` is a `DenseNodeMap`, as the semantic model's
  node tables are; its offset index, which only the language service
  reads, is two parallel arrays built into a map on the first lookup.
  294K `MapEntry<i32, Symbol>` became 4.8K.
- `#slotOwnerKey` caches per class by identity and then by slot name,
  instead of under a concatenated `classKey|slot` string; and
  `MixinType.sharedMembers` is null until a decorator declares one.

Snapshot inside discovery, same point: 6.48M objects and 394 MiB to
5.77M and 359 MiB; strings 773K to 650K.

Then three more, from the same table:

- Identifier names are interned through a `StringTable` the library
  loader owns (docs/design/string-interning.md): a keyword is
  classified against the source bytes before any `String` exists, and
  an identifier is probed against them in place, so a token allocates
  only the first time its spelling is seen. Every identifier of one
  spelling is one `String`, and the name maps downstream hash a string
  that has hashed before. 154K live name strings become a few
  thousand.
- `FunctionType.parameters` is a `GrowableArray<Type>` rather than the
  `Array<Type>` interface, which cost a fat pointer beside each
  signature's array: 153K of them.
- `WasmFunction.captures` and `mutableCaptures` are null until a
  closure captures something, in place of an empty array and set on
  each of 41K functions.

Snapshot at the same point: 5.27M objects, 335 MiB; strings 475K.

## A 2 s swing that is not in the compiler

The interning and lazy-capture changes above made the `zena` module
compile 2 s slower under wasmtime (18.0 s to 20.0 s, interleaved) and
no slower under V8 (5.93–5.96 s against 5.99–6.00 s). Each change
alone cost the 2 s, both together cost the 2 s, and reordering two
functions in a pristine tree cost nothing. The collector was not it:
`zena-run` now installs a logger when `ZENA_RUST_LOG` is set, and
`ZENA_RUST_LOG=wasmtime::runtime::store::gc=trace,wasmtime::runtime::vm::gc::enabled::copying=trace`
showed ten collections totalling 3.06 s against 3.00 s. Emitted code
was not it: `call_ref`, `ref.cast` and `ref.test` counts, the ZIR pass
statistics and the set of open struct types were the same.

`samply` (docs/profiling.md) with `scripts/samply-diff.py`, which
resolves wasm frames through the perf map and native frames through
`nm`, put all of it in one native function:
`StoreOpaque::is_subtype_cached`, 2,330 samples to 4,489, with every
wasm caller's share roughly doubled. A patched wasmtime showed both
runs make the same number of subtype checks (67M at the same
milestones) over the same 425 distinct (subtype, supertype) pairs.

The cache is `HashMap<u64, bool, NopHasher>` keyed by
`(sub << 32) | sup`, and `NopHasher` returns the key as the hash. So
hashbrown's bucket index is the low bits of the supertype's engine
type index and its tag the high bits of the subtype's: every pair that
casts to one common supertype (`Type`, `Node`, `Array`) lands in one
bucket group, and with 425 entries in a 512-slot table the probe
length is whatever the exact index values make it. Those values shift
with any change to the module, so any edit can flip a compile between
the fast and slow placements. Reserving 8,192 slots in the patched
runtime took the slow build from 24.3 s to 22.3 s, level with the fast
one (22.0–22.6 s; the patch's per-call env lookup inflates both).

This is wasmtime's to fix — a real hasher, or sizing the cache for a
few thousand pairs — and the reproduction is the two modules and
`samply-diff.py --callers is_subtype`. Until then, a 2 s step in the
`zena` module compile between two builds says nothing about the change
between them unless the subtype-check count or a profile says so too.

## Where the allocation goes

The live set is a tenth of what a compile allocates. The snapshot
work above found where the retained tenth was; the rest, the garbage
the collector copies around, needed a different instrument, because a
snapshot shows what survives and V8's allocation tracking sees no wasm
objects.

`scripts/wasmtime-alloc-hist.patch` is a local patch to wasmtime's
copying collector (applied to a copy of the crate through
`[patch.crates-io]`, never shipped). Bump allocation is contiguous,
so walking the active semi-space from the previous collection's bump
pointer at the start of each collection sees every object allocated
in between, including the ones compiled code allocated inline, and
counts them by type. `scripts/alloc-hist.py` joins the counts with
the type names of a `-g` build; `scripts/alloc-hist.sh` runs a
compile with it. `ZENA_GC_RESERVE_MB` reserves the heap by allocating
one giant i64 array, which the walk leaves out. Two things the census
made plain about the language's cost model: a tuple returned from a
method is a heap struct per call even when the caller destructures
it, and passing a `GrowableArray<T>` where `Array<T>` is expected
allocates a 32-byte fat pointer per call.

Callers come from a samply profile and `scripts/samply-callers.py`,
with samples whose leaf is in the collector left out: a collection is
charged to whichever allocation tripped it, which made `i32ToString`
look like 3% of a compile.

The `zena-cli` module compile at `-O2` (`cli-module` in
`mem-bench.sh`), before and after the changes below, on the same
machine with the census running:

| build       | allocated | objects | collections | wall   |
| ----------- | --------- | ------- | ----------- | ------ |
| origin/main | 11.1 GiB  | 233M    | 11          | 22.4 s |
| this branch | 4.4 GiB   | 89M     | 5           | 15.6 s |

Where the 11 GiB went, and what was done about each:

- **The checker's flow walk**, 1.4 GB. Every join evaluation purged
  the provisional-result buckets above its depth by replacing each
  with a fresh `Array<i64>` (9.3M of them, 0.9 GB), and built an
  `Array<Type>` for its antecedents' results before knowing they agree
  (5.7M, 0.5 GB). The buckets are cleared in place
  (`GrowableArray.clear`); the result list is built on the second
  distinct type.
- **Referrer keys in RTA**, 2.3 GB of strings. `queueReferrer`
  built a string key per referrer (prefix, `i32ToString`, class key,
  concatenations) and hashed it into two `Set<String>`s: 24M of the
  compile's 42M strings, plus 5% of its time in the lookups. The key
  is now an i64 (class uid, symbol/node bit, id) except when the
  referrer carries type arguments, and the hot sites check it before
  constructing the `Referrer` — 194K of the 6M were new.
- **`successors()`**, 1.2 GB. The decoder allocates a list, a fat
  pointer and a record per edge, and the passes call it in loops:
  7.3M calls, most from `forwardEmptyBlocks`, which decoded every
  terminator once per empty block. `successorCount` and
  `successorRecord` read the records in place; `forwardEmptyBlocks`
  keeps a predecessor list.
- **Liveness in copy coalescing**, 1.3 GB. `bitGet` took its bitset
  as `Array<i32>`, so every query from `liveAtDef` allocated a fat
  pointer (25M); the four bitsets, blocks × values bits, were pushed
  from empty, so one large function doubled each through half a
  gigabyte of discarded buffers; and the use list was one array per
  instruction.
- **Extension types in `typeToValType`**. An extension class's `on`
  type was resolved through the flattened class context, which keys
  the class's supertypes and interfaces, once per mention of
  `FixedArray<T>`. Only the class's own parameters can appear in
  `on`.
- **GVN keys**: a string per pure instruction built from about eleven
  allocations. Now a case class.
- **Substitution memo keys**: one string per type parameter and
  argument; now one `StringBuilder`. The two together were 9M
  strings.

What the census still shows, in the order it ranks them:

- **Small `Array<i32>` lists**, 8M at 64 bytes each that never grow
  (plus their 32-byte `GrowableArray` objects): the lowering's
  argument and operand lists, one per expression. Some of those could
  be scratch lists cleared per use, as `forwardEmptyBlocks` now does.
- **Strings**, 9.5M, a fifth of the bytes (from 42M). The remaining
  builders are spread thin: `getTypeUniqueKey`, the closure and
  member-path keys, `#walkPathType`'s memo key
  (`i32ToString(join.id) + "|" + path`).
- **Type lists from substitution**, 2.6M: the no-change path of
  `substituteTypeParamsInCodegen` builds the argument array before it
  knows nothing changed.
- **`MapEntry<String, Type>`**, 2.2M: the substitution caches keyed by
  string.

## The -O2 compile, and keys without strings

The census so far was of the `-O1` compile of the `zena-cli` module.
The self-build — the bootstrap compiling the compiler at `-O2`, which
`build:cli` runs and everything in CI waits on — was five times
worse: 22.5 GiB for the same module at `-O2`, 405M objects, and a
profile with 44% of its time in one function.

| compile          | main     | this branch |
| ---------------- | -------- | ----------- |
| `-O1`, allocated | 4.41 GiB | 4.30 GiB    |
| `-O1`, objects   | 88.7M    | 86.3M       |
| `-O2`, allocated | 22.5 GiB | 12.3 GiB    |
| `-O2`, objects   | 405M     | 190M        |
| `-O2`, wall      | 68 s     | 33 s        |

(Allocation with the census running; the walls without it, two runs
each on a near-idle machine, the "main" module being #218's head.)

- **Use lists per pass.** Constant propagation, scalar replacement,
  jump threading and the escape analysis each built a
  `GrowableArray<i32>` of users per instruction on every visit, and
  the escape fixpoint rebuilt its tables on every one of up to eight
  rounds, per inlining round: 128M lists, 17 of the 22 GB. One packed
  `IrUseLists` per body (`buildUseLists`) serves all four, and the
  escape summaries build each body's once per fixpoint.
- **`inlinableSize` per call site.** The inliner walked the whole
  callee body at every call that named it: 44% of the `-O2` profile.
  The size is memoized per callee for the sweep.
- **The CFG's per-block lists** (predecessors, successors, dominator
  children), built 474K times at `-O2`: packed the same way.
- **The function index**, rebuilt per sweep by four passes: memoized
  on the module and dropped when the function list changes.
- **Tables pushed from empty.** Every table a pass sizes to the body
  (`repl`, `useCount`, `posOf`, the bitsets, the edge tables) grew by
  doubling from eight slots, so a large inlined body left a chain of
  discarded buffers behind each: 16M of the 45M i32 arrays at `-O2`,
  and most of their bytes. Forty-eight of them now take their bound
  as capacity, and the remaining hot `successors()` callers
  (`removeTrivialParams`, `removeUnreachable`, constant propagation's
  edge table, the escape walk) read records in place. That took the
  `-O2` compile from 12.3 GiB and 189M objects to 9.2 GiB and 161M,
  and `-O1` from 4.29 GiB to 4.10 GiB.

Keys without strings. Everything that identified a generic type by
the identities of other types wrote those uids into a string and
hashed it: the instantiation caches on a class or interface template
(`argumentUidKey`), the substitution frames that answer a re-entrant
mention, codegen's substitution memo, the referrers RTA dedups when
they carry type arguments. `TypeArgTrie` keys them all: the node for
an argument list is reached by walking one `Map<i32, …>` per element,
so a hit allocates nothing, and the interner's union table is the
same trie. This is structural interning of generic types for every
argument that already has identity — primitives, declared types,
canonical instantiations, interned unions. A function, record or
tuple argument still has a fresh uid per substitution, so an
instantiation over one is not shared; interning those needs
`FunctionType`'s declaration fields moved off the type first.

The trie was then replaced by `TypeListTable`, an open-addressing
table with one slot per distinct list: the key is the list's uids as
one i32 array, and a lookup builds its probe in the table's scratch,
hashes the uids in place and compares them against the stored keys,
so a hit still allocates nothing and a miss allocates one entry and
one key. The trie had cost about one node and one map entry per
element of every distinct list — 1.1M nodes, 0.8M maps, 1.5M
entries, 190 MB and 4% of the zena-cli compile's allocation — and n
map lookups per probe. The table holds the same keys in 289K entries
and 42K tables, about 25 MB, and the compile allocates 4.00 GiB
where it allocated 4.13 (9.11 GiB at `-O2`, from 9.25).

What the `-O2` census still shows: 36M small `Array<i32>` lists, now
mostly the inliner's per-site argument lists and the per-block
tables of block cleanup and constant propagation; a long tail of
per-instruction tables sized to large inlined bodies (10K arrays of
64–128 KB, a gigabyte), which only fewer passes or a per-body scratch
arena would remove; and `successors()` lists from the `-O2` passes,
7.5M.

## Function types with identity

Interning class and interface instantiations through the uid trie
left one family of types with no identity: a `FunctionType` was made
fresh by every substitution, so an instantiation over a function
argument never shared, and every cache keyed by type identity below
it missed. The type also carried eighteen fields, nine of them facts
about the declaration — parameter names, symbols, initializers and
optionality, `final`/`abstract`, the overload list, the symbol tag —
copied onto each copy and set one by one after construction, which
is what made it impossible to intern.

Now the signature is immutable: parameters, return type, type
parameters, and for an instantiation its arguments and source, all
fixed at construction (`withReturnType` and `withTypeParameters`
make a changed copy, which is what the constructor-type overrides
became). The declaration's facts are a `FunctionDeclInfo`, one per
declaration, immutable, shared by every instantiation and
substitution of its type; getters on the type read through it, so
the readers did not change. `internFunctionType` then keys a
declaration's instantiations by the identities of their parts in a
trie on the info, so a signature substituted a thousand times
through one declaration is one object. A type without info, an
anonymous function type, has nothing to share under and stays fresh.

Two fields are still set after construction, and the class says
why: the overload list, which the checker fills in as it meets a
declaration's later overloads (a substitution sets its own list when
built), and the symbol tag, which the resolution of an identifier
stamps on the function's type for RTA and lowering to reach the
function by. The tag is per type object, as before, so an interned
instantiation carries the tag its source had when it was made.

What it bought, on the `zena-cli` module compile at `-O1`: a
`FunctionType` is 80 bytes rather than 96, 12K `FunctionDeclInfo`
records serve 154K types, and 84K of the function types the codegen
substitutions asked for were already there — 238K minted before,
154K now. Allocation overall did not move (4.10 GiB to 4.13 GiB):
the trie nodes cost about what the shared types save. The gain is
identity: every cache keyed by a function type's uid below the
substitution now hits where it missed, and a union or instantiation
over a function argument interns where it could not before.

## What is left

In the order the snapshot ranks them, each measurable by the same
snapshot afterwards:

- **Strings.** 773K live, 570K with a store of their own. The
  type-key caches (`uniqueKeyCache`, `specializationKeyCache`) hold
  ~125K of them and exist to compare types that identity now
  compares; the `Map<String, …>`
  tables of the checker and the module hold most of the rest.
- **`WasmFunction`**, 41K at 432 bytes: the per-kind nullable fields
  to side records.
- **`SourceLocation`** folded into the node: 437K objects.
- **`FunctionType`'s declaration fields** onto the declaration, which
  is what would let function types intern as unions and
  instantiations now do.
- **Allocation on the no-change path.** `substituteTypeParamsInCodegen`
  builds two argument arrays before it knows nothing changed, 194K
  times per compile.

## Immutable type classes

Interning needs types that do not change after construction, and the
type classes are built the other way: a bare object, then fields set
one by one, because a class with thirty fields cannot take thirty
positional parameters. A record parameter with optional fields —
`new FunctionType({parameters, returnType, isFinal: true})` — can,
which would let the classes become immutable and their constructors
intern.

What the record temporary costs was measured with the
`record-ctor` and `positional-ctor` workloads: a seven-field class
built two million times through a record parameter and positionally.
Total allocation is from the null collector, which never frees:

| build        | total allocation | wall, no reserve |
| ------------ | ---------------- | ---------------- |
| positional   | 90 MB            | 0.11 s           |
| record `-O1` | 215 MB           | 1.36 s           |
| record `-O2` | 90 MB            | 0.13 s           |

At `-O2` the constructor inlines and `simplify`'s allocation
forwarding reads the record's fields off the `struct_new`, so the
record is never allocated and the two variants compile to the same
bytes. At `-O1` nothing removes it: one 48-byte object per
construction, and in a loop that allocates nothing else, twelve times
the running time. The compiler is built at `-O1` (`build:cli` passes
no `-O`), so adopting the pattern in the compiler goes with building
the compiler at `-O2`. Interning cuts constructions by the duplication
factor first, which makes the temporary's cost matter less either
way.

Building the compiler at `-O2` pays on its own. The `-O2` self-build
the fixpoint check already produces (`cli-self.wasm`) compiles the
`zena` module in 20.0 s where the `-O1` build (`cli.wasm`) takes
26.9 s, two runs each at the same peak RSS. `build:cli` would take
longer — the bootstrap compiling the compiler at `-O2` is the
`self-hosted` workload, 65 s against about 25 s — and every compile
downstream of it, which is every other build and test step, would
take a quarter less.

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
