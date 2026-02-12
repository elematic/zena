# Pattern Exhaustiveness for Composite Types

**Status**: Proposed  
**Created**: 2026-02-12

## Problem

The current exhaustiveness checker uses **type subtraction** to track remaining
uncovered types. This works well for top-level patterns:

```zena
enum Status { Pending, Done }

match (status) {
  case Status.Pending: "waiting"
  case Status.Done: "finished"
}  // ✓ Exhaustive - Status - Pending - Done = Never
```

However, it fails for **composite types** (tuples, records) containing enums:

```zena
match (task) {  // task: {status: Status, id: i32}
  case {status: Status.Pending}: "pending"
  case {status: Status.Done}: "done"
}  // ✗ Currently reports non-exhaustive, but should be exhaustive
```

### Root Cause

The current `subtractType` for `RecordPattern` checks if each field's remainder
equals `Never`. But `subtractType(Status, Status.Pending)` returns a modified
`Status` type containing only `Done`—not `Never`. So the check fails.

The correct remaining type after matching `{status: Status.Pending}` should be
`{status: Status.Done, id: i32}`, but this requires proper type algebra for
composite types.

## The Combinatorial Explosion Concern

Naive enumeration doesn't scale:

```zena
// {a: A|B, b: C|D, c: E|F} has 2³ = 8 value combinations
// {a: enum(10), b: enum(10), c: enum(10)} has 10³ = 1000 combinations
```

Tracking all combinations explicitly leads to exponential blowup.

## Solution: Usefulness Algorithm

The standard solution (used by Rust, OCaml, Haskell, Swift) is the **usefulness
algorithm** from Maranget's 2007 paper "Warnings for Pattern Matching".

### Key Insight

Instead of asking "what types remain after these patterns?", ask:

> "Is there ANY value that matches pattern P but doesn't match any previous
> pattern in the matrix?"

This can be checked **symbolically** without enumerating combinations.

### Algorithm Sketch

1. Represent patterns as a **matrix** (rows = patterns, columns = positions)
2. To check if pattern `p` is **useful** against matrix `P`:
   - If `P` is empty: `p` is useful (matches something)
   - If `p` is all wildcards and `P` has a row of all wildcards: not useful
   - Otherwise: **specialize** on the first column's constructors and recurse
3. **Specialization**: For constructor `c`, filter to rows that match `c` and
   remove the first column, then recurse on remaining columns

### Example

```
Matrix P:              Pattern p:
[ Pending, _    ]      [ Done, _ ]
```

Specialize on `Done`:

- Row 1 doesn't match `Done`, filtered out
- Matrix becomes empty
- `p` is useful ✓

After adding `p`:

```
Matrix P:              Pattern p:
[ Pending, _ ]         [ _, _ ]  (wildcard)
[ Done, _    ]
```

Specialize on `Pending`: `[ _ ]` vs `[ _ ]` → not useful
Specialize on `Done`: `[ _ ]` vs `[ _ ]` → not useful
All constructors covered → `p` is not useful (unreachable)
And the match is exhaustive.

## Complexity

The usefulness algorithm is **O(n × m × s)** where:

- n = number of patterns
- m = max pattern depth
- s = sum of constructor arities

This is polynomial, not exponential, because we never enumerate all value
combinations—we work symbolically with constructors.

## Implementation Plan

### Phase 1: Refactor to Usefulness-Based Checking

Replace the current subtraction approach with:

1. **Pattern Matrix**: Represent match arms as a matrix of patterns
2. **Usefulness Check**: For each new pattern, check if it's useful
3. **Exhaustiveness Check**: Check if a wildcard pattern would be useful
   - If yes: match is non-exhaustive
   - If no: match is exhaustive

### Phase 2: Handle All Pattern Types

Extend the algorithm to handle:

- [x] Literal patterns (already work via type subtraction)
- [x] Enum member patterns (already work at top level)
- [ ] Tuple patterns
- [ ] Record patterns
- [ ] Nested patterns (patterns containing patterns)
- [ ] Or-patterns (if we add them)

### Phase 3: Good Error Messages

When a match is non-exhaustive, generate **witness** values:

- "Non-exhaustive match. Missing cases: `{status: Status.Done, id: _}`"

The usefulness algorithm can be adapted to generate witnesses by tracking which
constructors were NOT covered during specialization.

## References

1. Maranget, L. (2007). "Warnings for Pattern Matching". Journal of Functional
   Programming, 17(3), 387-421.
2. Rust implementation:
   https://github.com/rust-lang/rust/blob/master/compiler/rustc_pattern_analysis/

3. "How OCaml type checker works" (exhaustiveness section):
   https://okmij.org/ftp/ML/generalization.html

## Alternatives Considered

### Keep Type Subtraction, Add Composite Support

We could extend `subtractType` to handle composites:

- `subtract({a: A|B}, {a: A}) = {a: B}`
- `subtract((A|B, C|D), (A, C)) = (A, D) | (B, C) | (B, D)`

This works but requires representing union types for records/tuples, which we
don't currently have. It also makes the "remaining type" in error messages
complex and potentially exponential in size.

### Limit Exhaustiveness to Simple Cases

TypeScript's approach: only check exhaustiveness for simple discriminated unions
(switch on a single tag field). Don't attempt composite exhaustiveness.

**Rejected** because Zena aims for stronger type safety, and the usefulness
algorithm is well-understood and tractable.

## Current Status

Tests are skipped with TODOs in `match_exhaustiveness_test.ts`:

- `should pass for exhaustive enum in tuple` - SKIPPED
- `should report error for non-exhaustive enum in tuple` - SKIPPED
- `should pass for exhaustive enum in record` - SKIPPED
- `should report error for non-exhaustive enum in record` - SKIPPED
