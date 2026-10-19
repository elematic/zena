# Interface type tests

`x is I`, `x as I` and a `case I` arm mean "the class of `x` implements
`I`", for an interface `I` and an `x` held as anything: an `anyref`, a
class, another interface, or a union. This document says how the
compiler answers that in a fixed number of loads and tests, what it
costs, and where the pieces live.

## The problem

A value held as an interface is a fat pointer: a two-field struct
pairing the instance with a vtable for that interface, built when a
class value is converted to the interface type
(docs/design/polymorphic-references.md). So a `ref.test` against the
interface's fat pointer struct asks whether the value has already been
converted to `I`, which is a question about how the value is held and
not about its class. A `Square` behind an `anyref` answered `is Shape`
false, `as Shape` trapped, and a `Square` held as `Named` answered
`is Shape` false too. Only an operand statically typed `I` got the
right answer, because such an operand is always a fat pointer of `I`.

Wasm GC can test a struct's declared supertype chain, and a class
struct has one chain. Interface membership is a second relation over
the same classes, so it has to be stored somewhere the test can reach
from the instance.

## The layout

The answer lives in per-class tables reached from the vtable pointer
every class instance already carries in field 0, so an instance costs
nothing extra.

- **`TypeInfo`**: one struct for the program, with one immutable field
  per tested interface, typed as a nullable reference to that
  interface's vtable struct. Each candidate class gets one global of
  it, whose field for `I` holds the class's `(class, I)` pair vtable
  when the class implements `I` and null otherwise.
- **`<typeinfo>`**: the first field of the vtable struct of every class
  in a candidate hierarchy, holding that global, or null for a class in
  the hierarchy that no test can answer true for. `VTableBase`, a
  struct with just that field, is the supertype of the hierarchy's root
  vtable struct, so a test can read the field through a vtable
  reference of any such class.
- **`Object`**: a struct with one field, `<vtable>`, typed as a
  nullable `VTableBase`. It is the supertype of the root class struct
  of every candidate hierarchy some test reaches through a non-class
  operand, so the test can cast an `anyref` to `Object` and read the
  vtable. This needs the `<vtable>` field to be immutable, since only
  an immutable field may refine its type in a subtype; nothing writes
  it after the constructor's `struct.new`.
- **`FatPtrBase`**: a struct with the `instance` field alone, the
  supertype of every interface fat pointer struct, so one cast unwraps
  a fat pointer of any interface. It exists only when some test's
  operand can hold one.

The sequence for `x is I` on an `anyref` is then: test for `I`'s own
fat pointer (true at once), unwrap through `FatPtrBase` if the value is
some other fat pointer, cast to `Object`, read `<vtable>`, read
`<typeinfo>`, read the slot for `I`, test it for null. Each step is one
instruction or a null branch. A class-typed operand skips the casts and
reads its own `<vtable>` field. `x as I` reads the same slot and builds
`I`'s fat pointer from the instance and the vtable it holds, so a cast
packs without any per-class choice; a null slot traps through
`ref.as_non_null`. A binding the checker narrowed by `x is I` and reads
at `I`, and a `case I as v` binding, pack the same way.

The emitted type section carries `Object`, `VTableBase` and
`FatPtrBase` as open types, since they are extended; wasmtime answers a
cast to an open type by an index compare first and the `is_subtype`
libcall when the compare fails (docs/design/struct-finality.md). A cast
to `Object` always fails the compare, so a test on a non-class operand
leaves JIT code once. That is the constant the design pays; a chain of
per-class `ref.test`s against final structs stays inline but grows with
the number of implementers.

## What exists only when needed

Nothing above is emitted for a program that tests no interface. The
discovery walks record each test site with the operand's static type
(`ReachabilityVisitor.noteTypeTestSites`); a site whose operand is
statically `I` is not recorded, since the fat pointer test is right for
it. Once discovery has settled, `#markTypeTestPairs` turns the sites
into `(class, interface)` pairs: for each site, every instantiated class
that implements the interface and fits the operand's type. A
class-typed operand admits its subclasses, an interface-typed one the
classes that implement both, and anything else every implementer. Each
pair is marked as an interface adaptation so `#buildClassInterfaceVTables`
builds its vtable and trampolines, and the class gets a class vtable
global if it had none.

`#layoutTypeTests` then lays out the structs above for exactly those
classes: only hierarchies holding a candidate get `<typeinfo>` and
`VTableBase`; only hierarchies some test reaches through a non-class
operand extend `Object`; `FatPtrBase` exists only when some operand can
hold a fat pointer of an unknown interface. It runs after
`#pruneUndispatchedSlots`, which aligns vtable fields with their
functions by index; the leading `<typeinfo>` value travels separately
in `VTableInit.slotGlobals`, which the emitter stores before the
functions, harvest follows for liveness, and devirtualization subtracts
when it maps a slot index to a function. The globals an initializer
reads with `global.get` have to be declared first, so
`#orderGlobalInitializers` sorts `wasm.globals` by those references,
keeping the order otherwise.

The dead-field pass identifies a field by its declaring struct, and a
test on a non-class operand reads `<vtable>` through `Object`; such a
read keeps field 0 of every struct below `Object`.

## The checker's part

The checker narrows `x` to `I` in the true branch of `x is I` as it
always did. It registers a static pack (an interface adaptation) for a
class-to-interface conversion only when the class implements the
interface; a downcast such as `animal as Named`, which used to fail in
codegen with no vtable to pack through, now reaches the type-info path.

## Limits

- A class-typed operand tested against a class, `y is Square` for `y:
  anyref` holding a `Named` fat pointer around a `Square`, is still a
  `ref.test` against the class struct and answers false. Seeing
  through a fat pointer there would unwrap through `FatPtrBase` first,
  and `FatPtrBase` exists only when an interface test needs it.
- An extension class has no struct of its own, so it is never a
  candidate: a value of one is a value of its `on` type.
- An operand whose static type is a type parameter is "anything", and
  a test against an interface whose type arguments are still erased
  inside generic code tests the erased key.
- The candidate set is bounded by the operand's static type only.
  Interprocedural type propagation (elematic/zena#421) would narrow it
  to the classes that reach the operand.

## Tests

`tests/language/execution/interfaces/is-means-implements.zena` covers
the operand kinds, the generic instantiations, `case I as v`, the
narrowed reads, and the nullable binding.
`tests/language/execution/interfaces/downcast-through-interface.zena`
covers the class-target direction.
