# Portable Syntax Test Plan

This document outlines the directory structure and test groups for portable
syntax tests in `tests/language/syntax/`. These tests are `.zena` + `.ast.json`
pairs that both the TypeScript compiler and the self-hosted parser can run
against.

## Conventions

- Each `.zena` file tests ONE construct or interaction (small, focused).
- Files use directives: `// @target: statement|expression|module`.
- File names are `kebab-case` and descriptive (e.g., `nested-ternary.zena`).
- Directories group related constructs into suites.
- Error tests use `// @error: regex` for expected parse errors.
- Precedence/associativity tests verify tree shape (which operand is deeper).

## Porting Workflow

The portable test runner lives at `packages/compiler/src/test/portable-runner.ts`
and is invoked via the `portable-syntax_test.ts` test file, which discovers all
`.zena` files under `tests/language/syntax/` recursively.

**Snapshot auto-generation**: When a `.zena` file has no corresponding
`.ast.json` file, the runner parses the source, strips location info, and writes
the cleaned AST as the snapshot automatically. So the porting workflow is:

1. Create only the `.zena` file.
2. Run `npm test -w @zena-lang/compiler` (Wireit runs the portable suite).
3. Verify the auto-generated `.ast.json` looks correct.
4. Commit both files.

**AST cleanup**: The runner's `stripLocation()` removes `loc`, `start`, `end`,
`inferredType`, and `inferredTypeArguments` fields recursively before comparison.

### Gotchas discovered during porting

- **`{` is ambiguous with blocks**: Record literals (`{x: 1}`) and map literals
  (`{"a" => 1}`) cannot use `@target: expression` because the parser treats a
  leading `{` as a block statement. Use `@target: statement` with a `let`
  binding instead (e.g., `let r = {x: 1};`).
- **Empty braces `{}` always parse as empty record**: There is no empty map
  literal syntax. The `maps/empty.zena` entry in the plan is not portable as a
  map test.
- **Single-element parens are grouping, not tuples**: `(42)` parses as just a
  `NumberLiteral`, not a `TupleLiteral`. Tuples require 2+ elements. `(42,)`
  trailing-comma syntax for single-element tuples is not supported. Empty parens
  `()` throw an error.
- **Record shorthand has no flag**: `{x}` produces a `PropertyAssignment` where
  both `name` and `value` are `Identifier` nodes with the same `name` string.
  There is no `shorthand: true` field.
- **Self-hosted parser may lack support**: When porting tests, the self-hosted
  parser (`packages/zena-compiler/`) may not yet support the syntax being tested.
  You must add support to all three files: `ast.zena` (AST class definitions),
  `parser.zena` (parsing logic), and `ast-json.zena` (JSON serialization). The
  tokenizer usually already has the tokens. Always run **both** test suites:
  `npm run test:portable -w @zena-lang/compiler` (TS) and
  `npm test -w @zena-lang/zena-compiler` (self-hosted/WASI).
- **`let` vs `var` in Zena**: `let` bindings are immutable. If you need to
  reassign a variable (e.g., `raw = fallback`), use `var`.
- **`if` without `else`**: In Zena, `if` blocks don't require an `else` clause.
  Do not add `else { };` when the else branch is empty — simple `if (cond) { ... }`
  works fine. The TS compiler rejects spurious semicolons after `else { }` in
  some contexts.

## Status Key

- **[done]** — Portable tests already exist
- **[ts]** — Covered in TS parser tests, needs porting
- **[new]** — Not currently tested anywhere, needs new tests

---

## Directory Structure

```
tests/language/syntax/
│
├── literals/
│   ├── numbers/
│   │   ├── integer.zena                    [done] parser_test
│   │   ├── negative-integer.zena           [done]
│   │   ├── float.zena                      [done] parser_test
│   │   ├── hex.zena                        [done] hex_literals_test
│   │   ├── hex-uppercase.zena              [done] hex_literals_test
│   │   ├── hex-mixed-case.zena             [done] hex_literals_test
│   │   ├── zero.zena                       [done]
│   │   ├── large-integer.zena              [done]
│   │   └── errors/
│   │       ├── invalid-hex.zena            [done] e.g., 0xGG
│   │       └── leading-dot.zena            [done] e.g., .5
│   │
│   ├── strings/
│   │   ├── single-quotes.zena              [done] lexer_test
│   │   ├── double-quotes.zena              [done] lexer_test
│   │   ├── empty.zena                      [done]
│   │   ├── escape-characters.zena          [done] lexer_test
│   │   ├── escape-null.zena                [new]
│   │   └── errors/
│   │       ├── unterminated.zena           [new] Isn't failing correctly
│   │       └── unknown-escape.zena         [new]
│   │
│   ├── booleans/
│   │   ├── true.zena                       [done]
│   │   └── false.zena                      [done]
│   │
│   ├── null.zena                           [done] parser-null_test
│   │
│   ├── arrays/
│   │   ├── empty.zena                      [done]
│   │   ├── single-element.zena             [done]
│   │   ├── multiple-elements.zena          [done]
│   │   ├── nested.zena                     [done]
│   │   └── trailing-comma.zena             [done]
│   │
│   ├── records/
│   │   ├── empty.zena                      [done] records-tuples_test
│   │   ├── single-field.zena               [done] records-tuples_test
│   │   ├── multiple-fields.zena            [done] records-tuples_test
│   │   ├── shorthand.zena                  [done] records-tuples_test
│   │   ├── single-field-shorthand.zena     [done]
│   │   ├── nested.zena                     [done] records-tuples_test
│   │   └── spread.zena                     [done]
│   │
│   ├── tuples/
│   │   ├── two-elements.zena              [done] records-tuples_test
│   │   ├── three-elements.zena            [done]
│   │   ├── nested.zena                    [done] records-tuples_test
│   │   └── single-element.zena            [done] — disambiguation from parens
│   │
│   ├── maps/
│   │   ├── empty.zena                      [ts] map-literal_test — {} is always empty record
│   │   ├── single-entry.zena               [done] map-literal_test
│   │   ├── multiple-entries.zena            [done] map-literal_test
│   │   └── trailing-comma.zena             [done]
│   │
│   └── template-literals/
│       ├── simple.zena                     [done] template-literal_test
│       ├── empty.zena                      [done] template-literal_test
│       ├── substitution.zena               [done] template-literal_test
│       ├── multiple-substitutions.zena     [done] template-literal_test
│       ├── nested-template.zena            [done]
│       ├── expression-in-substitution.zena [done]
│       ├── tagged/
│       │   ├── basic.zena                  [done] template-literal_test
│       │   ├── with-substitution.zena      [done] template-literal_test
│       │   └── member-tag.zena             [done]
│       └── errors/
│           └── unterminated.zena           [new]
│
├── identifiers/
│   ├── simple.zena                         [ts] identifiers_test
│   ├── with-underscore.zena               [ts] identifiers_test
│   ├── with-dollar.zena                   [ts] identifiers_test
│   ├── leading-underscore.zena            [ts] identifiers_test
│   ├── leading-dollar.zena                [ts] identifiers_test
│   ├── keyword-like.zena                  [ts] identifiers_test (from, as, etc.)
│   └── errors/
│       ├── starts-with-digit.zena         [new]
│       └── reserved-keyword.zena          [new]
│
├── comments/
│   ├── single-line.zena                    [ts] lexer_test
│   ├── multi-line.zena                     [ts] lexer_test
│   ├── inline.zena                         [new]
│   └── nested-multiline.zena              [new]
│
├── variables/
│   ├── let-inferred.zena                   [done] variable_decl
│   ├── let-typed.zena                      [new]
│   ├── var-inferred.zena                   [ts] parser_test
│   ├── var-typed.zena                      [new]
│   ├── const-function.zena                [ts] parser_test
│   ├── exported-let.zena                  [new]
│   ├── exported-var.zena                  [new]
│   └── errors/
│       ├── const-suggested.zena           [ts] variable-declaration-errors_test
│       ├── Let-suggested.zena             [ts] variable-declaration-errors_test
│       ├── missing-initializer.zena       [new]
│       └── duplicate-declaration.zena     [new] (may be checker-level)
│
├── operators/
│   ├── arithmetic/
│   │   ├── add.zena                       [ts] parser_test
│   │   ├── subtract.zena                  [ts] parser_test
│   │   ├── multiply.zena                  [ts] parser_test
│   │   ├── divide.zena                    [ts] parser_test
│   │   ├── modulo.zena                    [new]
│   │   └── mixed.zena                     [new] — e.g., a + b * c (precedence)
│   │
│   ├── comparison/
│   │   ├── less-than.zena                 [new]
│   │   ├── less-equal.zena                [new]
│   │   ├── greater-than.zena              [new]
│   │   ├── greater-equal.zena             [new]
│   │   ├── equal.zena                     [new]
│   │   ├── not-equal.zena                 [new]
│   │   ├── strict-equal.zena              [new]
│   │   └── strict-not-equal.zena          [new]
│   │
│   ├── logical/
│   │   ├── and.zena                       [new]
│   │   ├── or.zena                        [new]
│   │   ├── not.zena                       [ts] unary_test
│   │   └── mixed.zena                     [new] — a && b || c (precedence)
│   │
│   ├── bitwise/
│   │   ├── and.zena                       [new]
│   │   ├── or.zena                        [new]
│   │   ├── xor.zena                       [new]
│   │   ├── shift-left.zena                [ts] shift-operators_test
│   │   ├── shift-right.zena               [ts] shift-operators_test
│   │   ├── unsigned-shift-right.zena      [ts] shift-operators_test
│   │   └── mixed.zena                     [new] — a & b | c (precedence)
│   │
│   ├── unary/
│   │   ├── negate.zena                    [ts] unary_test
│   │   ├── not.zena                       [ts] unary_test
│   │   └── double-negate.zena             [new]
│   │
│   ├── assignment/
│   │   ├── simple.zena                    [ts] parser_test
│   │   └── member-assignment.zena         [new]
│   │
│   ├── null-coalescing/
│   │   ├── basic.zena                     [done]
│   │   ├── chained.zena                   [done]
│   │   └── with-optional-chaining.zena    [done]
│   │
│   ├── optional-chaining/
│   │   ├── member.zena                    [done]
│   │   ├── index.zena                     [done]
│   │   ├── call.zena                      [done]
│   │   └── chained.zena                   [done]
│   │
│   ├── range/
│   │   ├── closed.zena                    [ts] range-expression_test
│   │   ├── open-end.zena                  [ts] range-expression_test
│   │   ├── open-start.zena                [ts] range-expression_test
│   │   └── unbounded.zena                 [ts] range-expression_test
│   │
│   ├── pipeline/
│   │   ├── basic.zena                     [ts] parser-pipeline_test
│   │   ├── chained.zena                   [ts] parser-pipeline_test
│   │   └── placeholder.zena              [ts] parser-pipeline_test
│   │
│   ├── cast/
│   │   ├── as-expression.zena             [new]
│   │   └── is-expression.zena             [new]
│   │
│   └── precedence/
│       ├── mul-before-add.zena            [new] — a + b * c
│       ├── add-before-compare.zena        [new] — a + b < c + d
│       ├── compare-before-logical.zena    [new] — a < b && c > d
│       ├── and-before-or.zena             [new] — a && b || c
│       ├── bitwise-order.zena             [new] — a & b ^ c | d
│       ├── shift-before-compare.zena      [new] — a << 1 < b
│       ├── unary-before-binary.zena       [new] — -a + b
│       ├── parens-override.zena           [new] — (a + b) * c
│       ├── pipeline-precedence.zena       [new] — a + b |> f($)
│       ├── range-precedence.zena          [new] — a + 1 .. b - 1
│       ├── nullish-vs-logical.zena        [new] — ensure ?? doesn't mix with ||
│       └── assignment-lowest.zena         [new] — x = a + b * c
│
├── expressions/
│   ├── calls/
│   │   ├── simple.zena                    [ts] parser_test
│   │   ├── multiple-args.zena             [new]
│   │   ├── no-args.zena                   [new]
│   │   ├── nested.zena                    [new]
│   │   ├── method-call.zena               [new]
│   │   └── chained-method.zena            [new]
│   │
│   ├── member-access/
│   │   ├── simple.zena                    [new]
│   │   ├── chained.zena                   [new]
│   │   └── computed-index.zena            [new]
│   │
│   ├── new/
│   │   ├── simple.zena                    [new]
│   │   ├── with-args.zena                 [new]
│   │   └── generic.zena                   [new]
│   │
│   ├── this.zena                          [new]
│   │
│   ├── super/
│   │   ├── constructor-call.zena          [ts] parser-super_test
│   │   ├── method-call.zena               [ts] parser-super_test
│   │   └── field-access.zena              [ts] parser-super_test
│   │
│   ├── if-expression/
│   │   ├── simple.zena                    [ts] if-expression_test
│   │   ├── nested.zena                    [ts] if-expression_test
│   │   ├── with-comparison.zena           [ts] if-expression_test
│   │   └── with-block.zena                [new]
│   │
│   ├── match/
│   │   ├── literal-pattern.zena           [ts] match-expression_test
│   │   ├── identifier-pattern.zena        [ts] match-expression_test
│   │   ├── wildcard-pattern.zena          [ts] match-expression_test
│   │   ├── record-pattern.zena            [ts] match-expression_test
│   │   ├── tuple-pattern.zena             [ts] match-expression_test
│   │   ├── class-pattern.zena             [ts] match-expression_test
│   │   ├── as-pattern.zena                [ts] match-expression_test
│   │   ├── or-pattern.zena                [ts] match-expression_test
│   │   ├── and-pattern.zena               [ts] match-expression_test
│   │   ├── guard.zena                     [ts] parser-match-guard_test
│   │   ├── block-body.zena                [ts] match-expression_test / block-statement_test
│   │   ├── nested-pattern.zena            [ts] match-expression_test
│   │   ├── enum-pattern.zena              [ts] enum-pattern_test
│   │   └── multiple-cases.zena            [new]
│   │
│   ├── throw.zena                         [ts] throw_test
│   │
│   ├── try-catch/
│   │   ├── basic.zena                     [ts] try-catch_test
│   │   ├── with-finally.zena              [ts] try-catch_test
│   │   ├── catch-no-finally.zena          [ts] try-catch_test
│   │   └── nested.zena                    [ts] try-catch_test
│   │
│   ├── inline-tuples/
│   │   ├── type-annotation.zena           [ts] inline-tuples_test
│   │   ├── return-expression.zena         [ts] inline-tuples_test
│   │   ├── destructuring.zena             [ts] inline-tuples_test
│   │   └── union-of-tuples.zena           [ts] inline-tuples_test
│   │
│   └── grouping/
│       └── parenthesized.zena             [new] — (a + b)
│
├── statements/
│   ├── blocks/
│   │   ├── simple.zena                    [ts] block-statement_test
│   │   ├── nested.zena                    [new]
│   │   └── empty.zena                     [new]
│   │
│   ├── if/
│   │   ├── simple.zena                    [new]
│   │   ├── if-else.zena                   [new]
│   │   ├── if-else-if.zena                [new]
│   │   └── let-pattern.zena              [new] — if (let x = expr)
│   │
│   ├── while/
│   │   ├── simple.zena                    [ts] parser_test
│   │   ├── let-pattern.zena              [new] — while (let x = expr)
│   │   └── break-continue.zena           [new]
│   │
│   ├── for/
│   │   ├── c-style.zena                   [ts] parser-for_test
│   │   ├── empty-init.zena                [ts] parser-for_test
│   │   ├── empty-test.zena                [ts] parser-for_test
│   │   ├── empty-update.zena              [ts] parser-for_test
│   │   ├── all-empty.zena                 [ts] parser-for_test
│   │   └── for-in.zena                    [new]
│   │
│   ├── return/
│   │   ├── value.zena                     [new]
│   │   ├── void.zena                      [new]
│   │   └── tuple.zena                     [new] — return (a, b)
│   │
│   ├── break.zena                         [new]
│   ├── continue.zena                      [new]
│   │
│   └── expression-statement.zena          [new]
│
├── functions/
│   ├── arrow/
│   │   ├── expression-body.zena           [ts] parser_test
│   │   ├── block-body.zena                [new]
│   │   ├── no-params.zena                 [new]
│   │   ├── single-param.zena              [new]
│   │   ├── multiple-params.zena           [new]
│   │   ├── typed-params.zena              [ts] parser_test
│   │   ├── return-type.zena               [new]
│   │   ├── optional-param.zena            [ts] parser-optional-params_test
│   │   ├── default-param.zena             [new]
│   │   └── contextual-typing.zena        [ts] contextual-typing-parser_test
│   │
│   ├── generic/
│   │   ├── single-param.zena              [ts] generics-parser_test
│   │   ├── multiple-params.zena           [ts] generics-parser_test
│   │   ├── constraint.zena                [ts] generics-parser_test
│   │   ├── default-type.zena              [ts] generics-parser_test
│   │   └── nested-generic.zena            [new]
│   │
│   └── closure/
│       └── captures-variable.zena         [new]
│
├── classes/
│   ├── basic/
│   │   ├── empty.zena                     [new]
│   │   ├── with-fields.zena               [ts] parser-class_test
│   │   ├── with-methods.zena              [ts] parser-class_test
│   │   ├── with-constructor.zena          [new]
│   │   ├── exported.zena                  [new]
│   │   └── field-mutability.zena          [new] — let vs var fields
│   │
│   ├── inheritance/
│   │   ├── extends.zena                   [ts] parser_test (basic)
│   │   ├── super-constructor.zena         [ts] parser-super_test
│   │   ├── super-method.zena              [ts] parser-super_test
│   │   ├── super-field.zena               [ts] parser-super_test
│   │   └── abstract-class.zena            [ts] parser-abstract_test
│   │
│   ├── modifiers/
│   │   ├── final-class.zena               [ts] parser-final_test
│   │   ├── final-method.zena              [ts] parser-final_test
│   │   ├── abstract-method.zena           [ts] parser-abstract_test
│   │   └── private-fields.zena            [ts] parser-private-fields_test
│   │
│   ├── accessors/
│   │   ├── getter.zena                    [ts] parser-class_test
│   │   ├── setter.zena                    [ts] parser-class_test
│   │   └── getter-setter-pair.zena        [new]
│   │
│   ├── operators/
│   │   ├── operator-eq.zena               [ts] operator_parser_test
│   │   ├── operator-index.zena            [ts] operator_parser_test
│   │   ├── operator-index-set.zena        [ts] operator_parser_test
│   │   ├── operator-plus.zena             [ts] operator_parser_test
│   │   └── operator-overloaded.zena       [new] — multiple signatures
│   │
│   ├── generic-class/
│   │   ├── single-param.zena              [ts] generics-parser_test
│   │   ├── multiple-params.zena           [ts] generics-parser_test
│   │   ├── constraint.zena                [ts] generics-parser_test
│   │   ├── default-type.zena              [ts] generics-parser_test
│   │   ├── generic-method.zena            [ts] generic-method_test
│   │   └── extends-generic.zena           [ts] generics-parser_test
│   │
│   ├── case-classes/                       [done] — 14 tests already ported
│   │   ├── basic.zena
│   │   ├── single-param.zena
│   │   ├── empty-params.zena
│   │   ├── let-param.zena
│   │   ├── var-param.zena
│   │   ├── exported.zena
│   │   ├── final.zena
│   │   ├── generic.zena
│   │   ├── extends.zena
│   │   ├── extends-with-body.zena
│   │   ├── implements.zena
│   │   ├── with-mixin.zena
│   │   ├── with-body.zena
│   │   └── all-clauses.zena
│   │
│   ├── extension/
│   │   └── basic.zena                     [new]
│   │
│   └── initializer-list/
│       ├── basic.zena                     [ts] initializer-list-private_test
│       └── with-super.zena               [ts] initializer-list-private_test
│
├── interfaces/
│   ├── empty.zena                          [ts] parser-interface_test
│   ├── with-methods.zena                  [ts] parser-interface_test
│   ├── with-fields.zena                   [ts] parser-interface_test
│   ├── extends.zena                       [ts] parser-interface_test
│   ├── generic.zena                       [ts] parser-interface_test
│   ├── implements.zena                    [ts] parser-interface_test
│   └── accessor-signature.zena            [new]
│
├── mixins/
│   ├── basic.zena                          [ts] parser-mixin_test
│   ├── with-on-clause.zena                [ts] parser-mixin_test
│   ├── with-fields.zena                   [new]
│   ├── with-methods.zena                  [new]
│   ├── class-with-mixin.zena              [ts] parser-mixin_test
│   └── generic.zena                       [ts] generic-method_test
│
├── enums/
│   ├── basic.zena                          [new]
│   ├── with-values.zena                   [new]
│   ├── string-values.zena                 [new]
│   └── exported.zena                      [new]
│
├── types/
│   ├── annotations/
│   │   ├── primitive.zena                 [new] — x: i32
│   │   ├── named.zena                     [new] — x: Point
│   │   ├── generic.zena                   [new] — x: Array<i32>
│   │   ├── nested-generic.zena            [new] — x: Map<string, Array<i32>>
│   │   └── nullable.zena                  [ts] parser-null_test — x: T | null
│   │
│   ├── aliases/
│   │   ├── simple.zena                    [ts] parser-type-alias_test
│   │   ├── generic.zena                   [ts] parser-type-alias_test
│   │   └── distinct.zena                  [ts] parser-type-alias_test
│   │
│   ├── unions/
│   │   ├── two-types.zena                 [ts] parser-union_test
│   │   ├── three-types.zena               [ts] parser-union_test
│   │   └── nullable.zena                  [ts] parser-union_test
│   │
│   ├── function-types/
│   │   ├── no-params.zena                 [ts] function-type_test
│   │   ├── single-param.zena              [ts] function-type_test
│   │   ├── multiple-params.zena           [ts] function-type_test
│   │   └── returning-function.zena        [ts] function-type_test
│   │
│   ├── literal-types/
│   │   ├── string.zena                    [ts] literal-types_test
│   │   ├── number.zena                    [ts] literal-types_test
│   │   ├── boolean-true.zena              [ts] literal-types_test
│   │   └── boolean-false.zena             [ts] literal-types_test
│   │
│   ├── record-types/
│   │   ├── basic.zena                     [ts] records-tuples_test
│   │   ├── optional-field.zena            [ts] records-tuples_test
│   │   └── nested.zena                    [new]
│   │
│   ├── tuple-types/
│   │   ├── basic.zena                     [ts] records-tuples_test
│   │   └── nested.zena                    [new]
│   │
│   ├── inline-tuple-types/
│   │   ├── basic.zena                     [ts] inline-tuples_test
│   │   └── union-of-tuples.zena           [ts] inline-tuples_test
│   │
│   └── this-type/
│       ├── return-type.zena               [ts] this-type_test
│       └── parameter-type.zena            [ts] this-type_test
│
├── destructuring/
│   ├── record/
│   │   ├── basic.zena                     [ts] destructuring_test
│   │   ├── with-rename.zena               [ts] destructuring_test
│   │   ├── with-default.zena              [ts] destructuring_test
│   │   ├── nested.zena                    [ts] destructuring_test
│   │   └── in-parameter.zena              [new]
│   │
│   ├── tuple/
│   │   ├── basic.zena                     [ts] destructuring_test
│   │   ├── nested.zena                    [ts] destructuring_test
│   │   └── inline-tuple.zena              [ts] inline-tuples_test
│   │
│   └── errors/
│       └── invalid-target.zena            [new]
│
├── imports/
│   ├── named.zena                          [ts] parser-imports_test
│   ├── multiple.zena                      [ts] parser-imports_test
│   ├── flipped.zena                       [ts] parser-imports_test
│   ├── default.zena                       [new]
│   ├── star.zena                          [new]
│   └── export-all.zena                    [new]
│
├── decorators/
│   ├── simple.zena                         [ts] decorator_test
│   ├── with-args.zena                     [ts] decorator_test
│   ├── external.zena                      [ts] parser-declare_test
│   └── multiple.zena                      [new]
│
├── declare/
│   ├── function.zena                       [ts] parser-declare_test
│   ├── with-external.zena                 [ts] parser-declare_test
│   └── overloaded.zena                    [ts] parser-declare_test
│
├── symbols/
│   └── basic.zena                          [ts] symbol-declaration_test
│
└── errors/
    ├── unexpected-token.zena              [new]
    ├── missing-semicolon.zena             [new]
    ├── missing-closing-paren.zena         [new]
    ├── missing-closing-brace.zena         [new]
    └── missing-closing-bracket.zena       [new]
```

---

## Test Counts Summary

| Group                    | Done   | Port from TS | New      | Total    |
| ------------------------ | ------ | ------------ | -------- | -------- |
| **Literals**             | 0      | ~14          | ~18      | ~32      |
| **Template Literals**    | 9      | 0            | ~1       | ~10      |
| **Identifiers**          | 0      | ~5           | ~2       | ~7       |
| **Comments**             | 0      | ~2           | ~2       | ~4       |
| **Variables**            | 1      | ~3           | ~5       | ~9       |
| **Operators**            | 7      | ~10          | ~30      | ~47      |
| **Expressions**          | 0      | ~20          | ~10      | ~30      |
| **Statements**           | 0      | ~6           | ~12      | ~18      |
| **Functions**            | 0      | ~8           | ~6       | ~14      |
| **Classes**              | 14     | ~18          | ~8       | ~40      |
| **Interfaces**           | 0      | ~6           | ~1       | ~7       |
| **Mixins**               | 0      | ~3           | ~3       | ~6       |
| **Enums**                | 0      | 0            | ~4       | ~4       |
| **Types**                | 0      | ~15          | ~5       | ~20      |
| **Destructuring**        | 0      | ~5           | ~2       | ~7       |
| **Imports**              | 0      | ~3           | ~3       | ~6       |
| **Decorators & Declare** | 0      | ~6           | ~1       | ~7       |
| **Symbols**              | 0      | ~1           | 0        | ~1       |
| **General Errors**       | 0      | 0            | ~5       | ~5       |
| **TOTAL**                | **22** | **~130**     | **~121** | **~273** |

## Porting Priority

1. **Operators & Precedence** — Most critical for a self-hosted parser to get
   right. Every precedence level and associativity must be tested.
2. **Literals** — Foundational; every expression relies on literals parsing
   correctly.
3. **Statements & Control Flow** — Core language mechanics.
4. **Classes** (non-case-class) — Large surface area, many modifier
   combinations.
5. **Functions & Generics** — Generics disambiguation (`<` vs less-than) is
   tricky.
6. **Types & Annotations** — Important for a self-hosted type checker later.
7. **Everything else** — Imports, decorators, mixins, destructuring, etc.

## Error Testing Strategy

Error tests live alongside their feature in an `errors/` subdirectory. Each
error test uses `// @error: regex` to assert the parser produces the expected
diagnostic. Categories:

- **Lexer errors**: unterminated strings, invalid hex, unknown escapes.
- **Unexpected tokens**: wrong token in a position (e.g., `let 123 = x`).
- **Missing delimiters**: unclosed parens, braces, brackets.
- **Invalid constructs**: `const` instead of `let`, keywords as identifiers.
- **Helpful suggestions**: the parser should suggest corrections where possible.
