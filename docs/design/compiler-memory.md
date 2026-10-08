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

## What is left

- **Hash-consing types.** Types are values with structural equality
  (`typesEqual`), identity equality for nominal ones, and every site
  that needs one builds it. Interning on construction — unions by
  member identity, arrays and tuples by element identity, class and
  interface instantiations by (template, argument identity) — would
  make equal types the same object. That collapses the 1.65M minted
  to the distinct ones (28K among the keyed 342K), turns identity
  caches like `substCache` into hits, and replaces the 24 MiB of key
  strings with pointer comparison. Interning retains each distinct
  type for the compile, which the checker's side tables already do
  for the types that matter. `UnionType` has eight construction sites
  and no mutation after construction, so it is the place to start;
  `FunctionType` is the obstacle: `functionSymbolId`,
  `parameterSymbols`, `parameterInitializers`, `overloads` and
  `isFinal` are declaration facts set on the type after construction
  (16 write sites each), so two structurally equal signatures are not
  interchangeable until those move to the declaration.
- **Allocation on the no-change path.** `substituteTypeParamsInCodegen`
  builds two argument arrays before it knows nothing changed, 205K
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
