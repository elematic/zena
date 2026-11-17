# Pitfalls

What TypeScript habits produce in Zena, with the message the compiler gives
and what to write. Every row was run against the compiler this skill shipped
with.

## Syntax that does not exist

| You wrote                        | The compiler says                                                              | Write                                                       |
| :------------------------------- | :----------------------------------------------------------------------------- | :---------------------------------------------------------- |
| `const x = 1;`                   | `Expected ';' after expression (got 'x')`                                      | `let x = 1;`                                                |
| `c ? a : b`                      | `Expected ';' after return statement (got '?')`                                | `if (c) a else b`                                           |
| `x++`                            | `Unexpected token in expression (got '+')`                                     | `x += 1`                                                    |
| `switch (x) { … }`               | `Expected ';' after expression (got '{')`                                      | `match (x) { case 1: … case _: … }`                         |
| `for (let x of xs)`              | `Expected '=' or 'in' after pattern in for statement (got 'of')`               | `for (let x in xs)`                                         |
| `a instanceof A`                 | `Expected ')' after if condition (got 'instanceof')`                           | `a is A`                                                    |
| `s!.length`                      | `Expected ';' after return statement (got '!')`                                | Narrow with `!= null`, or `s as String`                     |
| `1e3`                            | `Unexpected character in numeric literal '1e3'`                                | `1000.0`                                                    |
| `function f() {}` inside a body  | `'function' declarations may only appear at the top level of a module`         | `let f = () => …;`                                          |
| `m(): i32 => 1;` in a class      | `Expected identifier (got '=>')`                                               | `m(): i32 { return 1; }`                                    |
| `area: i32 { get => 1; }`        | `Expected '{' after get (got '=>')`                                            | `area: i32 { get { return 1; } }`                           |
| `function f(name?: String)`      | `Parameters cannot be optional. Use a default value`                           | `name: String? = null`                                      |
| `function f(...xs: Array<i32>)`  | `Expected identifier (got '...')`                                              | Take an `Array<i32>`                                        |
| `let {x: left} = p;`             | `Use 'as' to rename a destructured field: 'x as left'`                         | `let {x as left} = p;`                                      |
| `new(this.#x);`                  | `Expected identifier (got '#')`                                                | `new(x: i32) : #x = x;`                                     |
| `new(x: i32) { this.x = x; }`    | `Field 'x' must be initialized` and `Cannot assign to read-only property 'x'.` | `new(this.x);`, or `new(x: i32) : x = x;`, or a `var` field |
| `new(w: f64) { super(w); }`      | `Constructors in derived classes must call super().`                           | `new(w: f64) : super(w);`, with `super` last in the list    |
| `bio?: String;` in a class       | `Fields cannot be optional. For a field that may be null, use a nullable type` | `bio: String?;`                                             |
| `x[Disposable.dispose]()`        | `Type 'T' does not support indexing (no 'operator []' method).`                | `x.[Disposable.dispose]()`                                  |
| `if (let Some(value) = o)`       | `Expected '=' after pattern in let condition (got '(')`                        | `if (let Some {value} = o)`                                 |
| `grid[x, y]`                     | `Expected ']' after index (got ',')`                                           | An index takes one value. Use a method for two              |
| A statement at the top of a file | `A module body may only contain declarations`                                  | Move it into a function                                     |

## Types

| You wrote                                            | The compiler says                                                                                           | Write                                                         |
| :--------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------ |
| `string`, `number`, `any`                            | `Type 'string' not found.`                                                                                  | `String`, a numeric type, a real type (or `anyref`)           |
| `undefined`                                          | `Variable 'undefined' not found.`                                                                           | `null`                                                        |
| `if (text)`                                          | `Condition must be a boolean type, got 'String'.`                                                           | `if (!text.isEmpty)`, `if (x != null)`, `if (n != 0)`         |
| `let n: i32? = null;`                                | `'i32' is not nullable: primitives cannot be null.`                                                         | `Option<i32>`, `Box<i32>?`, or an inline tuple result         |
| `i32 \| null`, `i32 \| String`                       | `Union types cannot mix primitive types with reference types`                                               | The same                                                      |
| `let c: i32 = a / b;` with two `i32`s                | `'f32' is not assignable to 'i32'`                                                                          | `div(a, b)` from `zena:math`                                  |
| `a + b` with an `i32` and a `u32`                    | `cannot apply operator '+' to i32 and u32`                                                                  | Cast one side: `(a as u32) + b`                               |
| `let small: i32 = big;` from an `i64`                | `'i64' is not assignable to 'i32'`                                                                          | `big as i32`. Widening (`i32` to `i64` or `f64`) is implicit  |
| `n as i64 - 1`                                       | `Expected ';' … (got '-')`                                                                                  | `(n as i64) - 1`                                              |
| `'n=' + n`                                           | `Type mismatch in operator '+': expected 'String', got 'i32'.`                                              | `` `n=${n}` ``                                                |
| `throw 'bad';`                                       | `Thrown value must be an instance of Error, got 'String'.`                                                  | `throw new Error('bad');`                                     |
| `opts.timeout` where the field is `timeout?: i32`    | `Property 'timeout' is optional and may be absent. Destructure it with a default or match on its presence.` | `let {timeout = 5000} = opts;` or `if (let {timeout} = opts)` |
| `a === b` on records or tuples                       | `'===' compares identity; records and tuples are values — use '=='.`                                        | `a == b`                                                      |
| `debug requires (s != null)` then `s.length`         | `Object may be null when accessing 'length'.`                                                               | An unmarked `requires`: only it narrows                       |
| `tail return f(n - 1);` in a function with `ensures` | `'tail return' is not allowed in a function with 'ensures' clauses`                                         | Drop one of the two                                           |
| `for (let item in xs) invariant (item > 0)`          | `Variable 'item' not found.`                                                                                | State the invariant over variables declared before the loop   |
| `let f = (a, b) => a + b;`                           | `Parameter 'a' has no type annotation and cannot be inferred`                                               | Annotate, unless the arrow is passed where a type is expected |
| `if (a.s != null) a.s.length`, `s` a `var` field     | `Object may be null when accessing 'length'.`                                                               | `let s = a.s; if (s != null) { … }`                           |
| A `let` used in a class declared above it            | `Variable 'K' not found.`                                                                                   | Declare module-level `let`s above the classes that use them   |

## The standard library is not JavaScript's

| You wrote                        | The compiler says                                            | Write                                                                                                          |
| :------------------------------- | :----------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------- |
| `[1, 2].push(3)`                 | `Property 'push' does not exist on type 'ImmutableArray'.`   | `growable([1, 2])` or `new GrowableArray<i32>()`                                                               |
| `fixed(…)`, `growable(…)`        | `Variable 'growable' not found.`                             | `import {fixed, growable} from 'zena:core';`                                                                   |
| `map.set(k, v)`                  | `Property 'set' does not exist on type 'HashMap'.`           | `map[k] = v;`                                                                                                  |
| `map.get(k)` used as a value     | `'(true, i32) \| (false, _)' is not assignable to 'i32'`     | `map.getOr(k, fallback)`, `if (let (true, v) = map.get(k))`, or `map[k]`, which throws when the key is missing |
| `map.length`, `map.remove(k)`    | `Property 'length' does not exist on type 'HashMap'.`        | `map.size`, `map.delete(k)`, `map.has(k)`                                                                      |
| `for (let (k, v) in map)`        | `A tuple pattern cannot match a value of type 'MapEntry<…>'` | `for (let {key, value} in map)`                                                                                |
| `s[0]`                           | `'String' cannot be indexed by 'i32'`                        | `s[s.startIndex]`, `for (let g in s)`, `s.utf8[0]`                                                             |
| `s.length`                       | Compiles. It is the byte length and deprecated               | `s.isEmpty`, `s.utf8.length`, `s.graphemes.count()`                                                            |
| `s.replace(…)`, `s.repeat(n)`    | `Property 'replace' does not exist on type 'String'.`        | `zena:regex`, or build with `StringBuilder`                                                                    |
| `['a', 'b'].join(',')`           | `Property 'join' does not exist on type 'ImmutableArray'.`   | `import {join} from 'zena:string';`                                                                            |
| `none()`                         | `Type 'None' is not callable.`                               | `none`, and `some(x)`                                                                                          |
| `class C implements Iterable<T>` | `Method 'contains' is missing` and five more                 | `class C with IterableUtils<T> implements Iterable<T>`                                                         |

## Code that compiles and misbehaves

- `if (let t = maybeNull)` is not a null test. A `let` pattern with a plain
  name always matches. Write `if (maybeNull != null)`.
- `a == b` on two objects compares references unless their class declares
  `operator ==`. Case classes, records, tuples and strings compare by value.
  `===` always compares references.
- `/` on two `i32`s is an `f32`, which loses precision above 16 million.
  Cast to `f64` first when you want a real quotient.
- `Map` iteration order is not insertion order. Use `OrderedHashMap` from
  `zena:collections` when order matters.

## Failures at run time

A trap or an uncaught error prints a backtrace of function numbers. Run
again with `zena -g run …` to get function names.

| Output                                  | Usual cause                                                                                                                         |
| :-------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| `wasm trap: out of bounds array access` | An index past the end of an array                                                                                                   |
| `wasm trap: null reference`             | A `null` cast with `as T` and then used                                                                                             |
| `wasm trap: cast failure`               | `x as T` where `x` is not a `T`. Test with `is` first                                                                               |
| `thrown Wasm exception`                 | An `Error` nobody caught: a `throw`, `map[k]` for a missing key (`KeyNotFoundError`), or a failed contract clause (`ContractError`) |

`thrown Wasm exception` does not print the error's message. To see it,
catch the error in `main` and log `e.message`, or reproduce the failure in
a test: `zena test` prints the message of the error that failed a test.

## Compiler limits

These are bugs in the compiler. Each one fails with `Exception caught in CLI
compiler!` and a `zir unsupported: …` message instead of a diagnostic.

| You wrote                                               | Message                                                                         | Write                                             |
| :------------------------------------------------------ | :------------------------------------------------------------------------------ | :------------------------------------------------ |
| `for (let _ in 0..3)`                                   | `for-in pattern`                                                                | Name the variable                                 |
| `async function g(): Future<i32> { return f(); }`       | `return requires conversion`                                                    | `return await f();`                               |
| A static method passed as a value: `xs.map(V.make)`     | `static member not found`                                                       | `xs.map((x) => V.make(x))`                        |
| `var(#count) count = 0;` and then arithmetic on `count` | `return requires conversion`, or `cannot apply operator '+' to <error> and i32` | Annotate the field: `var(#count) count: i32 = 0;` |

When another `zir unsupported` appears, the code that triggered it is
named after `@` in the message. Reduce it to a few lines, find a spelling
that compiles, and tell the user: the reduction is a bug report.
