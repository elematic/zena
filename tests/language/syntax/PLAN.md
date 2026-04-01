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
│   ├── simple.zena                         [done] identifiers_test
│   ├── with-underscore.zena               [done] identifiers_test
│   ├── with-dollar.zena                   [done] identifiers_test
│   ├── leading-underscore.zena            [done] identifiers_test
│   ├── leading-dollar.zena                [done] identifiers_test
│   ├── keyword-like.zena                  [done] identifiers_test (from, as, etc.)
│   └── errors/
│       ├── starts-with-digit.zena         [done]
│       └── reserved-keyword.zena          [done]
│
├── comments/
│   ├── single-line.zena                    [done] lexer_test
│   ├── multi-line.zena                     [done] lexer_test
│   ├── inline.zena                         [done]
│   └── nested-multiline.zena              [done]
│
├── variables/
│   ├── let-inferred.zena                   [done] variable_decl
│   ├── let-typed.zena                      [done]
│   ├── var-inferred.zena                   [done] parser_test
│   ├── var-typed.zena                      [done]
│   ├── const-function.zena                [done] parser_test
│   ├── exported-let.zena                  [done]
│   ├── exported-var.zena                  [done]
│   └── errors/
│       ├── const-suggested.zena           [done] variable-declaration-errors_test
│       ├── let-suggested.zena             [done] variable-declaration-errors_test
│       ├── missing-initializer.zena       [done]
│       └── duplicate-declaration.zena     [new] (checker-level)
│
├── operators/
│   ├── arithmetic/
│   │   ├── add.zena                       [done] parser_test
│   │   ├── subtract.zena                  [done] parser_test
│   │   ├── multiply.zena                  [done] parser_test
│   │   ├── divide.zena                    [done] parser_test
│   │   ├── modulo.zena                    [done]
│   │   └── mixed.zena                     [done] — e.g., a + b * c (precedence)
│   │
│   ├── comparison/
│   │   ├── less-than.zena                 [done]
│   │   ├── less-equal.zena                [done]
│   │   ├── greater-than.zena              [done]
│   │   ├── greater-equal.zena             [done]
│   │   ├── equal.zena                     [done]
│   │   ├── not-equal.zena                 [done]
│   │   ├── strict-equal.zena              [done]
│   │   └── strict-not-equal.zena          [done]
│   │
│   ├── logical/
│   │   ├── and.zena                       [done]
│   │   ├── or.zena                        [done]
│   │   ├── not.zena                       [done] unary_test
│   │   └── mixed.zena                     [done] — a && b || c (precedence)
│   │
│   ├── bitwise/
│   │   ├── and.zena                       [done]
│   │   ├── or.zena                        [done]
│   │   ├── xor.zena                       [done]
│   │   ├── shift-left.zena                [done] shift-operators_test
│   │   ├── shift-right.zena               [done] shift-operators_test
│   │   ├── unsigned-shift-right.zena      [done] shift-operators_test
│   │   └── mixed.zena                     [done] — a & b | c (precedence)
│   │
│   ├── unary/
│   │   ├── negate.zena                    [done] unary_test
│   │   ├── not.zena                       [done] unary_test
│   │   └── double-negate.zena             [done]
│   │
│   ├── assignment/
│   │   ├── simple.zena                    [done] parser_test
│   │   └── member-assignment.zena         [done]
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
│   │   ├── closed.zena                    [done] range-expression_test
│   │   ├── open-end.zena                  [done] range-expression_test
│   │   ├── open-start.zena                [done] range-expression_test
│   │   └── unbounded.zena                 [done] range-expression_test
│   │
│   ├── pipeline/
│   │   ├── basic.zena                     [done] parser-pipeline_test
│   │   ├── chained.zena                   [done] parser-pipeline_test
│   │   └── placeholder.zena              [done] parser-pipeline_test
│   │
│   ├── cast/
│   │   ├── as-expression.zena             [done]
│   │   └── is-expression.zena             [done]
│   │
│   └── precedence/
│       ├── mul-before-add.zena            [done] — a + b * c
│       ├── add-before-compare.zena        [done] — a + b < c + d
│       ├── compare-before-logical.zena    [done] — a < b && c > d
│       ├── and-before-or.zena             [done] — a && b || c
│       ├── bitwise-order.zena             [done] — a & b ^ c | d
│       ├── shift-before-compare.zena      [done] — a << 1 < b
│       ├── unary-before-binary.zena       [done] — -a + b
│       ├── parens-override.zena           [done] — (a + b) * c
│       ├── pipeline-precedence.zena       [done] — a + b |> f($)
│       ├── range-precedence.zena          [done] — a + 1 .. b - 1
│       ├── nullish-vs-logical.zena        [done] — ensure ?? doesn't mix with ||
│       └── assignment-lowest.zena         [done] — x = a + b * c
│
├── expressions/
│   ├── calls/
│   │   ├── simple.zena                    [done] parser_test
│   │   ├── multiple-args.zena             [done]
│   │   ├── no-args.zena                   [done]
│   │   ├── nested.zena                    [done]
│   │   ├── method-call.zena               [done]
│   │   └── chained-method.zena            [done]
│   │
│   ├── member-access/
│   │   ├── simple.zena                    [done]
│   │   ├── chained.zena                   [done]
│   │   └── computed-index.zena            [done]
│   │
│   ├── new/
│   │   ├── simple.zena                    [done]
│   │   ├── with-args.zena                 [done]
│   │   └── generic.zena                   [done]
│   │
│   ├── this.zena                          [done]
│   │
│   ├── super/
│   │   ├── constructor-call.zena          [ts] parser-super_test
│   │   ├── method-call.zena               [ts] parser-super_test
│   │   └── field-access.zena              [ts] parser-super_test
│   │
│   ├── if-expression/
│   │   ├── simple.zena                    [done] if-expression_test
│   │   ├── nested.zena                    [done] if-expression_test
│   │   ├── without-braces.zena            [done]
│   │   ├── with-comparison.zena           [done] if-expression_test
│   │   └── with-block.zena                [done]
│   │
│   ├── match/
│   │   ├── literal-pattern.zena           [done] match-expression_test
│   │   ├── identifier-pattern.zena        [done] match-expression_test
│   │   ├── wildcard-pattern.zena          [done] match-expression_test
│   │   ├── record-pattern.zena            [done] match-expression_test
│   │   ├── tuple-pattern.zena             [done] match-expression_test
│   │   ├── class-pattern.zena             [done] match-expression_test
│   │   ├── as-pattern.zena                [done] match-expression_test
│   │   ├── or-pattern.zena                [done] match-expression_test
│   │   ├── and-pattern.zena               [done] match-expression_test
│   │   ├── guard.zena                     [done] parser-match-guard_test
│   │   ├── block-body.zena                [done] match-expression_test / block-statement_test
│   │   ├── nested-pattern.zena            [done] match-expression_test
│   │   ├── enum-pattern.zena              [done] enum-pattern_test
│   │   └── multiple-cases.zena            [done]
│   │
│   ├── throw.zena                         [done] throw_test
│   │
│   ├── try-catch/
│   │   ├── basic.zena                     [done] try-catch_test
│   │   ├── with-finally.zena              [done] try-catch_test
│   │   ├── catch-no-param.zena            [done] try-catch_test
│   │   └── nested.zena                    [done] try-catch_test
│   │
│   └── grouping/
│       └── parenthesized.zena             [done] — (a + b)
│
├── statements/
│   ├── blocks/
│   │   ├── simple.zena                    [done] block-statement_test
│   │   ├── nested.zena                    [done]
│   │   └── empty.zena                     [done]
│   │
│   ├── if/
│   │   ├── simple.zena                    [done]
│   │   ├── if-else.zena                   [done]
│   │   ├── if-else-if.zena                [done]
│   │   └── let-pattern.zena              [done] — if (let x = expr)
│   │
│   ├── while/
│   │   ├── simple.zena                    [done] parser_test
│   │   ├── let-pattern.zena              [done] — while (let x = expr)
│   │   └── break-continue.zena           [done]
│   │
│   ├── for/
│   │   ├── c-style.zena                   [done] parser-for_test
│   │   ├── empty-init.zena                [done] parser-for_test
│   │   ├── empty-test.zena                [done] parser-for_test
│   │   ├── empty-update.zena              [done] parser-for_test
│   │   ├── all-empty.zena                 [done] parser-for_test
│   │   └── for-in.zena                    [done]
│   │
│   ├── return/
│   │   ├── value.zena                     [done]
│   │   ├── void.zena                      [done]
│   │   └── tuple.zena                     [done] — return (a, b)
│   │
│   ├── break.zena                         [done]
│   ├── continue.zena                      [done]
│   │
│   └── expression-statement.zena          [done]
│
├── functions/
│   ├── arrow/
│   │   ├── expression-body.zena           [done] parser_test
│   │   ├── block-body.zena                [done]
│   │   ├── no-params.zena                 [done]
│   │   ├── single-param.zena              [done]
│   │   ├── multiple-params.zena           [done]
│   │   ├── typed-params.zena              [done] parser_test
│   │   ├── return-type.zena               [done]
│   │   ├── optional-param.zena            [done] parser-optional-params_test
│   │   ├── default-param.zena             [done]
│   │   └── contextual-typing.zena        [done] contextual-typing-parser_test
│   │
│   ├── generic/
│   │   ├── single-param.zena              [done] generics-parser_test
│   │   ├── multiple-params.zena           [done] generics-parser_test
│   │   ├── constraint.zena                [done] generics-parser_test
│   │   ├── default-type.zena              [done] generics-parser_test
│   │   └── nested-generic.zena            [done]
│   │
│   └── closure/
│       └── captures-variable.zena         [done]
│
├── classes/
│   ├── basic/
│   │   ├── empty.zena                     [done]
│   │   ├── with-fields.zena               [done] parser-class_test
│   │   ├── with-methods.zena              [done] parser-class_test
│   │   ├── with-constructor.zena          [done]
│   │   ├── exported.zena                  [done]
│   │   └── field-mutability.zena          [done] — let vs var fields
│   │
│   ├── inheritance/
│   │   ├── extends.zena                   [done] parser_test (basic)
│   │   ├── super-constructor.zena         [done] parser-super_test
│   │   ├── super-method.zena              [done] parser-super_test
│   │   ├── super-field.zena               [done] parser-super_test
│   │   └── abstract-class.zena            [done] parser-abstract_test
│   │
│   ├── modifiers/
│   │   ├── final-class.zena               [done] parser-final_test
│   │   ├── final-method.zena              [done] parser-final_test
│   │   ├── abstract-method.zena           [done] parser-abstract_test
│   │   └── private-fields.zena            [done] parser-private-fields_test
│   │
│   ├── accessors/
│   │   ├── getter.zena                    [done] parser-class_test
│   │   ├── setter.zena                    [done] parser-class_test
│   │   └── getter-setter-pair.zena        [done]
│   │
│   ├── operators/
│   │   ├── operator-eq.zena               [done] operator_parser_test
│   │   ├── operator-index.zena            [done] operator_parser_test
│   │   ├── operator-index-set.zena        [done] operator_parser_test
│   │   ├── operator-plus.zena             [done] operator_parser_test
│   │   └── operator-overloaded.zena       [done] — multiple signatures
│   │
│   ├── generic-class/
│   │   ├── single-param.zena              [done] generics-parser_test
│   │   ├── multiple-params.zena           [done] generics-parser_test
│   │   ├── constraint.zena                [done] generics-parser_test
│   │   ├── default-type.zena              [done] generics-parser_test
│   │   ├── generic-method.zena            [done] generic-method_test
│   │   └── extends-generic.zena           [done] generics-parser_test
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
│   │   └── basic.zena                     [done]
│   │
│   └── initializer-list/
│       ├── basic.zena                     [done] initializer-list-private_test
│       └── with-super.zena               [done] initializer-list-private_test
│
├── interfaces/
│   ├── empty.zena                         [done] parser-interface_test
│   ├── with-methods.zena                  [done] parser-interface_test
│   ├── with-fields.zena                   [done] parser-interface_test
│   ├── extends.zena                       [done] parser-interface_test
│   ├── generic.zena                       [done] parser-interface_test
│   ├── implements.zena                    [done] parser-interface_test
│   └── accessor-signature.zena            [done]
│
├── mixins/
│   ├── basic.zena                         [done] parser-mixin_test
│   ├── with-on-clause.zena                [done] parser-mixin_test
│   ├── with-fields.zena                   [done]
│   ├── with-methods.zena                  [done]
│   ├── class-with-mixin.zena              [done] parser-mixin_test
│   └── generic.zena                       [done] generic-method_test
│
├── enums/
│   ├── basic.zena                          [done]
│   ├── with-values.zena                   [done]
│   ├── string-values.zena                 [done]
│   └── exported.zena                      [done]
│
├── types/
│   ├── annotations/
│   │   ├── primitive.zena                 [done]
│   │   ├── named.zena                     [done]
│   │   ├── generic.zena                   [done]
│   │   ├── nested-generic.zena            [done]
│   │   └── nullable.zena                  [done]
│   │
│   ├── aliases/
│   │   ├── simple.zena                    [done]
│   │   ├── generic.zena                   [done]
│   │   └── distinct.zena                  [done]
│   │
│   ├── unions/
│   │   ├── two-types.zena                 [done]
│   │   ├── three-types.zena               [done]
│   │   └── nullable.zena                  [done]
│   │
│   ├── function-types/
│   │   ├── no-params.zena                 [done]
│   │   ├── single-param.zena              [done]
│   │   ├── multiple-params.zena           [done]
│   │   └── returning-function.zena        [done]
│   │
│   ├── literal-types/
│   │   ├── string.zena                    [done]
│   │   ├── number.zena                    [done]
│   │   ├── boolean-true.zena              [done]
│   │   └── boolean-false.zena             [done]
│   │
│   ├── record-types/
│   │   ├── basic.zena                     [done]
│   │   ├── optional-field.zena            [done]
│   │   └── nested.zena                    [done]
│   │
│   ├── tuple-types/
│   │   ├── basic.zena                     [done]
│   │   └── nested.zena                    [done]
│   │
│   ├── inline-tuple-types/
│   │   ├── basic.zena                     [done]
│   │   ├── type-annotation.zena           [done]
│   │   ├── return-expression.zena         [done]
│   │   ├── destructuring.zena             [done]
│   │   └── union-of-tuples.zena           [done]
│   │
│   └── this-type/
│       ├── return-type.zena               [done]
│       └── parameter-type.zena            [done]
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
| **Identifiers**          | 8      | 0            | 0        | 8        |
| **Comments**             | 0      | ~2           | ~2       | ~4       |
| **Variables**            | 1      | ~3           | ~5       | ~9       |
| **Operators**            | 51     | 0            | ~7       | ~58      |
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
