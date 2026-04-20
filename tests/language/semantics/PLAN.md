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
│   ├── infer-from-function-call.zena           [ts] checker_test
│   ├── infer-from-string.zena                  [ts] checker_test
│   └── infer-from-boolean.zena                 [ts] checker_test
│
├── operators/
│   ├── arithmetic-i32.zena                     [done]
│   ├── arithmetic-f64.zena                     [done]
│   ├── arithmetic-type-error.zena              [done]
│   ├── bitwise.zena                            [done]
│   ├── comparison.zena                         [done]
│   ├── unary.zena                              [done]
│   ├── mixed-arithmetic/
│   │   ├── i32-f32-allowed.zena                [ts] mixed-arithmetic_test — f32 + i32 → f32
│   │   ├── i32-f64-allowed.zena                [ts] mixed-arithmetic_test
│   │   ├── i64-f64-allowed.zena                [ts] mixed-arithmetic_test
│   │   ├── bitwise-mixed-rejected.zena         [ts] mixed-arithmetic_test — f32 & i32 error
│   │   └── shift-mixed-rejected.zena           [ts] mixed-arithmetic_test
│   ├── u32/
│   │   ├── basic-ops.zena                      [ts] u32_test — u32 arithmetic
│   │   ├── comparison.zena                     [ts] u32_test
│   │   ├── bitwise.zena                        [ts] u32_test
│   │   ├── mixed-i32-rejected.zena             [ts] u32_test — u32 + i32 error
│   │   └── cast.zena                           [ts] u32_test — u32 as i32
│   ├── compound-assignment/
│   │   ├── basic.zena                          [done] — x += 1
│   │   ├── type-error.zena                     [done] — string += i32 error
│   │   ├── string-concat.zena                  [done] — string += string
│   │   └── immutable-rejected.zena             [done] — let x = 1; x += 1; error
│   ├── null-comparison.zena                     [done]
│   ├── string-concat.zena                      [ts] checker_test — String + String
│   └── string-concat-type-error.zena           [ts] checker_test — String + i32 error
│
├── functions/
│   ├── basic-function.zena                     [done]
│   ├── return-type-mismatch.zena               [done]
│   ├── wrong-arg-count.zena                    [done]
│   ├── wrong-arg-type.zena                     [done]
│   ├── infer-return-type.zena                  [new] — let f = (x: i32) => x + 1; (no annotation)
│   ├── void-return.zena                        [new] — function returning void
│   ├── recursive-function.zena                 [ts] checker_test — recursive call type checks
│   ├── closure-captures.zena                   [new] — closure captures outer variable
│   ├── contextual-typing/
│   │   ├── param-from-annotation.zena          [ts] — let f: (i32) => i32 = (x) => x;
│   │   ├── callback-param.zena                 [ts] — arr.map((x) => x + 1) infers x: i32
│   │   └── multi-param.zena                    [ts] — infer multiple params from context
│   ├── optional-params/
│   │   ├── basic.zena                          [done] (optional-param-basic.zena)
│   │   ├── null-union.zena                     [done] (optional-param-null-union.zena)
│   │   ├── pass-null.zena                      [done] (optional-param-pass-null.zena)
│   │   ├── default-value.zena                  [ts] — param with default
│   │   ├── wrong-type.zena                     [done] (optional-param-wrong-type.zena)
│   │   ├── call-without-optional.zena          [done] (in optional-param-basic.zena)
│   │   ├── method.zena                         [done] (optional-param-method.zena)
│   │   └── constructor.zena                    [done] (optional-param-constructor.zena)
│   └── function-type/
│       ├── basic.zena                          [ts] function-type_test
│       ├── assignability.zena                  [ts] — (i32) => i32 assignable to (i32) => i32
│       └── mismatch.zena                       [ts] — (i32) => String not assignable to (i32) => i32
│
├── control-flow/
│   ├── break-outside-loop.zena                 [done]
│   ├── continue-outside-loop.zena              [done]
│   ├── for-loop.zena                           [done]
│   ├── non-boolean-condition.zena              [done]
│   ├── while-loop.zena                         [done]
│   ├── if-condition-type.zena                  [new] — if condition must be boolean
│   ├── block-scope.zena                        [ts] block-scope_test — var not visible outside block
│   ├── nested-block-scope.zena                 [ts] block-scope_test
│   └── block-scope-shadowing.zena              [ts] block-scope_test
│
├── if-expression/
│   ├── basic.zena                              [ts] if-expression_test — if/else returns union
│   ├── same-type-branches.zena                 [ts] — both branches same type → that type
│   ├── different-type-branches.zena            [ts] — different types → union
│   ├── void-if-no-else.zena                    [ts] — if without else → void
│   ├── nested.zena                             [ts] — nested if-expression
│   ├── with-block.zena                         [ts] — if { ... } else { ... } expression
│   ├── type-error-condition.zena               [ts] — non-bool condition in if expr
│   ├── if-let-basic.zena                       [new] — if (let Some {value} = x) { ... }
│   └── if-let-narrowing.zena                   [new] — binding is narrowed type in body
│
├── classes/
│   ├── basic/
│   │   ├── field-access.zena                   [ts] checker-class_test — access class fields
│   │   ├── method-call.zena                    [ts] — call class methods
│   │   ├── duplicate-field.zena                [ts] checker-class_test — duplicate field name error
│   │   ├── unknown-field.zena                  [ts] checker-class_test — access nonexistent field
│   │   ├── constructor-required.zena           [ts] checker-constructor_test
│   │   ├── constructor-arg-mismatch.zena       [ts] checker-constructor_test
│   │   ├── constructor-missing-super.zena      [ts] checker-constructor_test
│   │   └── forward-method-reference.zena       [done]
│   │
│   ├── fields/
│   │   ├── immutable-assignment.zena           [ts] immutable-field_test — let field assignment error
│   │   ├── mutable-assignment.zena             [ts] — var field assignment ok
│   │   ├── field-init-order.zena               [ts] checker-field-init_test
│   │   ├── field-init-required.zena            [ts] checker-field-init-required_test
│   │   ├── field-type-inference.zena           [done]
│   │   └── private-field-access.zena           [ts] — #field not accessible outside class
│   │
│   ├── inheritance/
│   │   ├── basic-extends.zena                  [ts] checker-inheritance_test
│   │   ├── method-override.zena                [ts] checker-inheritance_test
│   │   ├── invalid-override.zena               [ts] — override with wrong type
│   │   ├── super-field-access.zena             [ts] — access parent field
│   │   ├── subtype-assignability.zena          [ts] — Child assignable to Parent
│   │   └── deep-chain.zena                     [ts] — A extends B extends C
│   │
│   ├── abstract/
│   │   ├── cannot-instantiate.zena             [ts] checker-abstract_test
│   │   ├── must-implement.zena                 [ts] — concrete subclass must implement abstract
│   │   ├── abstract-method.zena                [ts] checker-abstract_test
│   │   ├── partial-implementation.zena         [ts] — some abstract methods implemented
│   │   └── abstract-field.zena                 [ts] — abstract fields in abstract class
│   │
│   ├── final/
│   │   ├── cannot-extend.zena                  [ts] checker-final_test
│   │   ├── cannot-override.zena                [ts] checker-final_test
│   │   └── final-class-method-override.zena    [ts] checker-final_test
│   │
│   ├── accessors/
│   │   ├── getter-return-type.zena             [ts] checker-accessor_test
│   │   ├── setter-param-type.zena              [ts] checker-accessor_test
│   │   ├── readonly-assignment.zena            [ts] readonly-assignment_test
│   │   └── name-conflicts.zena                 [ts] name-conflict_test
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
│   ├── records-tuples/
│   │   ├── record-literal.zena                 [ts] records-tuples_test — {x: 1, y: 2}
│   │   ├── record-assignability.zena           [ts] — structural subtyping (width)
│   │   ├── record-field-mismatch.zena          [ts] — wrong field type
│   │   ├── record-missing-field.zena           [ts] — required field absent
│   │   ├── record-optional-field.zena          [ts] records-tuples_test
│   │   ├── tuple-literal.zena                  [ts] records-tuples_test — (1, "hello")
│   │   ├── tuple-length-mismatch.zena          [ts] — (i32, i32) != (i32, i32, i32)
│   │   ├── tuple-element-mismatch.zena         [ts] — (i32, String) != (i32, i32)
│   │   ├── record-spread.zena                  [ts] record_spread_test
│   │   └── spread-non-record.zena              [ts] record_spread_test — spread primitive error
│   │
│   └── never-type/
│       ├── assignable-to-anything.zena         [ts] never_test
│       ├── throw-returns-never.zena            [ts] throw_test
│       ├── unreachable-after-throw.zena        [ts] never_test
│       └── never-in-union.zena                 [ts] — never | i32 simplifies to i32
│
├── type-narrowing/
│   ├── null-check.zena                         [ts] type-narrowing_test — if (x !== null) { x.foo() }
│   ├── null-check-else.zena                    [ts] — else branch retains nullable
│   ├── nested-null-check.zena                  [ts] — nested if for multiple nullables
│   ├── if-let-narrowing.zena                   [new] — if (let Some {val} = opt) { ... }
│   ├── is-expression.zena                      [new] — if (x is Dog) { x.bark() }
│   └── match-narrowing.zena                    [new] — type narrowed inside match case
│
├── pattern-matching/
│   ├── exhaustive-sealed.zena                  [done] (in sealed-classes/)
│   ├── exhaustive-boolean.zena                 [ts] match_exhaustiveness_test
│   ├── exhaustive-literal-union.zena           [ts] — match on "a" | "b" union
│   ├── non-exhaustive-error.zena               [done] (in sealed-classes/)
│   ├── unreachable-case.zena                   [ts] match_exhaustiveness_test
│   ├── wildcard-catches-all.zena               [done] (in sealed-classes/)
│   ├── guard-not-exhaustive.zena               [ts] — guard makes case non-exhaustive
│   ├── class-pattern-binding.zena              [ts] — case Foo {x, y}: use x, y
│   ├── record-pattern-binding.zena             [ts] — case {x, y}: use x, y
│   ├── tuple-pattern-binding.zena              [ts] — case (a, b): use a, b
│   ├── as-pattern-binding.zena                 [done]
│   ├── or-pattern.zena                         [ts] — case A {} | B {}: ...
│   ├── and-pattern.zena                        [ts] — case Foo {} & Bar {}: ... (intersection)
│   ├── literal-pattern.zena                    [ts] refutable-pattern_test
│   └── refutable-pattern/
│       ├── literal-in-let.zena                 [ts] refutable-pattern_test — let 42 = x (error)
│       ├── class-in-let.zena                   [ts] — let Some {value} = x (error)
│       └── or-in-let.zena                      [ts] — let A {} | B {} = x (error)
│
├── destructuring/
│   ├── record-basic.zena                       [done]
│   ├── record-with-rename.zena                 [done]
│   ├── record-with-default.zena                [done]
│   ├── record-nested.zena                      [done]
│   ├── record-missing-property.zena            [done]
│   ├── record-type-mismatch.zena               [done]
│   ├── tuple-basic.zena                        [done]
│   ├── tuple-nested.zena                       [done]
│   ├── tuple-length-mismatch.zena              [done]
│   ├── optional-field-default.zena             [done]
│   ├── optional-field-no-default.zena          [done]
│   └── invalid-pattern.zena                    [ts] destructuring_test — destructure non-record
│
├── null-coalescing/
│   ├── basic.zena                              [done]
│   ├── chained.zena                            [done]
│   ├── type-result.zena                        [new] — x ?? 0 where x: i32 | null → i32
│   └── non-nullable-rejected.zena              [new] — x ?? 0 where x: i32 is warning/error
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
│   ├── readonly-index-assign.zena              [done] (template_strings_array_index_assign)
│   ├── readonly-length-assign.zena             [done] (template_strings_array_length_assign)
│   ├── private-access.zena                     [done] (template_strings_array_private_access)
│   └── readonly-raw-assign.zena                [done] (template_strings_array_raw_assign)
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

| Group                      | Done   | Port from TS | New     | Needs @type | Total    |
| -------------------------- | ------ | ------------ | ------- | ----------- | -------- |
| **Variables**              | 6      | 3            | 2       | 0           | 11       |
| **Operators**              | 7      | ~12          | 3       | 0           | ~22      |
| **Functions**              | 4      | ~10          | 3       | 0           | ~17      |
| **Control Flow**           | 5      | 3            | 1       | 0           | 9        |
| **If Expressions**         | 0      | 5            | 2       | 0           | 7        |
| **Classes**                | 2      | ~24          | 1       | 0           | ~27      |
| **Case Classes**           | 11     | 0            | 2       | 0           | 13       |
| **Sealed Classes**         | 19     | 0            | 1       | 0           | 20       |
| **Interfaces**             | 0      | ~10          | 0       | 0           | ~10      |
| **Generics**               | 0      | ~12          | 0       | 0           | ~12      |
| **Type System**            | 2      | ~30          | 1       | 0           | ~33      |
| **Type Narrowing**         | 0      | 3            | 3       | 0           | 6        |
| **Pattern Matching**       | 1      | ~12          | 0       | 0           | ~13      |
| **Destructuring**          | 0      | ~9           | 0       | 0           | ~9       |
| **Null Coal. / Opt Chain** | 8      | 0            | 3       | 0           | 11       |
| **Mixins**                 | 0      | ~10          | 0       | 0           | ~10      |
| **Enums**                  | 0      | 0            | 5       | 0           | 5        |
| **Arrays**                 | 0      | ~7           | 0       | 0           | ~7       |
| **Extensions**             | 0      | 4            | 0       | 0           | 4        |
| **Throw/Try**              | 0      | 5            | 0       | 0           | 5        |
| **This Type**              | 0      | 5            | 0       | 0           | 5        |
| **Shadowing**              | 0      | 1            | 1       | 0           | 2        |
| **Template Strings**       | 4      | 0            | 0       | 0           | 4        |
| **Misc**                   | 4      | 2            | 0       | 0           | 6        |
| **Type Inference**         | 0      | 0            | 0       | 12          | 12       |
| **TOTAL**                  | **73** | **~167**     | **~28** | **12**      | **~280** |

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
