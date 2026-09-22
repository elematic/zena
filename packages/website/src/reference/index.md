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

- **Core language** — libraries, variables, functions, expressions, operators, comments
- **Data types** — numbers, booleans, strings, records, tuples, arrays, maps, sets, ranges, enums
- **Types** — the sound type system, inference, aliases, distinct types, unions, generics, and narrowing
- **Control flow** — conditionals, loops, pattern matching, destructuring, exceptions, and cancellation
- **Classes** — the nominal type system, interfaces, mixins, and sealed hierarchies
- **Standard library** — one page per `zena:` library
- **Toolchain** — the CLI, targets, flags, formatter, and language server

## Conventions

Code samples are complete unless they end in `// ...`. Where a sample shows an
error or warning, it appears with an inline diagnostic and squiggly underline:

```zena
let n: i32 = 42;
let x: f64 = n;
//           ^ error: i32 is not assignable to f64
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

- [Comments](/reference/comments/) — comments and documentation syntax
- [Libraries](/reference/libraries/) — source files, entry points, imports, and packages
- [Type system overview](/reference/types/) — how the type system fits together
- [Numbers](/reference/numbers/) — integers, floats, and numeric semantics
- [Strings](/reference/strings/) — string literals, template interpolation, and encodings
- [Pattern matching](/reference/pattern-matching/) — `match`, patterns, exhaustiveness
- [Classes](/reference/classes/) — nominal classes and object orientation
- [Standard library](/api/) — what ships with Zena
- [CLI](/reference/cli/) — every command and flag
