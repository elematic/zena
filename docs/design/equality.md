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

- `==` compares primitives and strings by value. On records and tuples
  it compares identity (#372): they reach `lowerErasedEq`, whose only
  test that applies to them is `ref.eq`. Neither satisfies `Hashable`.
  [Structural equality for records and tuples](#structural-equality-for-records-and-tuples)
  below is the design.
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

### Structural equality for records and tuples

Not implemented yet (#372). Record types come in three forms
([row-types.md](row-types.md#decisions)), and `==` follows them:

- **Closed records and tuples:** equal when every field (every
  element) is equal, each compared with its own type's `==`: a class's
  virtual `operator ==`, `String` content, primitives by value, the
  erased comparison for a type parameter, and this rule again for a
  nested record or tuple. A value of a closed type has exactly the
  fields of its type, because converting a wider record to it projects
  the wider one onto those fields. So comparing the type's fields
  compares the whole value.
- **Row-generic records** (`{x: i32, ...R}`): the same, per
  specialization, where `R` is a concrete row.
- **Existential records** (`{x: i32, ...}`): equal when both have the
  same underlying shape and equal fields. The dispatch table carries
  the shape's identity and its equality function. An existential and a
  closed record are equal when the existential's underlying shape is
  the closed type and the fields are equal.

`==` does not convert its operands. Two values of different closed
record types are never equal, and the checker reports that comparison
as always false.

Records and tuples satisfy `Hashable` and `Equatable` without
declaring anything: the compiler derives a `hashCode` per shape,
consistent with `==`, as it does for case classes.

For argument explosion, `==` and `hashCode` on a closed or row-generic
record read only its fields, so a record parameter compared with `==`
can still be passed as its fields. An existential needs the whole
record.

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

**Cost.** A hierarchy where no class declares `operator ==` compiles
`==` to `ref.eq`, as it did before. Below a class with no operator,
`==` tests the left operand against each class that introduces one,
and a class with an operator calls it directly unless a reached
subclass overrides it. Only a hierarchy with an override pays for the
dispatch, and that dispatch is what makes the answer correct.

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
  operator ==(other: this): boolean;
}

interface Hashable extends Equatable {
  hashCode(): i32;
}
```

The `this`-typed parameter ([this-type.md](this-type.md)) makes `==` a
binary method, so `Equatable` works as a generic bound, not as a value
type: two values both typed "some `Equatable`" may have different
`this` types and cannot be compared through it. Records, tuples,
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

`==` on an interface-typed or `anyref` operand reaches the runtime
class's `operator ==` too, or the static-type problem would return one
level up. Neither representation names the class:

- An interface value is a pair `{instance: anyref, vtable}`. Its vtable
  holds trampolines that call each target directly, with no link to the
  class's own vtable.
- There is no common root struct. Every class struct has its
  `<vtable>` at field 0, but each hierarchy root is its own unrelated
  wasm type, and so is each root's vtable type.

So the comparison finds the class by testing for it. A shared function,
`$erasedEq(a, b)`, tests `a` against each class in the program that
introduces a reached `operator ==` (declares or derives one, while its
superclass has none), `String` first. When one matches, `b` must be of
that class too, and that class's operator answers through its own
dispatch. A class that matches none has identity equality. One test
covers a whole subtree, because `ref.test` is an instance-of test and
the operator's virtual call picks the override; a hierarchy with no
operator anywhere needs no test. Every erased or interface-typed `==`
calls `$erasedEq` after testing identity and null inline, and an
interface value is unwrapped to its instance first.

Extension-class instances are not structs (a `FixedArray` is a raw wasm
array) and keep identity.

With this in place, code that needs equality across unrelated types,
such as test assertions over `anyref`, uses `==` directly. The earlier
plan for an explicit `DynEquatable` interface for that purpose is no
longer needed.

#### How `==` is lowered

```
a == b
├─ primitives: by value
├─ records, tuples: identity today, through the erased comparison (#372)
├─ a literal null operand: ref.is_null
├─ a class C, or C | null                     (ir/equality.zena, lowerClassEquality)
│  ├─ either operand nullable: both null → true, one null → false, else on
│  ├─ C has an operator == (declared, derived or inherited)
│  │    b outside the class that owns the operator's slot → false
│  │    otherwise call it: directly when no reached subclass overrides it,
│  │    through the vtable when one does
│  └─ C has none
│       for each class X below C that introduces one:
│         a is X → (b is X → X's operator, else false)
│       none matched → ref.eq
│       (more than four such classes, and $erasedEq exists: call it instead)
├─ an interface, anyref, eqref or erased type parameter
│    (lowerErasedEq; the interface pair unwrapped to its instance)
│  ├─ ref.eq → true; either null → false
│  └─ $erasedEq(a, b)                          (lowerErasedEqDispatch)
│       for each class X in the program that introduces a reached operator,
│       String first, the rest in type order:
│         a is X → (b is X → X's operator, else false)
│       none matched → false
└─ the start of a declared operator == of class D (lowerEqualityPrologue)
     other of exactly this's class? otherwise false:
     the same object → yes; D has no subclass with instances → ref.test;
     else test this against D's subtree, subclasses first
```

`equals<T>` and a case class's derived `==` on a class-typed field take
the class branch, and an interface or erased `T` the erased one.

#### Choosing the chain

Two other ways to answer an erased `==` were measured or considered.

**A common root.** Every class struct gets a supertype
`$Object { <vtable> }`, with `==` at a fixed slot of the vtable type:
one cast, one load and one `call_ref`, whatever the program's size. Its
cost is that `<vtable>` becomes read on every class, so dead-field
elimination can no longer delete it, and every vtable global and the
accessors it installs survive. Keeping every `<vtable>` live in an
otherwise unchanged `-O2` build measures that part alone:

| Program          | Introducing classes | Erased `==` sites | Size      | With every `<vtable>` kept |
| ---------------- | ------------------- | ----------------- | --------- | -------------------------- |
| hello-world      | 1                   | 0                 | 7,352     | 7,842 (+6.7%)              |
| other benchmarks | 1                   | 0                 | 7–13 KB   | +5–6%                      |
| zb               | 5                   | 20                | 181,841   | 211,818 (+16.5%)           |
| the compiler     | 15                  | 46                | 1,854,767 | 2,179,226 (+17.5%)         |
| zena-cli module  | 123                 | 50                | 2,474,390 | 2,847,322 (+15.1%)         |

The root's own slot, supertype and identity operators would add to
that. The chain is one function of one test per introducing class.

**A shared supertype only for hierarchies with an operator.** Roots of
hierarchies that contain an introducing class hang under one struct type
whose vtable has `==` at slot 0, and erased `==` is one `ref.test`
against it. Hierarchies without an operator would be untouched, but the
large ones with an operator, such as the compiler's `Type`, AST and IR
hierarchies, are where most of the vtable cost above is.

As built, the chain costs the compiler 36 KB (2,199,792 to 2,235,804
bytes). Most of it is the operators an erased comparison may now call:
105 more `==` functions, most of them AST and IR cases' derived ones,
and `$erasedEq` itself. Inlining the tests below a base without an
operator at every comparison, as `==` on a class does when the list is
short, cost 232 KB, because each case's derived `==` repeated them for
every field typed as the base; past four classes such a comparison
calls `$erasedEq` instead.

Both are implementation choices with the same semantics, so the chain
can be replaced if erased comparisons over many classes turn out to be
hot. Its runtime cost is one test per introducing class tried before the
match, and the sealed bases whose cases each derive `==` are what make
the list long. Two narrowings are open: at an interface-typed site only
the introducing classes that implement the interface can appear, and
reachability could leave out classes whose instances never reach an
erased value.

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
   comparisons. Every such site becomes `===` first. Done in #309: a
   temporary checker warning on exactly this condition, run over every
   `.zena` file in the repository, found 49 sites, all in the compiler.
2. **Hash keys declare equality**, in two steps around a re-baseline
   (bootstrapping.md, "Two-step landing"). The bootstrap derives a
   structural `==` on every case of `Type`, so once `Type` declares
   one, `equals<Type>` sees an overridden operator and cannot be
   lowered. The compiler that builds the compiler must have the
   derivation rule first.
   - The case-class derivation rule for sealed bases, and `Equatable`
     with the same structural satisfaction rule as `Hashable`. Done in
     #311.
   - After a re-baseline: `Hashable extends Equatable`, which makes
     `String` and every other hash key `Equatable`, and `Type`,
     `WasmType` and `WasmFunction` declare identity `operator ==`
     alongside their uid `hashCode`. Done.
3. **The implicit root `operator ==`** and the override rule with its
   exact-class test. Done. `sealed-classes/equality.zena` expects `true`,
   and case-class fields typed as a sealed base compare by the cases'
   `==`. As built, the root operator is not a function: `==` on a class
   that has no operator tests the left operand against the classes below
   it that introduce one and calls that one, or compares identity, so a
   hierarchy with no operator anywhere still compiles to `ref.eq` and
   gains no vtable slot. The exact-class test passes the same object at
   once and otherwise tests the receiver against the declaring class's
   subtree; comparing vtables would be shorter, but reading the field
   keeps every class's vtable global alive where nothing else does.
4. **Equality through interfaces and anyref.** Done, with a type-test
   chain (see
   [Equality through interfaces and anyref](#equality-through-interfaces-and-anyref)).
5. `contains`/`includes` land with the collections work that needs
   them; nothing blocks on them.

## Open questions

1. `operator ==` overloads with other parameter types, such as an
   operator that takes an interface and accepts every implementation
   (`tests/language/semantics/classes/operators/operator-eq-operand.zena`).
   Only the overload whose parameter is the declaring class overrides
   the root slot. Whether the others stay as statically dispatched
   overloads or are disallowed is undecided.
2. Deep equality for collections (`Array<T> == Array<T>`) — wants
   conditional conformance (`Array<T> implements Equatable when
T extends Equatable`); until then, explicit helpers.
3. Ordering (`Comparable` with `this`) — same shape as `Equatable`;
   design when sorting APIs need it.
4. Naming: `includes` vs `containsSame`.
