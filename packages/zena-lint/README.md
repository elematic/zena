# `zena-lint`

Lint rules for Zena source code, each with an automated fix. The compiler and type checker drive every rule, and when a fix is applied it is type-checked again before it is kept.

## Usage

### Command Line

```bash
zena lint [--fix] [--only a,b] [--skip a,b] <paths...>
zena lint --list-rules
```

A path is a `.zena` file or a directory, searched for them. Without `--fix` the command prints each finding as `path:line:column: message [rule]` and exits 1 when there is one; with `--fix` it rewrites the files. `-v` on the command lists every fix and the text of any rejected one.

The language server (`zena lsp`) publishes the findings as warnings and offers each as a quick fix, plus a `source.fixAll.zena` code action for the whole file.

### Library API

```zena
import { LintOptions, lintFile } from 'zena-lint';
import { Project } from 'zena-lint/checking';
import { allRules } from 'zena-lint/rules';

let project = new Project();
let options = new LintOptions(allRules());
let report = await lintFile(project, 'src/main.zena', options);
```

## Rules

| Rule                     | Rewrite                                                                                     |
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
| `console-to-string`      | ``console.log(`${x}`)`` and `console.log(i32ToString(x))` → `console.log(x)`                |
| `arrow-body`             | `(x) => { return e; }` → `(x) => e`                                                         |
| `prefer-let`             | `var` never assigned again → `let`                                                          |
| `immutable-field`        | `var` field nothing assigns → immutable field (`#private`, or the class is not exported)    |
| `empty-constructor`      | `new() {}` on a class with no other constructor → removed; the default is synthesized       |

## Libraries

- `zena-lint` / `zena-lint/lint` — lint driver (`lintFile`, `lintSource`, `LintOptions`, `FileReport`)
- `zena-lint/checking` — compiler project wrapper and overlay host (`Project`, `CheckedFile`)
- `zena-lint/checked` — checked module wrapper (`CheckedFile`)
- `zena-lint/rules` — rule registry (`allRules`, `ruleNamed`)
- `zena-lint/rule` — rule runner (`NamedRule`, `proposeEdits`, `messageOf`)
- `zena-lint/context` — rule traversal context (`RuleContext`)
- `zena-lint/source` — byte-range edits (`Edit`, `applyEdits`, `columnOf`)
- `zena-lint/files` — `.zena` file discovery (`collectZenaFiles`)

## License

MIT
