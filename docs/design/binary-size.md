# Binary size of a minimal program

**Status**: 🚧 partially fixed — the name section is gated (below); the
RTA leaks are diagnosed and measured but not yet fixed.

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
`struct.new` — its representation *is* the underlying `array<T>` — so
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

### 2b. Instantiating a class reaches *every* method of it

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

### 2c. Pass 1.05 populates classes that were only *discovered*

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
work: a discovered-only class still needs its struct *fields* laid out
(its type can appear in a signature even with no value of it), and the
pass does layout and method registration together. Tried; it breaks the
self-compile with `member not found @FixedArray_…[]$BoundedRange`. The
two responsibilities have to be separated first.

## What removing the extension rule is worth

Dropping `|| ct.isExtension` from both sites above and rebuilding:

| | before | after |
| --- | ---: | ---: |
| total (with names) | 33,875 | 18,161 |
| functions | 227 | 99 |
| code | 17,485 | 10,453 |
| types | 4,854 | 4,258 |
| globals | 730 (39) | 168 (18) |

`return 42` still compiles and runs, and **464 of 470** execution tests
pass. It is not landable as-is: the 6 failures are real gaps that the
blanket force-reach was masking.

```
arrays/extension-calls-zir.zena            method not found: FixedArray_s186_i32.map_spec_i32
arrays/generic-method-primitive-mono.zena  method not found
arrays/prelude-builtins-zir.zena           method not found
classes/generic-declare-interface.zena     interface vtable global not found
interfaces/sequence-array-index-trampoline.zena  interface vtable global not found
records/tuple-array-in-method.zena         interface vtable global not found
```

Both families are diagnosed:

- **`method not found: FixedArray_s186_i32.map_spec_i32`** —
  `registerInstantiations` (the path taken when a function body has
  checker dependency records, which is the common case) has no
  generic-method arm at all. Only `discoverNodeTypes`, the full-walk
  path, calls `instantiateGenericMethod`. Today a generic method on an
  extension class gets registered anyway because instantiation
  registers *everything*; remove that and the missing arm is exposed.
  The two walks are meant to be equivalent modulo cost, and this is a
  place where they are not.
- **`interface vtable global not found`** — the class↔interface vtable
  global is allocated for instantiated classes only, and an extension
  class that is never "instantiated" never gets one even though its
  values genuinely flow through `Iterable`/`Sequence` dispatch.
  Extension classes need an instantiation trigger tied to a *value*
  existing (an `array.new` of that element type) rather than to the
  type being mentioned.

## Plan

In dependency order:

1. **Give `registerInstantiations` a generic-method arm**, matching
   `discoverNodeTypes`. Independently correct, and a prerequisite.
2. **Separate struct layout from method registration** in
   `populateClassStructAndMethods`, so a discovered-only class can get
   its fields without its methods (2c).
3. **Give extension classes a value-based instantiation trigger** and
   drop `|| ct.isExtension` from the two sites in 2a.
4. **Prune interface vtables to referenced selectors.** RTA already
   tracks `referencedInterfaceMembers` / `usedInterfaceMembers`; the
   vtable struct shape should be built from that set rather than from
   every declared member. This is what makes 2b stop mattering: a
   selector nobody dispatches on should not occupy a slot, and then
   nothing forces its implementation to be emitted.
5. **Register function-value wrappers from genuine value positions
   only** — 7 remain for stdlib functions never used as values.

A regression test belongs with this: `dce_test.zena` currently only
asserts that two programs compile to the *same* length, which cannot
notice the module tripling. An absolute budget on the reference
program above would have caught every regression described here.
