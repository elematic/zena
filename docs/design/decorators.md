# Decorators Design

## 1. Overview

Decorators provide a way to annotate declarations (classes, methods, fields, functions) with metadata or to modify their behavior. In Zena, decorators use the `@expression` syntax, similar to TypeScript and Python.

Currently, Zena only supports a specific set of built-in decorators (intrinsics) handled directly by the compiler. The long-term goal is to support user-defined decorators for metadata, aspect-oriented programming (wrapping), and code generation.

## 2. Current Implementation

As of now, decorators are implemented as compiler intrinsics. They are not general expressions but specific keywords recognized by the parser.

### 2.1 Syntax

```typescript
@name(arguments)
declaration
```

### 2.2 Supported Decorators

#### `@external(module: string, name: string)`

The `@external` decorator is used to map a `declare function` statement to a specific WebAssembly import.

- **Target**: `declare function` statements.
- **Arguments**:
  - `module` (string): The name of the host module (e.g., "env", "console").
  - `name` (string): The name of the export in that module.

**Example:**

```typescript
@external("console", "log")
declare function print(value: i32): void;
```

**Compiler Implementation:**

1.  **Parsing**: The parser (`parser.ts`) explicitly checks for `@external`. It parses the two string arguments and passes them to the `DeclareFunction` AST node.
2.  **AST**: The `DeclareFunction` node has optional `externalModule` and `externalName` properties.
3.  **Codegen**: When generating the WASM binary, the emitter uses these values to construct the Import Section entry.

## 3. Future Design: User-Defined Decorators

The goal is to allow developers to write their own decorators in Zena.

### 3.1 Challenges in a Static Language

Unlike JavaScript, where decorators are functions applied at runtime that can freely mutate objects and prototypes, Zena is statically typed and compiles to WASM-GC structs.

1.  **Type Safety**: A decorator that replaces a method must ensure the new method has a compatible signature.
2.  **Immutable Structure**: WASM structs have a fixed layout. Decorators cannot add or remove fields at runtime.
3.  **Performance**: Runtime reflection and wrapping can introduce overhead. Zena prefers zero-cost abstractions where possible.

### 3.2 Proposed Approaches

#### A. Metadata Decorators (Annotations)

Decorators that simply attach metadata to a declaration. This metadata can be inspected at runtime via a Reflection API (to be designed).

```typescript
@route("/home")
class HomeController { ... }
```

- **Implementation**: The compiler emits this data into a custom WASM section or a static registry accessible at runtime.

#### B. Wrapping Decorators (Interceptors)

Decorators that wrap a method to add behavior (logging, validation, caching).

```typescript
function log(target: any, name: string, descriptor: Descriptor) {
  const original = descriptor.value;
  descriptor.value = (args) => {
    print("Calling " + name);
    return original(args);
  };
}

class Service {
  @log
  doWork() { ... }
}
```

**Static Implementation Strategy**:
Since we cannot easily mutate the function at runtime, the compiler can perform a **source-to-source transformation** or **AST rewrite** during compilation.

The compiler would generate a wrapper method that calls the decorator logic, which in turn calls the original implementation.

#### C. Macro Decorators

For more advanced use cases (e.g., generating `json` serialization methods), decorators could act as compile-time macros that generate new code/methods for a class.

### 3.3 Proposed Syntax & Semantics

To support type checking, decorators should be defined as functions with specific signatures.

```typescript
// Method Decorator Signature
type MethodDecorator<T, R> = (
  target: Object,
  propertyKey: string,
  descriptor: TypedPropertyDescriptor<T, R>,
) => TypedPropertyDescriptor<T, R> | void;
```

### 3.4 Roadmap

1.  **Refactor Parser**: Change the parser to parse decorators as generic expressions (`@Identifier(Args)`) attached to AST nodes, rather than hardcoding `@external`.
2.  **Decorator Resolution**: In the Checker, resolve the decorator name to a function definition.
3.  **Metadata Support**: Implement basic metadata emission.
4.  **Transformation**: Implement the logic to apply decorators during code generation (wrapping methods).

## 4. Specification (Draft)

### Grammar

```ebnf
Decorator ::= "@" Identifier ("(" Arguments? ")")?
DecoratedStatement ::= Decorator* Statement
```

### Resolution

1.  The identifier is looked up in the current scope.
2.  If it resolves to a built-in (like `external`), the compiler applies intrinsic logic.
3.  If it resolves to a user function, it is validated against the decorator signature requirements.
