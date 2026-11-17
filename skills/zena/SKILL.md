---
name: zena
description: >-
  Write, review, test, and debug code in the Zena programming language (`.zena`
  files, `zena-package.json`, `zebra.json`, and WebAssembly GC or WASI targets).
  Use whenever a task involves Zena source code, Zena packages, or the `zena`
  CLI toolchain.
---

# Zena Programming Language

## Language Overview

Start with TypeScript's module, generic (`<T extends U>`), union (`T | U`), arrow (`(x) => ...`), `#private`, `?.`/`??`, and template literal (`` `${x}` ``) syntax. Remove all JavaScript dynamic behavior (`any`, `undefined`, truthiness, implicit coercion, unbound `this`, mutable object shapes) and enforce a **sound**, **non-nullable-by-default** static type system compiled ahead-of-time to **WebAssembly GC**:

- **Nominal vs. structural and value types**: `class` and `interface` are nominal; records `{x: 1, y: 2}` and tuples `(1, 'a')` are immutable structural values (`==` compares contents, `===` is a compile error, and optional record fields `k?: T` track presence rather than nullability).
- **True primitives and explicit boxing**: Fixed-width Wasm scalars (`i32`, `i64`, `u32`, `u64`, `i8`–`u16`, `f32`, `f64`, `boolean`, `v128`); `/` always returns a float (`div(a, b)` in `zena:math` performs integer division), and `anyref` holds references only (`new Box(x)` boxes a primitive explicitly).
- **Dart-style classes, mixins, and extensions + Swift mutability**: Two-phase constructors (`new(this.x, this.y) : super(...)`), named constructors (`new origin()`), linearized `mixin M on Base` (`with M`), and zero-cost erased `extension class Meters on f64` (plus `distinct type` and `opaque type`). Variables (`let` vs `var`) and class fields are immutable by default (`var(#x) x` gives a public getter and private setter).
- **Scala-style ADTs + Rust/Dart 3 pattern matching**: Closed `sealed class` hierarchies and concise case classes (`class Pair<A, B>(first: A, second: B)`, inline `case Lit(value: i32)`) with synthesized `==` and `hashCode`, paired with exhaustive `match (x) { case Lit {value} if value > 0: ... }` expressions and `if (let P = x)` / `while (let P = x)` bindings.
- **Unicode-safe `String`**: `'...'`, `"..."`, `` `${x}` ``, and cached tagged templates (`` regex`...` ``, `` dedent`...` ``) create immutable UTF-8/WTF-8 `String` instances with no `str[i]` integer indexing (scan with `StringReader`, build with `StringBuilder`).
- **Zero-allocation multi-value returns**: Functions return unboxed Wasm-stack tuples and tagged unions (`inline (i32, i32)`, `inline (true, V) | (false, _)`, `inline Result<T, E>`), consumed via `if (let (true, v) = ...)` or unwrapped directly by `??` (`map.get(k) ?? fallback`).
- **Zero-allocation iteration and compile-time symbols**: Static `symbol` declarations (`static symbol iterator;`), declared `[Sym]()` and called via `.[Sym]()` (distinct from `xs[i]` indexing); `for (let x in xs)` drives `Iterator.next()`, returning an unboxed `Step<T>` inline tuple with zero per-step allocation, and sync `Iterator<T>` subtypes `AsyncIterator<T>`.
- **Affine resources and stack-bound borrows**: Wasm GC manages ordinary objects; external handles and linear memory use lexical `using` (`[Disposable.dispose]()`) or `resource class` with erased `Own<R>` (single-owner moves, compiler-inserted drop) and second-class stack-bound `Borrow<R>` (never escapes to heap fields or closures, requiring no lifetime annotations).
- **First-class async cancellation**: Structured concurrency via `TaskGroup` (`zena:async`) unwinds cancellation on a third channel separate from `return` and `Error` (`catch` ignores cancellation; `cancel` clauses and `shielded` blocks run cleanup).
- **Contracts**: Function, method, and constructor `requires` and `ensures` (`result`, `old(e)`) and loop `invariant` clauses run as assertions (always-on, `debug` under `zena test` and `-g`, or `static` specifications for in-progress static verification), and unmarked `requires` narrows types in the body.

## Idiomatic Example

```zena
import {div} from 'zena:math';

distinct type Score = i32;

sealed class Expr {
  case Lit(value: i32)
  case Div(left: Expr, right: Expr)
}

function evaluate(expr: Expr): inline (true, i32) | (false, _) {
  return match (expr) {
    case Lit {value}: (true, value)
    case Div {left, right}: {
      if (let (true, l) = evaluate(left)) {
        if (let (true, r) = evaluate(right)) {
          if (r != 0) {
            return (true, div(l, r));
          }
        }
      }
      (false, _)
    }
  };
}

class Counter {
  step: i32;
  var(#count) count = 0;

  new(this.step) requires (step > 0);

  advance(): i32
    ensures (this.count == old(this.count) + this.step)
    ensures (result == this.count)
  {
    this.#count += this.step;
    return this.count;
  }
}

export function main(): i32 {
  let weights = {'alpha' => 10 as Score, 'beta' => 20 as Score};
  let bonus = (weights.get('gamma') ?? (5 as Score)) as i32;
  let tree = new Div(new Lit(84), new Lit(2));
  return (evaluate(tree) ?? 0) |> $ + bonus;
}
```

## Idiomatic Zena Patterns

Agents trained heavily on TypeScript often write TypeScript-shaped code in Zena and miss Zena's stronger, lower-cost constructs. Prefer these Zena idioms:

### Top-level `function` vs. arrow closures

Write top-level functions as `function name(...) { ... }`. They are hoisted (supporting mutual recursion) and never allocate closure structs. Use arrow functions `(x) => ...` when capturing enclosing locals or passing inline callbacks, and omit callback parameter types when contextually typed:

```zena
function sumPositive(xs: FixedArray<i32>): i32 {
  return xs.fold(0, (acc, x) => if (x > 0) acc + x else acc);
}
```

### `sealed class`, `match`, and expression control flow

Model sum types as `sealed class` hierarchies with `case` variants (instead of string-tagged object unions or boolean flag bags) and branch with exhaustive `match` expressions. `if`, `match`, and `try` all evaluate to values. For one or two branches, prefer `if`, `if (x is Sub)`, or `if (let P = x)` over a one- or two-arm `match` (`zena lint` rewrites small matches to `if`).

### Unboxed `inline` multi-value returns

Avoid allocating heap `Option<T>` wrappers, sentinel `null`s, or double `has()`/`get()` lookups on hot paths. Return stack-resident `inline` tuples or tagged unions:

```zena
import {Result, parseI32} from 'zena:core';

function minMax(a: i32, b: i32): inline (i32, i32) {
  return if (a <= b) (a, b) else (b, a);
}

function parsePort(text: String): inline Result<i32, String> {
  if (let (true, n) = parseI32(text)) {
    return if (n >= 1 && n <= 65535) (true, n) else (false, 'out of range');
  }
  return (false, 'invalid integer');
}

let (lo, hi) = minMax(20, 10);
let port = parsePort(raw) ?? 8080; // `??` unwraps `(true, v)` directly
if (let (true, hit) = cache.get(key)) {
  use(hit);
}
```

### Zero-cost domain types and case classes

- **`distinct type UserId = i32;`**: Nominal type safety at zero runtime cost (`42 as UserId`).
- **`export opaque type SafePath = String;`**: Like `distinct`, and restricts `as SafePath` casts to the declaring file so validation invariants hold across callers.
- **`extension class Meters on f64`**: Zero-cost typed view adding statically dispatched methods, operators, and constructors (`new(v: f64) : super(v);`, or `x as Meters`) to primitives, classes, or Wasm GC arrays with zero boxing.
- **Case classes (`class Key(ns: String, id: i32)`)**: Auto-generate immutable fields, constructor, `operator ==`, and `hashCode()`, making them ready to use directly as `Map` and `HashSet` keys.

See [classes-and-types.md](./references/classes-and-types.md) for full details.

### Collections, literals, and concrete annotations

- `[1, 2, 3]` creates a genuinely immutable `ImmutableArray<i32>`. Use `fixed([1, 2, 3])` or `growable([1, 2, 3])` (from `zena:core` / `zena:collections`), `new FixedArray<i32>(len, 0)`, `new Array<i32>()` (empty `GrowableArray`), `{'a' => 1}` for `Map<String, i32>`, and `new HashSet<T>()` (`zena:collections`) instead of `Map<T, boolean>`.
- Slice arrays with half-open ranges: `xs[1..4]`, `xs[2..]`, `xs[..3]`.
- Annotate locals, fields, and parameters with concrete collection classes (`GrowableArray<T>`, `FixedArray<T>`, `HashMap<K, V>`, `HashSet<T>`) unless the binding accepts multiple implementations; `Array<T>` and `Iterable<T>` interface values carry fat pointers and indirect dispatch.

### Contracts on boundaries and algorithms

Add `requires`, `ensures` (`result`, `old(expr)`), and loop `invariant` clauses to state preconditions, postconditions, and index bounds directly on signatures. Put expensive checks behind `debug` (`debug requires (isSorted(xs))`) so `zena test` and `zena -g` verify them while release builds emit zero code. Unmarked `requires` clauses narrow nullable and union parameters throughout the body. See [contracts.md](./references/contracts.md).

### Resources (`using`, `Own`, `Borrow`) and async cancellation

WebAssembly GC has no finalizers. Bind lexical `Disposable` values with `using f = open(path);`, and model transferable external handles as `resource class` with `Own<R>` and stack-bound `Borrow<R>`. Use `TaskGroup` (`zena:async`), `cancel { ... }`, and `shielded { ... }` for structured concurrency and async cleanup. See [ownership-and-async.md](./references/ownership-and-async.md).

### Pipelines, tagged templates, `for-in`, and symbols

- Left-to-right data flow: `input |> trim($) |> parse($)` (`$` marks the piped value in any argument slot).
- Tagged templates: `` regex`^[a-z]+$` `` (`zena:regex`) and `` dedent`...` `` (`zena:core`).
- Iteration: `for (let item in items)` and `for (let {key, value} in map)` (note `in`, never `of`; `Map` yields `MapEntry`).
- Protocol methods: declare `static symbol s;` on an interface, implement `[Iface.s]()`, and call `value.[Iface.s]()`.

## Differences from TypeScript

- **Variables**: `let` is immutable; `var` is mutable. There is no `const` and no `++`/`--` (`x += 1`).
- **Strings**: Type is `String` (capital `S`). Direct `str[i]` indexing is a compile error; scan UTF-8 code points or safe byte offsets with `StringReader` and assemble strings in loops with `StringBuilder`.
- **Numbers and division**: Integer literals default to `i32`, floats to `f64`, bigints to `100n` (`zena:bigint`). `/` always returns a float (`div(a, b)` from `zena:math` divides `i32`/`i64`/`u32`/`u64`). Narrow integers (`i8`, `u8`, `i16`, `u16`) promote to `i32`/`u32` on arithmetic and narrow explicitly via `as u8`.
- **Nullability and soundness**: No `any` and no `undefined`. Nullable references use `T?` (`T | null`). Primitives cannot be nullable directly (`Box<i32>?` boxes explicitly). Conditions require `boolean` (no truthy `if (x)` on numbers, strings, or nullable refs).
- **Equality and type tests**: `==` compares structural/value equality (`operator ==`). `===` checks reference identity on classes and is a compile error on records and tuples. Runtime type checks use `x is MyType` (narrowing `x`), and `x as MyType` traps at runtime if invalid.
- **Optional record fields**: `{timeout?: i32}` tracks field _presence_, distinct from `{timeout: i32 | null}`. Direct `opts.timeout` is a compile error; read with a default (`let {timeout = 5000} = opts`) or match presence/absence (`if (let {timeout} = opts)`, `case {!timeout}:`).
- **Destructuring syntax**: Field renaming uses `as` (`let {x as xPos} = pt`), so `:` writes type annotations inside destructured parameters (`({x: i32, y as yPos: i32}) => x + yPos`).
- **Libraries and functions**: Every `.zena` file is a library whose top level allows declarations only (no top-level expression statements). Optional parameters require default values (`limit: i32 = 10`); rest parameters (`...args`) are not supported. Omit empty constructors (`new() {}`) when all fields have initializers.

## Toolchain and CLI

Run `zena --help` or `zena <command> --help` to inspect all flags on the installed binary.

| Command                                       | Usage                                                                                                                                                             |
| :-------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zena run <file.zena> [-- args...]`           | Compile (cached) and execute on Wasmtime. Pass `--dir HOST[::GUEST]`, `--allow-spawn`, or `--allow-extensions` before `<file.zena>` to grant capabilities.        |
| `zena build <entry.zena> -o <out.wasm\|.wat>` | Compile to binary `.wasm` or text `.wat`. `--target`: `zena-component` (default), `component` (WASI 0.3 / `--wit`), `js`, `zena-js`, or `core`.                   |
| `zena -g build` / `zena -g run`               | Global `-g` (`--debug`) emits the Wasm name section for readable trap backtraces and enables `debug` contract clauses. `-O <0\|1\|2\|s>` sets optimization level. |
| `zena test [paths...]`                        | Run package tests or `*_test.zena` files in parallel (`debug` contracts active automatically). Filter by path substring with `zena test -f <substr>`.             |
| `zena fmt -w <paths...>`                      | Format `.zena` source files canonically (`--check` to verify without writing).                                                                                    |
| `zena lint [--fix] <paths...>`                | Report non-idiomatic patterns (`zena lint --list-rules`); `--fix` applies type-checked rewrites.                                                                  |
| `zena doc <dir> [-o api.json]`                | Extract a package's public declarations, types, and JSDoc comments as JSON.                                                                                       |
| `zena pkg <subcommand>`                       | Manage `zena-package.json` and `zena-lock.json` (`init`, `add`, `update`, `fetch`, `publish`).                                                                    |
| `zena bench` / `zena lsp`                     | Run statistical benchmark suites (`bench`) or start the stdio language server (`lsp`).                                                                            |

### Writing unit tests (`*_test.zena`)

```zena
import {suite, test} from 'zena:test';
import {equal, equalText, isTrue, throws} from 'zena:assert';

export let tests = suite('Parser', () => {
  test('parses header', (ctx) => {
    equalText(parseHeader('k: v'), 'v');
    throws(() => { parseHeader('invalid'); });
  });

  test('async workflow', async (ctx) => {
    equal(await computeAsync(), 42);
  });
});
```

Run `zena fmt -w` and `zena lint --fix` after edits, and verify behavior with `zena test -f <name>`. When setting up a new Zena repository, add a brief note in `AGENTS.md` (or `CLAUDE.md`) stating that `.zena` files are written in Zena and pointing to this skill so future sessions activate it before editing.

## Standard Library Map

Search the standard library before writing custom helpers:

- **Prelude (always in scope)**: `String`, `Option`/`Some`/`None` (`some(v)`, `none`), `Array`/`MutableArray`/`ImmutableArray`/`FixedArray`/`GrowableArray`, `Map`, `Box`, `Range` (`BoundedRange`, `FromRange`, `ToRange`, `FullRange`), `Error`, `ContractError`, `IndexOutOfBoundsError`, `console`.
- **Core & Numerics**: `zena:core` (`Result`, `fixed`, `growable`, `parseI32`, `parseI64`, `parseF64`, `StringBuilder`, `StringReader`, `ByteArray`, `ByteBuffer`, `DataView`, `Hashable`, `Disposable`, `Resource`, `Own`, `Borrow`, `Unmanaged`, `Scoped`, `disown`, `adopt`, `dedent`, `TemplateStringsArray`), `zena:collections` (`HashMap`, `OrderedHashMap`, `HashSet`, `OrderedHashSet`, `Set`, `zip`), `zena:math` (`div`, trig, exp/log, roots, float bits), `zena:bigint`, `zena:decimal`, `zena:simd`.
- **Text, Formats & Crypto**: `zena:string`, `zena:regex` (`` regex`...` ``), `zena:json` (`parseJson`, `stringify`, `JsonValue`), `zena:encoding` (UTF-8, hex, base64), `zena:url` (`URL`, `URLSearchParams`, `URLPattern`), `zena:crypto` (SHA-256, HMAC, ECDSA), `zena:random`.
- **Async, Streams, Reactivity & Testing**: `zena:async` (`Future`, `TaskGroup`, `CancelScope`, `currentScope`, `checkCancellation`), `zena:stream`, `zena:task`, `zena:signals`, `zena:test` (`suite`, `test`), `zena:assert` (`equal`, `equalText`, `isTrue`, `isNull`, `throws`), `zena:bench`.
- **System, Host & Web**: `zena:fs`, `zena:path`, `zena:glob`, `zena:cli`, `zena:args` (`ArgParser`), `zena:process`, `zena:time`, `zena:http` (router, server, middleware, HTML/cookies), `zena:fetch`, `zena:memory`, `zena:wasi`, `zena:wasm`, `zena:extensions`, `zena:js`, `zena:web-elements`, `zena:web-templates`.

## Further Reference

- **Detailed skill references** (read on demand when working with these features):
  - [classes-and-types.md](./references/classes-and-types.md) — constructors, initializer lists, mixins, extension classes, sealed/case classes, records, inline tuples, operator overloading, and symbols.
  - [ownership-and-async.md](./references/ownership-and-async.md) — `Disposable`, `using`, `resource class`, `Own`/`Borrow`/`Unmanaged`/`Scoped`, `<scoped T>`, `TaskGroup`, cancellation, and `shielded`.
  - [contracts.md](./references/contracts.md) — `requires`, `ensures` (`result`, `old()`), `invariant`, `debug` and `static` clauses, purity rules, and narrowing.
- **Local stdlib sources & API extraction**:
  - Standalone `zena` unpacks the exact stdlib `.zena` sources for its version into `~/.cache/zena/stdlib/<version>/` (or `$XDG_CACHE_HOME/zena/stdlib/<version>/`); inside a Zena compiler checkout, read `packages/stdlib/zena/`.
  - Run `zena doc <package-path>` to dump any local package's public signatures as JSON.
- **Online documentation**:
  - Language Reference & Quick Reference: `https://zena-lang.dev/reference/` and `https://zena-lang.dev/reference/quick-reference/`
  - Standard Library API Docs: `https://zena-lang.dev/api/` (per library at `https://zena-lang.dev/api/<name>/`, such as `https://zena-lang.dev/api/core/`, `https://zena-lang.dev/api/collections/`, `https://zena-lang.dev/api/async/`).
