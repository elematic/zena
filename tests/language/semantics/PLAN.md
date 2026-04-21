# Portable Semantics Test Plan

This document outlines the directory structure and test groups for portable
semantics tests in `tests/language/semantics/`. These tests are `.zena` files
with `// @error:` directives that both the TypeScript compiler and the
self-hosted checker can run against.

## Conventions

- Each `.zena` file tests ONE type-checking behavior (small, focused).
- Files are auto-detected as `// @mode: check` when under `semantics/`.
- File names are `kebab-case` with underscores for compound names.
- Directories group related constructs into suites.
- **Error tests** use `// @error: pattern` on the line that should produce an error.
- **Warning tests** use `// @warning: pattern` on the line that should produce a warning.
- **Positive tests** have no `// @error:` — they must produce zero errors.
- Error patterns are **regex** in the bootstrap runner and **substring** in the
  self-hosted runner. Use simple substrings that work for both.

## Test Format

### Error tests (checking that bad code is rejected)

```zena
// @mode: check
let x: i32 = "hello"; // @error: Type mismatch
```

### Positive tests (checking that valid code type-checks)

```zena
// @mode: check
let add = (a: i32, b: i32): i32 => a + b;
let result: i32 = add(1, 2);
```

### Type inference tests (proposed `// @type:` directive)

Many bootstrap checker tests verify the _inferred type_ of an expression — not
just that it's error-free. The current portable format can't express this. We
propose a `// @type:` directive:

```zena
// @mode: check
let x = 42;           // @type: i32
let y = 3.14;         // @type: f64
let z = true;         // @type: true
var w = true;          // @type: boolean
```

The runner would:

1. Parse the source and run the checker.
2. For each `// @type: <expected>` comment, find the nearest preceding
   expression or variable declaration on that line.
3. Compare the inferred type's display string against `<expected>`.

This covers the most important class of tests that _can't_ be expressed as
error tests — verifying that the checker infers the right type. Implementation:

- **Bootstrap runner**: Access `node.inferredType`, format it as a string, compare.
- **Self-hosted runner**: Access `SemanticModel.getType(offset)`, format as string, compare.

**Note**: This is a proposed extension. Tests marked `[needs @type]` below are
blocked on this. In the meantime, many can still be approximated as positive
tests (no errors) or negative tests (assigning to wrong type produces an error).

## Bootstrap Tests to Port

The bootstrap compiler has **~600 tests** across **62 files** in
`packages/compiler/src/test/checker/`. Most test error diagnostics and can be
ported directly. Tests that assert on `inferredType` programmatically need
either the `// @type:` directive or creative reformulation as error tests.

## Porting Workflow

1. Create the `.zena` file in the appropriate `tests/language/semantics/` directory.
2. Run `npm test -w @zena-lang/compiler` to verify it passes the bootstrap checker.
3. Run `npm test -w @zena-lang/zena-compiler` to verify it passes the self-hosted checker.
4. If the self-hosted checker fails, either fix the checker or mark the test as
   known-failing (skip list in `portable_test.zena`).

## Status Key

- **[done]** — Portable test already exists
- **[ts]** — Covered in bootstrap checker tests, needs porting
- **[new]** — Not currently tested anywhere, needs new tests
- **[needs @type]** — Requires `// @type:` directive to port properly

## Priority Ordering

Tests are ordered by:

1. **Already implemented in self-hosted checker** — port these first, they should pass both runners immediately.
2. **Partially implemented** — port to define expected behavior, fix self-hosted checker to pass.
3. **Not yet implemented** — port to define the target, implement in self-hosted checker later.

---

## Directory Structure

```
tests/language/semantics/
│
├── variables/
│   ├── let-inferred.zena                       [done]
│   ├── let-with-annotation.zena                [done]
│   ├── let-type-mismatch.zena                  [done]
│   ├── let-reference.zena                      [done]
│   ├── var-widens-literals.zena                [done]
│   ├── undeclared-variable.zena                [done]
│   ├── var-assignment.zena                     [done] — var x = 1; x = 2; (valid)
│   ├── let-reassignment-rejected.zena          [done] — let x = 1; x = 2; (error)
│   ├── infer-from-function-call.zena           [done]
│   ├── infer-from-string.zena                  [done]
│   ├── infer-from-boolean.zena                 [done]
│   ├── destructure-record.zena                 [done] — smoke: let {x, y} = rec; x, y have correct types
│   └── destructure-tuple.zena                  [done] — smoke: let (a, b) = tup; a, b have correct types
│
├── operators/
│   ├── arithmetic-i32.zena                     [done]
│   ├── arithmetic-f32.zena                     [done]
│   ├── arithmetic-type-error.zena              [done]
│   ├── bitwise.zena                            [done]
│   ├── comparison.zena                         [done]
│   ├── unary.zena                              [done]
│   ├── mixed-arithmetic/
│   │   ├── i32-f32-allowed.zena                [done] — f32 + i32 → f32, also comparison
│   │   ├── comparison-allowed.zena             [done] — mixed i32/f32 comparison
│   │   └── bitwise-mixed-rejected.zena         [done] — f32 & i32 error
│   ├── u32/
│   │   ├── basic-ops.zena                      [done] — u32 arithmetic
│   │   ├── comparison.zena                     [done]
│   │   ├── bitwise.zena                        [done]
│   │   ├── mixed-i32-rejected.zena             [done] — u32 + i32 error
│   │   └── cast.zena                           [done] — u32 as i32
│   ├── compound-assignment/
│   │   ├── basic.zena                          [done] — +=, -=, *=, %=, /=
│   │   ├── type-error.zena                     [done] — string += i32 error
│   │   ├── string-concat.zena                  [done] — string += string
│   │   ├── immutable-rejected.zena             [done] — let x = 1; x += 1; error
│   │   └── nullish-assign.zena                 [done] — ??= with narrowing
│   ├── is-operator.zena                        [done] — is with subclass, union, nullable
│   ├── null-coalescing.zena                    [done] — ?? removes null, chained
│   ├── nullish-unnecessary.zena                [done] — ?? and ??= on non-nullable warns
│   ├── null-comparison.zena                    [done]
│   ├── string-concat.zena                      [done]
│   └── string-concat-type-error.zena           [done]
│
├── functions/
│   ├── basic-function.zena                     [done]
│   ├── return-type-mismatch.zena               [done]
│   ├── wrong-arg-count.zena                    [done]
│   ├── wrong-arg-type.zena                     [done]
│   ├── infer-return-type.zena                  [done]
│   ├── void-return.zena                        [done]
│   ├── recursive-function.zena                 [done]
│   ├── self-recursive-void.zena                [done] — self-recursive with void return type annotation
│   ├── self-recursive-no-return-type.zena      [done] — self-recursive without return type is error
│   ├── forward-ref-void.zena                   [done] — function calls another function defined later
│   ├── forward-ref-inferred.zena               [done] — forward ref with inferred return type
│   ├── forward-ref-no-return-type.zena         [done] — mutually recursive without annotation is error
│   ├── closure-captures.zena                   [done]
│   ├── no-param-annotations.zena               [done] — unannotated params error
│   ├── contextual-typing/
│   │   ├── param-from-annotation.zena          [done] — function type annotation with explicit params
│   │   ├── callback-param.zena                 [done] — callback param inferred from callee type
│   │   └── multi-param.zena                    [done] — multiple callback params inferred
│   ├── optional-params/
│   │   ├── basic.zena                          [done] (optional-param-basic.zena)
│   │   ├── null-union.zena                     [done] (optional-param-null-union.zena)
│   │   ├── pass-null.zena                      [done] (optional-param-pass-null.zena)
│   │   ├── default-value.zena                  [done] — param with default, no T|null widening
│   │   ├── wrong-type.zena                     [done] (optional-param-wrong-type.zena)
│   │   ├── call-without-optional.zena          [done] (in optional-param-basic.zena)
│   │   ├── method.zena                         [done] (optional-param-method.zena)
│   │   └── constructor.zena                    [done] (optional-param-constructor.zena)
│   └── function-type/
│       ├── basic.zena                          [done] (function-type-basic.zena)
│       ├── assignability.zena                  [done] (function-type-basic.zena)
│       ├── param-mismatch.zena                 [done] (function-type-param-mismatch.zena)
│       ├── return-mismatch.zena                [done] (function-type-return-mismatch.zena)
│       └── union-dedup.zena                    [done] (union-dedup-function.zena)
│   ├── destructure-param-record.zena           [done] — smoke: ({x, y}: {x: i32, y: i32}) param destructure
│   └── destructure-param-tuple.zena            [done] — smoke: ((a, b): (i32, String)) param destructure
│
├── control-flow/
│   ├── break-outside-loop.zena                 [done] — break outside loop errors
│   ├── continue-outside-loop.zena              [done] — continue outside loop errors
│   ├── if/
│   │   ├── non-boolean-condition.zena          [done] — non-boolean if condition errors
│   │   ├── if-let.zena                         [done] — if-let with class name pattern
│   │   ├── if-let-class-pattern.zena           [done] — if-let binds identifier to matched value
│   │   ├── if-let-record-pattern.zena          [done] — if-let with record destructure
│   │   ├── if-let-tuple-pattern.zena           [done] — if-let with tuple destructure
│   │   ├── null-check.zena                     [done] — !== null / != null / null !== narrow to non-null
│   │   ├── null-check-else.zena                [done] — else of !== null narrows to null
│   │   ├── nested-null-check.zena              [done] — nested null checks narrow independently
│   │   ├── null-guard-narrowing.zena           [done] — null guard + early return narrows after
│   │   ├── null-assign-narrowing.zena          [done] — if (x==null) x=v and x ??= v narrow after
│   │   ├── logical-and-narrowing.zena          [done] — x != null && x.val narrows right side
│   │   ├── logical-or-narrowing.zena           [done] — else of (a == null || b == null) narrows both
│   │   ├── is-expression.zena                  [done] — is narrows to subclass; else narrows other type
│   │   ├── if-expression-narrowing.zena        [done] — if-expression branches narrow types
│   │   ├── if-expr-throw.zena                  [done] — throw in branch collapses Never from result type
│   │   ├── if-let-narrowing.zena               [done] — if-let fields have the variant's declared types
│   │   ├── field-narrowing.zena                [done] (skip: self-hosted) — immutable vs mutable field narrowing
│   │   └── record-field-narrowing.zena         [done] — record fields narrow after null check
│   ├── for/
│   │   ├── for-loop.zena                       [done] — C-style for with var counter
│   │   ├── for-in-loop.zena                    [done] — for-in with Array<i32>
│   │   ├── for-in-iterator.zena                [done] (skip: self-hosted) — for-in on Iterator<T>
│   │   └── for-in-destructure-map.zena         [done] (skip: self-hosted) — for-in with HashMap entry destructure
│   ├── while/
│   │   ├── while-loop.zena                     [done] — basic while loop
│   │   ├── while-let.zena                      [done] — while (let Pattern = expr) loop
│   │   ├── while-non-boolean-condition.zena    [done] — non-boolean while condition errors
│   │   ├── while-loop-narrowing.zena           [done] — while (x != null) narrows body
│   │   └── while-let-narrowing.zena            [done] — while-let body has variant field types
│   └── match/
│       ├── exhaustive-boolean.zena             [done] — match true/false covers boolean
│       ├── non-exhaustive-boolean.zena         [done] — missing false case errors
│       ├── exhaustive-literal-union.zena       [done] — match all members of string literal union
│       ├── non-exhaustive-literal-union.zena   [done] — missing literal case errors
│       ├── exhaustive-sealed.zena              [done] (in sealed-classes/)
│       ├── non-exhaustive-error.zena           [done] (in sealed-classes/)
│       ├── wildcard-catches-all.zena           [done] (in sealed-classes/)
│       ├── unreachable-case.zena               [done] — case after wildcard is unreachable
│       ├── guard-not-exhaustive.zena           [done] — guard makes case non-exhaustive
│       ├── match-narrowing.zena                [done] — match case body binds destructured fields
│       ├── record-pattern-smoke.zena           [done] — smoke: case {x, y}: fields have correct types
│       └── tuple-pattern-smoke.zena            [done] — smoke: case (n, _): element has correct type
│
├── scoping/
│   ├── block-scope.zena                        [done] — var not visible outside block
│   ├── nested-block-scope.zena                 [done] — nested block var not visible in outer
│   └── block-scope-shadowing.zena              [done] — inner block can shadow outer var
│
├── if-expression/
│   ├── same-type-branches.zena                [done] — both branches same type → that type
│   ├── different-type-branches.zena            [done] — different types → union
│   ├── void-if-no-else.zena                    [ts] — if without else → void
│   ├── nested.zena                             [done] — nested if-expression
│   ├── with-block.zena                         [done] — if { ... } else { ... } expression
│   └── type-error-condition.zena               [done] — non-bool condition (non-boolean-condition.zena)
│
├── classes/
│   ├── basic/
│   │   ├── field-access.zena                   [done]
│   │   ├── method-call.zena                    [done]
│   │   ├── duplicate-field.zena                [done]
│   │   ├── unknown-field.zena                  [done]
│   │   ├── constructor-required.zena           [done]
│   │   ├── constructor-arg-mismatch.zena       [done]
│   │   └── constructor-missing-super.zena      [done]
│   │   └── forward-method-reference.zena       [done]
│   │
│   ├── fields/
│   │   ├── immutable-assignment.zena           [done]
│   │   ├── mutable-assignment.zena             [done]
│   │   ├── field-init-order.zena               [done]
│   │   ├── field-init-required.zena            [done]
│   │   ├── field-type-inference.zena           [done]
│   │   ├── optional-field-primitive.zena       [done]
│   │   ├── optional-field-valid.zena           [done]
│   │   └── private-field-access.zena           [done]
│   │
│   ├── inheritance/
│   │   ├── basic-extends.zena                  [done]
│   │   ├── method-override.zena                [done]
│   │   ├── unknown-superclass.zena             [done]
│   │   ├── extend-interface-rejected.zena      [done]
│   │   ├── invalid-override.zena               [done]
│   │   ├── super-field-access.zena             [done]
│   │   ├── subtype-assignability.zena          [done]
│   │   └── deep-chain.zena                     [done]
│   │
│   ├── abstract/
│   │   ├── cannot-instantiate.zena             [done]
│   │   ├── must-implement.zena                 [done]
│   │   ├── abstract-method.zena                [done]
│   │   ├── partial-implementation.zena         [done]
│   │   └── abstract-field.zena                 [done]
│   │
│   ├── final/
│   │   ├── cannot-extend.zena                  [done]
│   │   ├── cannot-override.zena                [done]
│   │   └── final-class-method-override.zena    [done]
│   │
│   ├── accessors/
│   │   ├── getter-return-type.zena             [done]
│   │   ├── setter-param-type.zena              [done]
│   │   ├── readonly-assignment.zena            [done]
│   │   └── name-conflicts.zena                 [done]
│   │
│   └── operators/
│       ├── operator-eq.zena                    [ts] — operator == type checking
│       ├── operator-index.zena                 [ts] — operator [] return type
│       └── operator-index-set.zena             [ts] — operator []= param type
│
├── case-classes/
│   ├── basic.zena                              [done]
│   ├── constructor_type_error.zena             [done]
│   ├── duplicate_constructor.zena              [done]
│   ├── duplicate_field.zena                    [done]
│   ├── equality.zena                           [done]
│   ├── extend_case_class_rejected.zena         [done]
│   ├── generic.zena                            [done]
│   ├── immutable.zena                          [done]
│   ├── mutable_field.zena                      [done]
│   ├── with_methods.zena                       [done]
│   ├── wrong_arg_count.zena                    [done]
│   ├── optional-param.zena                     [new] — case class with optional field
│   └── pattern-binding.zena                    [new] — match case class and bind fields
│
├── sealed-classes/
│   ├── basic.zena                              [done]
│   ├── distributed_variants.zena               [done]
│   ├── mixed_variants.zena                     [done]
│   ├── unit_variants.zena                      [done]
│   ├── duplicate_inline_variant.zena           [done]
│   ├── instantiate_sealed_rejected.zena        [done]
│   ├── no_variants_reject.zena                 [done]
│   ├── unlisted_extends.zena                   [done]
│   ├── sum_of_sums.zena                        [done]
│   ├── abstract_field_valid.zena               [done]
│   ├── abstract_field_unimplemented.zena       [done]
│   ├── abstract_field_not_abstract_class.zena  [done]
│   ├── exhaustive_match.zena                   [done]
│   ├── non_exhaustive_match.zena               [done]
│   ├── exhaustive_unit_match.zena              [done]
│   ├── non_exhaustive_unit_match.zena          [done]
│   ├── exhaustive_mixed_match.zena             [done]
│   ├── transitive_exhaustive.zena              [done]
│   ├── wildcard_exhaustive.zena                [done]
│   └── variant-field-access.zena               [new] — access case fields after match
│
├── interfaces/
│   ├── basic-implementation.zena               [ts] checker-interface_test
│   ├── missing-method.zena                     [ts] — class missing interface method
│   ├── wrong-method-signature.zena             [ts] — method return type mismatch
│   ├── missing-field.zena                      [ts] — class missing interface field
│   ├── multiple-interfaces.zena                [ts] — class implements A, B
│   ├── interface-extends.zena                  [ts] — interface extends other interface
│   ├── interface-assignability.zena            [ts] — class assignable to interface type
│   ├── generic-interface.zena                  [ts] checker-interface_test
│   ├── accessor-conformance.zena               [ts] — getter satisfies interface field
│   └── diamond-inheritance.zena                [ts] — A extends B, C; B extends D; C extends D
│
├── generics/
│   ├── basic-class.zena                        [ts] checker-generics_test — Box<i32>
│   ├── type-argument-mismatch.zena             [ts] — Box<i32> not assignable to Box<String>
│   ├── infer-from-constructor.zena             [ts] — new Box(42) infers Box<i32>
│   ├── infer-from-function.zena                [ts] — identity(42) infers i32
│   ├── constraint-check.zena                   [ts] — T extends Comparable, pass non-Comparable
│   ├── constraint-method-access.zena           [ts] — access constraint method inside generic
│   ├── default-type-param.zena                 [ts] checker-generics_test
│   ├── multiple-type-params.zena               [ts] — Pair<A, B>
│   ├── generic-method.zena                     [ts] generic-method_test
│   ├── nested-generics.zena                    [ts] — Box<Array<i32>>
│   ├── private-in-generic.zena                 [ts] generic-class-context_test
│   └── self-referential.zena                   [ts] — class Node<T> { next: Node<T>? }
│
├── type-system/
│   ├── type-alias/
│   │   ├── basic.zena                          [done] (in types/)
│   │   ├── unknown-type.zena                   [done] (in types/)
│   │   ├── generic-alias.zena                  [ts] type-alias_test
│   │   ├── recursive-alias.zena                [ts] type-alias_test — type List = ... (rejected?)
│   │   └── alias-to-union.zena                 [ts] — type Nullable<T> = T | null
│   │
│   ├── unions/
│   │   ├── basic-assignability.zena            [ts] checker-union_test — i32 | String
│   │   ├── null-union.zena                     [ts] — String | null
│   │   ├── non-member-access.zena              [ts] checker-union_test — member not on all types
│   │   ├── union-of-classes.zena               [ts] — Cat | Dog assigned to base Animal
│   │   ├── flatten-nested.zena                 [new] — (A | B) | C same as A | B | C
│   │   └── primitive-mix-rejected.zena         [ts] union_validation_test — i32 | String error
│   │
│   ├── literal-types/
│   │   ├── string-literal.zena                 [ts] literal-types_test — let x: "hello" = "hello"
│   │   ├── number-literal.zena                 [ts] literal-types_test — let x: 42 = 42
│   │   ├── boolean-literal.zena                [ts] boolean-literal-types_test
│   │   ├── literal-in-union.zena               [ts] — "a" | "b" union
│   │   ├── let-preserves-literal.zena          [ts] — let x = "hello" → type "hello"
│   │   ├── var-widens-literal.zena             [ts] — var x = "hello" → type String
│   │   └── literal-assignable-to-base.zena     [ts] — "hello" assignable to String
│   │
│   ├── distinct-types/
│   │   ├── basic.zena                          [ts] distinct-type_test — distinct type UserId = i32
│   │   ├── not-assignable.zena                 [ts] — UserId not assignable to i32
│   │   ├── explicit-cast.zena                  [ts] — cast required between distinct and base
│   │   └── generic-instantiation.zena          [ts] distinct-type_test
│   │
│   ├── records/
│   │   ├── literal.zena                        [ts] records-tuples_test — {x: 1, y: 2}
│   │   ├── assignability.zena                  [ts] — structural subtyping (width)
│   │   ├── field-mismatch.zena                 [ts] — wrong field type
│   │   ├── missing-field.zena                  [ts] — required field absent
│   │   ├── optional-field.zena                 [ts] records-tuples_test
│   │   ├── spread.zena                         [ts] record_spread_test
│   │   └── spread-non-record.zena              [ts] record_spread_test — spread primitive error
│   │
│   ├── tuples/
│   │   ├── index-out-of-bounds.zena            [done]
│   │   ├── literal-index.zena                  [done]
│   │   ├── not-array.zena                      [done]
│   │   ├── literal.zena                        [ts] records-tuples_test — (1, "hello")
│   │   ├── length-mismatch.zena                [ts] — (i32, i32) != (i32, i32, i32)
│   │   └── element-mismatch.zena               [ts] — (i32, String) != (i32, i32)
│   │
│   └── never-type/
│       ├── assignable-to-anything.zena         [ts] never_test
│       ├── throw-returns-never.zena            [ts] throw_test
│       ├── unreachable-after-throw.zena        [ts] never_test
│       └── never-in-union.zena                 [ts] — never | i32 simplifies to i32
│
├── destructuring/
│   │
│   │   Strategy: comprehensive pattern-type coverage here; variables/, functions/,
│   │   and control-flow/match/ carry smoke tests to verify each declaration site
│   │   delegates to the same pattern-parsing logic.
│   │
│   ├── record/
│   │   ├── basic.zena                          [done] (record-basic.zena)
│   │   ├── rename.zena                         [done] (record-with-rename.zena)
│   │   ├── default.zena                        [done] (record-with-default.zena)
│   │   ├── nested.zena                         [done] (record-nested.zena)
│   │   ├── missing-property.zena               [done] (record-missing-property.zena)
│   │   ├── type-mismatch.zena                  [done] (record-type-mismatch.zena)
│   │   ├── optional-field-with-default.zena    [done] (optional-field-default.zena)
│   │   └── optional-field-no-default.zena      [done] (optional-field-no-default.zena)
│   │
│   ├── tuple/
│   │   ├── basic.zena                          [done] (tuple-basic.zena)
│   │   ├── nested.zena                         [done] (tuple-nested.zena)
│   │   ├── length-mismatch.zena                [done] (tuple-length-mismatch.zena)
│   │   └── inline-never-union.zena             [done] (skip: self-hosted) — inline tuple Never union
│   │
│   ├── class/
│   │   ├── basic.zena                          [ts] — class pattern binds fields to their declared types
│   │   ├── nested-field.zena                   [ts] — nested class pattern
│   │   ├── refutable-in-let.zena               [ts] — let Some {value} = x is refutable (error)
│   │   └── refutable-in-for.zena               [ts] — for (let Some {v} in arr) is refutable (error)
│   │
│   ├── literal/
│   │   ├── match-arm.zena                      [ts] refutable-pattern_test — literal in match arm ok
│   │   └── refutable-in-let.zena               [ts] refutable-pattern_test — let 42 = x is refutable (error)
│   │
│   ├── composite/
│   │   ├── or-pattern.zena                     [ts] — case A {} | B {}: ... binds to union type
│   │   ├── and-pattern.zena                    [ts] — case Foo {} & Bar {}: ... binds to intersection
│   │   └── or-refutable-in-let.zena            [ts] — let A {} | B {} = x is refutable (error)
│   │
│   └── as/
│       └── binding.zena                        [done] (as-pattern-binding.zena) — p as x binds x
│
├── null-coalescing/
│   ├── basic.zena                              [done]
│   ├── chained.zena                            [done]
│   ├── type-result.zena                        [new] — x ?? 0 where x: i32 | null → i32
│   └── non-nullable-warned.zena                [done] — covered by operators/nullish-unnecessary.zena
│
├── optional-chaining/
│   ├── member_null_result.zena                 [done]
│   ├── member_with_coalescing.zena             [done]
│   ├── call_null_result.zena                   [done]
│   ├── call_with_coalescing.zena               [done]
│   ├── index_null_result.zena                  [done]
│   ├── index_with_coalescing.zena              [done]
│   └── on-non-nullable.zena                    [new] — x?.foo where x is non-null
│
├── mixins/
│   ├── basic-application.zena                  [ts] checker-mixin_test — class A with M
│   ├── mixin-method-access.zena                [ts] — access mixin methods on class
│   ├── mixin-field-access.zena                 [ts] — access mixin fields
│   ├── on-clause-satisfied.zena                [ts] — mixin M on Base; class C extends Base with M
│   ├── on-clause-violated.zena                 [ts] — error if on-clause not met
│   ├── multiple-mixins.zena                    [ts] — class A with M1, M2
│   ├── generic-mixin.zena                      [ts] checker-mixin_test
│   ├── mixin-method-override.zena              [ts] — override mixin method in class
│   ├── mixin-interface.zena                    [ts] — mixin satisfies interface
│   └── mixin-composition.zena                  [ts] — mixin M1 on M2 (mixin depends on mixin)
│
├── enums/
│   ├── basic-usage.zena                        [new] — enum Color { Red, Green, Blue }
│   ├── value-access.zena                       [new] — Color.Red usage
│   ├── type-checking.zena                      [new] — Color not assignable to i32
│   ├── with-values.zena                        [new] — enum with explicit values
│   └── exhaustive-match.zena                   [new] — match on enum is exhaustive
│
├── arrays/
│   ├── literal-inference.zena                  [ts] checker-array_test — #[1, 2, 3] → Array<i32>
│   ├── element-type-mismatch.zena              [ts] — #[1, "hello"] error
│   ├── index-access.zena                       [ts] — arr[0] → element type
│   ├── empty-with-annotation.zena              [ts] — let arr: Array<i32> = #[];
│   ├── method-map.zena                         [ts] — arr.map(f) return type
│   ├── push-type-check.zena                    [ts] — arr.push("hello") on Array<i32> error
│   └── length-type.zena                        [ts] — arr.length → i32
│
├── extensions/
│   ├── basic-usage.zena                        [ts] extension_test
│   ├── static-field-ok.zena                    [ts] — extension with static fields
│   ├── instance-field-rejected.zena            [ts] — extension with instance field error
│   ├── union-ambiguity.zena                    [ts] extension_union_test
│   └── match-ambiguity.zena                    [ts] extension_match_test
│
├── throw-try/
│   ├── throw-type.zena                         [ts] throw_test — throw returns never
│   ├── throw-non-error.zena                    [ts] — throw non-Error value error
│   ├── try-catch-basic.zena                    [ts] throw_test — try/catch type checking
│   ├── try-catch-typed.zena                    [ts] — catch param is Error
│   └── try-catch-finally.zena                  [ts] — finally block type checking
│
├── this-type/
│   ├── in-class-method.zena                    [ts] checker-this-type_test
│   ├── in-interface.zena                       [ts] checker-this-type_test
│   ├── in-mixin.zena                           [ts] checker-this-type_test
│   ├── outside-class-error.zena                [ts] — this.type outside class
│   ├── return-this.zena                        [ts] — method returns This type
│   └── generic-this.zena                       [ts] — This in generic class context
│
├── shadowing/
│   ├── builtin-shadowing.zena                  [ts] shadowing_builtins_test
│   ├── variable-shadowing.zena                 [new] — inner block shadows outer
│   └── type-name-shadowing.zena                [ts] — local type alias shadows outer
│
├── template-strings/
│   ├── readonly-index-assign.zena              [done]
│   ├── readonly-length-assign.zena             [done]
│   └── readonly-raw-index-assign.zena          [done]
│
├── misc/
│   ├── optional-field-primitive.zena           [done]
│   ├── optional-field-valid.zena               [done]
│   ├── tuple_not_array.zena                    [done]
│   ├── type_mismatch.zena                      [done]
│   ├── ambiguity.zena                          [ts] ambiguity_test
│   └── optional-primitive.zena                 [ts] optional_primitive_test
│
└── type-inference/
    ├── numeric-literals.zena                   [needs @type] — 42 → i32, 3.14 → f64
    ├── string-literal.zena                     [needs @type] — "hello" → "hello" (literal type)
    ├── boolean-literal.zena                    [needs @type] — true → true (literal type)
    ├── var-widening.zena                       [needs @type] — var x = true → boolean
    ├── if-expression-type.zena                 [needs @type] — if x a else b → union
    ├── match-expression-type.zena              [needs @type] — match result type
    ├── function-return-infer.zena              [needs @type] — inferred return type
    ├── generic-infer.zena                      [needs @type] — Box(42) → Box<i32>
    ├── record-infer.zena                       [needs @type] — {x: 1} → {x: i32}
    ├── tuple-infer.zena                        [needs @type] — (1, "hi") → (i32, String)
    ├── null-coalescing-infer.zena              [needs @type] — x ?? 0 result type
    └── contextual-number.zena                  [needs @type] — 0 < x:i64 makes 0 → i64
```

---

## Test Counts Summary

| Group                      | Done    | Port from TS | New     | Needs @type | Total    |
| -------------------------- | ------- | ------------ | ------- | ----------- | -------- |
| **Variables**              | 11      | 0            | 0       | 0           | 11       |
| **Operators**              | 23      | 0            | 0       | 0           | 23       |
| **Functions**              | 22      | 0            | 0       | 0           | 22       |
| **Control Flow**           | 30      | 0            | 1       | 0           | 31       |
| **Scoping**                | 3       | 0            | 0       | 0           | 3        |
| **If Expressions**         | 5       | 1            | 0       | 0           | 6        |
| **Classes**                | 2       | ~24          | 1       | 0           | ~27      |
| **Case Classes**           | 11      | 0            | 2       | 0           | 13       |
| **Sealed Classes**         | 19      | 0            | 1       | 0           | 20       |
| **Interfaces**             | 0       | ~10          | 0       | 0           | ~10      |
| **Generics**               | 0       | ~12          | 0       | 0           | ~12      |
| **Type System**            | 2       | ~30          | 1       | 0           | ~33      |
| **Pattern Matching**       | 1       | ~12          | 0       | 0           | ~13      |
| **Destructuring**          | 0       | ~9           | 0       | 0           | ~9       |
| **Null Coal. / Opt Chain** | 9       | 0            | 2       | 0           | 11       |
| **Mixins**                 | 0       | ~10          | 0       | 0           | ~10      |
| **Enums**                  | 0       | 0            | 5       | 0           | 5        |
| **Arrays**                 | 0       | ~7           | 0       | 0           | ~7       |
| **Extensions**             | 0       | 4            | 0       | 0           | 4        |
| **Throw/Try**              | 0       | 5            | 0       | 0           | 5        |
| **This Type**              | 0       | 5            | 0       | 0           | 5        |
| **Shadowing**              | 0       | 1            | 1       | 0           | 2        |
| **Template Strings**       | 4       | 0            | 0       | 0           | 4        |
| **Misc**                   | 4       | 2            | 0       | 0           | 6        |
| **Type Inference**         | 0       | 0            | 0       | 12          | 12       |
| **TOTAL**                  | **138** | **~115**     | **~14** | **12**      | **~279** |

## Porting Priority

Ordered by what the self-hosted checker already supports (port first, should
pass immediately) down to what needs implementation.

### Priority 1: Already Implemented — Port & Verify

These test areas are fully implemented in the self-hosted checker. Porting
these tests should result in both runners passing immediately.

1. **Variables** — let/var inference, type mismatch, undeclared, widening
2. **Operators** — arithmetic (i32, f64), bitwise, comparison, unary
3. **Functions** — basic calls, return type, arg count/type, closures
4. **Control Flow** — break/continue validation, loop conditions, block scope
5. **Case Classes** — construction, fields, immutability, generics
6. **Sealed Classes** — variants, exhaustiveness, abstract fields
7. **If Expressions** — branch types, condition validation
8. **Null Coalescing & Optional Chaining** — already well-covered

### Priority 2: Mostly Implemented — Port & Fix Gaps

These areas work in the self-hosted checker but may have edge cases that
need fixing.

9. **Classes (basic)** — field access, methods, constructors, duplicate fields
10. **Class Fields** — immutability, initialization, private access
11. **Class Inheritance** — extends, override, subtype assignability
12. **Interfaces** — implementation, missing methods, generic interfaces
13. **Type Aliases** — basic and generic aliases
14. **Union Types** — assignability, null unions
15. **Generics** — instantiation, inference, constraints
16. **Pattern Matching** — class/record/tuple patterns, exhaustiveness
17. **Literal Types** — preservation, widening, literal unions

### Priority 3: Partially Implemented — Write Tests as Targets

These need self-hosted checker work before they'll pass.

18. **Destructuring** — record and tuple destructuring in let
19. **Type Narrowing** — null checks, is-expression narrowing
20. **Abstract Classes** — instantiation, must-implement
21. **Final Classes** — cannot extend/override
22. **Accessors** — getter/setter type checking
23. **This Type** — resolution in class/interface/mixin

### Priority 4: Not Yet Implemented — Define Expected Behavior

These are stubs in the self-hosted checker. Tests define the target behavior.

24. **Mixins** — application, on-clause, generic mixin
25. **Enums** — usage, type checking, exhaustive match
26. **Arrays** — literal inference, index access, methods
27. **Extensions** — basic usage, restrictions
28. **Throw/Try** — throw type, try/catch, error types
29. **Records/Tuples** (as expressions) — literal checking, spread
30. **Type Inference** — requires `// @type:` directive

## Error Pattern Guidelines

When writing `// @error:` patterns, use simple substrings that both runners
can match:

| Good (works everywhere)       | Bad (regex-only)                  |
| ----------------------------- | --------------------------------- |
| `// @error: Type mismatch`    | `// @error: Type \w+ mismatch`    |
| `// @error: not assignable`   | `// @error: not assignable to.*`  |
| `// @error: Cannot find name` | `// @error: Cannot find 'foo'`    |
| `// @error: Missing required` | `// @error: Missing required \w+` |

The bootstrap runner treats patterns as regex, so plain substrings work there
too. The self-hosted runner does literal substring matching.

## Relationship to Checker API Tests

This plan covers **behavioral correctness** tests — "does the checker accept
good code and reject bad code with the right errors?" These tests are
compiler-agnostic and portable.

**Checker API tests** (non-portable, per-compiler) should cover:

- Creating a checker instance and calling it
- The `SemanticModel` data structure API
- Integration with the compiler pipeline (multi-module checking)
- Internal invariants (type interning identity, scope structure)

These live in the respective compiler's test directories:

- Bootstrap: `packages/compiler/src/test/checker/`
- Self-hosted: `packages/zena-compiler/zena/test/checker_test.zena` (to be created)
