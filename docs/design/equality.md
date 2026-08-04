# Equality, Identity, and Hashing

Status: **Proposed** (decided direction; sequencing in
[row-types.md](row-types.md) §9)

This document records the equality overhaul decided alongside the
records-are-value-types decision ([records-and-tuples.md](records-and-tuples.md)
§3.1): what `==` and `===` mean, the `Equatable`/`Hashable` interface
hierarchy, how generic code requires equality, and why there is no
fallback from `==` to reference equality. Identity-_keyed_ containers
(IdentityMap, WeakMap) are the constructive counterpart, designed in
[weak-references.md](weak-references.md).

The one-sentence rule the design optimizes for:

> **`==` is the type's declared equality (values always have one;
> classes declare one); `===` is identity and always works on classes;
> hashing is always declared.**

## 1. Current state (precise)

- `==` is structural on records/tuples/strings/primitives; on classes it
  calls `operator ==` **if declared, and silently falls back to
  reference equality otherwise** (`stdlib/hashable.zena:6` documents
  this). Case classes derive structural `==`/`hashCode`.
- `===` is reference equality, bypassing `operator ==`
  (language-reference §Comparison Operators). It currently works on
  records and observes identity through width adaptation — see
  records-and-tuples.md §3.1 for the tests that pin this and the
  decision that retires it.
- `HashMap`/`HashSet` keys require `Hashable`, enforced by
  checker special-casing; the case-class `hashCode`/`==` divergence in
  BUGS.md is an instance of the incoherence this document eliminates.

## 2. Decisions

### D1 — `===` is identity, and exists only where identity does

`===`/`!==` on record- or tuple-typed operands is a **compile error**
(records-and-tuples.md §3.1). On classes, `===` remains reference
equality and is total — every class has identity.

### D2 — no fallback: `==` on classes requires declared equality

`a == b` where the operands are class-typed is valid **only if** the
class declares `operator ==` (or derives it, as case classes do).
Otherwise it is a compile error whose message names both fixes:

```
error: `Session` does not declare equality.
  Use `===` to compare identity, or implement `operator ==`
  (e.g. `with IdentityEquality` for declared identity-equality).
```

Why no fallback (each of these is a bug class the fallback causes):

1. **Refactoring stops changing behavior silently.** Today, _adding_
   `operator ==` to a class flips every existing `==` call site from
   identity to structural with no diagnostic anywhere. Under D2, adding
   the operator only makes previously-erroring code compile.
2. **Hashable coherence becomes checkable.** `hashCode` claiming
   structural while `==` silently means identity (or vice versa) is how
   hash containers break probabilistically (BUGS.md). With
   `Hashable extends Equatable` and no implicit `==`, the pair is
   declared together and the checker can hold them to it.
3. **Call sites become legible.** `==` always means "this type's
   declared equality"; a reader never has to hunt for whether an
   operator exists somewhere to know what an expression does. Silent
   wrong answers (a `contains` that misses an equal-but-not-identical
   element) are the most expensive kind.
4. **Generic contracts become honest** (D4): `contains` states that it
   requires equality instead of quietly degrading to pointer comparison
   for some element types.

A class whose equality _is_ identity says so explicitly, once:

```zena
class Session {
  operator ==(other: This): boolean => this === other;
}
// or, via a stdlib mixin that provides exactly that operator:
class Session with IdentityEquality {}
```

The conditional-fallback _pattern_ ("structural if defined, identity
otherwise") thus survives as a per-class declaration; only the
invisible version is removed.

Precedent: Swift (`==` requires `Equatable`) and Rust (`PartialEq` is
explicit) are the no-fallback camp; Java/Kotlin (`equals` defaults to
identity on `Object`/`Any`) are the fallback camp, and the
`.equals`-vs-`==` confusion plus forgot-to-override bugs are the
result.

### D3 — `Equatable` and `Hashable` as interfaces

```zena
interface Equatable {
  operator ==(other: This): boolean;
}

interface Hashable extends Equatable {
  hashCode(): i32;
}
```

- The `This`-typed parameter ([this-type.md](this-type.md)) makes
  `==` a **binary method**: `Equatable` is usable as a generic _bound_,
  not as a runtime existential type — two values statically typed
  "some Equatable" cannot be compared, because their `This`es may
  differ. This matches Swift's `Self`-constrained protocols and Rust's
  non-object-safe `PartialEq`, and it is not a limitation in practice:
  bound-dispatch monomorphizes to direct calls.
- **Values conform by derivation.** Records, tuples, strings, and
  primitives get automatic structural `Equatable`/`Hashable`
  conformance, per shape, monomorphized. This formalizes the checker
  special-casing that `HashMap` keys already rely on. (Records cannot
  nominally implement interfaces — records-and-tuples.md §8.3 — so
  derivation is the only mechanism, and the right one.)
- **`This`, not f-bounds.** The f-bounded encoding
  (`Equatable<T extends Equatable<T>>`) solves the same
  self-referencing-signature problem with more boilerplate and the
  ability to mis-instantiate (`implements Equatable<SomethingElse>`).
  F-bounded polymorphism remains planned for the patterns `This` cannot
  express; equality, ordering, and hashing use `This`.

### D4 — conditional API via member-level `where` bounds

Zena extensions are deliberately **non-ambient** (the extension type
must be the static type), so Rust-style
`impl<T: PartialEq> Vec<T> { contains }` has no direct analogue.
The mechanism instead: a bound on the _class's_ type parameter declared
at the _member_ level:

```zena
class Array<T> {
  contains(value: T): boolean where T extends Equatable { ... }
}
```

- `Array<Session>` (no declared equality) simply has no `contains`; a
  call errors at the call site naming the unsatisfied bound. This fits
  the compiler's member-granular reachability: un-called conditional
  members are never instantiated.
- The `where` clause is what turns a late, deep,
  C++-template-style body error ("no `==` for `Session`" inside
  `contains` during specialization) into a declared, early,
  well-attributed contract.
- Granularity guidance: bounds go on the **class** when every operation
  needs them (`HashMap<K extends Hashable, V>`) and on the **member**
  when only some do (`Array.contains`). Mixin and interface-default
  members carry `where` the same way (`IterableUtils<T>` from
  iterable-methods.md gets `contains where T extends Equatable`).
- Until `where` lands (it rides the A1 bounds work, row-types.md §9),
  free functions with ordinary bounds are the interim:
  `<T extends Equatable>(arr: Array<T>, v: T) => ...`.
- **Conditional conformance** (`Array<T> implements Equatable when
T extends Equatable`, Swift-style) is the heavyweight generalization —
  deferred until an interface-level need (e.g. deep `==` on
  collections) forces it.

### D5 — `contains` vs `includes`: two total operations, honestly named

There is no unconstrained `areEqual<T>` and no capability-probing
(`if (a is Equatable)`) — the latter cannot typecheck (both operands
being Equatable does not make them _mutually_ comparable; the binary
method problem), and the former has no coherent contract. Instead,
collections expose both real operations:

```zena
class Array<T> {
  contains(value: T): boolean where T extends Equatable { ... }  // declared equality
  includes(value: T): boolean { ... }  // identity (ref.eq); classes and anyref
}
```

- `includes` deliberately takes the **JS name and the JS semantics**:
  `Array.prototype.includes` is identity (SameValueZero) on objects,
  and JS developers already hold that. It is total on reference-typed
  elements — `Array<Listener>`, `Array<anyref>` — with zero bounds and
  zero ceremony. On value-typed elements it is a compile error
  (identity does not exist there), which is the error that points at
  `contains`.
- `contains` requires `Equatable` and errors on `Array<anyref>` —
  correctly. The tempting alternative (fallback `==`) would compile
  and be **wrong**: Zena's `operator ==` is statically dispatched, so
  fallback-`==` at static type `anyref` compares _boxed strings and
  records by pointer_, silently. "It should just work" there is a bug
  wearing a friendly face. (Making it actually work would require a
  universal dynamically-dispatched `equals` slot on every class —
  Java's `Object.equals` — and D6 shows the hashing half of that model
  is unimplementable on this target anyway.)
- Predicate forms (`some((x) => ...)`, per iterable-methods.md) cover
  everything bespoke.

### D6 — identity hashing is opt-in by necessity, and injected on demand

Wasm GC provides `ref.eq` but **no identity-hash primitive and no
addresses** — the Java model ("every object is a hash key via
`identityHashCode`") would require a hidden hash field on _every_
object or a side table. Therefore:

- `Hashable` is **opt-in for classes, permanently**, on this target.
- Identity-keyed containers (IdentityMap, WeakMap) are still fully
  supported — via **compiler-injected per-class hash fields**, scoped
  to exactly the class hierarchies used as keys. Mechanism, bounds, and
  the inverted-WeakMap design live in
  [weak-references.md](weak-references.md).

### D7 — the dynamic escape hatch is explicit

Code that genuinely needs heterogeneous runtime equality (test
frameworks, debug printers, mixed caches) opts into the Java model
deliberately via a stdlib interface with an erased parameter and an
internal type test:

```zena
interface DynEquatable {
  equals(other: anyref): boolean;
}
```

Nothing in the core language or collections uses it. Relatedly,
`zena:test`'s assertions split honestly:
`assertEquals<T extends Equatable>` and `assertSame` (`===`).

## 3. Migration

Per the sequencing plan (row-types.md §9):

- **V0 (both compilers, now):** ban `===`/`!==` on record/tuple
  operands; convert the two identity execution tests to expected-error
  tests; create `tests/language/semantics/records/`. Cheap contraction;
  freezes the contract before more code grows on it.
- **V1 (survey, then both compilers or at retirement):** the D2
  no-fallback rule. Prerequisite: survey compiler + stdlib for bare
  `==` on class operands (each hit becomes `===` or gains an
  operator/derive/mixin); the survey size decides the landing slot.
  D3's interfaces and derived conformance land with it (formalizing the
  Hashable special-case). D4's `where` rides the A1 bounds work.
- `contains`/`includes` (D5) land with the collections work that needs
  them; nothing blocks on them.

## 4. Open questions

1. Naming: `IdentityEquality` mixin; `includes` vs `containsSame`;
   `DynEquatable`.
2. Should `operator ==` derivation be offered for ordinary classes
   (`with StructuralEquality`, field-wise), or only case classes?
   (Lean: offer the mixin; field-wise derive is what case classes
   already do.)
3. Ordering (`Comparable` with `This`) — same shape as `Equatable`;
   design when sorting APIs need it.
4. Deep equality for collections (`Array<T> == Array<T>` when
   `T extends Equatable`) — wants conditional conformance (D4's
   deferred generalization); until then, explicit helpers.
