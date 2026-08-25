# Array Element Mutability

**Status: Proposed, and gated.** The representation change is small and
mostly already plumbed. What blocks it is performance: the change removes
a free abstraction and replaces it with one that currently costs about
35× on element access. The optimizer work in
[Required optimizations](#required-optimizations) has to land first, and
the [Acceptance gate](#acceptance-gate) defines what "first" means.

## Overview

`ImmutableArray<T>` and `FixedArray<T>` are both declared
`extension class ... on array<T>`. An extension class is erased to its
`on` type during code generation, so both compile to the same Wasm type
index and a cast converts freely between them:

```zena
let frozen = [1, 2, 3] as ImmutableArray<i32>;
let thawed = frozen as FixedArray<i32>;
thawed[0] = 99;   // compiles, runs, mutates the "immutable" array
```

Wasm GC distinguishes `(array T)` from `(array (mut T))`. Giving the two
classes different underlying types makes the immutability enforceable at
runtime rather than by convention, and it enables covariance,
data-segment-backed constant tables, and loads the engine can treat as
pure.

It also has a cost that is easy to miss. Today one Wasm type serves every
array, so a function taking `FixedArray<T>` accepts an `ImmutableArray<T>`
and vice versa, for free. After the split they are unrelated types, and a
function that must accept both has to be generic or interface-typed.
Interface-typed array access is currently about 35× slower than direct
access. The split therefore converts an abstraction that costs nothing
into one that costs a great deal, unless the optimizer closes the gap
first.

## Current representation

`typeToValType` maps an extension class to its `on` type
(`packages/zena-compiler/zena/lib/codegen/type-mapping.zena`), so
`array<T>`, `FixedArray<T>`, and `ImmutableArray<T>` are one Wasm type.
The cast above emits no instructions because there is nothing to check.

The code generation plumbing for immutable arrays already exists and is
unused:

- `WasmArray` carries `isMutable` (`codegen/wasm-module.zena:343`)
- `ArrayKey` includes it in the intern key
- `getValTypeKey` spells `array_mut_` and `array_imm_`
  (`codegen/type-mapping.zena:1124`)
- Both emitters honor it (`codegen/binary-emitter.zena:942`,
  `codegen/wat-emitter.zena:672`)

Every `getArray(...)` call site passes `true`.

## Wasm array mutability

Verified with `wasm-tools validate --features all` and
`wasmtime 45.0.2 -W gc=y,function-references=y`:

```wat
(module
  (type $mut (array (mut i32)))
  (type $imm (array i32))
  (func (export "testImmOnMut") (result i32)
    (array.new_fixed $mut 2 (i32.const 1) (i32.const 2))
    (ref.test (ref $imm))))
```

| Case                                                                     | Result                                     |
| ------------------------------------------------------------------------ | ------------------------------------------ |
| `ref.test (ref $imm)` on an `(array (mut i32))` value                    | `0`                                        |
| `ref.test (ref $mut)` on an `(array i32)` value                          | `0`                                        |
| `ref.cast` between them                                                  | traps                                      |
| `array.set` on `(array i32)`                                             | rejected at validation                     |
| `(type $mut (sub $imm (array (mut i32))))`                               | rejected: "sub type must match super type" |
| `(array (ref null $cat))` declared `sub` `(array (ref null $animal))`    | accepted                                   |
| the same with `mut` elements                                             | rejected                                   |
| `array.new` and `array.new_default` on an immutable type, dynamic length | accepted                                   |

Three consequences:

1. The types are runtime-distinguishable. A cast that launders through
   `anyref` traps instead of succeeding, and `x is ImmutableArray<T>`
   becomes a real test.
2. `(array (mut T))` is not a subtype of `(array T)`. A `FixedArray<T>`
   can never be passed where an `ImmutableArray<T>` is expected, not even
   as a read-only view. This is the source of the performance problem
   above.
3. Immutable arrays are covariant in their element type, mutable arrays
   are invariant.

Wasm GC has no operation that converts a mutable array to an immutable
one. An immutable array can only be produced fully formed, by
`array.new`, `array.new_default`, `array.new_fixed`, `array.new_data`, or
`array.new_elem`. `array.set`, `array.fill`, `array.init_data`,
`array.init_elem`, and the destination of `array.copy` all require `mut`.

## Type system change

`ArrayType` gains a mutability flag:

```zena
case ArrayType(elementType: Type, elementsMutable: boolean)
```

Surface syntax: `array<T>` for immutable elements, `array<var T>` for
mutable ones.

`array<` appears in six places in Zena source, all in the standard
library: `array-iterator.zena` (2), `fixed-array.zena` (1),
`immutable-array.zena` (2), `string.zena` (1). Users write `FixedArray`,
`ImmutableArray`, and `GrowableArray`; `array<T>` reaches source only
through `on` clauses and intrinsic declarations. Flipping the default
costs six lines, and every miss fails loudly, since `array.set` against
an immutable type is a validation error.

Reasons for `array<var T>` over a second intrinsic name such as
`immutable_array<T>`:

- Records and tuples are already immutable structural types.
  `RecordType` carries no per-property mutability (`lib/types.zena:230`)
  and record and tuple fields emit `isMutable = false`. An unmarked
  `array<T>` matches them.
- `let`/`var` bindings and immutable-by-default class fields mean `var`
  marks mutability everywhere else in the language.
- It matches Wasm's `fieldtype`, which is the thing being modeled, and
  generalizes if records ever gain mutable fields (`{var x: f64}`).

### Scope of the `var` modifier

`var` in `array<var T>` is not a general use-site type-argument modifier.
It is part of the grammar of the `array` type constructor, which is a
builtin rather than a declared class. `Foo<var T>` on a user-written
class is rejected.

The rule that generalizes is that mutability is written where the slot is
declared, and each construct spells its own slots:

| Construct                                             | Slot declaration |
| ----------------------------------------------------- | ---------------- |
| class field                                           | `var x: T`       |
| local binding                                         | `var x = e`      |
| record property (if records ever gain mutable fields) | `{var x: f64}`   |
| array element                                         | `array<var T>`   |

`array<T>` is the only type in the language whose storage is a single
unnamed slot, so it is the only one whose slot declaration coincides with
its type argument. That is why the modifier appears inside the angle
brackets, and why it does not extend to user generics: a type argument to
a user class does not name a slot, so `var` there would have nothing to
modify.

If a user type ever needs a mutable-slot type parameter, it declares one
the ordinary way, with a `var` field.

### Relation to variance

`var` annotates slot mutability, and variance follows from it rather than
being declared alongside it. Wasm has no variance annotations at all; the
subtyping table above shows the derivation in both directions.

Zena has no declaration-site variance machinery today: `TypeParameter`
carries `name`, `constraint`, and `defaultType` (`lib/ast.zena:540`), and
nominal generics are invariant (`lib/checker.zena:6384`). Function types
are the exception and already vary structurally by position — covariant
returns, contravariant parameters (`lib/checker.zena:6364`).

Three options for where this goes, if variance is added later:

**Invariance everywhere except where the representation is free.**
`array<T>` gains covariance because Wasm grants it at no cost, and
everything else stays invariant. This is the smallest step and the one
this document assumes.

**Derived variance.** A type parameter appearing only in immutable slots
and output positions is covariant; anything in a `var` slot or an input
position forces invariance. This is the same predicate the compiler
already applies to function types, extended to nominal types, and it
needs no syntax. The hazard is that adding a `var` field or a method
taking `T` silently narrows a public type's variance and breaks distant
callers. That is addressable by making an annotation optional and
assertive: `class Foo<out T>` would not be required to obtain
covariance, but writing it makes the compiler check the property and
report the error at the declaration rather than at every use site.

**Dart-style covariance with runtime-checked writes.** A poor fit here.
Dart's `List<Cat> is List<Animal>` works because writes are checked at
runtime against a reified element type. Zena has neither reified type
arguments nor a place to put the check, and Wasm will not give a subtype
relation between `(array (mut Cat))` and `(array (mut Animal))` at all —
the declaration is rejected at validation, as shown above. Obtaining it
would mean erasing mutable arrays to a common supertype and casting on
every read, which costs more than the covariance is worth and gives up
soundness as well.

Whichever is chosen, `var` and a future `out` would not overlap: `out`
constrains how a type parameter may be used, and the check that enforces
it — does `T` appear in a mutable slot — is the same predicate `var`
records. `class Foo<out T> { var x: T }` is an error under all three.

## Array literals

Array literals are currently hardcoded to `FixedArray`:
`checker.zena:9751` infers the element type contextually, then always
resolves the container to `FixedArray`. Once the types split,
`[1, 2, 3] as ImmutableArray<i32>` traps, so literals must pick a side.

Literals should produce `ImmutableArray<T>` by default, with the
container taken from the contextual type when one exists. The container
half of that logic already exists for empty literals, which recognize
`GrowableArray`, `Array`, `FixedArray`, and `ImmutableArray` as expected
types.

The migration is cheap:

- Array literals in the compiler and standard library are overwhelmingly
  constant tables: `intrinsics`, `publicModules`, the `T95` statistics
  table, the prelude module lists.
- Across `tests/language/`, two files both build an array literal and
  index-assign. The one that mutates a literal already writes the
  annotation:

```zena
let arr: FixedArray<i32> = [10, 20, 30];
arr[1] = 42;
```

Literals already lower to `array.new_fixed`, which accepts immutable
types, so this needs no new construction path.

## Standard library shape

| Name                | Kind                              | Representation                       |
| ------------------- | --------------------------------- | ------------------------------------ |
| `Array<T>`          | interface                         | fat pointer                          |
| `MutableArray<T>`   | interface, extends `Array<T>`     | fat pointer                          |
| `ImmutableArray<T>` | extension class on `array<T>`     | `(array T)`                          |
| `FixedArray<T>`     | extension class on `array<var T>` | `(array (mut T))`                    |
| `GrowableArray<T>`  | class                             | struct with a `FixedArray<T>` buffer |

The concrete types form no hierarchy. `(array (mut T))` is not a subtype
of `(array T)`, and `GrowableArray` is a struct, so no representation
type is assignable to another. All polymorphism over arrays goes through
the interfaces and fat-pointer dispatch, or through generic
specialization.

`IterableUtils` survives intact — `contains`, `all`, `some`, `fold`, and
`find` all consume rather than produce arrays. Two members change:

- `ImmutableArray.map<U>` returns `FixedArray<U>`, which still satisfies
  `Array<U>` by covariant return.
- `ImmutableArray.from(seq)` is removed. It allocates then fills, and no
  immutable equivalent exists.

Construction becomes: array literals, `array.new_data` for numeric and
byte tables, and `array.new` or `array.new_default` for uniform fill.

## Cost of interface-typed arrays

### Measurements

From `docs/benchmarks/2026-08-05-pre-retirement-baseline.md`, iterating
10,000,000 elements. This is the only recorded run in the repository and
predates three weeks of codegen work, so the absolute figures want
re-measuring; the generated code below shows why the gap has the shape
the benchmark reports.

| Benchmark                            | wasmtime  | node     |
| ------------------------------------ | --------- | -------- |
| for-in / array                       | 8.75 ms   | 3.73 ms  |
| for-in / array (interface)           | 305.50 ms | 26.42 ms |
| for-in / immutable array             | 9.02 ms   | 3.64 ms  |
| for-in / immutable array (interface) | 284.09 ms | 26.72 ms |
| for-in / growable array              | 9.82 ms   | 2.98 ms  |
| for-in / growable array (interface)  | 317.10 ms | 27.04 ms |

The gap is dispatch, not the array operation. The interface trampoline
for `array.get`, `array.set`, and `array.len` already inlines the
operation instead of calling through to a method body
(`codegen/ir/lowering.zena`, `synthesizeInterfaceTrampoline`).

### Generated code

Compiling three signatures over the same `FixedArray<i32>` and reading
the emitted WAT:

```zena
function sumConcrete(arr: FixedArray<i32>): i32 { ... }        // param (ref 15)
function sumInterface(arr: Array<i32>): i32 { ... }            // param (ref 48)
function lenGeneric<A extends Array<i32>>(arr: A): i32 { ... } // param (ref 15)
```

where `(type 15) = (array (mut i32))` and
`(type 48) = (sub (struct (field anyref) (field (ref 40))))`, the fat
pointer.

The concrete loop body is two array operations per iteration:

```wat
local.get 0
array.len
...
local.get 0
local.get 2
array.get 15
```

The interface loop body is six loads and two indirect calls per
iteration:

```wat
local.get 0
struct.get 48 0     ;; instance
local.get 0
struct.get 48 1     ;; vtable
local.tee 4
struct.get 40 5     ;; length slot
call_ref 27
...
local.get 4
struct.get 40 6     ;; [] slot
call_ref 35
```

Two things stand out. The fat-pointer unpacking and both vtable slot
loads are loop-invariant and are re-executed every iteration. And the
call stays indirect even though `Array<i32>` has exactly one reachable
implementer in this program.

### Direct references

A fat pointer appears only where an interface type is written. It does
not arise from:

- array literals, which produce a concrete type
- locals and fields whose declared or inferred type is concrete
- direct calls to functions with concrete parameter types
- `if (arr is FixedArray<i32>)`, which narrows and unwraps the fat
  pointer to the concrete reference

The one case that forces it is a parameter that must accept more than one
array representation — which is exactly what this change creates.

## Required optimizations

These are preconditions, not follow-ups. Each is described by what it
must do and what it is worth to the loop above.

### Loop-invariant code motion

The fat pointer's `instance` and `vtable` fields and the vtable's method
slots are all immutable — `WasmField(..., false)` at every construction
site. Hoisting those four loads out of the loop removes most of the
per-iteration overhead and leaves one indirect call per operation.

This needs a purity notion for loads over immutable slots and a hoisting
pass. GVN today commons constants, pure arithmetic, casts, and
`global_get`, and no loads at all (`codegen/ir/gvn.zena`, 137 lines);
there is no loop-invariant code motion pass. Immutable struct fields
already give the struct half of the purity notion; this document supplies
the array half.

### Devirtualization

RTA already computes the reachable implementer set for each interface.
Where that set has one member, `call_ref` becomes `call`. In the probe
above, `Array<i32>` had exactly one reachable implementer and still
emitted `call_ref`.

`final` classes and methods are the trivially devirtualizable case and
are named in `docs/design/optimization-strategy.md` under Phase 2, not
yet implemented.

### Inlining

After devirtualization, the `length` and `[]` trampolines are two- and
three-instruction functions that already contain `array.len` and
`array.get` directly. Inlining them collapses the interface loop into the
concrete loop. Small callees, large payoff; this is the step that closes
the remaining gap once dispatch is static.

### Scalar replacement

The fat pointer is a two-field immutable struct. Where it does not
escape, it can be split into two locals, and at call boundaries the two
fields can be passed instead of the struct. That removes the allocation
at pack sites and both `struct.get`s at use sites.

`docs/design/argument-explosion.md` designs this for record parameters
and is marked Proposed. The interface case is the same rewrite over a
different two-field struct, and the two should share an implementation if
the general form lands; a fat-pointer-only version is an acceptable first
step.

### Operator lookup through generic bounds

Not an optimization, but the cheapest path to parity, and required for
the same reason.

Generic specialization already produces the direct representation. The
probe compiles `lenGeneric<FixedArray<i32>>` to:

```wat
(func $lenGeneric_spec_FixedArray_s199_i32 (param (ref 15)) (result i32)
  local.get 0
  array.len)
```

A direct array parameter and a bare `array.len`, with no fat pointer and
no dispatch. So `function sum<A extends Array<i32>>(arr: A)` is the
signature that accepts every array representation at no cost.

It does not work yet. Operators do not resolve through a type parameter's
constraint:

```
probe.zena:24:37 - Error: Index access not supported on type 'A'.
```

`arr.length` resolves through the bound and `arr[i]` does not. Making
operator and member lookup consult a type parameter's constraint turns
the recommended signature into a usable one.

This covers code that can be generic, which is most of it. The four
optimizations above are what cover code that must be dynamically
polymorphic: a heterogeneous collection of arrays, a virtual method
returning `Array<T>`, a value crossing a module boundary.

## Acceptance gate

The split lands only if the common case reaches parity with today's
design. "Today's design" is the commit immediately before the split;
"common case" is code that reads and iterates arrays without caring which
representation it was handed.

Measured with `npm run benchmark -w @zena-lang/zena-compiler` against a
baseline captured on that parent commit:

1. **No concrete-typed regression.** `LoopForInArray`, `LoopWhileArray`,
   `LoopForInImmutableArray`, and `LoopForInGrowableArray` stay within
   noise of baseline.
2. **Representation-polymorphic parity.** A loop whose parameter is
   typed so that it accepts both a `FixedArray<i32>` and an
   `ImmutableArray<i32>` runs within noise of the same loop typed
   concretely. This holds for the generic-bound form by construction once
   operator lookup lands, and is what the optimizer work has to achieve
   for the interface form.
3. **Interface dispatch closes most of the gap.** With one reachable
   implementer, the interface forms should match their concrete
   counterparts, since devirtualization plus inlining reduces them to the
   same code. With several implementers, loop-invariant hoisting and
   scalar replacement should remove four of the six per-iteration loads.
4. **Binary size.** The hello-world figure tracked in
   `docs/design/binary-size.md` does not regress beyond type-section
   growth.
5. **Self-compilation.** `test:fixpoint` still passes and self-compile
   time does not regress materially.

Thresholds for "within noise" and for criterion 3 need agreement before
the work starts. The benchmarks in criterion 2 do not exist yet and
should be added first, so the gate has a baseline to measure against.

## Other mutability sites

`mut` appears in exactly two places in the Wasm grammar: `fieldtype`,
shared by struct fields and array elements, and `globaltype`. Tables,
memories, tags, and function signatures have none.

- **Struct fields**: already correct. `fieldIsMutable` comes from
  `FieldInfo.isMutable`
  (`codegen/reachability/specialization.zena:2007`).
- **Array elements**: this document.
- **Globals**: incorrect. `codegen/reachability/visitor.zena:2286` sets
  `let isMutable = true;` with no branch, so a module-level `let` emits
  `(global (mut T))`. Fixing this requires initializing globals with
  constant expressions rather than through `__start`
  (`codegen/module-generator.zena:301`), which uses `global.set` and
  therefore requires mutability. GC constant expressions cover
  `struct.new`, `array.new_fixed`, `ref.i31`, and integer arithmetic, so
  many globals could move; any global initialized by a function call
  cannot. Worth tracking separately.

One adjacent gap in the same family: `emitStructTypeStart` always writes
`0x50`, the non-final `sub` form (`codegen/binary-emitter.zena:146`).
`isFinal` is threaded through the type model
(`codegen/type-mapping.zena:319, 869, 1723`) and never reaches the
emitter, so `final class String` emits a type engines must keep open to
subtyping. The fix is one line in the emitter, it applies to every final
class rather than only to arrays, and it is a precondition for the
devirtualization above.

## Implementation notes

- `instantiationKeyOf` renders `ArrayType` as `"Array<" + elem + ">"`
  with no mutability (`lib/types.zena:736`). The two array types would
  collide on generic instantiation keys. `getValTypeKey` already
  distinguishes them.
- `isValidCast` and `typesOverlap` must stop treating extension classes
  on `array` as interchangeable, without disturbing `isV128View`
  (`lib/checker.zena:5636`), which deliberately allows casts between
  `I32x4` and `F32x4` because those are the same bits. Arrays become the
  counterexample to an identically shaped declaration and should carry a
  comment saying why.
- `ArrayIterator<T>` holds `#array: array<T>` and needs a variant for
  each. `for`-in over both is fused into an index loop
  (`codegen/ir/control-flow.zena:2146`), so the iterator is rarely
  allocated.
- `__array_len` and `__array_get` must accept both types; `__array_set`
  and `__array_new_empty` only the mutable one.
- The sites that resolve an array-backed class must select the matching
  array type rather than assuming one:
  `findPreludeClass("ImmutableArray")`
  (`codegen/reachability/visitor.zena:428`) and the
  `"FixedArray" || "ImmutableArray"` name checks in
  `codegen/reachability/visitor.zena:2892`,
  `codegen/ir/control-flow.zena:2146`,
  `codegen/ir/lowering.zena:6256`, and `codegen/wasm-module.zena:1691`.
- Binary size is unaffected beyond a few type-section entries.
  `docs/design/binary-size.md` records that `FixedArray` and
  `ImmutableArray` already specialize separately, 28 methods each per
  element type, so no method bodies duplicate.
- `array.new_fixed` has engine operand limits (V8 caps it near 10,000).
  Large constant tables want `array.new_data`, which is already wired end
  to end as an intrinsic, an `IrOp`, and in both emitters.

## Covariance

Once `ImmutableArray<T>` is on `(array T)`, `ImmutableArray<Cat>` can
widen to `ImmutableArray<Animal>` with no copy and no fat pointer. This
needs `emitArrayType` to stop writing `sub final` with zero supertypes
(`codegen/binary-emitter.zena:947`) plus a checker rule, since nominal
generics are invariant today. Sound read-only covariance falls out of the
representation rather than needing `out` annotations. This is independent
of the main change and can land separately.

## Alternatives considered

**Nominal wrapper.** Make `ImmutableArray<T>` a regular class holding a
private `#items: array<var T>`. Immutability would rest on private-field
access, which leaves the representation mutable and adds a struct
indirection per element read. Distinct Wasm types give a stronger
guarantee at lower cost: a laundered cast traps rather than succeeding.
It does not avoid the performance problem either — the wrapper is a
struct, so a function accepting both it and a `FixedArray` still needs an
interface or a generic.

**Checker rule only.** Reject casts between `FixedArray<T>` and
`ImmutableArray<T>` while keeping one representation. Cheap, carries no
performance risk, and worth doing regardless. But
`x as anyref as FixedArray<T>` still lowers to a `ref.cast` that
succeeds, so it is a convention rather than a guarantee. If the
acceptance gate cannot be met, this is the fallback.

**A second intrinsic name.** `array<T>` and `immutable_array<T>` as
unrelated type constructors. Avoids touching `ArrayType`, but the casing
is off-idiom, the name collides conceptually with the `ImmutableArray`
extension class, and it does not generalize to any other slot qualifier.
It has the same performance consequences, since the two types are still
unrelated.

**Declaration-site `in`/`out`.** Adds a variance system to serve one
case, ahead of any second motivating example, in a language that
monomorphizes and already derives variance from position for function
types. See "Relation to variance" for how it would fit if added later.

**Interface parameters as the way to accept both representations.**
Typing every array parameter `Array<T>` avoids needing generic bounds, at
roughly 35× on element access. This is the status quo the acceptance gate
exists to prevent.

## Open questions

- **Naming.** `Array<T>` names the read-only interface, which reads as
  the concrete mutable type in most other languages, and is inconsistent
  with its sibling `MutableArray<T>`. Zena also marks mutability rather
  than immutability everywhere else, which makes `ImmutableArray` the one
  name marking the default. A consistent set would be `ReadableArray<T>`
  and `WritableArray<T>` for the interfaces, `Array<T>` for the immutable
  concrete type, `MutableArray<T>` for `(array (mut T))`, and
  `GrowableArray<T>` unchanged. This is a much larger migration than the
  rest of this document, since `Array` is in the prelude and re-exported
  from `zena:array`. Worth deciding separately.
- Whether `ImmutableArray.map` returning `FixedArray` is the right trade,
  or whether `map` should be dropped from `ImmutableArray` and reached
  through `Array<T>`.
- Thresholds for the acceptance gate.
- Whether a fat-pointer-only scalar replacement is acceptable as a first
  step, or whether the general form from
  `docs/design/argument-explosion.md` should land first.
