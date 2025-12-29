# The `this` Type

## Overview

The `this` type is a special type that refers to the type of the current class or
interface implementation. It enables more precise typing in inheritance
hierarchies and interface implementations without resorting to verbose
F-bounded polymorphism patterns.

## Motivation

### Problem: Imprecise Interface Signatures

Consider the `Sequence<T>` interface:

```zena
interface Sequence<T> {
  map<U>(f: (item: T, index: i32, seq: Sequence<T>) => U): Sequence<U>;
}
```

When `Array<T>` implements `Sequence<T>`, the callback receives `Sequence<T>`
rather than `Array<T>`. This loses type information:

```zena
class Array<T> implements Sequence<T> {
  map<U>(f: (item: T, index: i32, seq: Sequence<T>) => U): Sequence<U> {
    // Inside f, the user only knows they have a Sequence<T>,
    // not the concrete Array<T> they're actually working with
  }
}
```

### Solution: The `this` Type

With a `this` type, we can express that the callback receives the actual
implementing type:

```zena
interface Sequence<T> {
  map<U>(f: (item: T, index: i32, seq: this) => U): Sequence<U>;
}
```

Now when `Array<T>` implements this interface, `this` resolves to `Array<T>`:

```zena
class Array<T> implements Sequence<T> {
  // Effectively: map<U>(f: (item: T, index: i32, seq: Array<T>) => U): Sequence<U>
}
```

## Use Cases

### 1. Collection Callbacks

The primary motivating use case — callbacks that receive the collection itself:

```zena
interface Sequence<T> {
  length: i32 { get; }
  operator [](index: i32): T;
  map<U>(f: (item: T, index: i32, seq: this) => U): Sequence<U>;
  filter(predicate: (item: T, index: i32, seq: this) => bool): Sequence<T>;
  forEach(f: (item: T, index: i32, seq: this) => void): void;
}
```

### 2. Fluent/Builder APIs

Methods that return `this` enable fluent chaining that preserves the concrete type:

```zena
class Builder {
  #value: i32 = 0;

  setValue(v: i32): this {
    this.#value = v;
    return this;
  }
}

class ExtendedBuilder extends Builder {
  #name: string = '';

  setName(n: string): this {
    this.#name = n;
    return this;
  }
}

// Chaining works correctly:
const b = new ExtendedBuilder()
  .setValue(42)    // Returns ExtendedBuilder, not Builder
  .setName('foo'); // This works because setValue returned ExtendedBuilder
```

### 3. Self-Referential Comparisons

The classic `Comparable` pattern:

```zena
interface Comparable {
  compareTo(other: this): i32;
}

class MyInt implements Comparable {
  value: i32;

  #new(value: i32) {
    this.value = value;
  }

  // Must compare against MyInt, not arbitrary Comparable
  compareTo(other: MyInt): i32 {
    return this.value - other.value;
  }
}
```

### 4. Clone/Copy Patterns

```zena
interface Cloneable {
  clone(): this;
}

class Point implements Cloneable {
  x: i32;
  y: i32;

  clone(): Point {
    return new Point(this.x, this.y);
  }
}
```

## Design

### Syntax

The `this` keyword in type position refers to the implementing type:

```zena
interface Foo {
  method(arg: this): this;
}
```

### Resolution Rules

1. **In a class**: `this` resolves to the class type with its current type arguments.

   ```zena
   class Box<T> {
     map<U>(f: (value: T, box: this) => U): Box<U>;
     // `this` = Box<T>
   }
   ```

2. **In an interface**: `this` is a placeholder that resolves to the implementing
   type when the interface is implemented.

   ```zena
   interface Sequence<T> {
     forEach(f: (item: T, seq: this) => void): void;
   }

   class Array<T> implements Sequence<T> {
     // `this` becomes Array<T>
     forEach(f: (item: T, seq: Array<T>) => void): void { ... }
   }
   ```

3. **In a mixin**: `this` resolves to the class the mixin is applied to.

   ```zena
   mixin Timestamped {
     createdAt: i64;
     touch(): this { this.createdAt = now(); return this; }
   }

   class Document with Timestamped { ... }
   // touch() returns Document
   ```

### Variance Considerations

| Position           | Variance      | Safe?          | Notes                                 |
| ------------------ | ------------- | -------------- | ------------------------------------- |
| Return type        | Covariant     | ✅ Yes         | Subclasses return more specific types |
| Parameter (owned)  | Contravariant | ⚠️ Care needed | See below                             |
| Callback parameter | Covariant     | ✅ Yes         | Passed into callback, not out         |

**Parameter position caution:**

When `this` appears in a method parameter position (like `compareTo(other: this)`),
it creates a contravariant requirement. This is sound but requires that implementors
truly accept their own type:

```zena
interface Comparable {
  compareTo(other: this): i32;
}

class Animal implements Comparable {
  compareTo(other: Animal): i32 { ... }
}

class Dog extends Animal {
  // Must accept Dog, but Animal's compareTo accepts Animal
  // This is the classic "binary method" problem
}
```

**Callback position is safe:**

When `this` appears as a parameter to a callback, it's being _provided_ by the
implementation, not _received_ from the caller:

```zena
interface Sequence<T> {
  forEach(f: (item: T, seq: this) => void): void;
}
```

The implementation passes `this` to `f`, so this is covariant usage — the caller
receives a more specific type than declared, which is always safe.

### Restrictions

1. **Cannot appear in static contexts**: `this` refers to an instance type.

2. **Cannot be used as a type argument directly in return position when the type
   parameter changes**:

   ```zena
   // NOT allowed - we can't know what type parameters the result should have
   map<U>(f: (item: T) => U): this;  // ❌ What would this<U> even mean?

   // Allowed - this is just passed through, not constructed
   map<U>(f: (item: T, seq: this) => U): Sequence<U>;  // ✅
   ```

3. **Cannot be used in top-level function signatures**: Only meaningful in
   class/interface/mixin contexts.

## Comparison with F-Bounded Polymorphism

F-bounded polymorphism achieves similar goals but with more boilerplate:

```zena
// F-bounded approach
interface Sequence<T, Self extends Sequence<T, Self>> {
  map<U>(f: (item: T, index: i32, seq: Self) => U): Sequence<U, ???>;
}

class Array<T> implements Sequence<T, Array<T>> { ... }
```

Problems with F-bounded polymorphism:

- **Verbose**: Every type must repeat itself (`Sequence<T, Array<T>>`)
- **Viral**: The `Self` parameter propagates through the type hierarchy
- **No enforcement**: `class A implements Sequence<T, B>` compiles but is wrong
- **Awkward with multiple inheritance**: Each interface needs its own `Self` param

The `this` type provides the same expressiveness with:

- **Concise syntax**: No extra type parameters
- **Compiler enforcement**: Can't "lie" about the self type
- **Composability**: Works naturally with multiple interface implementations

## Implementation Strategy

### Type Representation

Add a new type kind `ThisType`:

```typescript
interface ThisType {
  kind: 'this';
  // Resolved during type checking based on context
}
```

### Resolution

1. **During parsing**: Parse `this` in type position as `ThisType`.

2. **During checking**:
   - In class context: Immediately resolve to the class type with current type args
   - In interface context: Keep as `ThisType` in the interface signature

3. **During interface implementation checking**:
   - Substitute `ThisType` with the implementing class type
   - Check that the implementation's signature matches after substitution

4. **During codegen**:
   - All `ThisType` references should be resolved to concrete types
   - No runtime representation needed

### Example Resolution

```zena
interface Sequence<T> {
  forEach(f: (item: T, seq: this) => void): void;
}

class Array<T> implements Sequence<T> {
  forEach(f: (item: T, seq: Array<T>) => void): void {
    for (var i = 0; i < this.length; i = i + 1) {
      f(this[i], i, this);  // `this` has type Array<T>
    }
  }
}
```

When checking that `Array<T>.forEach` implements `Sequence<T>.forEach`:

1. Take interface signature: `(f: (item: T, seq: this) => void) => void`
2. Substitute `this` → `Array<T>`: `(f: (item: T, seq: Array<T>) => void) => void`
3. Check implementation matches this resolved signature ✅

### WASM Codegen: Closure Type Adaptation

When an interface method has a callback parameter containing `this`, the interface
and class method have different WASM closure types:

- **Interface**: Callback with `anyref` parameter (erased `this`)
- **Class**: Callback with specific struct type parameter

The trampoline (which adapts interface calls to class methods) must handle this
mismatch by creating a wrapper closure:

```
// Interface trampoline receives: callback with (anyref) => T signature
// Class method expects: callback with (ref SpecificClass) => T signature

// Solution: Create wrapper closure that:
// 1. Has the class's expected closure signature
// 2. Holds the interface callback as its context
// 3. When called, passes arguments directly (subtyping allows specific → anyref)
// 4. Calls the original interface callback
```

This is handled automatically in `generateTrampoline` in `codegen/classes.ts`.

## Related: F-Bounded Polymorphism

The `this` type is essentially compiler-managed **F-bounded polymorphism**. The
"F" stands for "function" — a type-level function that takes a type and produces
a bound. The pattern looks like:

```zena
// F-bounded: T must extend Comparable<T>
interface Comparable<T extends Comparable<T>> {
  compareTo(other: T): i32;
}

class MyInt implements Comparable<MyInt> {
  compareTo(other: MyInt): i32 { ... }
}
```

The bound is recursive: `T` must extend `Comparable<T>`. This ensures implementors
compare against their own type.

### When You Need F-Bounded Polymorphism Instead of `this`

The `this` type covers most self-referential use cases, but F-bounded polymorphism
is still needed for:

**1. Generic Functions (Outside Classes)**

```zena
// Can't use `this` — we're not in a class/interface
const max = <T extends Comparable<T>>(a: T, b: T): T => {
  return a.compareTo(b) > 0 ? a : b;
};
```

**2. Mutually-Recursive Type Parameters**

```zena
// Graph where Nodes and Edges reference each other's concrete types
interface Graph<N extends Node<N, E>, E extends Edge<N, E>> {
  nodes: Array<N>;
  edges: Array<E>;
}
```

`this` gives you one self-reference; F-bounded allows multiple mutually-constrained
type parameters.

**3. Separating Self from Other Type Parameters**

```zena
interface Builder<Product, Self extends Builder<Product, Self>> {
  build(): Product;
  chain(f: (s: Self) => Self): Self;
}
```

### Comparison

| Feature                    | Use Case                                                           |
| -------------------------- | ------------------------------------------------------------------ |
| **`this` type**            | Simple self-reference inside classes/interfaces                    |
| **F-bounded polymorphism** | Generic functions, mutually-recursive types, complex relationships |

**Recommendation:** Use `this` for most cases (simpler syntax, compiler-enforced).
Reserve F-bounded polymorphism for advanced library code.

## Future Considerations

### `this` in Constructors

Should `#new` be allowed to have return type `this`? Probably not needed since
constructors implicitly return the constructed type.

### Conditional `this`

TypeScript allows `this is SomeType` for type guards. We could consider this
for pattern matching or type narrowing:

```zena
interface Node {
  isElement(): this is Element;
}
```

This is out of scope for the initial implementation.

## References

- TypeScript Handbook: [Polymorphic `this` types](https://www.typescriptlang.org/docs/handbook/2/classes.html#this-types)
- Canning, Cook, Hill, Olthoff, Mitchell (1989): "F-Bounded Polymorphism for Object-Oriented Programming"
- Bruce, Cardelli, Castagna, Leavens, Pierce (1995): "On Binary Methods"
