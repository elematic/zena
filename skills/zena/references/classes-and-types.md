# Classes, Data Types, and Protocols in Zena

## Classes, Fields, and Constructors

Classes and interfaces in Zena are **nominally typed** and have fixed field layouts on the WebAssembly GC heap.

### Field mutability and encapsulation

Fields are **immutable by default**. Mark a field `var` to allow reassignment, `#name` to make it class-private, or `var(#name) name` to expose a public getter with a private backing setter:

```zena
class Counter {
  id: String;             // public, immutable
  #secret: i32;           // private, immutable
  var label: String?;     // public, mutable, nullable (defaults to null)
  var(#count) count = 0;  // public read (`c.count`), private write (`this.#count`)

  new(this.id, this.#secret);

  increment(): void {
    this.#count += 1;
  }
}
```

- Nullable fields use `Type?` (`Type | null`) and default to `null` when omitted from construction. Writing `field?: Type` on a class is a compile error (`?` after a property name belongs to structural records).
- Omit empty constructors (`new();` or `new() {}`) when all fields have initializers; the compiler synthesizes one.

### Two-phase constructors and initializer lists

All fields of a class must be initialized before `this` exists, preventing partially constructed objects from escaping. Immutable fields cannot be assigned inside a `{ ... }` constructor body (`this.x = x` there requires `var x`); initialize them via `this.field` parameter shorthand, field initializers, or a Dart-style `: field = expr` initializer list before `{}` (or `;` when no body is needed). In subclasses, `super(...)` goes **last** in the initializer list:

```zena
class Rect {
  width: f64;
  height: f64;
  area: f64;

  new(w: f64, h: f64) : width = w, height = h, area = w * h;

  // Named constructor, called via `new Rect.square(5.0)`
  new square(side: f64) : width = side, height = side, area = side * side;
}

class LabeledRect extends Rect {
  label: String;

  new(label: String, w: f64, h: f64) : label = label, super(w, h);
}
```

Named constructors also accept `#private` or `[symbol]` names, and subclasses chain to them via `super.square(side)`.

### Generic classes and static members

Generics are monomorphized (`Box<i32>` and `Box<String>` are distinct runtime types). `static` members belong to the class rather than any instantiation, so class type parameters are out of scope inside `static` declarations; declare method-level type parameters instead (`static of<A>(v: A): Box<A>`).

## Case Classes and Sealed Hierarchies

### Case classes

Placing a parameter list directly after a class name declares a **case class**: implicitly `final`, with synthesized fields (immutable unless prefixed with `var`), constructor, structural `operator ==`, and `hashCode()` (`implements Hashable`):

```zena
class CacheKey(namespace: String, version: i32) {
  format(): String {
    return `${this.namespace}@${this.version}`;
  }
}

let seen = new HashSet<CacheKey>();
seen.add(new CacheKey('auth', 2));
```

### Sealed classes

`sealed class` declares an implicitly `abstract`, closed hierarchy whose direct variants must live in the same library, enabling exhaustiveness checking in `match`:

```zena
sealed class Node {
  abstract span: i32;
  case Ident(name: String, span: i32)
  case Empty(span: i32)
}

sealed class Color {
  case Red, Green, Blue // unit variants
}
```

Variants can also be declared outside the body (`final class Ident(name: String, span: i32) extends Node`) or nested as sub-hierarchies (`sealed class Expr extends Node`).

## Mixins and Interfaces

Standard inheritance is single-parent (`extends`), combined with `implements` for nominal interfaces and `with` for linearizable Dart-style mixins. Mixins can declare initialized fields, `#private` members, methods, accessors, and operators, and constrain their base type with `on` (mixins cannot declare `new` constructors):

```zena
interface Named {
  name: String;
}

mixin Labeled on Named {
  var tag = 'default';
  badge(): String {
    return `[${this.tag}] ${this.name}`;
  }
}

class Service extends BaseService with Labeled implements Named {
  name: String;
  new(this.name) : super();
}
```

## Zero-Cost Domain Types

Zena provides three compile-time-erased mechanisms that add static type distinctions or methods without heap wrapper objects:

1. **`distinct type`**: Creates a nominally separate type sharing the underlying runtime representation (`distinct type UserId = i32;`). Explicit `as` casts convert in either direction (`42 as UserId`, `id as i32`). Note that a `distinct type` over a primitive is still a primitive at runtime, so `UserId?` is invalid (use `Box<UserId>?` or an `inline (true, UserId) | (false, _)` return).
2. **`opaque type`**: Implies `distinct`, and restricts casts **into** the type (`x as SafeToken`, `xs as Array<SafeToken>`) to the declaring library, while allowing casts **out** (`tok as String`) everywhere:
   ```zena
   export opaque type NonEmpty = String;

   export function nonEmpty(s: String): inline (true, NonEmpty) | (false, _) {
     return if (s.length > 0) (true, s as NonEmpty) else (false, _);
   }
   ```
3. **`extension class`**: Defines a zero-cost typed view over any class, interface, primitive (`i32`, `f64`, `v128`), or Wasm GC array (`array<T>`, `array<var T>`), adding statically dispatched methods, accessors, operators, and constructors (`new(...) : super(underlying)`). Extension methods are called on the extension view (`new Meters(10.0)` or `(x as Meters)`), never on the bare underlying type without casting, and the view erases completely at compile time:
   ```zena
   final extension class Meters on f64 {
     new(v: f64) : super(v);
     operator +(other: Meters): Meters {
       return new Meters((this as f64) + (other as f64));
     }
   }
   ```
   Extension classes cannot declare instance fields, do not dispatch virtually, and two extension classes on the same base type cannot form a union (`Meters | Seconds` is rejected as runtime-indistinguishable).

## Records, Tuples, and `inline` Multi-Value Returns

### Structural records and presence

Records (`{x: 1, y: 2}`) and tuples (`(1, 'ok')`, 1-tuple `(42,)`) are shallowly immutable structural value types: `==` compares fields/elements recursively, `===` is a compile error, and width subtyping allows `{x: i32, y: i32, z: i32}` where `{x: i32, y: i32}` is expected. Spread (`{...base, x: 10}`) copies and overrides fields.

Optional record properties (`{timeout?: i32}`) represent **presence**, distinct from `{timeout: i32 | null}`:

```zena
type RequestOpts = {url: String, timeout?: i32};

function connect(opts: RequestOpts): i32 {
  // Direct `opts.timeout` is a compile error; supply a default or match presence:
  let {url, timeout = 5000} = opts;
  return if (let {timeout as custom} = opts) custom else timeout;
}
```

In `match` arms, `case {timeout}:` matches when present and `case {!timeout}:` matches when omitted.

### `inline` tuples and tagged unions

Returning `inline (...)` lowers directly to WebAssembly multi-value stack returns with zero heap allocation. Storing an inline return into a single variable or container boxes it automatically, whereas destructuring keeps it on the stack:

```zena
// Option-shaped multi-value return (hole `_` leaves unused Wasm slots defaulted)
function lookup(id: i32): inline (true, String) | (false, _) {
  return if (id == 1) (true, 'root') else (false, _);
}

// Consumed via pattern matching or unwrapped directly with `??`
let name = lookup(id) ?? 'guest';
if (let (true, found) = lookup(id)) {
  console.log(found);
}
```

In an `inline` union, every arm must have the same arity and start with a distinct literal tag of the same type (such as `true`/`false` or `0`/`1`). `Result<T, E>` in `zena:core` is `(true, T) | (false, E)`, so `: inline Result<T, E>` returns fallible results with zero allocation.

## Operator Overloading and Compile-Time Symbols

- **Operators**: Overload unary `-`, binary arithmetic/bitwise (`+`, `-`, `*`, `/`, `%`, `**`, `&`, `|`, `^`, `<<`, `>>`, `>>>`), indexing (`operator [](i: i32): T`, `operator []=(i: i32, v: T): void`), relational operators (or `compareTo(other: Self): i32`), and `operator ==`. Classes used as `Map` or `HashSet` keys must declare `implements Hashable` and define agreeing `operator ==` and `hashCode(): i32`.
- **Symbols**: `symbol` declarations are resolved statically at compile time with zero collision risk and zero dynamic lookup. Declare `export symbol mySym;` at top level or `static symbol iterator;` inside an interface, define members with `[Iterable.iterator]()`, and invoke them with dot-bracket syntax: `items.[Iterable.iterator]()`.
