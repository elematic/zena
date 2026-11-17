---
name: zena
description: Write, read, review and debug Zena, a statically typed language that compiles to WebAssembly GC. Use whenever a task touches `.zena` files, a `zena-package.json`, or the `zena` command (build, run, test, fmt, lint, doc, pkg), including when asked to port TypeScript to Zena.
---

# Zena

Zena reads like TypeScript, and most TypeScript habits produce Zena that
compiles. They also produce Zena that ignores most of the language. Read
"The language in brief" for the model, then "Features to reach for" before
writing code.

Zena changes quickly. This skill describes the toolchain it shipped with;
when it disagrees with the compiler, the compiler is right.

## The language in brief

Start from TypeScript's syntax: `let`, arrow functions, classes, generics,
`import`/`export`, template literals, `?.` and `??`, flow narrowing.

Remove everything dynamic. There is no `any`, `undefined`, truthiness,
implicit coercion, prototype, `this` rebinding or structural class typing.
The type system is sound, and types exist at run time: `is` and `as` are
checked, and `Box<i32>` is a different type from `Box<f64>`.

Split values into three kinds:

- **Primitives** are WebAssembly value types (`i32`, `i64`, `u32`, `u64`,
  `f32`, `f64`, `boolean`, and the narrow `i8`/`u8`/`i16`/`u16`). They are
  never boxed implicitly and never `null`.
- **Records and tuples** (`{x: 1, y: 2}`, `(1, 'a')`) are structural,
  immutable and compared by value.
- **Classes and interfaces** are nominal.

Then add, each from a language that does it well:

- **Swift's mutability defaults.** `let` is immutable and `var` is mutable,
  for variables and for class fields. `var(#count) count: i32 = 0` is a
  field with a public getter and a private setter.
- **Dart's classes.** Every field is initialized before a constructor's
  body runs: by a `this.` parameter, `new(this.x, this.y);`, or in an
  initializer list, `new(w: f64) : width = w, super(w);`, where `super`
  goes last. Named constructors: `new Point.origin()`. Mixins:
  `class Button with Clickable`. Extension classes:
  `extension class Path on String`, a typed view of a value, erased at run
  time.
- **Scala's data types.** A case class, `class Point(x: f64, y: f64)`, gets
  its fields, constructor, `==` and `hashCode`. A `sealed class` with
  `case Circle(radius: f64)` variants is a sum type.
- **Scala's `match`, Rust's `if let`.**
  `match (shape) { case Circle {radius} if radius > 0.0: … }` destructures,
  takes guards and must cover every case. `if (let P = x)` and
  `while (let P = x)` test and bind. `if`, `match` and `try` are
  expressions, so there is no ternary and no `switch`.
- **Go's multiple returns, on the stack.** `inline (i32, i32)` returns two
  values with no allocation. `inline (true, T) | (false, _)` is a value or
  nothing, and `??` unwraps it: `map.get(key) ?? fallback`.
- **Swift's strings.** A `String` is Unicode text with no integer index.
  `for (let g in s)` iterates graphemes; `s.codePoints`, `s.utf8` and
  `s.utf16` are views; a slice takes a `StringIndex` range.
- **Dafny's contracts, checked at run time.** `requires (n > 0)`,
  `ensures (result >= 0)`, `old(e)` and a loop's `invariant (…)` are part of
  a signature. A `debug` clause runs only in tests. A `static` clause is
  for proof, which is in progress.
- **Nim's distinct types.** `distinct type Meters = f64` is a nominal type
  at no cost. An `opaque type` can be cast into only by its own library.
- **Rust's ownership, without lifetimes.** `using file = open(path);`
  releases a `Disposable` when the block ends, as in C#. A handle that
  outlives a block is a `resource class`, held as `Own<T>`, which moves,
  or `Borrow<T>`, which cannot leave the stack.
- **Trio's cancellation.** `async` and `await` over `Future<T>`. A
  `TaskGroup` cancels what it started, cancellation unwinds past `catch`,
  and `try … cancel { … }` and `shielded { … }` are for cleanup.
- **JavaScript's symbols and iterators, resolved at compile time.** A
  member named by a symbol: `static symbol dispose;`, declared as
  `[Disposable.dispose]()` and called as `x.[Disposable.dispose]()`.
  `for (let x in xs)` drives an `Iterator` whose `next()` allocates
  nothing, and a `gen` function is one.
- **Also:** Hack's pipeline, `x |> f($) |> g($, 1)`; operator and method
  overloading, resolved statically; generics compiled once per type
  argument, as in Rust.

## A tour

Every block in this skill is a complete library that compiles.

```zena
import {HashMap} from 'zena:collections';
import {div} from 'zena:math';

// A zero-cost nominal type over a primitive. Cents and i64 do not mix.
distinct type Cents = i64;

// A record type: structural, immutable, compared by value.
type Line = {sku: String, quantity: i32, unit: Cents};

// A case class: fields, constructor, `==` and `hashCode` are generated.
// Fields are immutable unless marked `var`.
class Customer(name: String, var orders: i32)

// A sealed class is a sum type. Its cases are case classes.
sealed class Payment {
  case Card(last4: String)
  case Transfer(iban: String)
  case Voucher(code: String, value: Cents)
}

// `function` declares a top-level function. It is hoisted and never a
// closure. Closures are arrows.
function describe(payment: Payment): String {
  // `match` is an expression and must cover every case.
  return match (payment) {
    case Card {last4}: `card ending ${last4}`
    case Transfer {iban}: `transfer from ${iban}`
    case Voucher {code, value} if (value as i64) == 0: `spent voucher ${code}`
    case Voucher {code}: `voucher ${code}`
  };
}

// Contracts state what the types cannot. They run in every build and throw
// ContractError; `debug requires` runs only in tests and `-g` builds.
function total(lines: Array<Line>): Cents ensures ((result as i64) >= 0) {
  var sum: i64 = 0;
  for (let {quantity, unit} in lines) {
    sum += (quantity as i64) * (unit as i64);
  }
  return sum as Cents;
}

// Two results on the stack, with no allocation. `/` always gives a float;
// integer division is `div`.
function split(amount: Cents, ways: i32): inline (Cents, Cents)
  requires (ways > 0)
{
  let each = div(amount as i64, ways as i64);
  return (each as Cents, ((amount as i64) - each * (ways as i64)) as Cents);
}

// A class with Dart-style constructors and a private field.
class Ledger {
  #entries = new HashMap<String, Cents>();
  var(#count) count: i32 = 0;   // public getter, private setter

  record(customer: Customer, amount: Cents): void {
    this.#entries[customer.name] = amount;
    this.#count += 1;
    customer.orders += 1;
  }

  // `get` answers (true, value) or (false, _), so a missing key needs no
  // null and no boxing. `??` unwraps the value or takes the default.
  owed(name: String): Cents {
    return this.#entries.get(name) ?? (0 as Cents);
  }
}

export function main(): i32 {
  let lines = [
    {sku: 'tea', quantity: 2, unit: 450 as Cents},
    {sku: 'pot', quantity: 1, unit: 2_100 as Cents},
  ];
  let (each, rest) = split(total(lines), 2);

  let ledger = new Ledger();
  let ada = new Customer('Ada', 0);
  ledger.record(ada, each);

  console.log(describe(new Card('4242')));
  console.log(`Ada owes ${ledger.owed('Ada') as i64}, remainder ${rest as i64}`);
  return ledger.count;
}
```

## Features to reach for

Agents write TypeScript-shaped Zena by default. Each row is a place where
the TypeScript habit compiles, or nearly compiles, and Zena has something
better. Check your diff against this table before you finish.
[references/idioms.md](references/idioms.md) has a compiled example of each.

| When you are about to write                                                                  | Write                                                                                                                  |
| :------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| A `kind: 'a' \| 'b'` field and an `if` chain over it                                         | A `sealed class` with `case` variants and an exhaustive `match`                                                        |
| `export let add = (a: i32, b: i32) => a + b;` at the top level                               | `function add(a: i32, b: i32): i32 { … }`: hoisted, and never a closure. Arrows are for callbacks and captures         |
| A class that only holds data, with a hand-written constructor                                | A case class: `class Point(x: f64, y: f64)`                                                                            |
| An `interface` describing a bag of fields                                                    | A record type: `type Options = {port: i32, host: String}`                                                              |
| An options object read as `opts.timeout ?? 5000`                                             | An optional field, `{timeout?: i32}`, read with a default: `let {timeout = 5000} = opts;`                              |
| `T \| null` for a primitive, a sentinel like `-1`, or a thrown error for an expected failure | `inline (true, T) \| (false, _)`, `inline Result<T, E>`, or `Option<T>` to store it                                    |
| An object or array returned to carry two results                                             | `inline (A, B)`, destructured at the call: `let (a, b) = f();`                                                         |
| `if (x.kind == …) … else if …`, nested `if`s that pick a value                               | `match`, with patterns and guards; `if`/`match` as the expression itself                                               |
| A null check then a cast, or `has` then a second lookup                                      | `map.get(k) ?? d` (`??` unwraps `(true, v)`), `if (let (true, v) = map.get(k))`, `if (let Some {value} = opt)`, `x?.y` |
| `if (!ok) throw …` at the top of a function, or a comment "n must be positive"               | `requires (n > 0)`; `ensures (…)` for what the result promises; `invariant (…)` on a loop                              |
| `type UserId = String`, or a bare `i32` standing for a unit                                  | `distinct type UserId = String`; `opaque type` when a value must come from a validating function                       |
| `try { … } finally { x.close(); }`                                                           | `using x = open();`                                                                                                    |
| A wrapper class around one value, to give it a type and methods                              | `extension class Path on String`: the wrapper is erased, and `as` converts for free                                    |
| A base class that exists to share a few methods                                              | A `mixin`, applied with `with`                                                                                         |
| `a.plus(b)`, `a.equals(b)`, `a.compareTo(b) < 0`, `table.get(i)`                             | `operator +`, `operator ==`, `compareTo` (gives `<`), `operator []` and `operator []=`                                 |
| `h(g(f(x)))`                                                                                 | `x \|> f($) \|> g($) \|> h($)`                                                                                         |
| `for (var i = 0; i < xs.length; i += 1) { xs[i] … }`                                         | `for (let x in xs)`; `for (let i in 0..n)`; `for (let {key, value} in map)`                                            |
| An `AbortSignal`-style flag passed down to stop async work                                   | A `TaskGroup` and its `cancel()`; `try … cancel { … }` for cleanup                                                     |
| `s[i]`, `s.length` or a loop over UTF-16 units                                               | `for (let g in s)`, `s.codePoints`, `s.utf8.length`, `StringIndex` ranges, `StringReader`                              |
| A mutable field or `var`, by habit                                                           | `let` and plain fields; `var` only where the value changes                                                             |
| `xs: Array<T>` or `m: Map<K, V>` on a field or parameter                                     | The class: `GrowableArray<T>`, `HashMap<K, V>`. An interface type costs a wrapper per use                              |
| A `number`                                                                                   | The type the value has: `i32` for counts and indexes, `i64`, `f64`, `u8` for bytes                                     |

## TypeScript that is not Zena

- **Names.** `const`, `string`, `number`, `Promise`, `undefined`,
  `instanceof`, `for … of`, `switch`, `?:`, `++` and `x!` do not exist.
  Write `let`, `String`, a numeric type, `Future`, `null`, `is`,
  `for … in`, `match`, `if (c) a else b`, `+= 1`, and `x as T` after a null
  check.
- **Conditions and operators.** A condition is a `boolean`: `if (text)` and
  `if (count)` are errors. `/` on integers gives a float; integer division
  is `div(a, b)` from `zena:math`. `+` does not convert to a string; write
  `` `n=${n}` ``. `==` compares records, tuples, strings and case classes
  by value. `===` compares references, and is an error on records and
  tuples.
- **Numbers.** An integer literal is an `i32` and a float literal an `f64`
  unless the context says otherwise. An `i32` widens to `i64` or `f64` by
  itself. Narrowing, and mixing signed with unsigned, needs `as`, and a
  cast before a binary operator needs parentheses: `(n as i64) - 1`.
- **Null and unions.** A primitive is never `null`, and cannot share a union
  with a reference: `i32 | null` is an error. Use `Option<i32>`,
  `Box<i32>?` or an inline tuple.
- **Functions.** `function` is only for top-level declarations; inside a
  function, or as a callback, write an arrow. A method body is a block,
  never `=>`. An optional parameter has a default
  (`name: String? = null`), never `?`. There are no rest parameters.
- **Libraries.** A library body holds declarations only: code runs from
  `main`, or from a function something calls. Nothing is global except the
  prelude (`console`, `String`, `Error`, `Option`, `Future`, the array
  types, `Map`, `Box`, ranges). Everything else is imported.
- **Classes.** A field without `var` cannot be assigned anywhere, the
  constructor's body included: `new(x: i32) { this.x = x; }` is an error.
  Write `new(this.x);` or `new(x: i32) : x = x;`, with `super(…)` last in
  that list and never in the body. A field is always `this.x`, also in a
  case class. A getter is `area: f64 { get { return …; } }`. A `var` field
  does not narrow after a null check; copy it to a `let`. A symbol-keyed
  member is called with a dot, `x.[Disposable.dispose]()`: `x[sym]()` is an
  index.
- **Records.** Destructuring renames with `as`: `let {x as left} = point;`.
  A field marked `?` may be absent, which is different from `null`:
  `opts.timeout` is an error, so write `let {timeout = 5000} = opts;` or
  `if (let {timeout} = opts)`. A class field cannot be marked `?`.
- **Collections.** An array literal is an `ImmutableArray`. For a mutable
  one write `new GrowableArray<T>()`, or `growable([1, 2])` or
  `fixed([1, 2])`, both imported from `zena:core`. A `Map` is written with
  `map[k] = v` and read with `map.get(k)`, which returns `(true, v)` or
  `(false, _)`, or with `map[k]`, which throws when the key is missing. Its
  size is `map.size`, and iterating it gives `{key, value}` entries.
- **Strings.** A `String` has no integer index and no useful `length`. See
  "Strings" in [references/idioms.md](references/idioms.md).
- **Errors.** Only an `Error` can be thrown, and `catch (e)` binds one. An
  uncaught error prints `thrown Wasm exception` without its message: catch
  it in `main` and log `e.message`, or reproduce it in a test.

[references/pitfalls.md](references/pitfalls.md) has the longer list, with
the compiler's message for each mistake.

## The work loop

```sh
zena run main.zena [args]        # compile and run; --dir . before the file grants files
zena test                        # the package's tests; or: zena test path/ -f substring
zena build main.zena -o out.wasm # also the type check; -t component | js | zena-js | core
zena lint --fix <paths>          # idiom fixes, each one type-checked
zena -g run main.zena            # readable stack traces, debug contracts on
```

Run `zena lint` on what you wrote: its rules cover several rows of
"Features to reach for". Annotate the return type of a `function` or a
method, and leave the types off a callback that is passed where a function
type is expected.

A test file is named `*_test.zena` and exports `tests`:

```zena
import {suite, test} from 'zena:test';
import {equal} from 'zena:assert';

export let tests = suite('arithmetic', () => {
  test('adds', () => {
    equal(1 + 1, 2);
  });

  test('awaits', async () => {
    equal(await Future.of(3), 3);
  });
});
```

[references/tools.md](references/tools.md) covers packages
(`zena-package.json`, `zena pkg`), build targets, and debugging a trap.

## Finding more

- `zena --help` and `zena <command> --help` list every command and flag.
- `zena doc <package directory> -o api.json` writes a package's public API,
  with doc comments, as JSON. Use it on a dependency before guessing a
  signature.
- The standard library is imported as `zena:<library>`. Search it before
  writing a helper. Its libraries, by area:
  - Language: `core`, `collections`, `string`, `math`, `bigint`, `decimal`,
    `simd`, `memory`
  - Async: `async`, `task`, `stream`, `time`, `signals`
  - Data and text: `json`, `regex`, `encoding`, `crypto`, `random`, `url`,
    `path`, `glob`
  - Programs and hosts: `cli`, `args`, `fs`, `fetch`, `http`, `process`,
    `wasm`, `extensions`, `js`, `web-templates`, `web-elements`
  - Testing: `test`, `assert`, `bench`

  [references/stdlib.md](references/stdlib.md) says what each one holds and
  which targets have it. The API reference is at
  `https://zena-lang.dev/api/<library>/` (for example
  `https://zena-lang.dev/api/collections/`).

- The standard library's sources, for the installed version, are in
  `~/.cache/zena/stdlib/<version>/` (under `$XDG_CACHE_HOME/zena` when that
  is set) once `zena` has run. Each library opens with a doc comment and
  examples. In a checkout of Zena they are in `packages/stdlib/zena/`.
- One page with every language feature:
  `https://zena-lang.dev/reference/quick-reference/`. Per-topic pages are
  under `https://zena-lang.dev/reference/` (`pattern-matching`, `contracts`,
  `ownership`, `cancellation`, `strings`, `records`, `tuples`, `classes/`).
- The specification is `docs/language-reference.md` in
  `https://github.com/elematic/zena`.
- When the documentation and the compiler disagree, write a five-line
  program and run it.
