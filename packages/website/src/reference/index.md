---
title: 'Reference'
description: 'The Zena language reference: syntax, semantics, the standard library, and the toolchain.'
---

This is the reference for the Zena language, its standard library, and its
toolchain. It aims to be precise about what the language does today, rather than
what it is planned to do.

If you're new to Zena, start with the [guide](/guide/what-is-zena/) instead —
it introduces the same material in reading order.

## How to read this reference

Each page covers one construct and follows the same shape: syntax, semantics,
examples, and how the construct is represented in WebAssembly. The Wasm sections
are there because Zena's design is inseparable from its target; if you only want
to write code, they're safe to skip.

Pages are grouped by what they describe:

- **Declarations** — how names are introduced
- **Types** — the type system and each built-in type
- **Expressions** and **Control flow** — how code is written and evaluated
- **Data types** — records, tuples, arrays, maps, enums
- **Classes** — the nominal type system, in detail
- **Libraries** — modules, imports, exports, visibility
- **Standard library** — one page per `zena:` library
- **Toolchain** — the CLI, targets, flags, formatter, and language server

## Conventions

Code samples are complete unless they end in `// ...`. Where a sample shows an
error, the offending line is commented with the diagnostic:

```zena
let n: i32 = 42;
// let x: f64 = n;  // error: i32 is not assignable to f64
```

Grammar snippets use a light EBNF: `?` for optional, `*` for zero or more, `|`
for alternatives, and `'…'` for literal tokens.

## Feature status

Zena is under active development. Pages carry a badge when the feature they
describe isn't fully implemented:

<ul class="status-legend">
  <li><span class="badge tip">Stable</span> implemented and unlikely to change</li>
  <li><span class="badge warning">In progress</span> partly implemented; details may change</li>
  <li><span class="badge info">Planned</span> designed, not yet implemented</li>
</ul>

Where a page has no badge, treat the behaviour as implemented but the surface as
still open to change — nothing in Zena is frozen yet.

## Quick links

- [Lexical structure](/reference/lexical-structure/) — tokens, comments, semicolons
- [Type system overview](/reference/types/) — how the type system fits together
- [Pattern matching](/reference/pattern-matching/) — `match`, patterns, exhaustiveness
- [Classes](/reference/classes/) — the largest section
- [Standard library](/reference/stdlib/) — what ships with Zena
- [CLI](/reference/cli/) — every command and flag
