# Case Classes Design

This document describes **case classes** — concise, immutable-by-default class
declarations with auto-generated equality, hashing, and destructuring. It also
covers **sealed class hierarchies** for exhaustive pattern matching, and the
broader change to make class fields immutable by default.

## Motivation

Zena currently has three overlapping ways to model structured data:

- **Classes** — full-featured, mutable by default, verbose constructors
- **Records** — structural, immutable, lightweight syntax `{x: 1, y: 2}`
- **Enums** — primitive-backed constants with no associated data

For self-hosting the compiler, we need to define 50-100 AST node types. Each is
a small bag of named, immutable fields. Today this requires verbose
boilerplate for each variant:

```zena
abstract class Expr {}

class BinaryExpr extends Expr {
  let left: Expr
  let op: Token
  let right: Expr
  new(left: Expr, op: Token, right: Expr) : left = left, op = op, right = right {}
}
// ... repeat 50 times
```

Records avoid the boilerplate but lack nominal typing, inheritance, and
exhaustiveness checking. Enums have exhaustiveness but carry no data. A
full sum type feature would solve this but introduces a separate concept
parallel to classes.

**Case classes** bridge the gap: concise class declarations that are
data-oriented by default, with a smooth path to adding methods, private state,
and other class features when needed.

## Design

### 1. Concise Class Declarations (Case Classes)

A class with a parameter list after its name is a **case class**:

```zena
class Point(x: f64, y: f64)
```

This desugars to:

```zena
class Point {
  x: f64     // immutable (default)
  y: f64     // immutable (default)
  new(x: f64, y: f64) : x = x, y = y {}
  // auto-generated operator == (structural)
  // auto-generated hash
}
```

A case class can also have a body for additional members:

```zena
class Point(x: f64, y: f64) {
  distance(): f64 => sqrt(x * x + y * y)
}
```

#### What the compiler generates

For `class Foo(a: T1, b: T2)`:

1. **Constructor** — `new(a: T1, b: T2)` that assigns all parameters to fields.
2. **Immutable public fields** — each parameter becomes a `let` field.
3. **Structural `operator ==`** — compares all fields for equality.
4. **Structural `hash`** — combines hashes of all fields.
5. **Destructuring support** — already works for all classes.

#### Mutable fields in case classes

Use `var` to opt into mutability for specific fields:

```zena
class Counter(name: string, var count: i32)
// name is immutable, count is mutable
```

#### Generics

```zena
class Pair<A, B>(first: A, second: B)
class Box<T>(value: T)
```

### 2. Immutable Fields by Default

Independent of case classes, all class fields become **immutable by default**.
This affects both traditional and case class syntax:

```zena
// Traditional syntax — fields are now immutable unless marked `var`
class User {
  id: i32               // immutable (new default)
  var email: string     // mutable (explicit)
  var(#phone) phone: string  // mutable, private setter
}
```

This aligns with Zena's preference for `let` over `var` in variable bindings.

See [classes.md — Migration to Immutable-by-Default](classes.md#migration-to-immutable-by-default)
for the transition plan.

### 3. Sealed Class Hierarchies

A class declaration with `=` followed by variant declarations defines a
**sealed class hierarchy**:

```zena
class Expr =
  Binary(left: Expr, op: Token, right: Expr)
  | Unary(op: Token, operand: Expr)
  | Literal(value: i32)
  | Ident(name: string)
```

This desugars to:

```zena
abstract class Expr

class Binary(left: Expr, op: Token, right: Expr) in Expr
class Unary(op: Token, operand: Expr) in Expr
class Literal(value: i32) in Expr
class Ident(name: string) in Expr
```

Each variant is a case class that extends `Expr` and is implicitly `final`.

#### Exhaustive matching

The compiler knows the complete set of variants, enabling exhaustive `match`:

```zena
const eval = (e: Expr): i32 => match (e) {
  case Binary(l, op, r): applyOp(op, eval(l), eval(r))
  case Unary(op, x): applyUnary(op, eval(x))
  case Literal(v): v
  case Ident(name): lookup(name)
}
// No wildcard needed — all cases covered
```

#### Unit variants

Variants with no fields (unit variants) are supported:

```zena
class Token =
  Plus | Minus | Star | Slash
  | Number(value: i32)
  | Ident(name: string)
  | Eof
```

Unit variants are singletons — the compiler allocates one instance and all
references share it.

### 4. The `in` Keyword — Distributed Sealed Membership

A case class can declare membership in a sealed hierarchy from a separate
declaration — even a separate file — using `in`:

```zena
class Binary(left: Expr, op: Token, right: Expr) in Expr
```

This is equivalent to an inline variant in the `class Expr = ...` declaration.
It means:

- `Binary` extends `Expr`
- `Binary` is `final`
- `Binary` is a case class (immutable fields, auto ==, auto hash)
- `Binary` is part of `Expr`'s exhaustive variant set

#### Combining inline and distributed variants

A hierarchy can use both forms. The `class Expr = ...` declaration defines the
initial variant set, and `in Expr` declarations add to it:

```zena
// expr.zena
class Expr =
  Literal(value: i32)
  | Ident(name: string)

// expr-compound.zena
class Binary(left: Expr, op: Token, right: Expr) in Expr {
  precedence: i32 { get { ... } }
}
class Unary(op: Token, operand: Expr) in Expr
```

The `class Expr = ...` declaration can also stand alone with no inline
variants, serving purely as the sealed base:

```zena
// expr.zena
abstract class Expr

// binary.zena
class Binary(left: Expr, op: Token, right: Expr) in Expr
```

Note: when using `in` without a `class X = ...` declaration, the base class
must be declared as `abstract class`.

#### Restrictions

- A class can be `in` at most **one** sealed hierarchy. This ensures
  exhaustiveness is well-defined — a variant belongs to exactly one closed set.
- A class with `in` is implicitly `final` and cannot be further subclassed.
- All `in X` classes must be within the same **module** (package) as `X`.
  This gives the compiler a clear boundary for collecting variants. Separate
  files within the module are fine — the `in` keyword exists precisely for
  multi-file organization.

#### Module cycles

If `Expr` is defined in `expr.zena` and `Binary in Expr` is in
`binary.zena`, which imports `Expr`, then `expr.zena` must also be able to
find `Binary` to build the exhaustive set. This creates a cycle in the module
graph.

This is acceptable because:

- A sealed hierarchy is one inseparable unit — separate files are only for
  code organization.
- The compiler already processes modules within a package together.
- The cycle is shallow (only between files declaring variants of the same
  sealed class) and can be resolved by collecting all `in X` declarations
  during a pre-pass before full type checking.

### 5. Adding Methods and State to Variants

Case classes start as pure data but can grow incrementally:

```zena
// Stage 1: pure data
class Binary(left: Expr, op: Token, right: Expr) in Expr

// Stage 2: add computed properties
class Binary(left: Expr, op: Token, right: Expr) in Expr {
  precedence: i32 { get { ... } }
}

// Stage 3: add private state and methods
class Binary(left: Expr, op: Token, right: Expr) in Expr {
  #cachedType: Type | null = null

  resolve(ctx: Context): Type => {
    if (let t = #cachedType) { return t }
    const t = ctx.resolve(this)
    #cachedType = t
    t
  }
}
```

Methods can also be defined on the sealed base class and overridden:

```zena
class Expr = Binary(...) | Literal(...) | ...
{
  // shared method on all variants
  span(): Span => ...
}
```

Or equivalently with traditional syntax:

```zena
abstract class Expr {
  abstract span(): Span
}
```

### 6. Relationship to Existing Features

#### Enums

Enums remain a **separate feature** for primitive-backed named constants:

```zena
enum Color { Red, Green, Blue }          // i32-backed
enum Status { Ok = 200, NotFound = 404 } // explicit values
enum Direction { Up = "UP", Down = "DOWN" } // string-backed
```

Enums are for cheap serialization, FFI, and bitflags. Case classes are for
structured data. They complement each other:

```zena
enum TokenKind { Plus, Minus, Star, Number, Ident, Eof }

class Token =
  Operator(kind: TokenKind, pos: i32)
  | NumLit(value: i32, pos: i32)
  | IdentTok(name: string, pos: i32)
```

#### Records

Records (`{x: 1, y: 2}`) remain useful for:

- Anonymous data (no need to declare a named type)
- Structural typing (duck typing for config objects, options bags)
- Width subtyping (accepting records with extra fields)

Case classes are **nominal** — `Point(1, 2)` and `Vec2(1, 2)` are different
types even with the same fields. Records are **structural** — `{x: 1, y: 2}`
is compatible with any matching shape.

Rule of thumb: use case classes for domain types, records for ad-hoc data.

#### Regular classes

Regular class syntax remains for stateful objects, services, and any class that
doesn't fit the case class pattern:

```zena
class Server {
  var connections: Array<Connection>
  #config: Config

  new(config: Config) : connections = [], #config = config {}

  listen(port: i32): void => { ... }
}
```

A regular class differs from a case class:

| | Case class | Regular class |
|---|---|---|
| Declaration | `class Foo(x: T)` | `class Foo { ... }` |
| Auto-constructor | Yes | No (manual `new(...)`) |
| Auto `==` and `hash` | Yes (structural) | No (reference identity) |
| Default mutability | Immutable | Immutable (same as case class) |
| Can be `in` hierarchy | Yes | No — use `extends` |

## WASM Representation

### Case class structs

Each case class maps to a WASM GC struct, same as regular classes:

```zena
class Point(x: f64, y: f64)
```

```wat
(type $Point (struct
  (field f64)  ; x - immutable
  (field f64)  ; y - immutable
))
```

### Sealed hierarchy structs

Each variant has its own struct type. The base class struct is the common
prefix (typically just the vtable pointer):

```wat
(type $Expr (struct
  (field (ref $Expr_vtable))
))

(type $Binary (sub $Expr (struct
  (field (ref $Expr_vtable))
  (field (ref null $Expr))  ; left
  (field (ref null $Token)) ; op
  (field (ref null $Expr))  ; right
)))

(type $Literal (sub $Expr (struct
  (field (ref $Expr_vtable))
  (field i32)  ; value
)))
```

Pattern matching uses `ref.test` and `ref.cast` for variant discrimination,
same as existing class patterns.

### Unit variant singletons

Unit variants (no fields) are allocated once as globals:

```wat
(global $Plus (ref $Plus) (struct.new $Plus ...))
(global $Minus (ref $Minus) (struct.new $Minus ...))
```

### Equality and hashing

The auto-generated `operator ==` compiles to field-by-field comparison:

```wat
(func $Point_eq (param $a (ref $Point)) (param $b (ref $Point)) (result i32)
  (i32.and
    (f64.eq (struct.get $Point 0 (local.get $a))
            (struct.get $Point 0 (local.get $b)))
    (f64.eq (struct.get $Point 1 (local.get $a))
            (struct.get $Point 1 (local.get $b)))))
```

For reference-typed fields, the auto-generated `==` delegates to the field
type's `operator ==` (or uses reference identity if none is defined).

## Implementation Plan

### Phase 1: Immutable Fields by Default

1. Change the default field mutability from mutable to immutable.
2. Require `var` for mutable fields.
3. Follow the migration plan in [classes.md](classes.md#migration-to-immutable-by-default).

### Phase 2: Concise Class Declarations

1. **Parser**: Support `class Name(param, param, ...)` syntax — parameter list
   after the class name, before any `extends`/`in`/body.
2. **Checker**: Auto-generate constructor, fields, `operator ==`, and `hash`
   for case classes. Verify parameter types.
3. **Codegen**: No special handling needed — desugared case classes use the
   same WASM struct/function machinery as regular classes.

### Phase 3: Sealed Hierarchies (`class X = ...` and `in`)

1. **Parser**: Support `class Name = Variant(...) | Variant(...)` syntax.
   Support `in TypeName` clause after case class parameter list.
2. **Checker**: Collect all variants (inline + `in` declarations) per sealed
   class. Validate restrictions (single `in`, same module, no subclassing).
   Extend exhaustiveness checking to use the sealed variant set.
3. **Codegen**: Variant classes use normal subtype struct layout. Unit variants
   generate singleton globals.

### Phase 4: Exhaustiveness for Sealed Hierarchies

1. Extend the existing match exhaustiveness checker to understand sealed sets.
2. When matching on a sealed class type, require all variants to be covered
   (or use a wildcard).
3. Warn on redundant wildcard patterns when all variants are already covered.

## Examples

### Compiler AST

```zena
// tokens.zena
enum TokenKind {
  Plus, Minus, Star, Slash, Eq, EqEq, Bang, BangEq,
  LParen, RParen, LBrace, RBrace, LBracket, RBracket,
  Comma, Dot, Colon, Semicolon, Arrow, FatArrow, Pipe,
  Number, String, Ident, Eof
}

class Token(kind: TokenKind, value: string, pos: i32)

// expr.zena
class Expr =
  BinaryExpr(left: Expr, op: Token, right: Expr)
  | UnaryExpr(op: Token, operand: Expr)
  | LiteralExpr(value: string, kind: TokenKind)
  | IdentExpr(name: string)
  | CallExpr(callee: Expr, args: FixedArray<Expr>)
  | MemberExpr(object: Expr, property: string)
  | IfExpr(cond: Expr, then: Expr, else_: Expr | null)
  | MatchExpr(subject: Expr, cases: FixedArray<MatchCase>)

// stmt.zena
class Stmt =
  VarDecl(name: string, type_: TypeAnnot | null, init: Expr)
  | FnDecl(name: string, params: FixedArray<Param>, body: Expr)
  | ClassDecl(name: string, fields: FixedArray<Field>, methods: FixedArray<FnDecl>)
  | ExprStmt(expr: Expr)
  | ReturnStmt(value: Expr | null)

// visitor
const eval = (e: Expr): i32 => match (e) {
  case LiteralExpr(v, _): parseInt(v)
  case BinaryExpr(l, op, r): match (op.kind) {
    case TokenKind.Plus: eval(l) + eval(r)
    case TokenKind.Minus: eval(l) - eval(r)
    case TokenKind.Star: eval(l) * eval(r)
    case _: 0
  }
  case UnaryExpr(op, x): match (op.kind) {
    case TokenKind.Minus: 0 - eval(x)
    case _: eval(x)
  }
  case _: 0
}
```

### Data structures

```zena
// Simple value types
class Point(x: f64, y: f64)
class Color(r: i32, g: i32, b: i32, a: i32)

// Generic containers
class Pair<A, B>(first: A, second: B)

// Linked list
class List<T> =
  Cons(head: T, tail: List<T>)
  | Nil

const sum = (list: List<i32>): i32 => match (list) {
  case Cons(h, t): h + sum(t)
  case Nil: 0
}

// Result type
class Result<T, E> =
  Ok(value: T)
  | Err(error: E)
```
