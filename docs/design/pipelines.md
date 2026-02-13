# Pipeline Operator

## Overview

The pipeline operator `|>` enables fluent data transformation chains by passing
the result of one expression as input to the next. Combined with placeholder
references, it provides a readable alternative to nested function calls.

## Motivation

Nested function calls become hard to read:

```zena
// Hard to follow - read inside-out
validate(transform(normalize(parse(data)), options), schema)

// Pipeline - read left-to-right
data |> parse($) |> normalize($) |> transform($, options) |> validate($, schema)
```

## Syntax

```
pipeline-expr := expr ( "|>" expr )*
```

The left-hand side is evaluated and made available to the right-hand side via
placeholder references.

### Why `|>`?

| Syntax | Languages                              | Trade-offs                            |
| ------ | -------------------------------------- | ------------------------------------- |
| `\|>`  | F#, Elixir, Elm, OCaml, JS proposal    | ✅ Widely recognized, no conflicts    |
| `\|`   | Unix shell                             | ❌ Conflicts with bitwise OR, unions  |
| `>>`   | Some FP languages                      | ❌ Conflicts with bit shift right     |
| `->`   | Clojure thread-first                   | ❌ Conflicts with arrow functions     |
| `%>%`  | R (magrittr)                           | ❌ Ugly, unfamiliar                   |
| `then` | Some proposals                         | ❌ Verbose keyword                    |

**Decision**: `|>` is the right choice because:

1. **Recognition**: Anyone familiar with F#, Elixir, or the JS proposal knows it
2. **No conflicts**: We can still have `|` for bitwise OR and union types
3. **Directional**: The `>` clearly shows data flowing right
4. **Precedent**: The JS proposal has popularized this syntax widely

## Placeholder Reference

The placeholder `$` refers to the piped value:

```zena
// Single value
data |> transform($) |> validate($)

// With tuple indexing for multi-returns
person.getNames() |> formatName($[0], $[1])

// Mix with other arguments
map.get(key) |> process($[0], defaultOptions)
```

### Why `$`?

| Sigil | Pros                                    | Cons                                                  |
| ----- | --------------------------------------- | ----------------------------------------------------- |
| `$`   | Familiar (shell), unused in Zena, clean | None significant                                      |
| `*`   | Intuitive "the thing"                   | Conflicts with multiplication                         |
| `@`   | Unused                                  | Decorators in other languages                         |
| `^`   | Visually "points up"                    | XOR in other languages                                |
| `_0`  | Extends `_` family                      | **Confusing**: `_` in expressions means "unreachable" |

**Note on `_`**: In patterns, `_` means "I don't care about this value". But in
expressions (like `(_, false)` returns), `_` means "this value is unreachable".
Using `_0` for "the important piped value" would be semantically backwards.

### Tuple Indexing

Multi-return values are accessed via tuple indexing `$[n]`:

```zena
// getNames() returns (string, string)
person.getNames() |> formatFullName($[0], $[1])

// map.get() returns (V, bool)
scores.get(name) |> if ($[1]) processScore($[0]) else 0
```

This reuses the general tuple indexing feature (`expr[n]` for tuples) rather
than introducing separate positional placeholders.

## Operator Precedence

The pipeline operator has very low precedence, below assignment but above comma:

```zena
let result = data |> transform(_0) |> validate(_0)  // works as expected
```

## Interaction with Other Features

### Block Expressions

For complex transformations, combine with block expressions:

```zena
data |> {
  let processed = transform($);
  if (processed.isValid) {
    processed.value
  } else {
    defaultValue
  }
}
```

### Tuple Indexing

Outside of pipelines, use `[n]` for tuple element access:

```zena
let firstName = person.getNames()[0]
```

Inside pipelines, `$[0]`, `$[1]` provide the same access on the piped value.

### Method Calls

Pipeline works naturally with method calls:

```zena
text |> $.trim() |> $.toUpperCase() |> $.split(" ")
```

Though for pure method chaining, regular `.` syntax may be clearer:

```zena
text.trim().toUpperCase().split(" ")
```

Pipelines shine when mixing functions and methods, or when arguments are needed.

## Implementation Notes

### Parsing

`|>` is a new binary operator token. `$` is a new keyword/identifier that is
only valid within the right-hand side of a pipeline expression.

### Type Checking

- Track the type flowing through the pipeline (may be a tuple type)
- `$` has that type
- `$[n]` uses standard tuple indexing rules
- Error if `$` is used outside a pipeline context

### Code Generation

For WASM, pipeline is syntactic sugar that desugars to let bindings:

```zena
// Source
a |> f($) |> g($[0], $[1])

// Desugars to (conceptually)
let __pipe_0 = a
let __pipe_1 = f(__pipe_0)
g(__pipe_1[0], __pipe_1[1])
```

Multi-returns stay on the stack until needed.

## Future Considerations

### Async Pipelines

Could extend to async with `|>!` or similar:

```zena
fetchUser(id) |>! validateUser($) |>! saveUser($)
```

### Pipeline Functions

Point-free style for simple transformations:

```zena
let process = |> parse($) |> validate($) |> transform($)
data |> process
```

## Summary

| Feature          | Syntax         | Purpose                      |
| ---------------- | -------------- | ---------------------------- |
| Pipeline         | `a \|> b`      | Chain transformations        |
| Placeholder      | `$`            | Reference piped value        |
| Tuple indexing   | `$[0]`, `$[1]` | Access multi-return elements |
| Block expression | `{ ... }`      | Complex logic in pipeline    |

The pipeline operator with `$` placeholder provides ergonomic data
transformation while keeping the syntax minimal and avoiding confusion with `_`
(which means "unreachable" in expressions).
