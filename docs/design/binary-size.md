# Binary size of a minimal program

**Status**: **33,875 → 37 bytes — byte-identical to the hand-written
ideal — and the keystone is in** (section 11): hello-string 7,270 →
**532**, array-sum 11,967 → **217**, after sections 12–14 (signature
contexts, string-boundary directions, equality by evidence,
constructors by demand) and section 17 (a for-in over an array roots
no iterator protocol). `zena build <file> -o out.wat` dumps any
program's emitted WAT; minimal, hello-string and array-sum are
WAT-snapshot tested. The name
section is gated, the extension-class leak is closed, template helpers
are rooted from the templates that need them, the type section is
computed rather than accumulated, RTA roots only the entry unit,
`String` is instantiated by evidence rather than unconditionally
(section 7), the type section is rooted on evidence rather than
declaration (section 8), and a function DECLARATION's type is a
signature, not a value (section 9). `return 42` is exactly one
signature, one function, one export — snapshot-tested as WAT
(`minimal_program.snap`). The remaining structural work is the
keystone (vtable slot pruning + force-reach removal), which is what
`hello-string.zena`'s budget tracks.

The reference program throughout is the smallest thing Zena can
compile:

```zena
export function main(): i32 { return 42; }
```

`docs/design/dead-code-elimination.md` records this at 175 bytes under
the (now deleted) TypeScript bootstrap. Today, on the self-hosted
compiler, it is **33,875 bytes** — with 227 functions and 60 wasm
types, none of which `return 42` needs.

This document records where those bytes come from, measured rather
than guessed, and what has to change.

## Measured breakdown

`wasm-tools objdump` on the 33,875-byte module:

| section         |  bytes | count |
| --------------- | -----: | ----: |
| custom `"name"` |  9,873 |       |
| code            | 17,485 |   227 |
| types           |  4,854 |    60 |
| globals         |    730 |    39 |
| elements        |    269 |       |
| everything else |    664 |       |

Two things dominate: a name section nothing asked for, and 227
functions reached by a program with no calls in it.

## 1. The name section was unconditional (fixed)

`BinaryEmitter.emitModuleEnd` wrote the `name` custom section on every
compile. Nothing gated it — 29% of the module was debug metadata, and
there was no way to turn it off. `AGENTS.md` and
`packages/zena-compiler/zena/lib/codegen/ir/CONTEXT.md` both already
documented `-g` as the flag that "emits a WASM name section with
readable function names"; `-g` in fact only reached wasmtime's engine
config (inlining) and never the compiler.

Now `BinaryGenerator`/`BinaryEmitter` take `debugNames`, defaulting to
off, and `-g` turns it on. `33,875 → 23,994` bytes; `-g` reproduces the
old bytes exactly.

`-g` reaches the compiler as the env var `ZENA_DEBUG_NAMES` rather than
an argv flag, because the checked-in bootstrap predates the flag and
its arg loop would read an unknown `-g` as the input filename. An
unknown env var it simply ignores. `debug` already keys the compile
cache, so the two variants do not thrash one cache entry.

Artifacts that are debugged rather than shipped keep their names
explicitly: `build:self-hosted`, `check-fixpoint`, `build-wasi-tests`
and the portable-execution runner all pass `-g`. `backtrace_test.zena`
asserts on symbolized frames and is the test that fails if that is
dropped. Published artifacts (`api.wasm`, `lsp.wasm`) take the new
default and get smaller.

## 2. Reachability: 227 functions for `return 42`

The remaining 24KB is the real problem. What is actually in it:

- every `String` method — `split`, `startsWith`, `endsWith`,
  `contains`, `asciiLowerCase`, `asciiUpperCase`, `+`, `==`, `hashCode`
  … (21 functions), for a program with no strings
- `FixedArray` and `ImmutableArray` specialized at **four** element
  types — `u8`, `String`, `anyref`, and
  `union_MapEntry<anyref,anyref>|null` — 28 methods each per element
  type, plus an `ArrayIterator` and a set of `Iterable`/`Iterator`
  trampolines for each
- `WasiConsole` with `log`/`error`/`warn`/`info`/`debug`
- the whole number-formatting family: `i32ToString`, `u32ToString`,
  `i64ToString`, `u64ToString`, `f32ToString`, `f64ToString`,
  `boolToString`, `floatToStringImpl`, `pow10f`
- 7 function-value wrappers (`writeI32_valwrapper_$i32$arr_u8$i32`,
  `floatToStringImpl_valwrapper_$f64$i32`, …) for stdlib functions
  never used as values

Note `union_MapEntry<anyref,anyref>|null`: that is `HashMap`'s bucket
element type. A program that never mentions a map pays for two full
array specializations over the map's internal entry type.

### How it was traced

RTA was instrumented to record a parent edge for every
`queueReferrer`, every `markFunctionReached`, and every
`instantiateClassType`, tagged with the phase of `run()` that was
executing. Reconstructing the tree gives the chain directly. The
instrumentation is not checked in; the patch is small enough to
recreate from this description if it is needed again.

The phase tally is the whole story:

```
FN reached by phase          INST (class instantiations) by phase
  90  Pass 1.05 (structVT)     6  Pass 1.05 (structVT)
  44  layout pass 2            4  queue traversal
  16  Pass 1.15                2  checkable traversal
   4  init
   2  layout pass 3
```

and by force-reach site, 148 of the 226 non-`main` functions come from
one line.

### 2a. `isExtension` is treated as "instantiated"

`FixedArray<T>` and `ImmutableArray<T>` are declared
`extension class ... on array<T>`. An extension class has no
`struct.new` — its representation _is_ the underlying `array<T>` — so
"instantiated" is not a meaningful state for one. Two places treat it
as one anyway:

- `reachability/visitor.zena`, `discoverType`'s `ClassType` arm:
  `if (isRtaActive && (instantiatedClasses.has(lookupId) || ct.isExtension))
→ instantiateClassType(ct)`
- `reachability/specialization.zena`, `registerClassMethod`:
  `if (!isGenericTemplate && (hasInst || cType.isExtension))
→ #reachRegisteredMethod(func)`

So **mentioning** the type `FixedArray<X>` anywhere — as a field type,
a return type, a signature component — instantiates it, and
instantiating it reaches all 18 of its methods for that `X`.

### 2b. Instantiating a class reaches _every_ method of it

`registerClassMethod` force-reaches whatever it registers as soon as
`hasInst` is true, whether or not the method is ever called. This is
what turns "`String` is instantiated" into 21 emitted `String` methods.

It is not gratuitous: the class vtable global is a `struct.new` over
one `ref.func` per slot, so every slot in the vtable must be a real
emitted function. 24 of the 39 globals in the module are exactly these
vtables. The fix is therefore not "reach fewer methods" on its own —
it is to keep unreferenced selectors out of the vtable in the first
place, which is a whole-program decision RTA is the right place to
make.

### 2c. Pass 1.05 populates classes that were only _discovered_

`ReachabilityAnalysis.run`'s "Pass 1.05" walks every entry in
`wasm.classInfos` and calls `populateClassStructAndMethods`. At that
point `classInfos` holds 27 classes of which **20 were never
instantiated** — `HashMap`, `MapEntry`, `HashMapEntryIterator`,
`HashMapKeyIterator`, `GrowableArrayIterator`, `Box`, the four `Range`
classes, the error hierarchy, …

Registering their methods lowers their signature and field types,
which mints fresh concrete specializations, which (via 2a) are
instantiated, which (via 2b) reach all their methods. The blame tree
shows this exactly:

```
<structVT:String_s247>              -> FixedArray_s186_String_s247
<structVT:String_s247>              -> ImmutableArray_s109_String_s247
<structVT:ImmutableArray_s109>      -> ImmutableArray_s109_anyref
<structVT:ImmutableArray_s109>      -> FixedArray_s186_anyref
<structVT:HashMapEntryIterator_s418> -> FixedArray_s186_union_MapEntry_s414_anyref_anyref_null
<structVT:HashMapEntryIterator_s418> -> ImmutableArray_s109_union_MapEntry_s414_anyref_anyref_null
```

`HashMapEntryIterator` — a class this program cannot reach — is what
pays for the two `MapEntry` array specializations.

Simply skipping non-instantiated classes in Pass 1.05 does **not**
work: a discovered-only class still needs its struct _fields_ laid out
(its type can appear in a signature even with no value of it), and the
pass does layout and method registration together. Tried; it breaks the
self-compile with `member not found @FixedArray_…[]$BoundedRange`. The
two responsibilities have to be separated first.

## 3. Removing the extension rule (fixed)

Dropping `|| ct.isExtension` from both sites in 2a, plus the three
gaps it was masking:

|                   |   before |      after |
| ----------------- | -------: | ---------: |
| total (names off) |   23,994 | **15,328** |
| functions         |      227 |         99 |
| code              |   17,485 |     10,453 |
| types             |    4,854 |      4,258 |
| globals           | 730 (39) |   168 (18) |

Against the original 33,875-byte module that is a **55% cut**. All 470
execution tests pass and the fixpoint holds.

Removing the rule alone left 6 execution tests failing, in two
families, each a real gap the blanket force-reach was hiding:

### 3a. Registering a method is not the same as reaching it

`WasmModule.layout()` **rebuilds** `classMethodMap` from
`wasm.functions` — the list RTA has already pruned to reached
functions. So a method that is registered but never reached is erased
from the map before lowering looks it up, and lowering bails with
`method not found`. Registration is not a durable act; reaching is.

That is why `FixedArray<i32>.map_spec_i32` was registered (twice,
observably) and still not found. Two things follow:

- `registerInstantiations` — the walk taken when a function body has
  checker dependency records, which is the common case — had **no
  generic-method arm at all**. Only `discoverNodeTypes`, the full
  walk, called `instantiateGenericMethod`. The records are
  symbol-level: they name the method without its solved type
  arguments, so the specialized slot the call site looks up is never
  minted. This is the same disease as the string-literal and
  generic-instantiation arms already documented on that method —
  organ six. `registerGenericMethodUse` adds it.
- Both walks now `markFunctionReached` the specialization they
  instantiate, rather than only registering it.

### 3b. Class-interface vtables needed a fixpoint, not one pass

The class↔interface vtable global was allocated only for classes in
`instantiatedSpecializedClasses`. An extension class never enters that
set now, so `FixedArray<T>` lost the vtable its values genuinely
dispatch through. The gate is relaxed for extension classes;
`usedInterfaceAdaptations`, checked immediately below it, is the
honest signal — it is recorded from real pack sites and gates each
class-interface pair on its own.

That exposed an ordering bug that had always been latent: "Pass 2"
built these vtables **once**, and reaching an interface method's body
can instantiate further classes — `FixedArray<T>.[terator]` returns an
`ArrayIterator<T>` packed as `Iterator<T>` — which then need vtables
of their own. Classes instantiated by the final queue drain never got
one. Pass 2 and the drain now alternate to fixpoint; the pair set is
finite and only grows, so it terminates.

## What is left, and why

After the template fix, 80 functions remain — 21 `String` methods, 40
across four `FixedArray` specializations, 6 `WasiConsole`, and the
rest scaffolding. The blame tree at the 99-function point, which still
explains all of it:

```
R <phase:tInit>                    -> String_s247
C Csym:363  (zena:option `none`)   -> None_s353
C Csym:849  (zena:console `console`) -> WasiConsole_s837
R Rnode:1046@String_s247           -> FixedArray_s186_String_s247
R Rnode:1046@String_s247           -> FixedArray_s186_u8
R Rnode:1046@String_s247           -> FixedArray_s186_anyref
R Rnode:1046@String_s247           -> FixedArray_s186_union_MapEntry_s414_anyref_anyref_null
```

Only **seven** instantiations now, and they explain everything left:

1. **`String` is instantiated unconditionally** (`analysis.zena`, the
   `wasm.stringClass != null` block in `run`'s init phase). Every
   program pays for `String` and, through 2b, for all ~21 of its
   methods — `split`, `startsWith`, `asciiLowerCase`, … — whether or
   not it has a string in it.
2. **One instantiation of a generic instantiates all its known
   siblings.** `instantiateClassType` marks `instantiatedClasses` by
   the _generic's_ symbol id and then instantiates every entry in
   `specializedClassTypes` for it; `discoverType` gates on that same
   per-generic flag. So `FixedArray<u8>`, genuinely needed by
   `String`, drags in `FixedArray<String>`, `FixedArray<anyref>` and
   `FixedArray<MapEntry|null>` — three specializations nothing uses,
   at ~10 methods each.

   Making this per-specialization is the correct RTA and is where the
   next big cut is. Removing only the sibling loop is not enough
   (15,328 → 15,134) because `discoverType`'s per-generic gate
   re-instantiates each specialization as it is discovered; removing
   both breaks the self-compile, for the same class of reason as 3a —
   uses that currently rely on the over-approximation have to reach
   their own specialization first. Measured and reverted.

3. **`WasiConsole` and `None`** are instantiated from _checkable_
   traversals of stdlib globals (`console`, `none`). A checkable
   traversal is supposed to discover types without reaching code;
   `instantiateClassType` is not phase-gated, so it reaches.

## 4. The type section was accumulated, not computed (fixed)

`markTypeReached` runs throughout discovery and appends to
`emittedTypes`, and `wasm.types` is set from that list at the end. So
the type section was _everything any pass ever looked at_ — for
`return 42`, 59 types and 4,204 of 11,530 bytes, mostly interface
member signatures reached through the vtable structs of interfaces the
program never mentions.

It is now recomputed: the set is cleared at the start of the final
layout pass and re-rooted from what the emitted module can actually
reference — reached function signatures and their context structs,
tags, imports, globals and their vtable inits, class structs that
codegen knows about, record/adapted dispatches, closure structs, try
cells, boxed tuples and records, and the interfaces something is
genuinely packed into. `closeReachedTypes` takes it from there.

|                 |     before |      after |
| --------------- | ---------: | ---------: |
| minimal         |     11,530 | **10,457** |
| array-sum       |     16,790 | **15,947** |
| types (minimal) | 4,204 (59) | 3,400 (50) |

This one is safe to make aggressively: a type that is genuinely needed
and missing is a wasm validation failure at compile time, not a silent
miscompile. Getting it right meant naming the categories that lowering
references without any signature mentioning them — five of them, each
found by a distinct loud failure, and each now an explicit root with a
comment saying why.

The snapshot churn is type renumbering only; function and global
counts are identical in every snapshot.

## 5. RTA now roots only the entry unit (fixed)

The loop labelled "RTA Roots" queued **every global of every unit** —
the whole stdlib — as a referrer, reachable for `main` and the entry
unit's exports and checkable for everything else. That is not a root
set; it is a whole-program walk, and a checkable walk still
instantiates (see below).

A library unit's globals are now roots only when something reaches
them.

|                 |     before |      after |
| --------------- | ---------: | ---------: |
| minimal         |     10,457 |  **8,540** |
| array-sum       |     15,947 | **13,928** |
| types (minimal) | 3,400 (50) | 2,760 (29) |

`return 42` now has **no imports, no memory, no data section and no
start function** — 66 functions, all `String` and `FixedArray`, and
nothing else.

Three things had been leaning on the whole-program walk, each a real
bug once it was gone:

- `zena:async.drainMicrotasks` is resolved by name from the async ramp
  (`getStdlibFunc`), so nothing rooted it. Rooted from the async
  function that implies it — the same treatment template helpers got.
- `import * as ns` built its namespace object from
  `wasm.functionMap`, which is only populated for globals something
  discovered. The import itself now roots every export it names.
- a namespace-import global is initialized in `__start`, but carries
  no `initExpr` to say so, so `needsStartFunction` missed it. It had a
  start function for free as long as _some_ stdlib global had a
  non-literal initializer. Without one the object stayed null and
  calling through it trapped.

The last one is the shape to watch for: the whole-program walk was
holding up correctness in places nothing had noticed, because
something incidental was always true.

Two snapshots lose two functions each — synthesized record-dispatch
getters for a dispatch that only existed because the stdlib was being
walked. Imports and every other function are unchanged.

## 6. Instantiation is closed, and layout runs to a fixpoint (fixed)

Struct layout (Pass 1.05) ran **once**, over whatever was in
`classInfos` at that moment. But populating a class registers its
methods, and that instantiates further classes; so did the
class-interface vtable pass and the final queue drains, both of which
run _after_ layout. A class first instantiated in any of those never
got its struct populated, and carried an empty layout into codegen.

Nothing detected that. It surfaced much later and somewhere else —
`string helper synthesis: $stringCreate layout`, `zir unsupported:
operator dispatch` — with nothing pointing back at the instantiation
that caused it. Every attempt in this document to make reachability
more precise eventually hit one of those, from a different direction
each time, because the over-approximations were what kept the ordering
from mattering.

Now:

- **layout runs to a fixpoint** — `#layoutClassStructs` repeats until
  no class is left unpopulated, since populating one can create
  another;
- it runs **again** once discovery has fully settled, catching
  anything the vtable pass or the final drain instantiated;
- and then **instantiation is closed**: `instantiateClassType` throws
  `class instantiated after layout began: <key>` for a class that has
  never been instantiated before.

Size is unchanged — this is an invariant, not an optimisation. What it
buys is that the next attempt at the String root fails _at the
instantiation that is wrong_, naming the class, instead of somewhere
downstream in scaffold synthesis.

A specialization's concrete class type arguments are also instantiated
with it, which the same work exposed: if `FixedArray<String>` exists
then String values exist and its `contains` lowers to String's `==`.
That held by accident while String was instantiated unconditionally.

### Catching up is not only missing structs: erased field bakes

The fixpoint surfaced a second ordering hole, found by CI on the
wit-parser example and not by the compiler suite. When a struct is
laid out, a field whose class type has no registration yet is baked as
the `structref` fallback (`typeToValType`'s ClassType miss). Before
this change that was self-consistent: the class stayed unregistered,
every use of it went through the generic template's equally-erased
signatures, and the module was uniformly imprecise but valid.

The layout fixpoint populates more classes during Pass 1.05, each
population queues more referrers, and a body that used to be walked in
the _RTA-inactive_ final drain — where `instantiateClassType` no-ops —
now gets walked while RTA is still active. `JsonBuilder`'s constructor
(`new Array<i32>()`) is exactly that: `Array<i32>` becomes properly
instantiated _after_ `JsonBuilder`'s struct baked `#stack` as
`structref`, its `pop` gets a precise `ref null Array<i32>` receiver,
and lowering fails receiver conformance —
`zir unsupported: method receiver type` — half a compiler away from
the bake that caused it.

So the settle step re-resolves as well as re-populates: every field
baked `structref` for a class-typed member is recorded
(`ErasedFieldBake`), and once discovery settles,
`refreshErasedFieldTypes` recomputes each one against the final
registrations, in place. In place matters: inherited fields are shared
`WasmField` instances between super- and subclass structs, and both
must see the write. A field whose class still has no registration
stays erased, which is the old consistent behavior. Byte-for-byte
size-neutral on both fixtures.

## 7. The String root is out (fixed)

`return 42` was 8,540 bytes and 66 functions, and all of it hung off
one root: RTA instantiated `String` unconditionally at init, and
created and reached the four `$string*` host-interop helpers
unconditionally — their bodies synthesized against String's struct
layout, so they required the class in turn. String's 21 methods
mention `FixedArray`, which brought four specializations. That was
the whole 66.

Now instantiation follows evidence:

- **A string literal instantiates String** where the literal is
  registered (`noteStringLiteral`) — every literal walk passes through
  there, on either walk kind. A constructor call reaches it through
  the normal graph, as any class. And **an entry-unit export whose
  type mentions String** (`#typeMentionsString` — params, returns,
  unions, tuples, records, type arguments) instantiates it too: the
  host is entitled to build a String with `$stringCreate` and hand it
  in, even if the guest never constructs one
  (`export let identity = (s: String) => s;` — the runtime's
  string-writer tests are exactly this shape). **Exception infra is
  String evidence too** (`noteExceptionInfra`):
  `ensureExceptionInfra` creates `$stringCreate`/`$stringSetByte` for
  the host to build a String through — a created-but-unreached helper
  is a dangling export, function index -1, an invalid module
  (`default_param_try_expr.zena` found this) — and their bodies are
  synthesized against String's layout and vtable. Making exception
  paths not imply host String construction is a possible future
  refinement. The unconditional init-time instantiation is gone.
- **The `$string*` helpers follow the verdict**:
  `ensureAllHelperFunctionsReached` creates and reaches them only when
  `String` is in `instantiatedSpecializedClasses`, recording the
  verdict as `wasm.stringClassIsInstantiated` for the module
  generator, whose own late `ensureStringHelpers` call follows it too.
  ("Does String's struct have fields" is no signal anymore — layout
  populates every declared class's struct whether or not a value can
  exist.)
- **The class-interface vtable pass no longer walks every declared
  class** — only classes codegen has state for. The declared-class
  walk was what instantiated `FixedArray` at four element types for a
  program that mentions none of them; `usedInterfaceAdaptations` is
  only ever recorded against discovered classes, so the walk found
  nothing the classInfos walk does not.

Two catch-up gaps surfaced, both of the same shape section 6 fixed for
structs — state built once, invalidated by late instantiation:

- **The erased-field bake** (section 6a): `JsonBuilder`-style structs
  baked `structref` for a field of a class a later walk then
  instantiated. Fixed by `refreshErasedFieldTypes` at the settle
  point; found by CI's wit-parser example before this change landed.
- **String's class vtable global**: `$stringCreate` is synthesized
  against it, and a literal surfacing in a body walked late (array
  bounds messages, in `array-sum`) instantiates String after Pass 1.5
  has run. The settle point re-runs Pass 1.5 **for String alone**.
  Other late-instantiated classes deliberately get no vtable global:
  nothing dispatches through one (they never had one before either),
  and building them for all late classes cost `array-sum` 13
  functions and 9 globals — measured and reverted to the targeted
  form.

|           | before |      after |
| --------- | -----: | ---------: |
| minimal   |  8,540 |  **2,292** |
| array-sum | 13,928 | **13,504** |

`minimal` is one function (`main`, 8 bytes of code), one export, no
imports, no memory, no data, no start function.

## 8. The type section is rooted on evidence (fixed)

After section 7, `return 42` was 2,292 bytes of which 2,257 were type
section — 218 individual types (134 class/vtable structs, ~74
signatures, 4 arrays) for a program that needs one. Each came from a
wholesale root in the final type-rooting walk:

- **every `classInfos` entry's struct + vtable struct** — and
  `classInfos` holds every _declared_ class, because init pre-registers
  them all for circular-definition handling;
- **every closure struct ever interned** — each dragging its impl
  signature through its `func` field (that was most of the 74);
- **every anonymous boxed-tuple struct**, minted by `discoverType`
  for every tuple type _any_ walk sees.

(Record-dispatch triples stay wholesale for now — deliberately.
`getRecordDispatch` pushes the dispatch's vtable global
unconditionally, the final globals walk force-reaches its getters, and
the getters' bodies `struct.get` the concrete type, so gating only the
TYPES yields an emitted getter referencing an unemitted struct.
Pruning unused dispatch globals is the prerequisite, and its own
change.)

Each of the rest is now gated on evidence, with a named set recorded
during traversal: `reachablyNamedClasses`, `reachablyNamedClosures`,
`reachablyNamedAnonStructs` — "instantiated, or named by reached
code". Getting the recording gate right was the whole job, in three
steps:

1. `currentReachable` alone is worthless: it is ambient state, and the
   init import loops and the layout passes run with whatever the last
   referrer left behind (usually `true`). Recording on it captured
   roughly everything declared. **Evidence is only collected while a
   queue referrer is actually being processed** (`inQueueWalk`), the
   one place the flag is set per-referrer. This is a lite version of
   plan step 0b, and the first piece of it to land.
2. The dependency-record fast path skips the full node-type walk, so
   **cast targets, local binding types, boxed tuple/record literals,
   and class patterns** — types a body names with no signature or
   record naming them — were invisible (organ seven of that walk's
   disease). `registerInstantiations` now discovers all four. And the
   recording happens BEFORE `discoverType`'s dedup
   (`#recordTypeEvidence`): a type first discovered by a plumbing walk
   early-returns on its later in-queue discovery, so recording inside
   the arms never saw it. Composite resolution (closure interning,
   tuple struct lookup) is deferred to the settle point, where every
   nested dispatch exists.
3. Two loweringtime syntheses reference Box structs no AST names: the
   **unboxing cast** (`(erased as f64)` → ref.cast to `Box<f64>`) and
   the **erased-`==` diamond**, which ref_tests every
   registered-and-shaped `Box<prim>`. The cast is mirrored at RTA time
   (`noteUnboxCast`); registered Box specializations are kept
   wholesale — bounded at the five primitive boxes.

|              | before |                         after |
| ------------ | -----: | ----------------------------: |
| minimal      |  2,292 | **53** (→ 39 after section 9) |
| hello-string |      — |               7,392 (→ 7,354) |
| array-sum    | 13,504 |                    **12,169** |

The failures this cut surfaced were all the loud kind — `Invalid
WasmType index < 0` naming the struct — exactly the failure mode
section 4 chose this design for.

## 9. A declaration's type is a signature, not a value (fixed)

53 bytes still carried one stray closure-struct pair (an erased impl
signature + `{func, ctx}` struct), minted for `main`'s own function
type. Three separate paths treated a `function` DECLARATION's type as
a value position, each minting the pair for every declared function
whether or not it is ever used as a value:

- `discoverFunctionDeclaration` routed the declared type through
  `discoverType` (the value path) instead of `discoverSignatureType`;
- the full node walk discovered the declaration's own nodes — the
  name identifier and the FunctionExpression — whose node types are
  the function type (now gated on the parent being a
  FunctionDeclaration);
- the checker's `referencedTypes` records include a callee's function
  type for a plain CALL, and `traverseDependencies` discovered every
  one as a value. Function-typed records now go through
  `discoverSignatureType`; genuine value uses are covered by the
  wrapper registration beside it and by arrows in value position,
  which mint the closure struct at the use site.

```
export function main(): i32 { return 42; }   →   39 bytes

(module
  (type (;0;) (func (result i32)))
  (export "main" (func $main))
  (func $main (type 0)
    i32.const 42
    return
    unreachable))
```

One signature, one function, one export — 4.5× smaller than the
deleted TypeScript bootstrap's 175 bytes. Snapshot-tested as WAT
(`minimal_program.snap` in binary-size_test.zena): the module is small
enough to read whole, so a regression shows up as the exact
type/function/export it added, not just a byte count. hello-string
also dropped 7,392 → 7,354 (dead value-pairs for stdlib function
declarations).

## 10. Fall-through returns (fixed)

The last two removable bytes were opcodes, not types: every body
ended `return` + `unreachable` — the explicit return, then the filler
the emitter appends because wasm validation resets to "reachable"
after each block `end`. (The TYPE cannot be elided: `(func (export
"main") (result i32) …)` is WAT sugar, and the binary format's
function section entry IS a type index — the hand-written ideal
assembles to the same one-entry type section.)

An outermost `return` — no open frames — is now emitted LAZILY: its
values are pushed and the opcode is written only if anything else
follows. If nothing does, both the `return` and the filler are
dropped, and the function falls through to its own `end` with the
results on the stack. Every emission path flushes the pending return
first, so a mid-function outermost return (a merge continuation
follows it) still emits.

```
export function main(): i32 { return 42; }   →   37 bytes

(module
  (type (;0;) (func (result i32)))
  (export "main" (func $main))
  (func $main (type 0)
    i32.const 42))
```

**Byte-identical to `wasm-tools parse` of the hand-written ideal.**
Every function's tail shrinks, not just minimal's: hello-string
7,354 → 7,270, array-sum 12,169 → 11,967, and the WAT snapshots lost
82 lines of nothing but trailing `return`/`unreachable`. One test had
been asserting its "impossible no-match path traps" against the tail
filler; it now asserts against an exhaustive sealed match, which has
a genuine mid-block trap.

## The ceiling, measured

A spike (branch `spike-entry-only-rta-roots`, **not landable** — 68 of
470 execution tests fail) settles what is actually achievable:

```
export function main(): i32 { return 42; }   ->  2,887 bytes, ONE function
```

`main`, 8 bytes of code, one export. No imports, no memory, no data
section, no start function. So nothing about wasm-GC, the language or
the prelude forces a five-figure module; the 11,530 bytes on `main` are
all reachability over-approximation.

Three changes get there, each answering a "why is this here at all":

| change                                                        | minimal | tests   |
| ------------------------------------------------------------- | ------: | ------- |
| baseline (PR #220)                                            |  11,530 | 470/470 |
| root only the entry unit                                      |   9,562 | 465/470 |
| + gate `String` and the `$string*` helpers on String existing |   2,887 | 402/470 |

And what remains at 2,887 is **2,852 bytes of type section** — 33
function-signature types for a function that needs one. They are
interface member signatures, rooted through the interface vtable
structs that Pass 0.8 populates for every declared interface in the
program.

### The 68 failures are all one shape

Every one is code the compiler **synthesizes and resolves by name
after RTA has finished**:

- `zena:async.drainMicrotasks`, via `getStdlibFunc` from the async ramp
- the `$string*` host-interop helpers, whose bodies are synthesized
  against String's struct layout
- namespace-import (`import * as ns`) members
- array extension machinery reached through `Pass 1.5`'s vtable slots

This is the same defect as the template helpers fixed in #219, and it
has a general form worth stating: **anything the backend looks up by
name is invisible to RTA, so it must be rooted explicitly by whatever
construct implies it.** Every such lookup is a latent
`function index < 0` or an invalid module the moment RTA gets more
precise. `getStdlibFunc` has four call sites; `classMethodMap` lookups
in lowering have many more.

Until that contract is closed, RTA cannot be made precise without
breaking codegen — which is exactly what the last three attempts in
this document ran into from different directions.

## Why `String` is in the module at all

It is worth stating plainly, because it is not a leak in the ordinary
sense. **RTA's root set is the whole program, not `main`'s closure.**

`ReachabilityAnalysis.run` has a loop labelled "RTA Roots" that walks
`program.units` — every stdlib module — and queues _every_ global
declaration in each one as a referrer. Only `main` and the entry
unit's exports are queued reachable; the rest are queued **checkable**.
Nothing is ever excluded.

A checkable traversal is meant to discover types without reaching
code. It does not hold to that:

- `instantiateClassType` is not phase-gated at all, so walking a
  checkable global instantiates whatever it constructs. That is
  `zena:console`'s `console = new WasiConsole(..)`, `zena:option`'s
  `none = new None()`, and a `zena:string-convert` body that builds a
  `String`.
- several walk-driven referrers hardcode `isReachable = true`
  regardless of the phase they are walking in — `queueExplicitCtor`,
  `queuePrivateMethod`, the plain-identifier-call arm, the
  tagged-template tag. So a `new X()` in code nothing reaches still
  reaches `X`'s constructor.

Instantiating `String` then reaches all 21 of its methods (2b), one of
which mentions `FixedArray<u8>`, and until recently that dragged in
every other discovered `FixedArray` specialization too. That is the
whole chain, and none of it starts from `main`.

### The blocker is that the phase is ambient state

The obvious fix — gate instantiation and those referrers on the
current phase — was built. It does not work, and the reason matters
more than the attempt:

`currentReachable` is a mutable field on the pass, set while a
referrer is being processed and simply _left there_ afterwards.
`ensureAllHelperFunctionsReached`, the layout passes and Pass 1.5 all
run outside queue processing, and read whatever the last referrer
happened to leave behind — usually `false`, since the checkable queue
drains last. Gating on it there silently disables rooting that the
module needs; the trivial program stopped compiling with a bare
`thrown Wasm exception` and 7 reached functions.

So the first move is not a gate. It is to stop representing the phase
as ambient mutable state: make it an explicit parameter of the
traversal (and of `instantiateClassType`), so that "am I reaching or
merely discovering?" is answerable at every call site instead of
depending on execution order. Everything else in this document —
phase-gating, the keystone, per-specialization instantiation — is
downstream of that.

## 11. The keystone landed

Sections below this one predate it and describe the earlier attempt
(kept for the measurements); this is what shipped.

**A vtable slot exists so something can dispatch through it.** A class
can be virtually dispatched only if a value of a supertype's static
type can hold it: it has a superclass, or something declared extends
it (`extendedClassSymbols`, built at init from every declaration,
sealed variants included). On a class with neither, every slot except
`==`/`hashCode` — which HashMap and generic equality dispatch through
the class vtable regardless of hierarchy — is dropped at slot
materialization. `String` went from 15 slots to 2; each dropped slot
un-forces an entire method.

**And the force-reach went with it**, as the old attempt said it must.
What replaced it:

- **Member referrers reach what they register** (concrete classes,
  reachable referrers) — registration alone is erased by `layout()`'s
  `classMethodMap` rebuild.
- **Constructors keep the force-reach.** Ctors are never
  vtable-dispatched but every `new` needs one.
- **Mixin-scoped private members kept it too, and no longer do.**
  `Scope::#name` members are lexically bound, and nothing named them,
  so every one of them was emitted for every host class that applied
  the mixin. They now get real referrers: a private name in a mixin
  body queues the member THAT mixin declares, selected by the
  accessing body's scope key rather than by a name-only search, on
  both the full walk and the dependency-record walk. On a fixture with
  one used and five dead mixin privates across three hosts, 1054 B →
  439 B. Production code sees no change — `IterableUtils` is the only
  mixin in the stdlib or compiler and it declares no privates — so
  this is a rule made principled and a floor for mixin-heavy code, not
  a win on today's binaries.

  Two things had to be true first. The lookup had to stop falling back
  to the host's same-named member, or a missing registration would be
  a silent wrong answer rather than a loud one (member-lookup.md §6);
  that landed separately. And the accessor arm of the referrer loop
  had to register under the SCOPED name — it registered the bare one,
  minting an unscoped twin with the host's signature, which made any
  mixin declaring a private accessor **with a setter** fail to compile
  outright, used or not. Only getter-only accessors were covered by a
  test, which is why nobody had hit it.

- **Pass 1.2 resolves synthesized accessors over every REGISTERED
  method**, not `wasm.functions` — an early-registered getter carries
  backing index -1 (an `unreachable` stub body) until fixed up, and
  membership in wasm.functions used to be equivalent to registration.
- **Symbol-level member deps are recorded against the generic**
  (`recordReachedClassMember` from `traverseDependencies`): the dep
  fan-out only queued for specializations that existed at traversal
  time, so a member dep walked before the receiver's specialization
  was instantiated queued nothing and the edge was lost
  (`JsonObject.size` reads its `OrderedMap`'s `size` before any
  OrderedMap exists).
- **Field accessors named before populate registers them** go on a
  pending list re-checked at the settle point (`var(#x) x` getters are
  created during layout, after the queues).
- **The member replay sets are insertion-ordered** (OrderedMap, not
  HashSet<i32>): their iteration order is now function emission order,
  and node ids are a relabelling across `invalidate()` — id-hash order
  made an unchanged file emit different bytes after an invalidate.

|              | before |                                                                                              after |
| ------------ | -----: | -------------------------------------------------------------------------------------------------: |
| minimal      |     37 |                                                                                                 37 |
| hello-string |  7,270 | **1,926** (14 functions: main, the literal machinery, the four `$string*`, `String.==`/`hashCode`) |
| array-sum    | 11,967 |                                                                                          **6,665** |

All four `FixedArray` specializations left hello-string entirely.
Budgets ratcheted to 37 / 2,000 / 6,700 here, then to 37 / 600 /
5,800 after sections 12–13.

## 12. Signature contexts do not mint value machinery (fixed)

Three paths treated SIGNATURES as value positions, each minting a
closure struct + erased impl signature pair per member:
`registerSpecializedInterface`'s member discovery (22 pairs from one
Iterable-family interface), function-typed PARAMETERS of
signature-routed types (`discoverSignatureType` now propagates the
signature context instead of value-routing components), and the
class-declaration walk's per-member types (method and accessor
definitions now signature-route, like `function` declarations in
section 9). Evidence recording also requires `currentReachable` again
— reaching paths all set the phase flag properly now, including
`#buildClassVTableGlobals`. hello-string 1,926 → 1,468.

## 13. String boundary directions, and equality by evidence

The four `$string*` helpers split by DIRECTION: writes
(`$stringCreate`/`$stringSetByte` — an export takes a String
parameter, a reached host import returns one, or exception infra
exists) and reads (`$stringGetByte`/`$stringGetLength` — an export
returns one, a host import takes one). `return "Hello World"` ships
only the read half.

And the `==`/`hashCode` slots — plus the entire equality/hash chain
they force (String.==, #regionEquals, both hash helpers: 633 bytes in
hello-string) — now follow `equalityDispatchUsed`, set by evidence
during traversal: an `==`/`!=` whose operand is ERASED (the equality
diamond dispatches slots on erased receivers), a case-class operand
(its synthesized == dispatches its fields' == through slots — flagged
at SIGHT, since the slot decisions bake at layout), or the `eq`/`hash`
intrinsics (which lower through the diamond). Concrete class operands
root their `==` operator DIRECTLY (`ir/operators.zena` resolves it by
name — `T == T` in a template body has no record naming the
specialization's operator), string-literal patterns root `String.==`
(both the `LiteralPattern` and bare-literal forms; `stringPatternEq`
resolves it by name), and synthesized case-class members — which have
no AST node to find — reach by MAP KEY through a deferred drain that
tolerates its own growth. hello-string 1,468 → **592**; array-sum →
5,784.

What remains in hello-string's 592 bytes: `main`, `__start`, the
literal machinery (`get_string_literal`, `string_from_shared`,
String's constructor), and the two read-side exports — plus ~330
bytes of type section. The next named cuts: record-dispatch GLOBALS
(section 8's caveat), and the literal machinery itself could
specialize for single-literal programs.

## 14. Constructors by demand

`string_from_shared` builds its String with `struct.new` directly —
yet every literal-only program shipped `String.<constructor>`, because
instantiation PROMOTED every registered ctor. And the promoted ctor's
reachable body walk was what dragged six dead class struct pairs
(`Encoding`, `ImmutableArray<u8>`, the ranges…) into the type section.

A ctor's evidence is a CONSTRUCTION SITE. `queueExplicitCtor` records
demand against the generic (and its super chain, for `: super(...)`)
and pends concrete keys for the settle drain; promotion and the
registration force-reach both gate on the demand set. The
construction sites, each found as a loud
`constructor missing for <class>` (the bail now names the class):

- `new` expressions — including resource `new`, whose node TYPE is
  the opaque wrapper (`Own<C>`), so the demand comes from the CALLEE's
  declared class;
- range literals (`1..5` shares `new`'s construction tail with no
  NewExpression);
- map literals already had their own rooting.

hello-string 592 → **532** (ctor gone, and with it the dead pairs);
array-sum → 5,635.

### Late equality evidence: repair, not luck

The `==`/`hashCode` slot decision bakes at each class's layout, but
equality evidence can legitimately arrive later — array-sum's for-in
machinery is walked in the vtable-fixpoint drains, after earlier
classes already pruned their slots. That worked only because the
specific pruned slots happened never to be dispatched. Now the pass
records which classes pruned (`noteEqSlotPruned`), and at the settle
point, if `equalityDispatchUsed` flipped after any pruning, it
REPAIRS: re-adds the two slot fields to every pruned class's vtable
struct, discards and rebuilds those classes' vtable globals, and
drains the newly reached slot methods (rebuilding per pruned key —
the all-classes builder would also create globals for
late-instantiated classes Pass 1.5 deliberately skipped). Array-sum's
5,625 → 5,635 is this repair being honest — those bytes are slots the
evidence says could be dispatched.

### Not yet: dead-field elimination

String's struct still carries `#encoding` and `#hashCode` — written
as zeros by `string_from_shared`, read by nothing in hello-string.
Eliminating dead FIELDS needs per-field access tracking and index
rebaking across every accessor, scaffold body, and host helper — a
separate pass, listed here so the two i32s stop looking like an
oversight.

## 15. An erasure is not a specialization

A type parameter lowers to `anyref`, so `Store<K, V>` named from inside
generic code is discovered as `Store<anyref, anyref>` — and that passes
`isConcrete`, because anyref is a type, and a real one (`let x: anyref =
"hi"`). RTA took the erasure for a real specialization: a fan-out target
for every reached member of the generic class, and, once instantiated, a
class with a vtable global. A vtable global is a `struct.new` over one
`ref.func` per slot, so an erased body of every method came with it, for
a class no value can ever have.

The dead bodies were the mild half. `hash`/`eq` dispatch on their
operand's type and have nothing to dispatch on at anyref, so a generic
class whose methods use those intrinsics could not be SUBCLASSED at all
— subclassing is what makes the base's slots dispatchable:

```
zir unsupported: eq operand type @Store_s868_anyref_anyref.matches
```

The mentions that fabricate an erasure are made by plumbing, not by code
that runs: `#linkSuperAndVT` naming a subclass template's supertype, and
the walk of a generic class's own template naming its field types.
Neither is evidence that a value exists, so neither instantiates now.

### The generic method behind it

That rule wants to be flat, and could not be at first: `Array<T>.map<R>`
is emitted with the METHOD's own parameter erased, and its `new Array<R>`
constructs an `Array<anyref>` that genuinely needs a constructor. Which
raises the question the fix turned on — who calls that body?

Nobody. In the compiler's own module, all **80** `Array<X>.map` bodies
were referenced by nothing: not called, not `ref.func`'d, not exported.
The one real `.map` call site in the compiler (`checker.zena:13531`)
resolves to `map_spec_Type`, minted per call site by
`registerGenericMethodUse`. A generic method has no single body — it has
one per specialization, each with its own signature — so it cannot hold
a class-vtable slot either, and the unspecialized registration is not a
function to reach. Both now say so.

That is also what `zir unsupported: method not found` was: the call site
looked for `identity_spec_i32` and found the erased body sitting in its
place. `classes/generic-method.zena` is unskipped, and a generic method
whose body uses `eq` on its own parameter compiles for the first time.

With no erased body left to construct one, an erasure is never
instantiated, and the rule is flat.

|                                    | before                     | after                          |
| ---------------------------------- | -------------------------- | ------------------------------ |
| `subclassed-generic.zena`          | 478 B                      | **400 B**                      |
| compiler's own module              | 3,241,046 B / 15,284 funcs | **3,219,326 B / 15,184 funcs** |
| minimal / hello-string / array-sum | 37 / 532 / 5,635           | unchanged                      |

What is left: 130 functions on erased classes remain in the compiler's
module, a closed island referenced only by each other — kept alive by
generic FUNCTION values, whose erasure is real code.

### Erasure has its own type now

The two things that had to be separated were separated by giving
erasure a type. `eraseTypeParameters` mapped a type parameter to
`AnyRefType`, and the specialization key spelled that, an unsubstituted
type parameter, and the REAL `anyref` type all "anyref" — so a
program's own `Cell<anyref>` and codegen's erasure of `Cell<T>` were one
class, one struct, one method set:

```zena
let stash = (v: anyref): Cell<anyref> => new Cell<anyref>(v);
let wrap = <T>(v: T): Cell<T> => new Cell<T>(v);
```

Three `Cell` specializations before, four now
(`Cell_s867_anyref` and `Cell_s867_erased` were the same one). See
`ErasedType` in `types.zena`: codegen-internal, lowering to anyref
because that IS a top-typed slot's representation, keyed "erased" so it
stops being mistaken for the type of the same shape.

That turns a guess into a fact. `containsErasedType` asks whether a type
IS an erasure; the version before it had to ask which walk produced a
mention. The two questions are now asked separately — a MENTION of an
erasure never instantiates, a CONSTRUCTION inside an emitted body does
and erases with it (`fill_spec_erased` runs `new Full<T>` as
`new Full<erased>`), and a template's body constructs nothing because it
is never emitted.

**Erasure is a boundary representation, not a substitute for
monomorphization, and cannot be one.** `Full<i32>` stores an i32 field
where `Full<erased>` stores a reference: the erased form is a different
struct, not a supertype. Values crossing the boundary are boxed, which
is why `roundtrip<i32>(42, 7)` comes back 42. The only erased bodies
that are not dead are the ones generic function VALUES need — one
funcref shape per generic function — and `tests/language/execution/
generics/erased-generic-chain.zena` pins that path.

### Tooling

`zena build <file> -o out.wat` emits the WAT text of exactly what the
binary build would contain (the extension picks the emitter; the
artifact caches like any build). `minimal_program.snap` and
`hello_string_program.snap` hold the two fixtures' full WAT — small
enough to read whole, so a regression names the exact
function/type/export it added.

## 16. Inherited methods are re-emitted per subclass

When RTA instantiates a concrete class, it registers a body for every
reached member under that class's key — including members declared on
an ancestor. This program:

```zena
class Base<T> {
  #node: Node<T> | null;
  #find(): Node<T> | null { return this.#node; }
  size(): i32 { ... }
}
final class Derived<T> extends Base<T> {}
// new Derived<i32>() ... d.size()
```

emits four method bodies where two would do:

```
$Base_s890_i32.size    $Derived_s891_i32.size     — identical bodies
$Base_s890_i32.#find   $Derived_s891_i32.#find    — identical bodies, same type index
```

The pairs are identical by construction, not by luck. A method body can
only mention type parameters in scope at its declaration site — the
declaring class's chain — and restricted to those parameters, the
subclass's substitution context is exactly the resolved base
instantiation's. The receiver parameter is already typed by the
declaring class (`getMemberRootClass`), so both copies of `#find` above
even share a wasm type index. The duplication compounds: every
instantiated level of a hierarchy carries its own full set of reached
bodies, and the base's set is force-reached by its vtable global even
when every call goes through the subclass.

### Sharing by declaring-class instantiation

The fix is a keying change in registration, not a dedup pass over
emitted bodies: register an inherited member under its _declaring
class's resolved instantiation_ (`Derived<i32>` resolves `#find` to
`Base_s890_i32.#find`) instead of minting a copy under the
instantiating class. The cases that genuinely need a distinct copy then
fall out of the key itself:

- An override is a different declaration — it registers under the
  subclass because the subclass is its declaring class.
- A subclass that binds the base's generics differently
  (`extends Base<String>` vs `extends Base<i32>`) resolves to a
  different instantiation of the declaring class, so a distinct copy is
  minted exactly when the substitution context differs.
- Mixin members stay per-host copies: a mixin body's `this` maps to the
  host class, so those bodies differ by design.

Devirtualization does not depend on the per-subclass copies.
`resolveDevirtualizedMethod` (lowering-context.zena) walks the
receiver's super chain and takes the first `classMethodMap` hit,
refusing when a reached subclass overrides the member — remove the
subclass copies and the walk finds the base copy one hop later.

Private members are the contained first slice: they are lexically
scoped and can never be overridden, so a subclass-keyed copy of a
private method is never needed. That copy is also where the
signature-vs-body substitution bug lived (an inherited private method's
signature was substituted with the subclass's own type parameters,
which are different symbols from the declaring class's — fixed in
`registerClassMethod` by using the same `substituteTypeParamsInClassContext`
the body lowering uses).
`tests/language/execution/classes/private-generic-return-subclass.zena`
and its `-nonnull` sibling pin the shape and are the natural fixtures:
with sharing, the `Derived.#find` copy stops existing at all.

The touch points are the registration and lookup sites that key by the
instantiating class today: vtable slot population (point the slot at
the declaring-class instantiation's function), `queuePrivateMethod` and
the private-call lowering (resolve to the declaring class's
instantiation), and `WasmModule.layout()`'s rebuild of
`classMethodMap` from reached functions (a shared body is reached
once, not once per subclass). Synthesized accessors are safe to share:
a base field keeps its index in a subtype struct, so the
`getterStruct`/`getterFieldIndex` pair computed for the declaring class
is correct for every subclass receiver.

### Landed, and what it was worth

The keying change landed as a single chokepoint in
`registerClassMethod`: when the member node's declaring class, resolved
through the receiver's (already-substituted) super chain, differs from
the registering class, the registration re-enters under the declaring
instantiation. Every consumer already walked the chain — vtable slot
population, interface trampolines, `resolveDevirtualizedMethod`, and
the method-call lowering all find the shared body one hop later — so
no lookup changed. `queuePrivateMethod` now walks the chain too, and
`inherited-method-sharing_test.zena` asserts the subclass-keyed copy is
ABSENT from the WAT (a property a snapshot cannot hold: regenerating
one accepts the copy right back).

Measured on the compiler's own module, fixed input, both stages `-g`:
3,244,237 → 3,243,538 bytes and 15,199 → 15,190 functions. The nine
removed bodies are the `hashCode` copies the `Type` and `WasmType`
hierarchies dragged onto every subclass. The win is small because the
compiler's hierarchies mostly override what they inherit or inherit
only fields; the fixtures (`minimal`, `array-sum`, `hello-string`) are
byte-identical because they barely inherit at all. The remaining
same-name pairs are all copies the key is SUPPOSED to keep distinct: a
case variant's synthesized `==`/`hashCode` (its own declaration, even
under a hand-written base method) and interface-adaptation accessors
registered without a declaration node. A side effect worth keeping:
`memberProvidedBySubclass` no longer sees a phantom entry for a
subclass that merely inherits, so a call through a base-typed receiver
devirtualizes in cases that used to dispatch through the vtable.

## 17. A for-in over an array roots no iterator protocol

`lowerForIn` compiles a for-in whose iterable is a bare array,
`FixedArray`, `ImmutableArray` or `Array` to an index loop —
`array.len`/`array.get`, no `.[iterator]` call, no `ArrayIterator`, no
`Iterable` dispatch. Reachability rooted the whole protocol anyway,
from two places: the checker registered an `Iterable` adaptation on
every class-typed for-in iterable (picked up by both the adaptation
walk and the dependency records), and RTA's own `ForInStatement` arm
queued `[iterator]` implementations, recorded
`[Iterable.iterator]`/`Iterator.next` as used interface members, and —
for a bare array iterable — instantiated `FixedArray<elem>` outright.

For array-sum that rooting was 94% of the module. The chain, verified
in the emitted WAT: the instantiation's sibling propagation brings
`FixedArray<u8>` and `FixedArray<String>` in alongside the `i32`
specialization; the adaptation is keyed on the UNSPECIALIZED
(class, interface) pair, so the i32 loop's evidence unlocked
class-interface vtables for all three; `#buildClassInterfaceVTables`
force-reaches every slot of `Iterable`'s vtable per specialization
(`contains`/`all`/`some`/`find`); and `FixedArray<String>.contains`
compares elements with `==`, which dragged the whole String
equality/hash chain into a program with no strings.

Both sides now mirror `lowerForIn`'s dispatch
(`forInLowersToIndexLoop`, one copy in the checker and one in RTA):
fast-path iterables register no adaptation and root no protocol. The
filter includes the type-argument requirement, and a mismatch fails
loudly — a class the filter calls fast that lowering iterator-paths is
a missing-method error at lowering, never a silent fallback.

What the fast path DOES still need is the value's type, and losing the
protocol exposed that nothing else supplied it: the machinery's method
signatures were the only thing keeping the raw wasm array emitted. An
index-loop for-in references it directly (`array.new_fixed`,
`array.get`) with no reached signature ever naming it. So
`#recordTypeEvidence` treats an extension's substituted `on` type as
evidence of its own — an extension VALUE is its representation — and
records an array type as a named composite, resolved at the settle
drain with the same `typeToValType` derivation lowering uses
(deferred like records: computing the element ValType during evidence
recording can run before a record element's dispatch exists). Each
gap surfaced as a loud `array.new_fixed references unemitted type`,
which now names the function it is in.

|                                           |                     before |                          after |
| ----------------------------------------- | -------------------------: | -----------------------------: |
| array-sum                                 |         3,647 B / 45 funcs |             **217 B / 1 func** |
| compiler's own module (fixed input, `-g`) | 3,463,511 B / 16,613 funcs | **2,899,290 B / 13,347 funcs** |
| minimal / hello-string                    |                   37 / 532 |                      unchanged |

The compiler's 16% is the same leak at scale: its sources are full of
for-in loops over arrays, and every one seeded the `Iterable`
adaptation for whatever element type it iterated.

The eq-slot repair's honest 10 bytes (section 13) vanish with the
evidence that triggered them. The budget ratchets 5,800 → 240 — 5,800
had gone stale; the module was already at 3,647 before this change,
improved by the erasure work among others, with the budget never
moved. The module is now small enough to read whole, so it is
WAT-snapshot tested like minimal and hello-string, and an invariant
test asserts no `ArrayIterator`, no interface trampoline, and no
String machinery in its module. What remains in the 217 bytes past
`main` and the array type: the struct/vtable pairs of six classes the
prelude walk names (`FixedArray<i32>`, `ImmutableArray<i32>`, the
ranges) — empty, dead, and the next visible cut.

## The keystone: `hasInst` and the class vtable

Everything still in the module traces back to a single coupling.

`registerClassMethod` force-reaches every method it registers as soon
as the class is instantiated. That is not gratuitous: the class vtable
global is a `struct.new` over one `ref.func` per slot, **every**
non-static, non-private, non-constructor method gets a slot, and
`Pass 1.5` does its own `markFunctionReached` per slot. So the vtable
would reach them all even if the force-reach were removed — and
removing the force-reach alone breaks the self-compile immediately.

The two have to move together:

1. a method gets a class-vtable slot only if something can dispatch on
   it through that vtable — i.e. the class has a superclass or a
   subclass. `String` and `FixedArray<T>` are both `final` with no
   superclass, so their class vtables (15 and 16 slots) can be empty.
   Interface dispatch is unaffected: it goes through
   `classInterfaceVTables`, built separately and gated on
   `usedInterfaceAdaptations`.
2. the force-reach goes, and every call site that relied on it has to
   root its own callee.

Step 2 is the work, and it is mechanical but wide, because
**registering a method is not reaching it** (3a). Four sites that
registered without reaching have already been found and fixed —
`registerGenericMethodUse`, `discoverNodeTypes`' generic-method arm,
`queuePrivateMethod`'s generic branch, and the method-node referrer in
`processQueues`. Each surfaced only when the over-approximation that
hid it was removed, one compile error at a time.

### The keystone was attempted, and it has a prerequisite

Both halves were built. Measured, on top of 11,530 / 16,823:

| step                                           | minimal |  array-sum | tests          |
| ---------------------------------------------- | ------: | ---------: | -------------- |
| vtable pruning + `==`/`hashCode` kept          |  11,077 |     16,303 | 469/470        |
| … + reach method-node referrers                |  11,111 | **17,709** | 470/470        |
| … + reach accessor referrers, drop force-reach |       — |          — | compiler traps |

Three things came out of it, all worth keeping:

- **Vtable pruning works.** Emptying the class vtable of a class that
  is neither a subclass nor a superclass is safe — 470/470 — with one
  exception found the hard way: `==` and `hashCode` must keep their
  slots. Generic code and `HashMap`/`HashSet` dispatch those two
  through the class vtable even on a class with no hierarchy, which is
  why `populateClassStructAndMethods` pushes them unconditionally for
  case classes. Everything else can go.
- **A vtable slot was silently doing a second job.** With the slots
  gone, `Array<i32>.push` stopped being emitted: it was reached only
  because `Pass 1.5` reaches every slot. The call site never rooted it.
  Two more register-without-reach sites fell out — the method-node
  referrer and the accessor referrer in `processQueues`.
- **And that is where it stops being a win.** Rooting those referrers
  costs _more_ than the vtable pruning saves: `array-sum` went from
  16,303 to 17,709. The cause is `recordReachedClassMember`, which,
  when a member is reached on one specialization, queues that member
  for **every** known specialization of the class. Under the old
  scheme those extra copies were merely registered and then pruned;
  once referrers reach what they name, they are all emitted.

So the real prerequisite is one level further down: **a member reached
on `Array<i32>` is not evidence about `Array<String>`.** Until
`recallReachedClassMember`'s fan-out is per-specialization, "reach what
is referenced" is a worse approximation than "reach what is in the
vtable", and the keystone cannot pay for itself. Reverted; the correct
order is fan-out first, then the keystone, then phase-gating.

Dropping the force-reach on top of all this traps the compiler with
`wasm unreachable` rather than a clean bail, so it needs the first two
in place before it can even be diagnosed.

### Why phase-gating instantiation is not the shortcut it looks like

`instantiateClassType` is not phase-gated, so a _checkable_ traversal —
one whose whole purpose is to discover types without reaching code —
instantiates. Tracing the seven surviving instantiations showed all
three junk ones (`String`, `WasiConsole`, `None`) coming from checkable
traversals of stdlib globals, which looks like a two-line fix.

It is not. Gating it:

- gained only 279 bytes on `minimal.zena` (`String` is re-instantiated
  from a reachable traversal anyway, so its 21 methods and all four
  array specializations stay),
- **cost 1,523 bytes on `array-sum.zena`**, and
- made `enums/string.zena` fail _only under the batched test runner_ —
  it passes standalone. That is order-dependence across entry points
  sharing one `Compiler`, the same hazard as the batch-position
  nondeterminism already documented in
  `packages/zena-compiler/CONTEXT.md`.

Built, measured, reverted. Phase-gating is probably still right, but it
has to come _after_ the keystone, not before it — while the force-reach
is load-bearing, moving instantiation just moves which
over-approximation fires.

## Measured dead ends

Three cuts that look obvious and are not. Each was built and measured;
none is landable as written.

- **Gate the unconditional `String` instantiation on a string literal
  existing.** Worth 134 bytes (15,328 → 15,194) at the time, and wrong
  as stated — a program can use `String` values with no literal in it.
  The gate that landed (section 7) is "a string value can exist":
  a literal, a constructor call through the normal graph, or an
  entry-unit export whose type mentions String.
- **Drop the sibling-propagation loop in `instantiateClassType`**
  (instantiating one specialization instantiates every known sibling).
  Worth 194 bytes on its own (15,328 → 15,134) because
  `discoverType`'s gate is keyed on the _generic's_ symbol id and
  re-instantiates each specialization as it is discovered. Removing
  both breaks the self-compile.
- **Drop the `hasInst` force-reach in `registerClassMethod`** (2b).
  Breaks the self-compile immediately. It cannot move on its own: the
  class vtable is a `struct.new` over one `ref.func` per slot and
  every non-static, non-private, non-constructor method gets a slot,
  so the vtable pass (`Pass 1.5`, which does its own
  `markFunctionReached` per slot) would reach them all regardless.
  The force-reach and the vtable's slot list have to shrink in the
  same change.

That last point is the shape of the remaining work: **a method should
get a class-vtable slot only if it can actually be dispatched through
that vtable** — the class has a superclass or a subclass. `String` and
`FixedArray<T>` are both `final` with no superclass, and between them
account for a 15-slot and four 16-slot vtables in the minimal module.
Interface dispatch does not need these: it goes through
`classInterfaceVTables`, built separately and gated on
`usedInterfaceAdaptations`.

## Plan

In dependency order:

0a. **Close the by-name lookup contract.** Every backend lookup that
resolves a callee by name after RTA (`getStdlibFunc`, and the
synthesized-helper families) needs an explicit root from the
construct that implies it, as template helpers got in #219. This is
what makes all the later steps possible instead of merely smaller.

0b. **Make the traversal phase explicit rather than ambient.** Thread
it through `queueReferrer`/`instantiateClassType`/the visitor
instead of reading `pass.currentReachable`, which survives between
phases and is what makes every phase-gating attempt fail in a
different place. Prerequisite for 1 and everything after it.

1. ~~**Make `recordReachedClassMember` per-specialization.**~~ Done:
   `queueReferrer` now records a member against the generic only when
   the referrer's class type _is_ the generic template. A referrer
   against a concrete specialization names its own. Worth little on
   its own (16,823 → 16,790) — it is a correctness fix and the
   prerequisite, not a win.
2. **The keystone** (above): shrink the class vtable to
   genuinely-virtual slots (keeping `==`/`hashCode`) and drop the
   `hasInst` force-reach in the same change, rooting each call site
   that relied on it.

   With the fan-out fixed, re-measured: minimal 11,530 → **11,111**,
   array-sum 16,790 → **17,160**, one test failing
   (`Array<i32>.push` — no vtable slot, and the fan-out no longer
   covers it either, so its call site must root it). Still a net wash,
   so still not landed. The residual +370 on array-sum is the
   accessor/method-node referrers reaching members that the referrer
   names but the program never calls: a referrer is queued per
   _member node_, while the checker's dependency records distinguish
   `get#x` from `set#x`. Threading that distinction through is
   probably what closes the gap.

3. **Make instantiation per-specialization**, not per-generic — with
   the use-side gaps closed first, the way 3a closed them for generic
   methods. Worth roughly three of the four array specializations.
4. ~~**Do not instantiate `String` unconditionally.**~~ Done
   (section 7): instantiation follows a literal, a constructor call,
   or a String-mentioning entry-unit export, and the `$string*`
   helpers follow the verdict. Landed WITHOUT the keystone — the
   entry-only roots (5) turned out to be the actual prerequisite.
5. **Phase-gate `instantiateClassType`**, and fix the referrers that
   hardcode `isReachable = true` (`queueExplicitCtor`,
   `queuePrivateMethod`, the plain-identifier-call arm, the
   tagged-template tag). Blocked on 0. Together these are what stop a
   dead stdlib global from instantiating `String`, `WasiConsole` and
   `None`.
6. **Separate struct layout from method registration** in
   `populateClassStructAndMethods`, so a discovered-only class can get
   its fields without its methods (2c). Blunt-skipping it does not
   work — tried, and it breaks the self-compile with `member not found
@FixedArray_…[]$BoundedRange`.
7. **Prune interface vtables to referenced selectors.** RTA already
   tracks `referencedInterfaceMembers` / `usedInterfaceMembers`; the
   vtable struct shape should be built from that set rather than from
   every declared member. This is what makes 2b stop mattering: a
   selector nobody dispatches on should not occupy a slot, and then
   nothing forces its implementation to be emitted.
8. **Register function-value wrappers from genuine value positions
   only** — 7 remain for stdlib functions never used as values.
9. **Key inherited members by declaring-class instantiation**
   (section 16), so a subclass reuses `Base_i32.size` instead of
   minting an identical `Derived_i32.size`. Start with private
   members — never overridable, so never legitimately copied — then
   vtable slot population. Distinct copies remain only where the key
   genuinely differs: overrides, different generic bindings of the
   base, mixin members.

## The ratchet

`zena/test/binary-size_test.zena` holds three fixtures to absolute
byte budgets, to be moved DOWN only:

| fixture                        | what it adds                                                                                   | bytes | budget |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ----: | -----: |
| `test-files/minimal.zena`      | `return 42` — no strings, no allocation, no calls                                              |    37 |     37 |
| `test-files/array-sum.zena`    | an array literal summed by a for-in loop: one index-loop function, one array type (section 17) |   119 |    130 |
| `test-files/hello-string.zena` | a returned string literal: the literal machinery and the read-side exports                     |   399 |    420 |

Minimal alone cannot notice a regression in generic specialization,
because it specializes nothing — hence the other two. A budget left
slack goes stale the other way: array-sum's sat at 5,800 while the
module shrank to 3,647 underneath it, and a 2KB regression would have
passed unseen.

`dce_test.zena` never caught any of this: it asserts only that two
programs compile to the _same_ length, which stays true while both
triple.
