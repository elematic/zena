---
title: 'Correctness and Safety'
description: 'Why Zena prioritizes automated safety checks—from WebAssembly isolation and garbage collection to sound types, immutability, Result and Option, contracts, and testing.'
---

Safety and correctness are key goals of Zena. Software safety has always
mattered, though many languages—especially scripting languages—trade safety for
convenience so people can get code running quickly. Strictly typed,
correctness-focused languages existed too, and for a long time they were
sometimes seen as pedantic or annoying when programmers had to write every type
annotation and boilerplate check by hand.

Modern language design narrowed that trade-off. Languages like Rust and
TypeScript showed that mainstream developers value strong static guarantees, and
ergonomic features—optional type annotations backed by heavy type inference,
compact closure and class syntax, algebraic data types, destructuring, and
pattern matching—make fully static types much easier to read and write.

AI-assisted coding points in the same direction. When code is generated or
refactored with AI, automated checks from the compiler, runtime, and test runner
help changes meet a real quality bar even with light review. What is good for
humans is good for AI, and vice versa—and strictness feels even less annoying
when an agent writes the extra checks or deals with the hoops of immutability.

Zena aims to take a familiar, light-feeling language and push its safety and
correctness checks much further—because developers and programming languages
have gravitated toward stronger guarantees, and because modern workflows need
them.

## Layers of safety

Zena stacks safety checks from the outside in. At the base, the runtime isolates
each module and keeps heap memory safe; in the middle, static types and data
structures restrict what states a program can reach; at the top, explicit error
types, contracts, units, and tests check domain behavior.

| Layer                               | Mechanism                                                                           | What it catches or prevents                                               |
| :---------------------------------- | :---------------------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| **External isolation**              | WebAssembly sandbox and explicit capabilities                                       | Corrupting the host or touching files, sockets, or memory not granted     |
| **Internal memory safety**          | Garbage collection (Wasm GC), plus `using` / `Own<T>` for external handles          | Use-after-free, double frees, buffer overruns, and leaked handles         |
| **Type safety**                     | Sound static types, non-nullability, initializer lists, `distinct` / `opaque` types | `null` dereferences, uninitialized fields, mixed-up IDs, silent coercions |
| **Units of measure** _(planned)_    | Compile-time dimensional annotations (`f64<m>`, `f64<s>`)                           | Adding or comparing numbers with incompatible physical units              |
| **State and data shapes**           | Immutability by default, array hierarchy, records vs. maps, exhaustive `match`      | Accidental mutation, dictionary/struct confusion, and unhandled cases     |
| **Explicit errors**                 | `Option<T>`, `Result<T, E>`, and typed `Error` subclasses                           | Ignored missing values and untyped thrown exceptions                      |
| **Contracts and automated testing** | `requires`, `ensures`, `invariant`, `debug` clauses, and `zena test`                | Violated preconditions, broken postconditions, bad loop bounds            |

## Isolation and memory safety

### External memory safety and code isolation

Every compiled Zena program runs inside a WebAssembly sandbox. A module's memory
is isolated from the host process and from other modules, and a module starts
with no ambient access to the filesystem, network, environment variables, or
subprocesses. It can use only the capabilities the host explicitly hands it—such
as passing `--dir` to `zena run` or wiring up a WIT interface. Running
untrusted, third-party, or freshly generated code cannot corrupt host memory or
reach outside its sandbox.

### Internal memory safety with garbage collection

Sandbox isolation protects the host from a module, while internal memory safety
protects a module's own state from use-after-free bugs, double frees, dangling
pointers, and out-of-bounds reads or writes.

Zena uses WebAssembly GC for heap memory. Garbage collection is a practical,
well-proven alternative to borrow checking for memory safety: classes, records,
arrays, strings, and closures live on the engine's managed heap with typed
references and bounds-checked arrays, without lifetime annotations on data
structures or `unsafe` pointer arithmetic. Because Wasm GC relies on the host
engine's collector, Zena binaries do not bundle a collector in the module
either.

When code manages an external resource that genuinely needs deterministic
cleanup—such as a file descriptor, socket, or linear-memory allocation—Zena
handles that with `using` declarations and stack-scoped affine handles
(`Own<T>` and `Borrow<T>`). Because borrows cannot be stored in heap fields, the
compiler checks ownership locally without lifetime parameters; see
[Resources and Ownership](/guide/resources/).

## Type safety

Zena has a static, sound type system: if an expression has type `Account` at
compile time, evaluating it at runtime produces an `Account`. Unlike TypeScript,
which keeps unsound escape hatches to type existing JavaScript idioms (see
[Zena for TypeScript Developers](/guide/comparisons/typescript/)), Zena leaves
out dynamic escape hatches so types hold at runtime:

- **No `any` or implicit coercion**: There is no `any` type that turns off type
  checking, no silent coercion between numbers, strings, and booleans, and `if`
  or `while` conditions require an explicit `boolean`. `anyref` is the top type
  for GC references only, and narrowing it back to a concrete type requires an
  `is` test or a runtime-checked `as` cast (`ref.cast`) that traps immediately
  on mismatch.
- **Non-nullable by default**: `String` never holds `null`. Nullable references
  are written `String | null` and must be narrowed with `!= null`, `?.`, `??`,
  or pattern matching before use.
- **Constructor initializer lists**: Every class field must be initialized in
  its declaration or in the constructor's `: ...` initializer list before `this`
  can be read inside the constructor body, ruling out partially initialized
  objects.
- **Distinct and opaque types**: Plain primitives cannot stop an `orderId` from
  being passed where a `userId` is expected. `distinct type` creates a separate
  nominal type with zero runtime overhead, and `opaque type` restricts casts
  into that type to its declaring file so invariants checked at construction
  cannot be bypassed elsewhere:

```zena
distinct type UserId = i32;
distinct type OrderId = i32;

export opaque type NonEmptyString = String;

export function nonEmpty(raw: String): NonEmptyString {
  if (raw.length == 0) {
    throw new Error('Expected a non-empty string');
  }
  return raw as NonEmptyString;
}
```

- **Units of measure** <span class="badge info">Planned</span>: Distinct types
  keep unrelated IDs apart, while scientific and layout code also needs units
  that compose across arithmetic. Zena plans compile-time units of measure
  (`f64<m>`, `f64<s>`) that propagate dimensions through multiplication and
  division (`m / s`) and reject unit mismatches—such as adding meters to
  seconds—at compile time, erasing completely before code generation.

## State, data shapes, and exhaustiveness

Beyond checking individual types, Zena limits unexpected mutation and separates
data structures that scripting languages often blur together:

- **Immutability by default**: Local bindings declared with `let`, class fields
  without `var`, records, and tuples are immutable. Making mutation opt-in
  narrows where state can change, so a reader checking a function can tell what
  stays fixed without tracing every helper it calls.
- **The array hierarchy**: Rather than using a single mutable, resizable array
  everywhere, Zena separates element mutability from resizability in types:
  `ImmutableArray<T>` is the default for `[1, 2, 3]` literals and compiles to an
  immutable Wasm `(array T)`, `FixedArray<T>` (`fixed([...])`) allows in-place
  element updates at a fixed length, and `GrowableArray<T>` (`growable([...])`)
  supports pushing and resizing. Read-only `Array<T>` and `MutableArray<T>`
  interfaces unify them, and mutable containers are invariant in `T` so subtype
  aliasing cannot write the wrong element type into an array.
- **Records versus maps**: Dynamic languages frequently overload plain objects as
  both fixed-field structs and arbitrary string-keyed dictionaries. Zena splits
  them cleanly: records (`{x: 10, y: 20}`) have fixed field names checked at
  compile time, while maps (`{'apples' => 5}`) store dynamic keys of a uniform
  type (`Map<K, V>` / `HashMap<K, V>`) where keys are evaluated expressions.
- **Exhaustiveness**: `match` expressions over `sealed class` hierarchies,
  enums, booleans, and unions must cover every case at compile time. Adding a
  variant turns every incomplete `match` across the codebase into a compile
  error—an exact checklist for a developer or coding agent.

```zena
import {fixed, growable} from 'zena:core';

let roles = ['admin', 'editor']; // ImmutableArray<String>
let buffer = fixed([0, 0, 0]); // FixedArray<i32>
let log = growable(['started']); // GrowableArray<String>

let point = {x: 10, y: 20}; // Record with static fields .x and .y
let counts = {'apples' => 5, 'oranges' => 12}; // HashMap<String, i32>

sealed class Payment {
  case Card(last4: String, cents: i32)
  case Cash(cents: i32)
}

function amountInCents(payment: Payment) {
  return match (payment) {
    case Card {cents}: cents
    case Cash {cents}: cents
  };
}
```

## Explicit absence and errors

Missing values and recoverable failures are represented in return types so
callers handle them explicitly:

- **`Option<T>` and nullable unions**: Alongside `T | null` for nullable
  references, the prelude includes `Option<T>` (`Some<T> | None`, constructed
  with `some(x)` and `none`), which works uniformly for primitives, references,
  and nested options.
- **`Result<T, E>`**: `zena:core` defines `Result<T, E>` as the value union
  `(true, T) | (false, E)`. Written `inline Result<T, E>` on a return type, it
  uses WebAssembly multi-value returns with zero heap allocation while keeping
  both the success value and the error type visible in the signature.
- **Typed `Error` exceptions**: For faults that should unwind the stack, `throw`
  accepts only instances of `Error` (or its subclasses)—strings and numbers
  cannot be thrown—and `try`/`catch` works as an expression so recovery paths
  still evaluate to a typed value.

```zena
import {Result} from 'zena:core';

function checkedDivide(a: f64, b: f64): inline Result<f64, String> {
  if (b == 0.0) {
    return (false, 'division by zero');
  }
  return (true, a / b);
}

function findPositive(items: Array<i32>): Option<i32> {
  for (let item in items) {
    if (item > 0) {
      return some(item);
    }
  }
  return none;
}
```

## Runtime contracts and testing

Static types check the shapes of values, while many bugs live in concrete
behavior and relationships between values: a counter exceeding its limit, a
binary-search index crossing `hi`, or a mutating method forgetting to update a
count. Zena checks those properties with [contracts](/guide/contracts/) and
built-in tests.

### Runtime and debug contracts

`requires`, `ensures` (with `result` and `old(...)`), and loop `invariant`
clauses attach preconditions, postconditions, and loop invariants directly to
function signatures and loop headers:

```zena
function isSorted(array: GrowableArray<i32>) {
  for (var i = 1; i < array.length; i += 1) {
    if (array[i - 1] > array[i]) {
      return false;
    }
  }
  return true;
}

function insertSorted(array: GrowableArray<i32>, item: i32)
  debug requires (isSorted(array))
  ensures (array.length == old(array.length) + 1)
  ensures (array[result] == item)
  debug ensures (isSorted(array))
{
  array.push(item);
  var i = array.length - 1;
  while (i > 0 && array[i - 1] > item)
    invariant (0 <= i && i < array.length)
  {
    array[i] = array[i - 1];
    i -= 1;
  }
  array[i] = item;
  return i;
}
```

Unmarked clauses run in every build and throw `ContractError` with the failed
condition text when violated; unmarked `requires` clauses also narrow parameter
types in the function body. Prefixing a clause with `debug` (`debug requires`,
`debug ensures`, `debug invariant`) enables it in `zena test` and `--debug`
(`-g`) builds while emitting nothing in ordinary builds (without narrowing
types), so thorough `O(n)` checks can run throughout testing at zero production
cost.

Contracts currently run on functions, closures, methods, constructors, and
loops, while support for generators, bodyless interface/abstract methods, and
`ensures` on `async` functions and `inline` returns is still in progress. Longer
term, Zena plans to pass contracts and loop invariants on `@verify` functions to
an SMT solver alongside specification-only `ghost` clauses to prove contracts at
compile time.

### Built-in testing

`zena:test` (`suite`, `test`) and `zena:assert` (`equal`, `isTrue`, `throws`)
ship in the standard library, and `zena test` compiles and runs `*_test.zena`
suites in parallel with `debug` contract clauses enabled automatically. Fast
compilation and sandboxed WebAssembly execution make running tests cheap enough
to happen after every change—whether written by a person or by an agent.

## Next

- [Contracts](/guide/contracts/) — preconditions, postconditions, `old()`, loop invariants, and `debug` clauses
- [Working with AI Agents](/guide/ai-agents/) — how automated checks and fast tooling support agent workflows
- [The Type System](/guide/type-system/) — subtyping, narrowing, and variance
- [Resources and Ownership](/guide/resources/) — `using`, `Own<T>`, and `Borrow<T>` for external handles
- [Zena for TypeScript Developers](/guide/comparisons/typescript/) — side-by-side comparison with TypeScript
