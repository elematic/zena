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

### Pipeline Observability via Context Parameters

Zena can support pipeline (and general) observability through **context parameters**—a
feature inspired by Scala's `using`/`given`. Context parameters are regular parameters
that can be automatically provided from the enclosing scope, making them zero-cost
sugar over explicit parameter passing.

#### Context Parameters (Language Feature)

A `context` parameter is an optional parameter with special lookup rules:

```zena
// Function declares it accepts a tracer context
let chunk = (doc: Document, size: i32, context tracer: Tracer?) => {
  tracer?.mark("chunk:start", doc);
  let result = doChunking(doc, size);
  tracer?.mark("chunk:end", result);
  return result;
};
```

**Lookup rules:**
1. If explicitly provided at the call site, use that value
2. Otherwise, look for a matching context in the enclosing scope
3. If no context found, use the default value (typically `null`)

```zena
// No context in scope - tracer is null, marks are no-ops
chunk(doc, 512);

// Provide context explicitly
chunk(doc, 512, tracer: myTracer);

// Or provide context for a scope
with Tracer.console() {
  chunk(doc, 512);           // tracer automatically provided
  embed(chunks);             // same - all context-aware functions receive it
  doc |> chunk($, 512) |> embed($);  // works in pipelines too
}
```

**Key insight**: This is purely sugar for parameter passing. The compiler transforms:
```zena
with Tracer.console() {
  chunk(doc, 512);
}
```
Into:
```zena
let __ctx_tracer = Tracer.console();
chunk(doc, 512, tracer: __ctx_tracer);
```

No hidden global state. No async context propagation problems. Just parameters.

#### The `zena:performance` Module

A general-purpose observability module, not tied to pipelines:

```zena
module zena:performance {
  // Core tracer interface
  interface Tracer {
    // Record a named instant
    let mark: (name: string, data: any?) => void;
    
    // Measure duration of a block
    let measure: <T>(name: string, fn: () => T) => T;
    
    // Start/end spans (for structured tracing)
    let spanStart: (name: string, data: any?) => SpanId;
    let spanEnd: (id: SpanId, data: any?) => void;
  }
  
  // Built-in tracer implementations
  let consoleTracer: () => Tracer;           // Prints to console
  let nullTracer: Tracer;                     // No-op (for type satisfaction)
  let bufferTracer: () => BufferTracer;       // Collects events for later
  
  // Convenience for wrapping functions
  let traced = <T>(name: string, fn: () => T, context tracer: Tracer?) => T;
}
```

#### Using Context for Tracing

Functions opt-in by declaring a context parameter:

```zena
import {Tracer, traced} from "zena:performance";

// Manual instrumentation
let embed = (chunks: List<Chunk>, context tracer: Tracer?) => {
  tracer?.mark("embed:start", ("chunks", chunks.length));
  let embeddings = chunks.map((c) => computeEmbedding(c));
  tracer?.mark("embed:end", ("count", embeddings.length));
  return embeddings;
};

// Or use the helper
let embed = (chunks: List<Chunk>, context tracer: Tracer?) => {
  return traced("embed", () => {
    return chunks.map((c) => computeEmbedding(c));
  });  // tracer flows through via context
};
```

#### Zero-Cost Principle

When no tracer context is in scope:
- `tracer` is `null`
- `tracer?.mark(...)` is a no-op (null-coalescing short-circuits)
- No allocations, no function calls, no overhead

When a tracer is provided:
- Calls happen as written
- Cost is exactly what you'd pay for manual instrumentation

#### Automatic Pipeline Instrumentation (Optional)

For convenience, a `traced` block could auto-instrument pipeline stages:

```zena
import {Tracer} from "zena:performance";

with Tracer.console() {
  // Regular function calls - only traced if the function opts in
  let doc = loadDocument("data.txt");
  
  // Pipeline inside traced block - compiler auto-instruments stages
  let index = traced {
    doc |> chunk($, 512) |> embed($) |> store($, "kb")
  };
}
```

The `traced { pipeline }` block is sugar that the compiler expands:

```zena
// Compiler transforms the traced block to:
let __pipe_0 = doc;
tracer?.mark("stage:0", __pipe_0);
let __pipe_1 = chunk(__pipe_0, 512);
tracer?.mark("stage:1", __pipe_1);
let __pipe_2 = embed(__pipe_1);
tracer?.mark("stage:2", __pipe_2);
let __pipe_3 = store(__pipe_2, "kb");
tracer?.mark("stage:3", __pipe_3);
__pipe_3
```

This is **opt-in at the use site**—the compiler only instruments pipelines inside
`traced {}` blocks. Outside, pipelines compile normally with no overhead.

#### Describable Values

Types can implement `Describable` to provide rich trace output:

```zena
interface Describable {
  let describe: () => string;
}

class VectorStore implements Describable {
  let describe = () => "<VectorStore:" + this.name + " " + this.count + " vectors>";
  // ...
}
```

Tracers can use this for human-readable output:
```
[stage:1] chunk → List<5 Chunks>
[stage:2] embed → List<5 Embeddings>  
[stage:3] store → <VectorStore:kb 5 vectors>
```

#### Host Integration

The host environment can provide tracers that integrate with external systems:

```zena
// In browser - integrate with Performance API
@external("host", "createPerformanceTracer")
let browserTracer: () => Tracer;

// In Node.js - integrate with OpenTelemetry
@external("host", "createOTelTracer") 
let otelTracer: (serviceName: string) => Tracer;

// Usage
with browserTracer() {
  // All traced operations appear in browser DevTools Performance tab
  runPipeline();
}
```

#### Comparison: Context Parameters vs Alternatives

| Approach | Propagation | Async-safe | Zero-cost | Explicit |
|----------|-------------|------------|-----------|----------|
| **Context parameters** | Lexical (compile-time) | ✅ Yes | ✅ Yes | ✅ Yes |
| Global variable | Manual | ❌ No | ✅ Yes | ❌ No |
| JS AsyncContext | Runtime | ⚠️ Complex | ❌ No | ❌ No |
| Thread-local | Runtime | ❌ No | ⚠️ Mostly | ❌ No |
| Explicit passing | Manual | ✅ Yes | ✅ Yes | ✅ Yes |

Context parameters are essentially **compiler-assisted explicit passing**. The compiler
does the tedious work of threading the context through, but the mechanism is just
regular parameters—no runtime magic, no async hazards.

#### Async Considerations

Because context is lexical (resolved at compile time), async works naturally:

```zena
with Tracer.console() {
  // The tracer is captured when the async block is created
  let result = async {
    let data = await fetchData();
    data |> process($) |> validate($)  // tracer still available
  };
}
```

The compiler captures context values into the async closure, just like any other
captured variable. No special async context propagation needed.

#### Open Questions

1. **Syntax for context parameters**: `context tracer: Tracer?` vs `using tracer: Tracer?` vs other?
2. **Syntax for providing context**: `with X { }` vs `given X { }` vs `using X { }`?
3. **Multiple contexts**: Can a scope provide multiple different context types?
4. **Context lookup**: By type only, or by name + type?
5. **Default context providers**: Can a module declare "if no Tracer in scope, use nullTracer"?

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
