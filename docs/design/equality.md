# Equality, Identity, and Hashing

Status: **Proposed**. Revised 2026-10-10: `==` on classes falls back to
identity, and is a virtual call from the root of every class
hierarchy. The earlier direction, where `==` on a class without
`operator ==` was a compile error, is described under
[Reversed: no fallback from `==` to identity](#reversed-no-fallback-from--to-identity).

This document records what `==` and `===` mean, how a class declares
equality, how hash keys stay consistent with `==`, and how generic and
erased code compares values. It was written alongside the
records-are-value-types decision ([records-and-tuples.md](records-and-tuples.md)
§3.1). Identity-_keyed_ containers (IdentityMap, WeakMap) are designed
in [weak-references.md](weak-references.md).

The rules, in one sentence each:

> **`==` is the runtime class's declared equality, and identity when it
> declares none. `===` is identity, and exists only where identity
> does. A hash key declares both `==` and `hashCode`.**

## Current state

- `==` compares primitives, strings, records and tuples by value.
- On a class, `==` resolves on the **static** type of the left operand:
  - If that type declares or inherits `operator ==`, the call is
    virtual. A subclass override is found at runtime
    (`tests/language/execution/operators/class_operator_overload.zena`).
  - If it does not, `==` compiles to `ref.eq`, even when every runtime
    subclass declares an `operator ==`.

  So the answer depends on how the operands are typed:

  ```zena
  sealed class Shape {
    case Circle(radius: i32)
    case Square(side: i32)
  }

  let c1 = new Circle(5);
  let c2 = new Circle(5);
  c1 == c2;   // true: Circle's generated structural ==

  let s1: Shape = c1;
  let s2: Shape = c2;
  s1 == s2;   // false: Shape declares no ==, so identity
  ```

  `tests/language/execution/sealed-classes/equality.zena` asserts the
  `false`.

- A case class's generated `==` compares a field whose class declares
  no `operator ==` by identity. A field typed as a sealed base is one
  of these, so `Add(left: Expr, right: Expr)` compares its children by
  identity even though every `Expr` case has a structural `==`.
- An `operator ==` override must keep the parameter type exactly.
  `Point3.==(other: Point3)` under `Point.==(other: Point)` is rejected
  as an overload that overlaps the inherited one. The supported pattern
  is to keep `other: Point` and narrow inside the body.
- `HashMap`/`HashSet` keys must satisfy `Hashable`, which declares only
  `hashCode()`. Nothing requires a key's `==` to agree with its hash.
  The compiler's own `Type` is an instance: the sealed base hashes by a
  per-object uid, its cases derive a structural `==`, and `Type == Type`
  happens to mean identity only because the base declares no `==`. The
  case-class `hashCode` divergence in
  [#113](https://github.com/elematic/zena/issues/113) is another
  instance.
- `===` is identity on classes and a compile error on records and
  tuples.

## Decisions

### Identity on records and tuples

`===`/`!==` on record- or tuple-typed operands is a **compile error**
(records-and-tuples.md §3.1). Records and tuples are values, and the
compiler copies or dissolves them freely, so identity is not
observable. On classes, `===` is reference equality and always
available.

### Virtual equality with an identity default

Every class hierarchy root has an `operator ==`. If the root declares
none, the compiler supplies one equivalent to:

```zena
operator ==(other: Root): boolean {
  return this === other;
}
```

It is an ordinary virtual method, so `==` at any static class type
dispatches to the runtime class's equality. In the example above,
`s1 == s2` calls `Circle`'s `==` and returns true.

**Cost.** Reachability already deletes a vtable slot that no reached
subclass overrides, and lowering calls directly whenever no subclass
provides the method. A hierarchy where no class declares `operator ==`
therefore compiles `==` to `ref.eq`, as it does today. Only a
hierarchy with an override pays for a virtual call, and that call is
what makes the answer correct.

**Overrides compare the same class.** A subclass declares its equality
with its own type as the parameter:

```zena
class Point {
  x: i32;
  new(this.x);

  operator ==(other: Point): boolean {
    return this.x == other.x;
  }
}

class Point3 extends Point {
  z: i32;
  new(x: i32, this.z) : super(x);

  operator ==(other: Point3): boolean {
    return this.x == other.x && this.z == other.z;
  }
}
```

`Point3`'s operator overrides `Point`'s slot, which takes a `Point`.
The compiler inserts a test at the top of every declared
`operator ==`: if `other` is not of **exactly** the receiver's runtime
class, the result is false; otherwise `other` is cast to the declared
parameter type and the body runs.

The test is exact, not an instance-of test, because an instance-of test
is asymmetric. With one, `point == point3` runs `Point.==`, finds that
a `Point3` is a `Point`, compares only `x`, and can return true, while
`point3 == point` runs `Point3.==` and returns false. Java's `equals`
has this problem and leaves it to every author. Case classes already
avoid it: their generated `==` tests `other` against their own struct,
and case classes are final, so that test is exact.

The cost of this rule: a `Point3` never equals a plain `Point`, even
when their shared fields match. A program that wants cross-class
equality writes a method for it, with a name.

**What it trades away.** Adding `operator ==` to a class changes what
every existing `==` on it means: those calls compared identity and now
compare whatever the operator says. This is accepted. Defining
equality for a class is the class author's decision, and a caller that
needs identity has `===`. The alternative is in
[Reversed: no fallback from `==` to identity](#reversed-no-fallback-from--to-identity).

Precedent: Java's `Object.equals`, Kotlin's `Any.equals` and Dart's
`Object.==` work the same way — virtual, identity by default. Swift and
Rust have no default; their `==` requires `Equatable`/`PartialEq`.

### Hash keys declare equality

A class satisfies `Hashable` only if it declares or inherits an
`operator ==` other than the implicit identity one.

`hashCode` and `==` must agree: equal objects must hash equally. A class
that declares `hashCode` and no `operator ==` pairs its hash with the
implicit identity `==`. That pairing keeps the contract only until a
subclass or case adds a structural `==` and leaves the hash as it was.
Equal objects then land in different buckets, and lookups miss. The
compiler's `Type` is in this state today, with a uid hash on the sealed
base and a derived structural `==` on each case. Requiring the operator
puts both declarations in front of the class author, and makes the
sealed-base rule below possible.

A class whose equality really is identity writes it down:

```zena
class Session implements Hashable {
  #id: i32 = nextSessionId();

  operator ==(other: Session): boolean {
    return this === other;
  }

  hashCode(): i32 {
    return this.#id;
  }
}
```

or uses `IdentityMap`, which hashes by a compiler-injected identity
field (weak-references.md).

**Case classes and sealed bases.** A case class derives `==` and
`hashCode` together. If it inherits a declared `operator ==` or
`hashCode` from its sealed base, it derives neither: the base's pair
is the hierarchy's equality. Without this rule a base declaring
identity equality, as the compiler's `Type` will have to, would see
its cases override `==` with a structural one while keeping the base's
uid hash.

**`Equatable`.** With virtual `==`, every class has an equality, so a
bound is not needed for `==` to compile in generic code. `Equatable`
remains as the interface meaning "declares an `operator ==` of its
own", and `Hashable` extends it:

```zena
interface Equatable {
  operator ==(other: This): boolean;
}

interface Hashable extends Equatable {
  hashCode(): i32;
}
```

The `This`-typed parameter ([this-type.md](this-type.md)) makes `==` a
binary method, so `Equatable` works as a generic bound, not as a value
type: two values both typed "some `Equatable`" may have different
`This` types and cannot be compared through it. Records, tuples,
strings and primitives satisfy both interfaces by derivation, as the
checker already arranges for `Hashable` today.

### Member-level `where` bounds

Zena extensions are deliberately **non-ambient** (the extension type
must be the static type), so Rust-style `impl<T: PartialEq> Vec<T> {
contains }` has no direct analogue. Instead, a member can constrain the
_class's_ type parameter:

```zena
class Array<T> {
  sortedBy(): Array<T> where T extends Comparable { ... }
}
```

`Array<Session>` has no `sortedBy`, and a call is an error at the call
site naming the unsatisfied bound. This replaces a late error deep in
the specialized body with an early one at the call. Un-called
conditional members are never instantiated, which fits the compiler's
member-granular reachability.

Bounds go on the class when every operation needs them
(`HashMap<K extends Hashable, V>`) and on the member when only some do.
Mixin and interface-default members carry `where` the same way.
Ownership uses the same mechanism (`where T extends Copyable`,
[ownership.md](ownership.md)).

Equality no longer needs it: `contains` compiles for every element
type (see the next section). Ordering does, and deep equality for
collections may (open question 4).

Until `where` lands with the bounds work (row-types.md §9), free
functions with ordinary bounds are the interim.

### `contains` and `includes`

Collections expose both comparisons:

```zena
class Array<T> {
  contains(value: T): boolean { ... }  // ==
  includes(value: T): boolean { ... }  // ===; classes and anyref only
}
```

- `contains` uses `==`, so it means "an equal element exists": by value
  for values, and by the runtime class's equality for objects, which is
  identity when the class declares none.
- `includes` takes JavaScript's name and meaning:
  `Array.prototype.includes` is identity (SameValueZero) on objects.
  It is for code that needs identity even when the element class
  declares `==`, such as removing one listener from a list. On
  value-typed elements it is a compile error, since values have no
  identity.
- Predicate forms (`some((x) => ...)`, per iterable-methods.md) cover
  everything else.

### Identity hashing

Wasm GC provides `ref.eq` but **no identity-hash primitive and no
addresses**. Java's model, where every object can be a hash key through
`identityHashCode`, would need a hidden hash field on every object or a
side table. Therefore:

- `Hashable` is **opt-in for classes, permanently**, on this target.
  [Hash keys declare equality](#hash-keys-declare-equality) is what
  makes virtual `==` compatible with this: no class has to be hashable
  just because it has an `==`.
- Identity-keyed containers (IdentityMap, WeakMap) are supported
  through **compiler-injected per-class hash fields**, added only to
  the class hierarchies used as keys. Mechanism, bounds, and the
  inverted-WeakMap design are in [weak-references.md](weak-references.md).

### Equality through interfaces and anyref

`==` on an interface-typed or `anyref` operand must reach the runtime
class's `operator ==` too, or the static-type problem returns one level
up. Today neither can reach it:

- An interface value is a pair `{instance: anyref, vtable}`. Its vtable
  holds trampolines that call each target directly, with no link to the
  class's own vtable.
- There is no common root struct. Every class struct has its
  `<vtable>` at field 0, but each hierarchy root is its own unrelated
  wasm type, and so is each root's vtable type.
- The erased comparison (`lowerErasedEq`) tests identity, then null,
  then `ref.test` against `String` and a direct call to `String.==`.
  It calls no other class's `==`.

Two ways to close this, not yet chosen (open question 1):

1. **A type-test chain.** Extend the erased comparison with one
   `ref.test` per hierarchy that has a reached `operator ==`, calling
   that root's slot. The `String` tier is already this shape. The cost
   grows with the number of such hierarchies in the program.
2. **A common root.** Give every class struct a supertype
   `$Object { <vtable>: ref null $ObjectVTable }`, with `==` at a fixed
   first slot of `$ObjectVTable`. Dispatch is one cast, one load and one
   `call_ref`. This changes the type section of every program, and
   wasmtime's cast performance depends on type finality and placement
   (struct-finality.md), so it needs measuring.

Either way, extension-class instances are not structs (a `FixedArray`
is a raw wasm array) and keep identity.

With this in place, code that needs equality across unrelated types,
such as test assertions over `anyref`, uses `==` directly. The earlier
plan for an explicit `DynEquatable` interface for that purpose is no
longer needed.

## Reversed: no fallback from `==` to identity

The previous version of this document made `==` on a class that
declares no `operator ==` a compile error, pointing at `===`. Its
reasons were:

1. Adding `operator ==` to a class silently changes existing `==`
   calls.
2. Hash keys whose `hashCode` and `==` disagree break maps.
3. A reader could not tell what `a == b` does without looking for an
   operator on the static type and its superclasses.
4. Generic `contains` would compare by identity for some element types
   and by value for others.

It was implemented
([#286](https://github.com/elematic/zena/pull/286)) and closed before
merging. Reasons 2 to 4 are answered here by
[Hash keys declare equality](#hash-keys-declare-equality) and by
virtual dispatch, which makes the answer independent of the static
type. Reason 1 is the trade-off accepted above.

That implementation also surveyed the code. Compiling the compiler,
wit-parser and the standard library found 129 places where `==` fell
back to identity: 125 with class operands, 1 with an interface, and 3
on type parameters. Scanning all 2,131 test files, the examples and
the other packages found 14 more, all in tests. Rewriting every class
and interface site to `===` changed no test result outside the tests
that asserted the fallback itself. The rule added friction at 140
sites without changing any program's behavior, while the static-type
problem above was asserted by a test.

## Migration

1. **Convert identity comparisons that would change meaning.** Under
   virtual `==`, a site changes meaning when its static type declares
   no `operator ==` but a reached subclass does. The compiler's `Type`
   and AST `Node` hierarchies are sealed classes with case variants, so
   their `==` sites (45 on `Type` alone) would become structural
   comparisons. Every such site becomes `===` first; #286's rewrites
   did this for all class sites and can be reapplied. A temporary
   checker warning on exactly this condition finds the rest.
2. **Hash keys declare equality**, with `Type` declaring identity
   `operator ==` alongside its uid `hashCode`, and the case-class
   derivation rule for sealed bases.
3. **The implicit root `operator ==`** and the override rule with its
   exact-class test. `sealed-classes/equality.zena` then expects
   `true`, and case-class fields typed as a sealed base compare by
   the cases' `==`.
4. **Equality through interfaces and anyref**, once the representation
   is chosen.
5. `contains`/`includes` land with the collections work that needs
   them; nothing blocks on them.

## Open questions

1. Erased dispatch: a type-test chain or a common root struct (see
   [Equality through interfaces and anyref](#equality-through-interfaces-and-anyref)).
2. The exact-class test. `ref.test` against the receiver's struct is
   exact only when no reached subclass of it exists. Comparing the two
   objects' `<vtable>` pointers is exact in general, but the field is
   null for classes reachability gives no vtable global, so those
   classes would need one.
3. `operator ==` overloads with other parameter types, such as an
   operator that takes an interface and accepts every implementation
   (`tests/language/semantics/classes/operators/operator-eq-operand.zena`).
   Only the overload whose parameter is the declaring class overrides
   the root slot. Whether the others stay as statically dispatched
   overloads or are disallowed is undecided.
4. Deep equality for collections (`Array<T> == Array<T>`) — wants
   conditional conformance (`Array<T> implements Equatable when
T extends Equatable`); until then, explicit helpers.
5. Ordering (`Comparable` with `This`) — same shape as `Equatable`;
   design when sorting APIs need it.
6. Naming: `includes` vs `containsSame`.
