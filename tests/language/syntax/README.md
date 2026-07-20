# Portable Syntax Tests

This directory contains portable syntax tests for Zena. These tests verify parser correctness and AST structure, and are shared between the TypeScript bootstrap compiler and the Zena self-hosted parser.

## Conventions

- Each `.zena` file tests ONE construct or interaction (small, focused).
- Files use directives: `// @target: statement|expression|module`.
- File names are `kebab-case` and descriptive (e.g., `nested-ternary.zena`).
- Directories group related constructs into suites.
- Error tests use `// @error: regex` for expected parse errors.
- Precedence/associativity tests verify tree shape (which operand is deeper).

## Porting & Testing Workflow

The portable test runner lives at `packages/compiler/src/test/portable-runner.ts` and is invoked via the `portable-syntax_test.ts` test file, which discovers all `.zena` files under `tests/language/syntax/` recursively.

### Snapshot Auto-Generation

When a `.zena` file has no corresponding `.ast.json` file, the runner parses the source, strips location info, and writes the cleaned AST as the snapshot automatically. The workflow is:

1. Create only the `.zena` file.
2. Run `npm test -w @zena-lang/compiler` (Wireit runs the portable suite).
3. Verify the auto-generated `.ast.json` looks correct.
4. Commit both files.

**AST cleanup**: The runner's `stripLocation()` removes `loc`, `start`, `end`, `inferredType`, and `inferredTypeArguments` fields recursively before comparison.

### Gotchas to Keep in Mind

- **`{` is ambiguous with blocks**: Record literals (`{x: 1}`) and map literals (`{"a" => 1}`) cannot use `@target: expression` because the parser treats a leading `{` as a block statement. Use `@target: statement` with a `let` binding instead (e.g., `let r = {x: 1};`).
- **Empty braces `{}` always parse as empty record**: There is no empty map literal syntax.
- **Single-element parens are grouping, not tuples**: `(42)` parses as just a `NumberLiteral`, not a `TupleLiteral`. Tuples require 2+ elements. Empty parens `()` throw an error.
- **Record shorthand has no flag**: `{x}` produces a `PropertyAssignment` where both `name` and `value` are `Identifier` nodes with the same `name` string.
- **Self-hosted parser support**: When adding new syntax, you must add support to:
  1. `ast.zena` — Add the case class to the appropriate sealed class (`Node`, `Statement`, `Expression`, `TypeAnnotation`, etc.)
  2. `parser.zena` — Add parsing logic.
  3. `ast-json.zena` — Add the type name mapping in `nodeTypeName()` and field serialization in `nodeToJson()`.
- **`else { };` in match case blocks**: Inside match case bodies (which are block expressions), if-statements that have no meaningful else branch still need `else { };` because existing code follows this pattern.
