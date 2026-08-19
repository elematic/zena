# Non-Nullable WASM References

Zena's checker distinguishes `T` from `T | null`, but codegen has
historically widened both to nullable wasm references. Precise types
matter at the uses: a read of a nullable-typed slot whose IR type is
non-null costs an explicit `ref.as_non_null` (a compare-and-trap the
engine cannot fold into a dereference), and nullable declared types
pessimize engine-side null-check elimination, `call_ref` handling, and
inlining.

The work splits by storage kind:

- **Signature params and returns** are precise already — `typeToValType`
  maps `T` to `(ref $T)` and only `T | null` to `(ref null $T)`.
- **Locals** are precise since the init-discipline typing in
  [ir.md §12.1](ir.md): emission replays the validator's scoped
  init-tracking and declares every local that passes at its precise
  non-null type. The residue (conditional-join values) waits on typed
  labels, also §12.1.
- **Struct fields** are the remaining leg, and this document's subject.

## Fields today

`Specializer.registerSpecializedClass` registers every class field
nullable and mutable regardless of its declared type
(specialization.zena):

```zena
let nullableValType = match (valType) {
  case ValTypeRef {target}: new ValTypeRefNull(target)
  case _: valType
};
let wf = new WasmField(fName, nullableValType, true);
```

The widening exists because construction is allocate-then-mutate:
`new C(...)` lowers to `struct.new_default` plus a vtable `struct.set`
(`#instanceShell` in lowering.zena), then a call to `$C.<constructor>`
which stores field defaults, the initializer list, and `this.` params
into the shell with `struct.set`, calls the super constructor on the
same shell, and runs the body. `struct.new_default` requires every
field defaultable, so a non-null reference field cannot exist under
this protocol.

Records and tuples already register precise, immutable fields — they
construct with `struct.new` in one shot. Classes are the exception.

The cost, measured on the compiler's own module after the locals leg
landed: 15,530 of the 31,951 remaining `ref.as_non_null` re-asserts
(49%) immediately follow a `struct.get`. Every constructor field store
also pays a `local.get $this` + `struct.set` pair that a `struct.new`
operand would not, and the per-allocation vtable store pays a
`global.get` + `struct.set` where an operand would pay only the
`global.get`.

## Language rules already in place

The construction semantics were designed for single-shot allocation,
and the checker enforces all three preconditions today (verified
against the current compiler):

- Initializer lists (including desugared `this.x` params) cannot
  reference `this` — "the object doesn't exist yet"
  (language-reference.md, Initializer Lists).
- Immutable fields have no setter: `this.x = 2` on a `let` field in a
  constructor body is rejected ("Cannot assign to read-only property"),
  so bodies only ever write `var` fields.
- A non-nullable field with neither an inline initializer nor a
  constructor assignment is rejected ("Field 'b' must be initialized").

So every value a `let` field will ever hold, and the first value of
every `var` field, is computable before allocation, with no `this` in
scope.

## Construction protocol

Constructors reshape from mutate-a-shell to compute-then-allocate.
Three function roles per class, all lowered from the same constructor
AST in the class's own module (no cross-module inlining):

- **`$C.<constructor>` — the factory.** Signature changes from
  `(this, args...) -> ()` to `(args...) -> (ref $C)`; `new C(...)`
  sites call it and use the result. It evaluates C's own field
  defaults and initializer list into SSA values (no `this` exists
  yet), evaluates the `super(...)` arguments, then drives the ancestor
  chain:

  ```
  factory C(argsC):
    cVals, argsB  = C's defaults + initializer list; super args   (inline)
    (bVals..., argsA...) = call $B.<init>(argsB)
    (aVals...)           = call $A.<init>(argsA)
    this = struct.new $C (vtableGlobal, aVals..., bVals..., cVals...)
    call $A.<ctorBody>(this, argsA...)      (only if A's ctor has a body)
    call $B.<ctorBody>(this, argsB...)
    C's body                                 (inline)
    return this
  ```

- **`$B.<init>` — a superclass's value phase.** Signature
  `(args...) -> (ownFieldValues..., evaluatedSuperArgs...)`: the
  class's field defaults and initializer list, in its own-struct field
  order, plus the arguments it evaluates for _its_ super constructor.
  Returning the super args is what lets the factory continue the chain
  and later hand `$A.<ctorBody>` the same values — each level's
  constructor arguments are evaluated exactly once. Minted only for
  classes that are the superclass of some instantiated class.

- **`$B.<ctorBody>` — a superclass's body phase.** Signature
  `(this, args...) -> ()`: just the constructor body statements, which
  run post-allocation and may write `var` fields, call methods, and
  escape `this`. Minted only when the constructor has a body.

The leaf level always inlines into its factory, so a depth-1 class
(the common case) costs one call per `new`, the same as today. Each
ancestor level costs one `<init>` call plus one `<ctorBody>` call when
a body exists, against one constructor call per level today. A
non-abstract base that is both instantiated and extended carries its
init code twice (inline in its own factory, and as `<init>` for
subclass factories).

Fields with no initializer and no constructor assignment — nullable
references, numerics — fill their `struct.new` slot with the type's
default, preserving `struct.new_default` semantics.

### Evaluation order

Observable side-effect order is unchanged for written constructors.
Today: C defaults, C initializer list, super args, then recursively
B's prologue and body, then C's body. Under the factory: identical —
the allocation moves from before everything to after all value
phases, and allocation itself has no observable effects.

Synthesized default constructors change order to match the documented
semantics: today they call super _first_ and store their own defaults
after, which contradicts the language reference's "subclass fields are
initialized before the superclass constructor runs". Under the
factory, default-constructor classes evaluate their own defaults
first like every other class. Observable only when field default
expressions have side effects ordered against an ancestor's.

### Field type and mutability flip

With single-shot allocation in place, registration drops the
widening:

- Field type = `typeToValType` of the checker type, exactly: `T` →
  `(ref $T)`, `T | null` → `(ref null $T)`. Type-parameter fields
  keep their erased (nullable) encodings.
- `isMutable` = the checker's `FieldInfo.isMutable` (`var` fields
  only). Wasm immutable fields unlock engine CSE of `struct.get` and
  are covariance-capable in subtypes, though this design keeps field
  types invariant across a hierarchy.
- The `<vtable>` field keeps its current nullable, mutable encoding
  for now; its value becomes a `struct.new` operand rather than a
  post-allocation store. Flipping it non-null (and covariant per
  class) is a separate follow-up.
- `ErasedFieldBake` re-resolution (a class-typed field registered
  before its class) preserves the precise nullability when it
  re-resolves.

`struct.get` of a non-null field then has a non-null IR result type,
and the emitter's existing machinery stops re-asserting — no emission
changes needed.

### Internal allocators

Compiler-synthesized structs keep `struct.new_default` and stay fully
defaultable: generator and async frames, closure contexts, heap cells.
The scaffold's string construction switches to `struct.new` with its
already-computed values, since `String` is an ordinary class whose
fields flip.

Erased specializations register structs but no constructor today; they
likewise get no factory. Abstract classes get `<init>`/`<ctorBody>`
but no factory (no `new` sites exist).

## Results

On the compiler's own module: the protocol swap alone (fields still
nullable) took the self-compile from 2,021,549 to 1,984,066 bytes
(−1.9%) — the per-field `local.get $this` + `struct.set` pairs and
the per-allocation vtable stores collapsing into `struct.new`
operands. The field flip took it to 1,952,219 (−3.4% total), with
`ref.as_non_null` count falling from 31,951 to 16,731; nearly all of
the residue is the conditional-join locals, which wait on typed
labels (ir.md §12.1 mechanism 4). Engine-side, non-null immutable
fields are the representation V8 and wasmtime optimize best.

## Testing

- Portable execution tests: constructor evaluation order across a
  hierarchy (side-effecting initializers), super bodies calling
  virtual methods that read subclass fields, `var` field writes in
  bodies, defaults + initializer-list overwrite semantics, mixin
  field defaults, case classes, sealed variants.
- WAT invariants: a class with non-null `let` fields declares
  `(field (ref $T))` (immutable), and a reader function contains no
  `ref.as_non_null` after `struct.get`; a `T | null` field stays
  `(ref null $T)`.
- The full suite plus stage-2 byte parity gate the protocol swap; the
  whole self-compile must validate under wasm-tools.
