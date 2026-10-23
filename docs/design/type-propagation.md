# Interprocedural Type Propagation

## Overview

At `-O2` the module loop makes a `call_ref` direct in two cases
(`ir/devirt.zena`). In the first, the vtable it loads from is known on
the spot: a `global_get` of a vtable global, the `<vtable>` field of a
`struct_new`, or the unpacking of an `iface_pack`. In the second, every
vtable global in the module installs the same function in the slot.
Neither rule looks past the function it is in. A dispatch on an object
read from a field, an array or a parameter stays indirect whenever two
classes in the module implement the method, even if only one of them
can ever reach that field.

[#421](https://github.com/elematic/zena/issues/421) proposed a
whole-program analysis for those sites: for every reference value,
compute the set of classes, vtables and functions that can reach it,
and make a site direct when its set holds one function. This document
records what such an analysis finds in the compiler's own -O2 build
and what making the found sites direct is worth.

In summary, the analysis (`ir/propagate.zena`) finds one target for 214
of the 830 `call_ref` sites the module loop leaves in the self-compile,
and making them direct leaves 617. The compiler it builds is the same
size and compiles 0.7% faster under V8 and 7% faster under wasmtime.
The analysis adds 400 ms (2%) to the -O2 self-compile, and a small
program grows by about 36 bytes. The rewrite runs at `-O2`;
`ZENA_PROPAGATE=0` turns it off.

Until two inliner bugs it exposed were fixed
([#536](https://github.com/elematic/zena/pull/536)), the rewrite made
the compiler 0.55% larger and every small program 465 bytes larger, and
on an earlier revision it did not make the compiler faster at all. Both
are below, as is the work the measurements point to that does not need
the analysis.

All numbers are for `zena/cli/main.zena`, the standalone compiler,
built at `-O2` on one machine, except where a section names an earlier
revision.

## What the module loop leaves

`ZENA_ZIR_STATS=1` prints a census (`ir/census.zena`) of the module just
before emission:

| `call_ref` sites left | 830 |
| --------------------- | --- |
| class dispatch        | 194 |
| interface dispatch    | 414 |
| closure calls         | 222 |

For each dispatch site the census also counts how many functions the
module's vtable globals install in the site's slot:

| Implementations of the slot | 1   | 2   | 3   | 4   | 5–8 | 9+  |
| --------------------------- | --- | --- | --- | --- | --- | --- |
| class dispatch sites        | 0   | 86  | 0   | 6   | 0   | 102 |
| interface dispatch sites    | 8   | 344 | 9   | 0   | 16  | 37  |

The second rule above catches nearly every site whose slot has one
implementation; the census does not record why 8 interface sites with
one implementation are left. Discovery builds 2,463 class-interface vtables and
6,481 interface trampolines; 106 and 756 survive harvest. The census
found no interface type test on a value not statically typed as that
interface, so #421's other proposed consumer, type tests, has nothing
to work on in this program.

## The analysis

The graph has a node per instruction of every reached body, per field,
per array type's elements, per global, per function result and per
mutable variable. A field node is keyed by the struct that declares the
field, so a subclass's instances share their superclass's field nodes.
Edges follow every flow ZIR names: branch arguments into block
parameters, call arguments into the callee's parameters and its results
back, stores into fields, array elements, globals and variables and the
loads out of them, and casts.

The sets hold **atoms** of three kinds: a struct type that some
`struct_new` allocates (a class instance, a closure, a closure's
context), a vtable global, and a function that some `ref_func` names.
Three loads are resolved through the atoms reaching their operand
rather than through a field node:

- `<vtable>` of an object yields its class's vtable global.
- A slot of a vtable global yields the function the global installs
  there.
- Unpacking a fat pointer yields the class-interface vtable global or
  the instance it was packed from.

When a `call_ref`'s callee set gains a function, the analysis adds that
function's argument and result edges and marks the function reached, so
the call graph and the sets reach a fixpoint together. A function only
a vtable installs is not reached until some reached dispatch loads it
from the vtable.

Values from outside the program are **top**: the parameters of an
exported function, an import's results, `any_convert_extern`, an
imported global, and the parameters of any function whose reference is
handed to the host. So is the result of any instruction the analysis
does not model. A site resolves only when its callee's set is one
function and not top.

The analysis assumes that every flow passes through an instruction it
models, with two exceptions it adds edges for. A struct value can be
used as its supertype with no instruction in between, which sharing
field nodes along the subtype chain covers. An immutable array is
likewise read through its declared supertype array
(`WasmArray.superArray`), so each array type's element node flows into
its supertype's. Thrown values travel through the exception global,
which is an ordinary `global_set` and `global_get`; a handler parameter
that no branch argument fills is top.

On the self-compile the graph has 559,000 nodes and 2,653 atoms, and
building and solving it takes 400 ms of a 19.9 s compile.

## Results

For the `call_ref` sites in reached functions:

| Callee set reaches | one function | several | something from outside | nothing |
| ------------------ | ------------ | ------- | ---------------------- | ------- |
| class dispatch     | 81           | 111     | 0                      | 0       |
| interface dispatch | 102          | 312     | 0                      | 0       |
| closure calls      | 31           | 166     | 0                      | 0       |

The 27 other sites are in 538 functions nothing reaches.

### Making the resolved sites direct

The module loop runs the analysis once after its rounds and before
loop-invariant code motion, rewrites each resolved site to a direct
call, and runs two more rounds so the new direct calls can be inlined.
At that point the rewrite finds 1,631 sites, because the rounds stop at
their cap before the harvest rounds after them make most of those
direct anyway. What it changes is what reaches emission: 617 `call_ref`
sites instead of 830.

Three checks find the rewrite correct:

- The fixpoint test (`npm test`) builds the compiler at `-O2` with the
  rewrite and requires stage B and stage C to be identical.
- The execution suite at `-O2` passes everything that passes at `-O2`
  without the rewrite. Five tests fail at `-O2` either way
  ([#526](https://github.com/elematic/zena/issues/526)). The suite
  normally compiles at `-O1`; this runs it at `-O2`:

  ```sh
  ZENA_TEST_OPT_LEVEL=2 npm run test:execution -w @zena-lang/zena-compiler
  ```

- `zena/test/type-propagation_test.zena` checks a dispatch that only
  the analysis can resolve: one class reaches a field and the other
  class an array.

The compiler is 2,151,666 bytes without the rewrite and 2,151,076 with
it. The 23 benchmark workloads grow by 17 to 49 bytes, 36 on average.
In each of them the rewrite makes one site direct: the call to the
stack-trace hook in `captureStackTrace`, which only the host's capture
function ever fills. `captureStackTrace` is then small enough to inline
into the three functions that call it. `poly-param`'s seven
dispatch sites stay indirect, because both array classes really do
reach them.

The compiler built with the rewrite compiles faster. Under wasmtime,
the `-O1` self-compile, mean of four runs:

| Compiler built    | Without the rewrite | With it |
| ----------------- | ------------------- | ------- |
| before #536       | 12.65 s             | 12.47 s |
| with #536's fixes | 12.73 s             | 11.79 s |

Under V8, the `js`-target build compiling the language service
(`scripts/heap-snapshot.mjs clocks`), mean of four runs:

| Compiler built    | Without the rewrite | With it  |
| ----------------- | ------------------- | -------- |
| before #536       | 6,663 ms            | 6,655 ms |
| with #536's fixes | 6,599 ms            | 6,555 ms |

Wasmtime shows more than V8, and wasmtime's timings move by up to 2 s
with the placement of type indices (its subtype-check cache), so its 7%
is an upper bound. That placement does not explain all of it: before
#536, a second pair of compilers with an extra struct type at index 312,
which shifts every later index, was faster with the rewrite in every
run, by the same 1.5% as the first pair. V8 inlines a `call_ref`'s
target from run-time feedback and wasmtime does not, which may be why
direct calls matter more there.

### Two inliner bugs

Before #536, the rewrite made every benchmark workload 465 bytes larger
and the compiler 0.55% larger. Making the hook call in
`captureStackTrace` direct let `captureStackTrace` fall under the
inliner's limit for small bodies, so it was copied into every
`new Error(...)`, and two inliner rules then made those copies
expensive:

- The inliner inlined into blocks that end in `throw`, which run only
  on the way out by an exception. Now it leaves them alone.
- A callee with control flow is inlined at its only call site because
  its body moves there. The site counts were taken once per sweep, so
  when a callee with several sites was copied, the calls the copies
  carried still counted as one site each, and the functions they named
  were inlined into every copy. Splicing a callee with several sites now
  adds a site for each call it copies.

### An earlier revision

On 6907294e, before main gained unboxed iterator steps and the inliner
fixes above, the analysis resolved 167 of 778 sites, 54 of them
interface dispatch where it now resolves 102. Making them direct made
no measurable difference: 11.35 s with the rewrite against 11.36 s
without, mean of three.

On that revision a compiler was also built with the WAT output path
removed. That leaves `BinaryEmitter` the only `WasmEmitter`, so the
existing rule makes all 306 emitter dispatch sites direct; together they
run once per emitted instruction. The emit phase went from 2,283 ms to
2,262 ms.

### The sites with several targets

Of the 586 sites with several targets on that revision, 347 had two.
306 of those call the `WasmEmitter` interface, which the CLI implements
twice and picks at run time. Most of the rest are AST getters such as
`Expression.get#loc`, with 20 to 102 targets, and 164 are closure calls
inside shared higher-order functions such as `GrowableArray.some` and
`HashMap.forEach`. Telling one caller's closure from another's needs a
context-sensitive analysis, or a clone of the higher-order function per
closure, which inlining already provides for the small ones. The
emitter measurement bounds a speculative dispatch, a `br_on_cast`
ladder over a site's few targets (docs/design/optimization-pipeline.md):
making all 306 emitter sites direct with no test at all saved under 1%.

### Functions nothing reaches

Harvest keeps every function a live vtable global installs. The
analysis finds 538 of them, with 4,652 instructions, that no reached
dispatch can load. 518 of those are installed only in slots that no
reached body reads at all. For example, every call to `some` on an
`Array<Type>` was devirtualized and inlined, so the slot's trampoline
and `GrowableArray<Type>.some` behind it remain only because the vtable
global names them. Deleting the vtable slots no body reads after the
module loop, the way `ir/deadfields.zena` deletes unread class fields,
would remove these 518 without this analysis. In `minimal` the same
count is 9 functions.

### Interface-typed fields

50 fields of an interface type survive in the self-compile. One class
reaches 46 of them and two classes reach the other 4. The 46 include
the type model's lists (`ClassType.typeArguments`,
`FunctionType.parameters`, `UnionType.types` and their relatives), which
only ever hold a `GrowableArray<Type>`. Such a field could hold the
instance and save the 32-byte fat pointer allocated per store, plus an
indirect call per use.

docs/design/compiler-memory.md ("Classes over interfaces") bounds the
gain. After the compiler's own annotations were narrowed to classes,
the `-O1` compile still made 0.8M fat pointers, about 25 MB of its
3.30 GiB, at its public boundaries and in these lists. That document
keeps the lists interface-typed because they "are assigned from many
sources"; in this build every one of those sources assigns a
`GrowableArray`.

## Decision and next steps

The rewrite runs at `-O2`. It costs 2% of an -O2 compile and about 36
bytes per small program, and the compiler it builds is the same size
and faster under both engines. `ZENA_ZIR_STATS=1` prints what the
analysis resolves, so the numbers above can be re-measured as the
optimizer and the compiler's source change.

Work the measurements point to that does not need the analysis:

1. Delete vtable slots that no body reads after the module loop. This
   is a size change that needs only a scan for slot loads.
2. Fix [#526](https://github.com/elematic/zena/issues/526) and run the
   execution suite at `-O2` in CI, where nothing exercises the module
   loop on small programs today.

And for the analysis itself: a benchmark pair for a class with an
interface-typed field, written by a user who did not follow the
compiler's own rule of annotating with classes, would show whether
holding the instance in such a field is worth building.
