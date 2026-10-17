# zena-lint

Lint rules for Zena source, each with a fix. The compiler and type
checker drive every rule, and when a fix is applied it is checked again
before it is kept.

```bash
zena lint [--fix] [--only a,b] [--skip a,b] <paths...>
zena lint --list-rules
```

A path is a `.zena` file or a directory, searched for them. Without
`--fix` the command prints each finding as `path:line:column: message
[rule]` and exits 1 when there is one; with `--fix` it rewrites the
files. `-v` on the command lists every fix and the text of a rejected
one.

The language server (`zena lsp`) publishes the findings as warnings and
offers each as a quick fix, plus a `source.fixAll.zena` code action for
the whole file. The VS Code extension does the same, and adds the
command "Zena: Fix lint findings in file".

## Rules

| rule                     | rewrite                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `function-declaration`   | top-level `let f = (…) => …` → `function f(…) { … }`                                        |
| `unnecessary-cast`       | `x as T` where `x: T` → `x` (from the checker's warning, less contextually typed operands)  |
| `unnecessary-annotation` | `let x: T = e` with `e: T`; return types the body implies; callback parameter types         |
| `collection-literal`     | `new Array<T>()` + `push` runs → `growable<T>([…])`; `new Map<K, V>()` + `[]=` → `{k => v}` |
| `if-initializer`         | `var x = d; if (c) { x = a; }` → `let x = if (c) a else d`                                  |
| `nullish`                | `if (x != null) x else d` → `x ?? d`; `if (x != null) x.f else null` → `x?.f`               |
| `match-to-if`            | one- and two-arm `match` → `if`, `if (x is T)`, `if (let P = x)`                            |
| `else-if`                | `else { if (…) { … } }` → `else if (…) { … }`                                               |
| `for-in`                 | index loops that read only `xs[i]` → `for (let x in xs)`                                    |
| `boolean-return`         | `if (c) { return true; } return false;` → `return c;`; `if (c) true else false` → `c`       |
| `template-literal`       | three or more `+`-joined strings → a template literal                                       |
| `arrow-body`             | `(x) => { return e; }` → `(x) => e`                                                         |
| `prefer-let`             | `var` never assigned again → `let`                                                          |
| `immutable-field`        | `var` field nothing assigns → immutable field (`#private`, or the class is not exported)    |
| `empty-constructor`      | `new() {}` on a class with no other constructor → removed; the default is synthesized       |

## How it works

Each file is compiled and checked with the real `Compiler`, and the rules
walk the syntax tree with the `SemanticModel` beside it. A rule proposes
**text edits** on byte ranges — nothing is re-printed from the AST, so
comments and layout survive. The edits of a pass are applied in memory,
and the result is checked again through an overlay `CompilerHost`. When
the rewrite introduces an error, the driver bisects the edits, keeps the
ones that check, and reports the rest with the checker's message:

```
packages/x/y.zena: 12 edits in 3 passes (function-declaration 9, nullish 3)
  rejected unnecessary-annotation at line 40: 40: Type mismatch: …
```

Passes repeat until no rule has anything to propose, so rules compose:
`var` + `if` becomes `let x = if …`, which becomes `x ?? d`.

A rewrite that holds several edits (a loop header and the line it makes
redundant) is one _group_, applied or rejected whole.

The check after a rewrite is a type check, not a proof: a rule is still
written to preserve meaning on its own, and the tests of the package being
cleaned are the final word. `ZENA_LINT_DEBUG=1` makes some rules say
why they declined a site.

## Adding a rule

A rule is a function `(ctx: RuleContext) => void` in `zena/lib/rules/`,
registered in `zena/lib/rules.zena`. `RuleContext` (`zena/lib/context.zena`)
has the file's text, tree and types, and the questions rules ask: a node's
text and extent, its parent, whether an expression is pure, whether it is
contextually typed, whether a binding is ever assigned. Propose a change
with `replace`, `replaceRange` or `removeRange`; wrap several that belong
together in `beginGroup()` … `endGroup()`.
