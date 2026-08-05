# Result and Option as Inline Unions

## Summary

[component-model.md](./component-model.md) Part 8a records the decision that
`Result<T, E>` is an inline multi-value union, not a heap type:

```zena
type Result<T, E> = inline (true, T, _) | inline (false, _, E);
type Option<T> = inline (true, T) | inline (false, _);
```

This doc answers the three questions that decision opens:

1. Why keep the boolean tag — why not discriminate on which slot is a hole?
2. How does the error arm bind? What do other languages do here?
3. What operator sugar (`??`, error forwarding) should exist over these shapes?

## 1. The tag stays

The alternative considered was dropping the boolean and discriminating on which
payload slot is occupied:

```zena
type Result<T, E> = inline (T, _) | inline (_, E);   // rejected
```

Rejected for three independent reasons:

**Holes are only observable in reference slots.** A hole lowers to null only
when the merged slot type is a reference (`mapUnionOfInlineTuplesToWasmResults`
makes a lane nullable iff some member has a hole there and the lane is a ref
type). A numeric lane has no null: in `Result<_, ErrorCode>` with an `i32`-repr
error code — WIT's single most common result form, 117 of 291 occurrences in
the pinned WASI trees — both arms would be indistinguishable at runtime.
The untagged form only works when both payloads happen to be non-nullable
reference types.

**Nullable payloads are ambiguous.** `Result<T?, E>` cannot distinguish
ok-with-null from err. This is the same reason `Option<T>` is not `T | null`:
the encoding collapses at one level of nesting.

**Patterns refute on literals, not on holes.** Refutation in patterns is
literal-driven (`true`, `false`, numbers, strings, `null`); there is no "this
slot is occupied" pattern. The untagged form would have to be matched as
`let (v, null) = f()` — which again only exists for reference slots, and reads
as a claim about the error rather than about success.

The tag costs one `i32` lane in a multi-value result — a register, never an
allocation. It is also the shape the narrowing machinery already understands
(`patternCanMatchType` handles `BooleanLiteral` refutation today) and the shape
the iterator protocol already ships.

**Why three slots, not two.** `inline (true, T) | inline (false, E)` would put
`T` and `E` in the same lane. Lane merging assigns one wasm valtype per lane
across all union members; `T` and `E` share a lane only if they share a
representation (impossible for numeric-vs-reference, and a cast on every access
otherwise). Holes keep every lane type-homogeneous — the payload lane is always
`T`-or-hole, the error lane always `E`-or-hole — which is what makes the merged
signature well-defined for arbitrary `T`, `E`.

## 2. Binding the error arm

The documented idiom binds only the ok arm:

```zena
if (let (true, v) = f()) { use(v); }
// the error is unreachable from here
```

### Precedent

|       | representation                     | ok-arm sugar                                    | error-arm binding                                                                                 |
| ----- | ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Rust  | boxed-ish enum (niche-optimized)   | `if let Ok(v)`, `let … else`, `?`               | `match` arms only — `if let`'s `else` and let-else bind nothing (RFC 3137 explicitly excludes it) |
| Swift | enum                               | `if case .success(let v)`, `guard case`, `try?` | `switch` arms; or `do { try r.get() } catch let e` — `catch` _is_ an else-arm with a binding      |
| Zig   | unboxed error union (tagged value) | `if (f()) \|v\|`, `orelse`, `try`               | `if (f()) \|v\| { … } else \|e\| { … }`; `catch \|e\| expr`                                       |

Two observations fall out of the survey:

**Rust and Swift can afford to refuse else-bindings** because their result
types are storable: the universal escape hatch is _bind the scrutinee to a
local, then `match`/`switch` it_, and each arm binds its own payload. Zena's
inline tuples cannot be stored in a local, so that escape hatch does not exist
here. Whatever consumes both arms must do so in a single construct applied
directly to the call.

**The language whose result type is shaped like ours is the one that grew
else-bindings.** Zig's error unions are unboxed tagged values — the closest
existing cousin of an inline tuple union — and Zig ended up with exactly the
construct in question (`else |err|`) plus a small operator suite over it
(`orelse`, `catch`, `try`). That is precedent not just for the feature but for
the shape of the whole consumption surface.

### Recommended forms

These are layered; the first is required, the rest are ergonomics.

**(1) `match` over inline tuple unions** — already recommended in
component-model.md Part 8a. General, exhaustive (two literal-tagged arms
provably cover the union), and per-arm narrowing means no correlated-narrowing
machinery is needed:

```zena
match (f()) {
  case (true, v, _): use(v)
  case (false, _, e): handle(e)
}
```

**(2) An else-binding for `if (let …)`** — the Zig form in Zena spelling:

```zena
if (let (true, v, _) = f()) {
  use(v);
} else let (false, _, e) {
  handle(e);
}
```

- _Checking:_ the else pattern is checked against the **residual type** — the
  scrutinee's union minus what the first pattern matched. The subtraction
  already exists (`subtractPatternFromType`, used for match exhaustiveness).
  For a two-variant union the else pattern is irrefutable against the residual;
  a refutable else pattern could chain (`else let … else let … else`) for
  wider unions, though `match` is probably the better spelling at that point.
- _Lowering:_ `lowerLetCondition` already materializes the multi-value lanes in
  temps before testing the tag; the else binds read the same temps. No
  re-evaluation, no new codegen shape — only new binds in the else block.
- The `while (let …)` form needs no else-binding: the iterator protocol's false
  arm carries nothing. This feature is motivated by `Result` specifically.

**(3) Operator sugar** — proposed direction, not yet designed in detail:

- **`??` over inline unions.** `m.get(k) ?? fallback` — a tag test instead of
  a null test, yielding `T`. Precedent is direct: Swift's `??` is defined on
  `Optional` (a tagged enum), not on null pointers; Zig spells it `orelse`.
  For `Result` it discards the error (Rust's `unwrap_or`). Typing:
  `(inline (true, T, _) | inline (false, _, E)) ?? U → T | U`.
- **An error-binding coalesce** (Zig's `catch |e| expr`) — useful, spelling
  open (`f() ?? (e) => fallback(e)`?). Can be deferred; (1)/(2) cover it.
- **A forwarding operator** — Rust's `?`, Zig's `try`:

  ```zena
  let fd = openAt(path)?;
  // ≡ match (openAt(path)) {
  //     case (true, v, _): v
  //     case (false, _, e): return (false, _, e)
  //   }
  ```

  This composes unusually well with Zena's position restriction: the desugar's
  early exit is a `return` of an inline tuple — precisely the one position
  inline tuples are allowed to occupy. Requires the enclosing function to
  return `Result<_, E2>` with `E` assignable to `E2` (Rust inserts a
  `From` conversion here; plain subtyping is the right starting point).

## 3. Relation to the boxed `Option` in the stdlib

`Some<T>` / `None` / `Option<T>` in `stdlib/zena/option.zena` remain: inline
tuples cannot be stored in fields, locals, arrays, or parameters, so any
_stored_ optional still needs the boxed form. The stdlib already lives this
split — `Map.get` returns the inline union, `Map.getOption` returns the boxed
`Option` — and it mirrors component-model.md Part 8a's recommendation (c) for
WIT: the inline union is _the_ `Result`/`Option` in return position, and
boxing happens explicitly at the boundary where a value must outlive the
return. If inline `Option<T>` gets an alias in the stdlib, the boxed type
should probably be renamed or demoted to keep one name meaning one thing;
that rename is out of scope here.
