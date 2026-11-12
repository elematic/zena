# Development

Notes for working on `zena-lint`.

## How It Works

Each file is compiled and checked with the real `Compiler`, and the rules walk the syntax tree with the `SemanticModel` beside it. A rule proposes **text edits** on byte ranges — nothing is re-printed from the AST, so comments and layout survive. The edits of a pass are applied in memory, and the result is checked again through an overlay `CompilerHost`. When the rewrite introduces an error, the driver bisects the edits, keeps the ones that check, and reports the rest with the checker's message:

```
packages/x/y.zena: 12 edits in 3 passes (function-declaration 9, nullish 3)
  rejected unnecessary-annotation at line 40: 40: Type mismatch: …
```

Passes repeat until no rule has anything to propose, so rules compose: `var` + `if` becomes `let x = if …`, which becomes `x ?? d`.

A rewrite that holds several edits (a loop header and the line it makes redundant) is one _group_, applied or rejected whole.

The check after a rewrite is a type check, not a proof: a rule is still written to preserve meaning on its own, and the tests of the package being cleaned are the final word. `ZENA_LINT_DEBUG=1` makes some rules say why they declined a site.

The compiler's source, and the standard library files it imports, are also compiled by the bootstrap (`docs/design/bootstrapping.md`), whose checker is older than the one lint checks with, so a rewrite lint keeps can still fail `build:cli`. Clean them one rule at a time (`--only <rule>`), running `npm run build:cli -w @zena-lang/zena-compiler` after each rule and `npm test` at the end.

## Adding a Rule

A rule is a function `(ctx: RuleContext) => void` in `src/rules/`, registered in `src/rules.zena`. `RuleContext` (`src/context.zena`) has the file's text, tree and types, and the questions rules ask: a node's text and extent, its parent, whether an expression is pure, whether it is contextually typed, whether a binding is ever assigned. Propose a change with `replace`, `replaceRange` or `removeRange`; wrap several that belong together in `beginGroup()` … `endGroup()`.

## Running Tests

```bash
npm test -w @zena-lang/zena-lint
```

Or run the test suite directly:

```bash
./target/release/zena-cli test packages/zena-lint/test/lint_test.zena
```
