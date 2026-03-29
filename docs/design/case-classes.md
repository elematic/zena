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
3. **Structural `operator ==`** — compares all fields for equality (see below).
4. **Structural `hash`** — combines hashes of all fields.
5. **Destructuring support** — already works for all classes.

#### Equality and class identity

The auto-generated `operator ==` includes a **class identity check** when the
case class participates in a hierarchy (has subclasses or is part of a sealed
set). This preserves symmetry:

```zena
class Binary(left: Expr, op: Token, right: Expr) extends Expr
class EvalBinary(left: Expr, op: Token, right: Expr, var result: i32) extends Binary

const a = Binary(x, plus, y)
const b = EvalBinary(x, plus, y, 42)
a == b  // false — different classes
b == a  // false — symmetric
```

Without the class check, `a == b` would be `true` (same `Binary` fields) but
`b == a` would be `false` (missing `result` field), breaking symmetry.

For standalone case classes with no subclasses (e.g., `class Point(x: f64,
y: f64)`) the compiler may omit the class check as an optimization, since
there's only one concrete class.

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

A `sealed` class restricts direct subclassing: only classes listed in its
`case` declaration can directly extend it. This gives the compiler a complete
variant set for exhaustive pattern matching.

#### `sealed` and `case`

`sealed` is a class modifier (like `abstract`). `case` inside the body
enumerates the variants:

```zena
sealed class Expr {
  case Binary, Unary, Literal, Ident
}
```

The two concepts are independent but compose:

| Declaration                      | Meaning                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `sealed class Foo { case A, B }` | Closed hierarchy — only A and B can directly extend Foo |
| `sealed class Foo { }`           | No direct subclassing allowed (locked-down class)       |
| `class Foo { case A, B }`        | **Error** — `case` requires `sealed`                    |

`case` inside a sealed class can also define inline variants with fields
(concise form for small hierarchies):

```zena
sealed class Expr {
  case Binary(left: Expr, op: Token, right: Expr)
  case Unary(op: Token, operand: Expr)
  case Literal(value: i32)
  case Ident(name: string)
}
```

Each inline `case` declares a case class that extends the sealed base.

#### Distributed variants

When variants need their own files or bodies, the `case` declaration lists
names only, and the variants are defined separately with `extends`:

```zena
// expr.zena
sealed class Expr(loc: SourceLocation) {
  case Binary, Unary, Literal, Ident

  span(): Span => loc.toSpan()
}

// binary.zena
class Binary(left: Expr, op: Token, right: Expr) extends Expr

// literal.zena
class Literal(value: i32) extends Expr
```

The compiler verifies that every class directly extending a sealed class is
listed in its `case` declaration, and that every name in the `case` list has
a corresponding class definition.

#### Exhaustive matching

The compiler knows the complete variant set, enabling exhaustive `match`:

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
sealed class Token {
  case Plus, Minus, Star, Slash, Eof
  case Number(value: i32)
  case Ident(name: string)
}
```

Unit variants are singletons — the compiler allocates one instance and all
references share it.

#### Concrete leaves and abstract intermediates

Only **concrete** (non-abstract) classes can be case classes — they get
auto-generated constructors, equality, and hashing. Abstract classes in a
sealed hierarchy serve as grouping intermediates for shared fields and methods,
but are never instantiated directly.

This follows the **Abstract Hierarchy + Concrete Leaf** pattern:

```zena
// Abstract intermediate — groups related variants, shares fields
sealed abstract class Expr(loc: SourceLocation) extends Node {
  case Binary, Literal, Ident

  span(): Span => loc.toSpan()
}

// Concrete leaves — these are the actual case classes
class Binary(left: Expr, op: Token, right: Expr, loc: SourceLocation) extends Expr
class Literal(value: i32, loc: SourceLocation) extends Expr
class Ident(name: string, loc: SourceLocation) extends Expr
```

Exhaustiveness checking only considers **concrete leaves**. Since abstract
classes can't be instantiated, they never appear as runtime values — only
their concrete descendants do.

#### Subclassing concrete variants

Concrete variants are **not** implicitly `final`. A variant can be subclassed
— the subclass is not itself a variant, but it IS-A its parent variant, so
exhaustiveness is preserved:

```zena
// Subclass of a variant — NOT a variant itself
class EvalBinary(left: Expr, op: Token, right: Expr, var result: i32) extends Binary
```

When an `EvalBinary` flows into a match on `Expr`, it matches the `Binary`
arm because `EvalBinary` IS-A `Binary`. WASM `ref.test $Binary` succeeds for
any subtype of `$Binary`. Destructuring works too — `EvalBinary` has all of
`Binary`'s fields.

Automatic equality handles this correctly via the class identity check:
`Binary(...) == EvalBinary(...)` is `false` even if the shared fields match.

What is restricted: **directly extending the sealed base** with a class not in
the variant list. This would break exhaustiveness:

```zena
class Weird(x: i32) extends Expr   // ERROR: Weird is not in Expr's case list
```

#### Restrictions

- Only classes named in the `case` declaration can directly extend the sealed
  class. Other `extends` of the sealed base are rejected.
- A variant can belong to at most **one** sealed hierarchy (it cannot appear
  in multiple `case` lists).
- All variants must be within the same **module** as the sealed base. This
  gives the compiler a clear boundary for collecting variants. Separate files
  within the module are fine.
  **Note**: The exact definition of "module" in Zena (package boundary, single
  file, directory, etc.) is not yet specified. This needs to be defined as part
  of the module system design. See `docs/design/modules.md`.

#### Module cycles

If `Expr` is defined in `expr.zena` and `Binary extends Expr` is in
`binary.zena`, which imports `Expr`, then `expr.zena` must also be able to
find `Binary` to build the exhaustive set. This creates a cycle in the module
graph.

This is acceptable because:

- A sealed hierarchy is one inseparable unit — separate files are only for
  code organization.
- The compiler already processes modules within a package together.
- The cycle is shallow (only between files declaring variants of the same
  sealed class) and can be resolved by collecting all variant definitions
  during a pre-pass before full type checking.

#### Nested sealed hierarchies (Sum of Sums)

A sealed variant can itself be `sealed`, creating nested hierarchies. This is
the **Sum of Sums** pattern — essential for modeling ASTs where `Node` is the
top-level sum, and `Expr`, `Stmt`, `Type` are sub-sums with their own
variants.

```zena
// node.zena — top-level sealed hierarchy
sealed class Node(loc: SourceLocation) {
  case Expr, Stmt

  span(): Span => loc.toSpan()
}

// expr.zena — sealed sub-hierarchy, itself a variant of Node
sealed abstract class Expr(loc: SourceLocation) extends Node {
  case Binary, Literal, Ident, Call
}

class Binary(left: Expr, op: Token, right: Expr, loc: SourceLocation) extends Expr
class Literal(value: i32, loc: SourceLocation) extends Expr
class Ident(name: string, loc: SourceLocation) extends Expr
class Call(callee: Expr, args: FixedArray<Expr>, loc: SourceLocation) extends Expr

// stmt.zena — another sealed sub-hierarchy
sealed abstract class Stmt(loc: SourceLocation) extends Node {
  case VarDecl, Return, ExprStmt
}

class VarDecl(name: string, init: Expr, loc: SourceLocation) extends Stmt
class Return(value: Expr | null, loc: SourceLocation) extends Stmt
class ExprStmt(expr: Expr, loc: SourceLocation) extends Stmt
```

`Expr` and `Stmt` are `sealed abstract` — they are abstract intermediates in
the `Node` hierarchy, and simultaneously sealed bases of their own sub-hierarchies.
The only instantiable objects are the concrete leaves: `Binary`, `Literal`,
`VarDecl`, etc.

**Matching at the top level** — a match on `Node` can handle branches at any
granularity:

```zena
const describe = (n: Node): string => match (n) {
  // Match an entire sub-hierarchy
  case Expr: "expression at ${n.span()}"
  // Match individual leaves
  case VarDecl(name, _, _): "var ${name}"
  case Return(_): "return"
  case ExprStmt(_): "expr statement"
}
```

The exhaustiveness checker understands that matching `Expr` covers all of
`Binary`, `Literal`, `Ident`, and `Call`. Matching `VarDecl`, `Return`, and
`ExprStmt` individually covers all of `Stmt`. Together, all of `Node` is
covered.

**Matching at a sub-level** — a function taking `Expr` gets its own exhaustive
match:

```zena
const eval = (e: Expr): i32 => match (e) {
  case Binary(l, op, r): applyOp(op, eval(l), eval(r))
  case Literal(v): v
  case Ident(name): lookup(name)
  case Call(callee, args): apply(eval(callee), args.map(eval))
}
```

**Rules for nesting**:

- A sealed class can be a variant of another sealed class (it appears in the
  parent's `case` list).
- Such a class must be `abstract` — it serves as a grouping intermediate,
  not a concrete instantiable type.
- Exhaustiveness recurses: matching a sealed intermediate counts as matching
  all its concrete descendants.

#### GADTs (future consideration)

Generalized Algebraic Data Types allow variants to **narrow type parameters**
of the sealed base. This enables type-safe evaluators where matching a variant
refines the return type:

```zena
// Hypothetical future syntax
sealed class Expr<T> {
  case IntLit(value: i32) extends Expr<i32>
  case BoolLit(value: boolean) extends Expr<boolean>
  case Add(left: Expr<i32>, right: Expr<i32>) extends Expr<i32>
  case If(cond: Expr<boolean>, then: Expr<T>, else_: Expr<T>)
}

const eval = <T>(e: Expr<T>): T => match (e) {
  case IntLit(v): v       // T narrowed to i32, returns i32 ✓
  case BoolLit(v): v      // T narrowed to boolean, returns boolean ✓
  case Add(l, r): eval(l) + eval(r)
  case If(c, t, e): if (eval(c)) { eval(t) } else { eval(e) }
}
```

GADTs require **type-level narrowing in match arms** — when the compiler sees
`case IntLit(v)`, it must refine the generic `T` to `i32` within that arm's
scope. This is powerful for typed ASTs, type-safe serialization, and typed
embedded DSLs.

This is not planned for the initial implementation but the `extends` clause
on inline case variants provides a natural syntax for it.

### 4. Adding Methods and State to Variants

Case classes start as pure data but can grow incrementally:

```zena
// Stage 1: pure data
class Binary(left: Expr, op: Token, right: Expr) extends Expr

// Stage 2: add computed properties
class Binary(left: Expr, op: Token, right: Expr) extends Expr {
  precedence: i32 { get { ... } }
}

// Stage 3: add private state and methods
class Binary(left: Expr, op: Token, right: Expr) extends Expr {
  #cachedType: Type | null = null

  resolve(ctx: Context): Type => {
    if (let t = #cachedType) { return t }
    const t = ctx.resolve(this)
    #cachedType = t
    t
  }
}
```

Methods can also be defined on the sealed base class:

```zena
sealed class Expr(loc: SourceLocation) {
  case Binary, Literal, Ident

  span(): Span => loc.toSpan()
  abstract eval(): i32
}
```

### 5. Relationship to Existing Features

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

sealed class Token {
  case Operator(kind: TokenKind, pos: i32)
  case NumLit(value: i32, pos: i32)
  case IdentTok(name: string, pos: i32)
}
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

|                      | Case class        | Regular class                  |
| -------------------- | ----------------- | ------------------------------ |
| Declaration          | `class Foo(x: T)` | `class Foo { ... }`            |
| Auto-constructor     | Yes               | No (manual `new(...)`)         |
| Auto `==` and `hash` | Yes (structural)  | No (reference identity)        |
| Default mutability   | Immutable         | Immutable (same as case class) |
| Sealed variant       | Yes               | No — use `extends`             |

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

The auto-generated `operator ==` compiles to a class identity check followed
by field-by-field comparison. The class check ensures symmetry across
hierarchies:

```wat
(func $Binary_eq (param $a (ref $Binary)) (param $b (ref $Binary)) (result i32)
  ;; Class identity check — reject subclasses
  (if (i32.eqz (ref.test (ref $Binary) (local.get $b))) (then (return (i32.const 0))))
  ;; Field-by-field comparison
  (i32.and
    (call $Expr_eq (struct.get $Binary 1 (local.get $a))
                   (struct.get $Binary 1 (local.get $b)))
    (i32.and
      (call $Token_eq (struct.get $Binary 2 (local.get $a))
                      (struct.get $Binary 2 (local.get $b)))
      (call $Expr_eq (struct.get $Binary 3 (local.get $a))
                     (struct.get $Binary 3 (local.get $b))))))
```

For standalone case classes with no subclasses (e.g., `Point`), the compiler
omits the class identity check as an optimization:

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

### Phase 1: Immutable Fields by Default ✅

1. Change the default field mutability from mutable to immutable.
2. Require `var` for mutable fields.
3. Follow the migration plan in [classes.md](classes.md#migration-to-immutable-by-default).

### Phase 2: Concise Class Declarations ✅

1. **Parser**: Support `class Name(param, param, ...)` syntax — parameter list
   after the class name, before any `extends`/body.
2. **Checker**: Auto-generate constructor, fields, `operator ==`, and `hash`
   for case classes. Verify parameter types.
3. **Codegen**: No special handling needed — desugared case classes use the
   same WASM struct/function machinery as regular classes.

### Phase 3: Sealed Hierarchies (`sealed` + `case`)

1. **Parser**: Support `sealed` class modifier. Support `case Name, Name` and
   `case Name(fields...)` declarations inside sealed class bodies.
2. **Checker**: Collect all variants per sealed class from the `case`
   declaration. Validate that only listed classes directly extend the sealed
   base. Validate same-module restriction.
   Extend exhaustiveness checking to use the sealed variant set.
3. **Codegen**: Variant classes use normal subtype struct layout. Unit variants
   generate singleton globals.

### Phase 4: Exhaustiveness for Sealed Hierarchies

1. Extend the existing match exhaustiveness checker to understand sealed sets.
2. When matching on a sealed class type, require all variants to be covered
   (or use a wildcard).
3. Warn on redundant wildcard patterns when all variants are already covered.

## Examples

### Compiler AST (nested hierarchy)

```zena
// tokens.zena
enum TokenKind {
  Plus, Minus, Star, Slash, Eq, EqEq, Bang, BangEq,
  LParen, RParen, LBrace, RBrace, LBracket, RBracket,
  Comma, Dot, Colon, Semicolon, Arrow, FatArrow, Pipe,
  Number, String, Ident, Eof
}

class Token(kind: TokenKind, value: string, pos: i32)

// node.zena — top-level sealed hierarchy
sealed class Node(loc: SourceLocation) {
  case Expr, Stmt

  span(): Span => loc.toSpan()
}

// expr.zena — sealed sub-hierarchy
sealed abstract class Expr(loc: SourceLocation) extends Node {
  case BinaryExpr, UnaryExpr, LiteralExpr, IdentExpr
  case CallExpr, MemberExpr, IfExpr, MatchExpr
}

class BinaryExpr(left: Expr, op: Token, right: Expr, loc: SourceLocation) extends Expr
class UnaryExpr(op: Token, operand: Expr, loc: SourceLocation) extends Expr
class LiteralExpr(value: string, kind: TokenKind, loc: SourceLocation) extends Expr
class IdentExpr(name: string, loc: SourceLocation) extends Expr
class CallExpr(callee: Expr, args: FixedArray<Expr>, loc: SourceLocation) extends Expr
class MemberExpr(object: Expr, property: string, loc: SourceLocation) extends Expr
class IfExpr(cond: Expr, then: Expr, else_: Expr | null, loc: SourceLocation) extends Expr
class MatchExpr(subject: Expr, cases: FixedArray<MatchCase>, loc: SourceLocation) extends Expr

// stmt.zena — sealed sub-hierarchy
sealed abstract class Stmt(loc: SourceLocation) extends Node {
  case VarDecl, FnDecl, ClassDecl, ExprStmt, ReturnStmt
}

class VarDecl(name: string, type_: TypeAnnot | null, init: Expr, loc: SourceLocation) extends Stmt
class FnDecl(name: string, params: FixedArray<Param>, body: Expr, loc: SourceLocation) extends Stmt
class ClassDecl(name: string, fields: FixedArray<Field>, methods: FixedArray<FnDecl>, loc: SourceLocation) extends Stmt
class ExprStmt(expr: Expr, loc: SourceLocation) extends Stmt
class ReturnStmt(value: Expr | null, loc: SourceLocation) extends Stmt

// Matching at top level — handles all Nodes exhaustively
const nodeKind = (n: Node): string => match (n) {
  case Expr: "expr"
  case Stmt: "stmt"
}

// Matching at sub-level — handles all Exprs exhaustively
const eval = (e: Expr): i32 => match (e) {
  case LiteralExpr(v, _, _): parseInt(v)
  case BinaryExpr(l, op, r, _): match (op.kind) {
    case TokenKind.Plus: eval(l) + eval(r)
    case TokenKind.Minus: eval(l) - eval(r)
    case TokenKind.Star: eval(l) * eval(r)
    case _: 0
  }
  case UnaryExpr(op, x, _): match (op.kind) {
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
sealed class List<T> {
  case Cons(head: T, tail: List<T>)
  case Nil
}

const sum = (list: List<i32>): i32 => match (list) {
  case Cons(h, t): h + sum(t)
  case Nil: 0
}

// Result type
sealed class Result<T, E> {
  case Ok(value: T)
  case Err(error: E)
}
```
