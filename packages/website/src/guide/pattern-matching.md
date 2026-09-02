---
title: 'Pattern Matching'
description: 'Pattern matching, destructuring, irrefutable patterns, match expressions, and pattern taxonomy in Zena.'
---

Pattern matching in Zena allows you to inspect, test, and extract data from
classes, records, tuples, unions, and sealed hierarchies with compile-time
exhaustiveness checking.

## Irrefutable patterns and destructuring

A pattern is **irrefutable** if it is guaranteed to match every possible value
of the matched type. In Zena, destructuring syntax is simply the application of
irrefutable pattern matching.

### Variable destructuring

You can destructure records, tuples, and classes directly in `let` and `var`
declarations:

```zena
// Record destructuring
let point = { x: 10.0, y: 20.0 };
let { x, y } = point;

// Tuple destructuring
let tuple = (1, 'hello');
let (id, message) = tuple;

// Renaming with 'as' and default values
let options = { timeout: 3000 };
let { timeout as waitMs, retries = 3 } = options;
```

### Function parameter destructuring

Function signatures and arrow functions accept destructuring patterns in place
of simple parameter names:

```zena
type Point = { x: f64, y: f64 };

let distance = ({ x, y }: Point): f64 => {
  return sqrt(x * x + y * y);
};

let printPair = ((first, second): (String, i32)): void => {
  print(first + ': ' + second.toString());
};
```

### `for-in` loop destructuring

Iterating over collections of tuples or records can be destructured directly in
the `for-in` loop header:

```zena
let entries = [('alpha', 1), ('beta', 2), ('gamma', 3)];

for (let (name, index) in entries) {
  print(name + ' at position ' + index.toString());
}
```

## Refutable patterns and match expressions

A pattern is **refutable** if it might fail to match certain values of the
target type (for example, matching an exact literal `1`, a specific sealed
variant `Some`, or an instance of a subclass `Circle`).

Refutable patterns are used in `match` expressions, `if let` statements, and
`while let` loops.

### `match` expressions

A `match` expression evaluates a discriminant expression against a series of
pattern arms:

```zena
let description = match (statusCode) {
  case 200: 'OK'
  case 400: 'Bad Request'
  case 404: 'Not Found'
  case 500: 'Internal Server Error'
  case let code: 'Unknown status: ' + code.toString()
};
```

`match` is expression-oriented and returns the value of the matched arm. Arms
can be written as single expressions or as multi-statement code blocks `{ ...
}`:

```zena
let processed = match (input) {
  case let (true, value): {
    let doubled = value * 2;
    doubled + 1
  }
  case let (false, _): 0
};
```

### Exhaustiveness checking

`match` expressions in Zena are **strictly checked for exhaustiveness**. The
compiler ensures that every possible value of the discriminant type is handled:

- For **enums** and **literal union types** (`1 | 2 | 3`), all member values
  must be matched or covered by a wildcard `case _`.
- For **sealed class hierarchies**, all subclasses declared in the sealed family
  must be matched.
- If any possible case is omitted, the compiler reports a compilation error.

```zena
type Status = 200 | 404 | 500;
let s: Status = 200;

// ❌ Compile error: Missing case for '500'
// let result = match (s) {
//   case 200: 'OK'
//   case 404: 'Not Found'
// };
```

## Pattern taxonomy

Zena provides a rich vocabulary of patterns that can be composed and nested.

### Wildcard pattern (`_`)

The wildcard pattern `_` matches any value without introducing a variable
binding:

```zena
match (value) {
  case 0: 'zero'
  case _: 'non-zero' // Matches anything else
}
```

### Literal patterns

Literal patterns match exact primitive values, strings, and `null`:

```zena
match (val) {
  case 42: 'forty-two'
  case 3.14: 'pi'
  case 'hello': 'greeting'
  case true: 'yes'
  case null: 'nothing'
  case _: 'other'
}
```

### Variable binding patterns (`let x`, `var x`)

In Zena, whether a name in a pattern _binds a new variable_ or _references an
existing class_ is determined syntactically by the `let` or `var` keyword:

- Under `let` or `var`, every identifier introduces a new variable binding.
- A bare identifier without `let` refers to a type/class to match against.

```zena
match (shape) {
  case Circle: 'Matches any instance of class Circle'
  case let s: 'Binds the entire matched value to new variable s'
}
```

This explicit syntactic distinction prevents typos from quietly turning into
accidental catch-all variables:

```zena
match (shape) {
  case Circle: 'circle'
  case Squre:  'square' // ❌ Compile error: 'Squre' does not name a class
}
```

### Record patterns

Record patterns match structural record properties and bind their fields:

```zena
match (user) {
  case { role: 'admin', name }: 'Admin user: ' + name
  case { role: 'guest', id as userId }: 'Guest ID: ' + userId.toString()
  case { name }: 'Standard user: ' + name
}
```

### Tuple patterns

Tuple patterns match fixed-length tuples and destructure elements by position:

```zena
match (coordinate) {
  case (0, 0): 'Origin'
  case (0, let y): 'On Y-axis at ' + y.toString()
  case (let x, 0): 'On X-axis at ' + x.toString()
  case let (x, y): 'Point (' + x.toString() + ', ' + y.toString() + ')'
}
```

### Class and case class patterns

Class patterns match nominal class instances and destructure their fields:

```zena
class Point(x: f64, y: f64)

match (p) {
  case let Point { x: 0.0, y: 0.0 }: 'Origin'
  case let Point { x, y: 0.0 }: 'On X-axis'
  case let Point { x, y }: 'Point at (' + x.toString() + ', ' + y.toString() + ')'
}
```

### Sealed class variant patterns

Matching against `sealed class` hierarchies supports both parameterless unit
variants (matched by identifier) and parameterized variants:

```zena
sealed class Expr {
  case Lit(value: i32)
  case Add(left: Expr, right: Expr)
  case Neg(expr: Expr)
}

function evaluate(e: Expr): i32 {
  return match (e) {
    case let Lit { value }: value
    case let Add { left, right }: evaluate(left) + evaluate(right)
    case let Neg { expr }: -evaluate(expr)
  };
}
```

### Logical patterns (`|` and `&`)

Logical patterns combine multiple patterns:

- **OR pattern (`|`)**: Matches if any sub-pattern matches.
- **AND pattern (`&`)**: Matches only if all sub-patterns match simultaneously.

```zena
match (code) {
  case 200 | 201 | 204: 'Success'
  case 400 | 401 | 403 | 404: 'Client Error'
  case 500 | 502 | 503: 'Server Error'
  case _: 'Other'
}
```

### Relational and range patterns <span class="badge info">Planned</span>

Value comparison patterns and range intervals are planned for future releases:

```zena
// Planned syntax:
match (age) {
  case 0..12: 'Child'
  case 13..19: 'Teenager'
  case >= 20: 'Adult'
}
```

## Pattern guards

Match cases can include an optional boolean guard using the `if` keyword. The
arm executes only if the pattern matches **and** the guard expression evaluates
to `true`:

```zena
match (score) {
  case let n if n < 0: 'Invalid score'
  case let n if n >= 90: 'Grade A'
  case let n if n >= 80: 'Grade B'
  case let n if n >= 70: 'Grade C'
  case _: 'Grade F'
}
```

### Guards and exhaustiveness

Because the compiler cannot statically verify all possible runtime outcomes of
an arbitrary boolean guard expression, match arms with `if` guards do not count
toward covering the discriminant type for exhaustiveness. A non-guarded fallback
or covering case is still required:

```zena
// Even with guards covering all values, an exhaustive fallback is required:
let category = match (temperature) {
  case let t if t > 30: 'Hot'
  case let t if t <= 30: 'Cool'
  case _: 'Fallback' // Required for exhaustiveness
};
```

## Next

- [Control Flow](/guide/control-flow/) — loops, conditionals, and expressions
- [Classes](/guide/classes/) — case classes and sealed hierarchies
- [Types](/guide/types/) — unions, literal types, and narrowing
