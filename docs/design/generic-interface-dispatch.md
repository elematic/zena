# Generic Interface Dispatch

How a generic method declared on an interface dispatches through an
interface-typed receiver ([elematic/zena#116](https://github.com/elematic/zena/issues/116)).

```zena
import { Array } from 'zena:array';

let a: Array<i32> = [1, 2, 3];
let b = a.map((x) => x + 1);   // virtual call of a generic method
```

Before this design, the checker rejected the call ("Generic method
'map' cannot be called through interface 'Array'") because a vtable
slot holds one `ref.func` of one signature and a generic method has no
single signature.

## Monomorphized slots

Zena compiles whole programs, and RTA already monomorphizes generic
methods per solved type-argument list (`map_spec_i32` on each concrete
receiver class). Virtual dispatch reuses that: each (interface
specialization, solved type-argument list) a reached body calls through
gets its own interface vtable slot, named with the same
`getSpecializedName` mangle the class-side copies register under. The
call site, the slot, and every implementing class's trampoline all
derive the name from the checker-solved arguments, so they agree
without a shared table.

The set of slots is finite for the same reason RTA terminates: demands
come from call sites in reached bodies, one per enclosing
specialization, and reached bodies are a fixed point RTA already
computes. Erased virtual dispatch (one slot serving every `U` through
`anyref`) was the alternative, and would box primitive arguments —
Zena has no implicit boxing, so it was rejected.

## Demand discovery

`registerGenericInterfaceMethodUse` (reachability/visitor.zena) is the
interface-receiver arm of `registerGenericMethodUse`: when a walk
names a generic method through a concrete interface type, it records a
`GenericInterfaceMethodDemand` — the interface specialization, the
method, and the solved arguments resolved through the walk's
substitution context. The same template/erasure guards apply as on the
class path: a mention whose receiver or arguments still contain type
parameters is the template of a call, and registers nothing.

Slots are appended by `#syncGenericInterfaceSlots` at the top of every
`#buildClassInterfaceVTables` round, after Pass 0.8 has populated the
declared members, so field order is: declared members in declaration
order, then generic slots in demand order — both deterministic. A
demand discovered after a class-interface pair's vtable global was
built (a body reached in a later fixpoint round) appends trampolines
for the tail slots to the existing global's init; fields are
append-only, so earlier entries stay aligned.

The implementing classes are not fanned out at demand time. A class
can join a demand's interface in any later round, so
`#buildTrampolineForSlot` instantiates the class's monomorphized copy
(`instantiateGenericMethod`) when it fills the slot, which is the one
point that sees every (class, interface, demand) combination.

## Slot signatures and the interface view

The slot's signature is the interface view of the method at the
demand's arguments (`getGenericInterfaceMethodType`): interface type
parameters bound to the specialization's arguments, `this` bound to
the interface type, method type parameters bound to the demand's. The
checker gives the call site the same view (it substitutes `this` the
same way), so the closure struct a call-site lambda mints is the
closure struct the slot's signature names.

`this` substitution matters here in a way it does not for non-generic
slots: a `this`-typed callback parameter left unsubstituted lowers to
`anyref` and keys a closure struct the call site's closure does not
have.

## Trampoline adaptation

An implementing class's own declaration may narrow the interface view.
`Array<T>` declares

```zena
map<U>(f: (item: T, index: i32, seq: this) => U): Array<U>;
```

and `GrowableArray<T>` implements it as

```zena
map<U>(f: (item: T, index: i32, seq: GrowableArray<T>) => U): GrowableArray<U>
```

so the monomorphized copy's wasm signature differs from the slot's in
two places, and the trampoline adapts both
(`#computeGenericTrampolineAdaptations`):

- **Covariant class-typed result.** The copy returns a class struct
  where the slot returns an interface fat pointer. The trampoline
  calls (no tail call — the pack runs after the target returns) and
  packs the result through the class-interface pair vtable. The pair
  is demanded via `usedInterfaceAdaptations` when the adaptation is
  computed, and the fixpoint builds its global in a later round; the
  ZIR synthesis resolves it by key and fails loudly on a miss.

- **Narrowed callback parameters.** The interface wrote `seq: this`,
  so the caller's closure takes the interface fat pointer where the
  copy's closure takes the class struct — two different closure
  structs, and wasm function subtyping does not bridge them. The
  trampoline rebuilds the argument as a class-view pair: a synthesized
  forwarder as the func, the caller's interface-view pair as the ctx.
  The forwarder (`lowerClosureForwarder`, the structural twin of
  `lowerFunctionAdaptation`) unpacks the ctx, packs each narrowed
  argument into its interface fat pointer, and `call_ref`s the
  caller's closure.

Any other signature mismatch — a `this`-typed parameter at the top
level of the method, callback result adaptation, interface-to-
interface conversion — throws a named compile error rather than
emitting an invalid call. These shapes can be added if code needs
them.

## Call-site lowering

`#lowerMethodCall`'s interface arm computes the slot name from the
checker-solved arguments (`#solvedCallTypeArguments`, substituted into
the enclosing specialization) and dispatches through
`#lowerInterfaceDispatch` unchanged: unpack the fat pointer, load the
named slot, `call_ref`. A generic call with no recorded solution bails
(`generic interface method call`), matching the concrete-receiver
path.

## What this costs

Slots exist only for demanded (interface, arguments) pairs, and each
implementing class pays one trampoline per demanded slot plus one
forwarder per narrowed callback parameter. A program that never calls
a generic method through an interface emits exactly what it did
before.
