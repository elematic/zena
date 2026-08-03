---
title: 'Classes and interfaces'
description: 'How method calls are dispatched: vtables for classes, fat pointers for interfaces, and when the compiler can remove the indirection.'
---

Zena is an object-oriented language with single inheritance for classes,
multiple interface implementation, and mixins. Calling methods on class
instances requires virtual dispatch. Wasm GC has no built-in mechanism for it,
so Zena builds one on top of Wasm GC structs.

## Wasm representation

A class compiles to a Wasm GC struct. A subclass's struct is a Wasm subtype of
its base struct, so field offsets are inherited and a subclass value is usable
wherever the base is, with no conversion.

```zena
class Animal {
  speak(): i32 {
    return 0;
  }
}

class Dog extends Animal {
  speak(): i32 {
    return 1;
  }
}
```

Which lowers to roughly this:

```wat
;; The class and vtable types refer to each other, so they share a rec group.
(rec
  ;; The signature every `speak` shares. `this` is typed at the class that
  ;; declared the method, so one signature covers the base and its subclasses.
  (type $sig_speak (func (param (ref $Animal)) (result i32)))

  ;; One vtable type per class. `$Dog_vtable` is a subtype of `$Animal_vtable`,
  ;; so slot 0 is `speak` in both.
  (type $Animal_vtable (sub (struct (field $speak (ref $sig_speak)))))
  (type $Dog_vtable (sub $Animal_vtable (struct (field $speak (ref $sig_speak)))))

  ;; One struct type per class, the subclass declared as a Wasm subtype.
  (type $Animal (sub (struct (field $vtable (ref $Animal_vtable)))))
  (type $Dog (sub $Animal (struct (field $vtable (ref $Dog_vtable))))))

(func $Animal_speak (type $sig_speak) (param $this (ref $Animal)) (result i32)
  i32.const 0)
(func $Dog_speak (type $sig_speak) (param $this (ref $Animal)) (result i32)
  i32.const 1)

;; One vtable instance per class, built once.
(global $Animal_vtable_instance (ref $Animal_vtable)
  (struct.new $Animal_vtable (ref.func $Animal_speak)))
(global $Dog_vtable_instance (ref $Dog_vtable)
  (struct.new $Dog_vtable (ref.func $Dog_speak)))
```

Because Wasm GC provides subtyping directly, an upcast is a no-op and a downcast
is a single `ref.cast`. Aside from the vtable reference, there is no object
header of Zena's own and no runtime type information beyond what the engine
already keeps.

## Virtual calls

Virtual calls are implemented with vtables.

Each class has one vtable — a struct of function references, one per virtual
method — and each instance holds a reference to it. A virtual call is a load of
the vtable, a load of the slot, and a `call_ref`.

A subclass's vtable starts with the same slots in the same order as its base, so
a call site compiled against `Animal` reads slot _n_ whether the object is an
`Animal` or a `Dog`. Overriding replaces the function reference in that slot.

## Devirtualization

A vtable is only needed when the compiler cannot name the function to call.
Every devirtualization is that one condition reached by a different route.

Today the compiler reaches it four ways:

- **The method is `final`.** It cannot be overridden, so the target is fixed.
- **The class is `final`.** Nothing can extend it, so no override can exist.
- **The receiver's exact type is known**, as in `new Dog().speak()`. Inference
  gives the concrete class, not a supertype.
- **No subclass overrides the method.** Zena is a whole-program compiler, so it
  walks the transitive subclasses and, finding none, calls directly.

The first two are declarations and the last two are conclusions. Most methods
are never overridden, so most calls are already direct without anyone writing
`final`; marking a class or method `final` states intent and preserves the
guarantee if a subclass appears later, rather than being the main source of
direct calls.

Devirtualization is bounded by inference rather than by those four routes. A
method with several overriding subclasses still compiles to a direct call at a
site where only one of them can arrive, since what decides it is the set of
types flowing through that site. Sharper inference therefore removes
indirection without any change to how dispatch works.

## Interface references

An interface value is a struct holding two fields — the instance, erased, and a
vtable for that interface:

```wat
(type $Runnable (struct
  (field $instance (ref null any))
  (field $vtable (ref $RunnableVTable))))
```

Wasm GC references are opaque: there is no tagging, no arithmetic, and no way to
pack two references into a single value. The pair is therefore a heap object
with two reference fields, rather than the two machine words in registers that
"fat pointer" denotes on a native target.

The instance field is erased to the top reference type so that one interface has
one Wasm struct type. Typing the field as the implementing class would make a
`Runnable` holding a `Task` and a `Runnable` holding a `Job` distinct Wasm
types, and a variable annotated `Runnable` could hold only one of them. Erasure
gives every implementer the same fat pointer type.

The vtable's functions take the erased receiver for the same reason, so each one
is a trampoline: it casts the instance back to its concrete class and calls the
real method.

A class's layout is the same whichever interfaces it implements, since the pair
lives outside the object.

The alternative is an **itable**: a per-object table of the interfaces a class
implements, searched at call time. That keeps conversion free and makes dispatch
a lookup. Fat pointers make the opposite trade — dispatch is a constant-time
load-load-call, and the cost moves to conversion.

Converting an object to an interface therefore allocates:

```zena
let r: Runnable = new Task(); // allocates the fat pointer
```

The allocation goes away when the call site does not need the pair:

- **Narrowed to a concrete class**, the call is direct and no interface value is
  built at all.
- **Narrowed to a superclass** that declares the method, the call goes through
  the class vtable instead.
- **Scalar replacement of aggregates** would split the struct into two locals
  wherever it does not escape, so the pair is allocated only when it is stored
  in a field or an array. Planned, along with the rest of the
  [optimizing backend](/development/roadmap/).

Repeated dispatch on one value can also be consolidated. Two interface calls on
the same value load the instance and vtable twice; hoisting those loads out of a
loop, or sinking them into the single branch that uses them, reduces that to one
pair of dereferences.

## Mixins become classes

`class C extends S with M1, M2` is linearized into a chain of generated classes:
`S` ← `S+M1` ← `S+M1+M2` ← `C`. Each application produces a Wasm struct type
that extends the previous one.

Linearization makes a mixin ordinary single inheritance by the time it reaches
codegen, so everything above about vtables and devirtualization applies to it
unchanged. The `on` clause constrains what a mixin may be applied to and leaves
the lowering alone.

A mixin also declares a type. A reference typed as the mixin needs a fat pointer
for the same reason an interface reference does: the mixin's members sit at
different offsets in every class that applies it.

::: warning Mixin-typed references are not implemented
A mixin cannot be used as a type today. Both the parameter type and the argument
are rejected:

```zena
let f = (n: Named) => n.name;
// error: Property access not supported on type 'Named'.
f(new User());
// error: Type mismatch in argument 1: expected Named, got User
```

:::

→ Working documents:
[`classes.md`](https://github.com/elematic/zena/blob/main/docs/design/classes.md),
[`interfaces.md`](https://github.com/elematic/zena/blob/main/docs/design/interfaces.md),
[`mixins.md`](https://github.com/elematic/zena/blob/main/docs/design/mixins.md)
