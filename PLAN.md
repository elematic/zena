# Zena Development Plan

This document tracks completed work and planned features. For project instructions
and coding standards, see [AGENTS.md](./AGENTS.md).

## Completed

- [x] Initialize npm project with TypeScript.
- [x] Set up project structure (`src`, `tests`).
- [x] Implement the Lexer.
- [x] Implement Parser (AST generation).
- [x] Implement Type Checker (Basic).
- [x] Implement Code Generator (WASM-GC) for:
  - `i32` arithmetic.
  - Function parameters.
  - `while` loops.
  - `if` statements.
  - Variable assignment (`var`).
  - Function calls and recursion.
- [x] Implement Structs & Classes (WASM-GC structs).
- [x] Implement Arrays (WASM-GC arrays).
- [x] Implement Strings (UTF-8 bytes, concatenation, equality).
- [x] Implement Generics:
  - Generic Classes (`class Box<T>`).
  - Multiple Type Parameters (`class Pair<K, V>`).
  - Generic Functions (`<T>(x: T) => x`).
  - Type Inference (`new Box(10)` -> `Box<i32>`).
  - Default Type Parameters (`class Box<T = i32>`).
  - Inheritance (Basic):
    - `extends` keyword.
    - Struct layout compatibility.
    - Method/Field inheritance.
    - Static dispatch for overridden methods.
- [x] Implement Accessors (Parser, Checker, Codegen).
- [x] Implement `final` modifier (Parser, Checker, Codegen).
- [x] Implement Host Interop:
  - Imports (`declare`, `@external`).
  - Exports (Functions, Classes).
  - Standard Library (`Console`).
  - Runtime Helper.
  - Function Overloading.
- [x] Implement Closures:
  - Parser (Generic Arrow Functions).
  - Checker (Capture Analysis).
  - Codegen (Context Structs, \`ref.func\`, Element Section).
- [x] Implement Tagged Template Literals.
- [x] Implement Type Aliases (`type` keyword).
- [x] Implement Distinct Types (`distinct type` keyword).
- [x] Implement Function Types (`(a: i32) => void`).
- [x] Implement Records & Tuples:
  - Parser: Literals (`{...}`, `[...]`) and Types.
  - Checker: Structural typing and inference.
  - Codegen (Boxed): Canonical WASM structs.
  - Destructuring: Parser, Checker, Codegen.
- [x] Implement Optional Parameters:
  - Parser: `?` syntax.
  - Checker: Union with `null`, assignability.
  - Codegen: Default values.
- [x] Implement `eq` intrinsic and `operator ==` overloading.
- [x] Implement `Map` and `Box` in Standard Library.
- [x] Implement `hash` intrinsic.
- [x] Implement strict equality (`===`, `!==`).
- [x] Implement bitwise XOR (`^`), AND (`&`), OR (`|`).
- [x] Implement modulo operator (`%`).
- [x] Implement `i64` and `f64` support (Codegen & Emitter).
- [x] Allow identifiers to contain `$` and `_`.
- [x] Implement `#[ ... ]` array literal syntax.
- [x] Implement `map()` for `Array` and `FixedArray`.
- [x] Implement Pattern Matching (Basic):
  - `match` expression.
  - Identifier patterns (binding & wildcards).
  - Literal patterns (number, string, boolean).
  - Record patterns (`{x: 1}`).
  - Tuple patterns (`[1, 2]`) for Tuples.
  - Class patterns (`Point {x}`).
  - `as` patterns (`Point {x} as p`).
  - Logical patterns (`|`, `&`).
  - Match Guards (`case ... if ...`).
  - Exhaustiveness Checking.
- [x] Implement Record Spread (`{ ...p, z: 3 }`).
- [x] Implement Exceptions (`throw`).
- [x] Implement `never` type.
- [x] Implement Super Calls (`super(...)`, `super.method()`, `super.field`).
- [x] Implement Advanced Inheritance:
  - Virtual Fields (Uniform Access Principle).
  - Dynamic Dispatch (VTables).
  - Casting (`as`, `is`).
  - Mixins (Parser, Checker, Codegen).
- [x] Implement Interfaces:
  - Definition, Implementation, Inheritance.
  - Fat Pointers & VTables.
  - Interface Properties.
- [x] Implement Abstract Classes (`abstract` keyword, abstract methods).
- [x] Enforce Access Control (`#` private fields).
- [x] Implement Generic Constraints (`T extends Animal`).
- [x] Implement Blocks (Lexical Scoping).
- [x] Implement Type Narrowing (control-flow-based null checks).
- [x] Implement Method Overloading:
  - Multiple methods with same name but different signatures.
  - Signature-based name mangling for codegen.
  - Overload resolution by parameter type and count.
  - Inheritance: override specific overloads, inherit others.
  - Operator overloading (`operator []` with multiple signatures).
  - Virtual dispatch with overloaded methods.
- [x] Implement Dead Code Elimination (DCE):
  - AST Visitor infrastructure (`visitor.ts`) for reusable tree traversal.
  - Usage analysis pass (`analysis/usage.ts`) to determine reachable declarations.
  - Declaration-level DCE: skip codegen for unused functions, classes, and interfaces.
  - Type-level DCE: skip WASM type/function creation for intrinsic methods and fields.
  - VTable elimination: skip vtable creation for extension classes with empty vtables.
  - Method-level DCE: fully eliminate unused methods (no function allocation, no vtable entry).
    - Tracks method calls via `SemanticContext.getResolvedBinding()`.
    - Handles polymorphic dispatch: if a method is called through a base class/interface, all overrides are kept.
    - Subclass tracking: propagates polymorphic calls to known subclasses.
    - Covers regular methods, accessors (getters/setters), and implicit field accessors.
    - Constructors (`#new`) are always kept if the class is used.
  - Binary size results: 21% reduction on string programs, minimal programs at 41 bytes.
- [x] Implement untagged enums with nominal typing.
- [x] Checker-Driven Type Instantiation (Phases 1-9 completed)
- [x] Multi-Return Values & Zero-Allocation Iteration (completed)
- [x] For-In Loops
- [x] `if (let pattern = expr)` and `while (let pattern = expr)`

## Planned

### Near-Term

1.  **Visitor Infrastructure Improvements**:
    - **Ensure new syntax is visited**: When adding new AST node types, always add corresponding visit methods to `visitor.ts` to ensure DCE and other analyses cover them.
    - **Type Object Visitor**: Consider implementing a `TypeVisitor` for traversing checker `Type` objects (ClassType, FunctionType, etc.), which would be useful for type-level analyses.
    - **Migrate existing passes to visitors**: Convert capture analysis (`captures.ts`) and other AST-traversing code to use the generic visitor infrastructure for consistency and maintainability.

2.  **Type Checker Refactoring**:
    - **`ctx.currentClass` consistency**: Inside a generic class `Foo<T>`, `ctx.currentClass` should have `typeArguments = typeParameters` (i.e., represent `Foo<T>`, not just `Foo`). Currently, `checkThisExpression` creates a type with `typeArguments`, but `ctx.currentClass` doesn't have them, requiring a workaround in `isAssignableTo` to handle self-referential generic class comparisons. Fixing this at the source would eliminate that special case.
    - **Reject index assignment without `operator []=`**: Currently `x[0] = y` compiles even if the type only has `operator []` (getter). The checker should require `operator []=` for index assignment.
    - **Reject assignment to getter-only properties**: Currently `x.length = 5` compiles even if `length` only has a getter. The checker should require a setter for property assignment.

3.  **Host Interop**:
    - **WASM GC Interop Notes**:
      - WASM GC structs and arrays are OPAQUE from JavaScript.
      - JS cannot access struct fields or iterate GC arrays.
      - Use byte streaming (start/byte/end pattern) for string I/O.
      - See `docs/design/host-interop.md` for details.
    - **`@expose` Decorator**: Allow marking class methods as callable from JS hosts.
      - Syntax: `@expose` or `@expose("customName")` on methods.
      - Generates a WASM export wrapper that takes `this` as first parameter.
      - Example: `@expose` on `Suite.run()` exports `Suite.run(self: Suite): i32`.
      - JS usage: `exports['Suite.run'](suiteInstance)`.
      - The inverse of `@external` - exposes Zena methods to hosts instead of importing host functions.

4.  **Data Structures**:
    - **Maps**: Implement map literal syntax (`#{ key: value }`).
    - **Sets**: Implement mutable sets.

5.  **Top-Level Statement Execution**:
    - Currently, top-level expression statements (like `test('name', fn)`) are ignored in codegen.
    - Only global variable initializers run via the WASM start function.
    - This blocks DSL-style test registration. See `docs/design/testing.md` for workaround.
    - **Solution**: Extend the start function to execute top-level statements, or add module initialization support.

6.  **Standard Library**:
    - Math functions (`sqrt`, `abs`, etc.).
    - String manipulation (`substring`, `indexOf`).
    - Regexes.

7.  **Pattern Matching (Advanced)**:
    - Array element matching (requires `FixedArray` support or `Sequence` interface).
    - Rest patterns (`...tail`).

### Long-Term (Self-Hosting Path)

8.  **Self-Hosting**:
    - Rewrite the compiler in Zena.
    - Write new tests as portable tests (in `tests/language/`) when possible.
    - These tests can be run by both the TypeScript compiler and a future Zena compiler.

### Future Features

- **Syntax**:
  - Blocks.
  - JSX-like builder syntax.
- **Type System**:
  - Numeric unit types.
  - Intersection types.
  - Contextual typing for closures: Infer parameter types from context (e.g., `arr.map(x => x * 2)`). Requires parser support for `(a, b) =>` without type annotations, and checker support to propagate expected function type.
- **OOP & Functions**:
  - Extension methods.
  - Operator overloading.
  - `operator is` overloading (zero-cost for non-overriders).
  - `TypeId<T>` intrinsic (compile-time type identifier).
  - Mixin constructors.
  - Async functions.
- **Optimization**:
  - Compile-time constant expressions (string literals, immutable arrays, records/tuples, TemplateStringsArray as WASM constant globals instead of lazy initialization).
- **Standard Library & Runtime**:
  - More operators: exponentiation.
  - Workers.

## Future Considerations

- **Strings**:
  - **Design**: See `docs/design/strings.md` for the full design (including unified
    String architecture with internal implementations like GCString, LinearString).
  - **Multi-Encoding**: Track encoding per string (UTF-8 or UTF-16). Compiler flag
    `--default-encoding` controls literal encoding. UTF-16 enables efficient JS interop.
  - **StringBuilder**: ✅ Done. See `zena:string-builder`.
  - **Interning**: Implement runtime string interning for fast literal equality.
  - **Iterators**: Implement Unicode-aware iteration over code points.
- **Numeric Literals**:
  - **Defaults**: Revisit default types for literals. Consider making `f64` the default for floating-point literals (matching JS).
  - **Suffixes**: Implement syntax for numeric suffixes (e.g., `1L` for `i64`, `1f` for `f32`) to avoid verbose casting (`1 as i64`).

## Technical Debt

### Remaining Checker-Driven Type Instantiation Work

- [ ] `instantiateClass` - still builds `context: Map<string, TypeAnnotation>` for `typeToTypeAnnotation` and `resolveAnnotation`
- [ ] Remove `ClassInfo.typeArguments` (deprecated) and `typeToTypeAnnotation()` helper
- [ ] Remove `ctx.functions` Map - requires identity-based generic function instantiation tracking
- [ ] Remove `ctx.classes` Map entirely - migrate to identity-only registration via `ctx.registerClassInfoByType()`
