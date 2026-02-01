# Zena Compiler Architecture

This document describes the high-level architecture of the Zena compiler. It is designed to help developers and LLMs navigate the codebase and understand the core concepts.

## Overview

The compiler is implemented in TypeScript and follows a standard pipeline:
`Source Code -> Lexer -> Parser -> AST -> Type Checker -> Code Generator -> WASM Binary`

The goal is to produce a valid WebAssembly (WASM-GC) binary from Zena source code. The compiler is designed to be modular, with clear separation between parsing, semantic analysis, and code generation.

## Key Concepts & Terminology

Understanding these terms is crucial for working on the compiler:

- **WASM-GC**: The target architecture. Unlike linear-memory WASM (C/C++/Rust), Zena uses the Garbage Collection proposal (structs, arrays) to manage memory.
- **Type Index**: An integer representing a type in the WASM binary's Type Section. All functions, structs, and arrays in WASM refer to types by their index.
- **`ValType`**: WASM Value Types (e.g., `i32`, `f64`, `ref`, `ref_null`). Defined in `packages/compiler/src/lib/wasm.ts`.
- **`HeapType`**: WASM Heap Types for GC objects (e.g., `struct`, `array`, `func`, `any`, `eq`). Defined in `packages/compiler/src/lib/wasm.ts`.
- **`CodegenContext`**: The central state object during code generation. It holds the `WasmModule` being built, symbol tables, and type maps.
- **`mapCheckerTypeToWasmType`**: A function (in `codegen/classes.ts`) that converts a checker `Type` object into WASM bytes. This is the **identity-based** path used for all type resolution.
- **VTable**: A table of function references used for dynamic dispatch (method overriding). In Zena, this is implemented as a WASM struct containing `ref func` fields.
- **Fat Pointer**: Interfaces in Zena are implemented as "fat pointers": a struct containing the object instance (`ref any`) and its VTable (`ref vtable`).

## Components

### 1. Lexer (`packages/compiler/src/lib/lexer.ts`)

- **Input**: Source string.
- **Output**: Stream of `Token`s.
- **Key Function**: `tokenize(source: string): Token[]`
- **Responsibility**: Tokenizes the input, handling whitespace, comments, and literals.

### 2. Parser (`packages/compiler/src/lib/parser.ts`)

- **Input**: `Token` stream (from Lexer).
- **Output**: Abstract Syntax Tree (AST).
- **Key Class**: `Parser`
- **Key Function**: `parse(): Module`
- **Responsibility**: Performs recursive descent parsing to build the AST. It handles operator precedence and syntax validation.

### 3. AST (`packages/compiler/src/lib/ast.ts`)

- **Responsibility**: Defines the `Node` types and the `NodeType` constants.
- **Structure**: All nodes extend the base `Node` interface.
- **Key Types**: `Module`, `ClassDeclaration`, `MethodDefinition`, `Expression`, `Statement`.

### 4. Type Checker (`packages/compiler/src/lib/checker/index.ts`)

- **Input**: AST.
- **Output**: List of errors (if any) and a populated `CheckerContext`.
- **Key Class**: `TypeChecker`
- **Key Context**: `CheckerContext` (`packages/compiler/src/lib/checker/context.ts`)
- **Responsibility**:
  - **Semantic Analysis**: Validates that the program makes sense (e.g., variables are defined before use).
  - **Type Inference**: Determines types for variables and expressions (e.g., `let x = 1` infers `i32`).
  - **Symbol Resolution**: Resolves identifiers to their definitions using scopes.
  - **Type Compatibility**: Checks if types match (e.g., passing `i32` to a function expecting `string`).
  - **Generic Instantiation**: Creates specialized types for generic classes (e.g., `Box<i32>` from `Box<T>`), including proper substitution of `superType` and `onType`.
- **Key Methods** (for codegen integration):
  - `resolveFieldTypes(classType)`: Returns resolved field types for an instantiated generic class.
  - `substituteTypeParams(type, typeMap)`: Substitutes type parameters using an explicit map. The canonical method for type parameter substitution.
  - `buildTypeMap(classType)`: Builds a substitution map from an instantiated class type.
  - `buildFunctionTypeMap(funcType)`: Builds a substitution map from an instantiated function type.
  - `resolveTypeInContext(type, context)`: _(Deprecated)_ Convenience wrapper for `substituteTypeParams(type, buildTypeMap(context))`.
- **Backend-Independent Semantic Analysis** (for multi-backend support):
  - `analyzeBoxing(sourceType, targetType)`: Returns a `BoxingKind` describing what boxing transformation is needed (none, primitive-box, or interface-box).
  - `analyzeMethodDispatch(classType, methodName)`: Returns a `MethodDispatchKind` describing how to dispatch a method call (static, virtual, or interface).
  - `analyzeArgumentAdaptation(argType, paramType)`: Returns an `ArgumentAdaptationKind` describing what transformation is needed for an argument (none, box-primitive, box-interface, or wrap-closure).
  - `findInterfaceImplementation(classType, interfaceType)`: Finds which interface a class implements that satisfies the target interface, handling inheritance.
  - `isInterfaceAssignableTo(sub, sup)`: Checks if one interface is assignable to another, handling generic interface bases.
  - `isPrimitive(type)`: Checks if a type is a primitive numeric or boolean type.

### 5. Code Generator (`packages/compiler/src/lib/codegen/index.ts`)

- **Input**: AST (type-checked).
- **Output**: WASM Binary (`Uint8Array`).
- **Key Class**: `CodeGenerator`
- **Key Context**: `CodegenContext` (`packages/compiler/src/lib/codegen/context.ts`)
- **Responsibility**:
  - Traverses the AST and emits WASM instructions.
  - Manages WASM locals, globals, and memory.
  - Handles class layout (structs) and vtables.
  - Manages string and array allocations.
  - Uses `emitter.ts` to write the binary format.

#### Sub-modules of Codegen:

- **`codegen/classes.ts`**: Handles class/struct layout, method tables, and interface VTables.
  - `registerClassStruct`: Defines the WASM struct type for a class.
  - `registerClassMethods`: Generates the functions for class methods.
  - **Trampolines**: Generates bridge functions (`generateTrampoline`) for interface methods. These handle:
    - Casting `this` from `anyref` (interface view) to the concrete class type.
    - Unboxing arguments (e.g., `anyref` -> `i32`).
    - Calling the actual class method.
    - Boxing the return value (e.g., `i32` -> `anyref`).
- **`codegen/functions.ts`**: Generates function bodies.
- **`codegen/statements.ts`**: Generates code for statements (if, while, return).
- **`codegen/expressions.ts`**: Generates code for expressions (binary ops, calls).
  - **Adaptation**: Handles argument adaptation during function calls:
    - **Arity Adaptation**: Drops extra arguments if the target function expects fewer than provided (e.g., in callbacks).
    - **Boxing/Unboxing**: Automatically boxes primitives to `anyref` and unboxes them when required by the target signature (e.g., generic methods).
    - **Interface Boxing**: Wraps class instances in interface "fat pointers" when passing to a function expecting an interface.

### 6. Emitter (`packages/compiler/src/lib/emitter.ts`)

- **Key Class**: `WasmModule`
- **Responsibility**: Low-level WASM binary construction.
- **Details**: Handles encoding of sections (Type, Function, Code, Data, etc.) and LEB128 encoding.

### 7. WASM Definitions (`packages/compiler/src/lib/wasm.ts`)

- **Responsibility**: Contains WASM Opcodes, Value Types, and other constants.
- **Key Objects**: `Opcode`, `GcOpcode`, `ValType`, `HeapType`.

### 8. Intrinsics

The compiler supports intrinsics to map Zena methods directly to WASM instructions.

- **Declaration**: Methods are marked with the `@intrinsic("op_name")` decorator.
- **Processing**:
  - **Parser**: Parses the decorator.
  - **Checker**: Validates the decorator usage.
  - **Codegen**: Emits specific WASM opcodes instead of a function call.

### 9. AST Visitor (`packages/compiler/src/lib/visitor.ts`)

- **Key Type**: `Visitor<T>`
- **Key Function**: `visit(node, visitor, context)`
- **Responsibility**: Provides a generic, reusable infrastructure for traversing AST nodes.
- **Pattern**: Pre-order traversal with optional callbacks per node type.
- **Usage**: The visitor is used by the usage analysis pass and can be reused for other AST-based analyses.

Example usage:

```typescript
const visitor: Visitor<MyContext> = {
  visitCallExpression: (node, ctx) => {
    // Process call expression
    return true; // Continue visiting children
  },
};
visit(ast, visitor, myContext);
```

**Note for future agents**: When adding new AST node types, always add corresponding visit methods to `visitor.ts` to ensure DCE and other analyses cover them.

### 10. Usage Analysis (`packages/compiler/src/lib/analysis/usage.ts`)

- **Key Function**: `analyzeUsage(program, options): UsageAnalysisResult`
- **Key Interface**: `UsageAnalysisResult` with `isUsed(decl)`, `getUsage()`, `isModuleUsed(path)`
- **Responsibility**: Determines which declarations are reachable from entry point exports.
- **Algorithm**: Starts from exported declarations and recursively marks reachable declarations via the AST visitor.
- **Integration**: Called by `CodeGenerator` when DCE is enabled.

### 11. Dead Code Elimination (DCE)

The compiler implements aggressive DCE at multiple levels:

- **Declaration-level**: Unused functions, classes, and interfaces are not generated.
- **Type-level**: WASM types for intrinsic methods/fields are not created if unused.
- **VTable-level**: Extension classes with empty vtables skip vtable creation entirely.

**Binary size optimization** is a key design goal for Zena. The DCE system ensures that:

- Standard library components (like `Map`) are only included if actually used.
- Intrinsic operations (like `String.length`) don't generate function definitions.
- Minimal programs can be as small as 41 bytes.

## Type Flow Architecture

The compiler propagates type information from the checker to codegen via `inferredType` properties on AST nodes. Understanding this flow is essential for maintaining the checker-as-single-source-of-truth principle.

### How Types Are Set

| AST Node Category    | How `inferredType` is set                                                                     | Example                              |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Expressions**      | `checkExpression()` wrapper sets `expr.inferredType = type` after `checkExpressionInternal()` | `BinaryExpression`, `CallExpression` |
| **Type Annotations** | `resolveTypeAnnotation()` sets `annotation.inferredType = result`                             | Function params, field types         |
| **Declarations**     | Set explicitly in `checkClassDeclaration()`, `checkFunctionDeclaration()`, etc.               | `ClassDeclaration.inferredType`      |

### Expression Types (Comprehensive Coverage)

All expressions go through `checkExpression()` in `checker/expressions.ts`:

```typescript
export function checkExpression(ctx: CheckerContext, expr: Expression): Type {
  const type = checkExpressionInternal(ctx, expr);
  expr.inferredType = type; // Always set
  return type;
}
```

This ensures **every expression** has an `inferredType`. Codegen relies on this:

```typescript
// In codegen/expressions.ts
export function inferType(ctx: CodegenContext, expr: Expression): number[] {
  // 1. Check context for 'this', locals (WASM types may differ from AST types)
  // 2. Fall back to checker's type
  if (expr.inferredType) {
    return mapCheckerTypeToWasmType(ctx, expr.inferredType);
  }
  throw new Error(
    `Type inference failed: Node ${expr.type} has no inferred type.`,
  );
}
```

### Type Annotation Types

Type annotations (e.g., `x: i32`, `fn(a: string): void`) get their `inferredType` set by `resolveTypeAnnotation()` in `checker/types.ts`. This converts the syntactic annotation to a semantic `Type` object.

Tests for annotation coverage are in `test/checker/inferred-type_test.ts`.

### Why This Matters for Codegen

**Goal**: Codegen should never re-infer types. The checker is the single source of truth.

**Current state**:

- Expressions: ✅ Always use `expr.inferredType`
- Annotations: ✅ Use `annotation.inferredType` via `mapCheckerTypeToWasmType`
- Generic instantiation: ✅ Uses checker-based types via `mapCheckerTypeToWasmType`

**Benefits**: All type resolution in codegen goes through checker types, enabling:

- Intellisense (hover shows resolved types like `i32`, not `T`)
- Compiler API (query assignability of instantiated types)
- Multiple backends sharing semantic model
- Incremental compilation

## Navigation Guide for LLMs

When asked to modify the compiler, look in these files first:

- **Adding Syntax**:
  1.  `packages/compiler/src/lib/ast.ts` (Add Node type)
  2.  `packages/compiler/src/lib/parser.ts` (Parse the syntax)
  3.  `packages/compiler/src/lib/checker/` (Check semantics)
  4.  `packages/compiler/src/lib/codegen/` (Generate WASM)

- **Modifying Type System**:
  - `packages/compiler/src/lib/checker/types.ts` (Type definitions)
  - `packages/compiler/src/lib/checker/expressions.ts` (Expression typing)

- **Modifying Code Generation**:
  - `packages/compiler/src/lib/codegen/context.ts` (State/Context)
  - `packages/compiler/src/lib/codegen/classes.ts` (Class/Struct layout)
  - `packages/compiler/src/lib/codegen/expressions.ts` (Opcode generation)

- **WASM Opcodes**:
  - `packages/compiler/src/lib/wasm.ts`

## Key Data Structures

- **Module**: The AST node for a single source file. Contains both the syntax tree (`body`) and compilation metadata (`path`, `isStdlib`, `source`, `imports`, `exports`, `diagnostics`). All metadata fields are set at parse time via `ParserOptions`.
- **Program**: A compiler-created container (not an AST node) holding all modules in a compilation unit, plus the entry point and prelude modules.
- **Scope**: A mapping of variable names to their types and indices.
- **ClassInfo**: Metadata about a class (struct index, field layout, method table). Stored in `CodegenContext.classes` and looked up via `CodegenContext.getClassInfoByCheckerType()`.
- **InterfaceInfo**: Metadata about an interface (fat pointer layout, vtable layout). Looked up via `CodegenContext.getInterfaceInfoByCheckerType()` or `CodegenContext.getInterfaceInfoByStructIndex()`.

## Debugging Tips

- **Type Registration Logging**: When debugging WASM validation errors (e.g., `expected type (ref null 123), found ...`), it is helpful to log the registration of types in `codegen/classes.ts`.
  - Add `console.log` in `registerClassStruct` and `registerInterface` to print the Class/Interface name and its assigned `structTypeIndex`.
  - This allows you to map the numeric Type Index in the error message back to the Zena type name.

## Future Refactoring

### Intrinsic Types & Symbol Identity

**Problem**: Currently, the compiler identifies built-in types (like `Array`, `String`) by checking their name (e.g., `name === 'Array'`). This is fragile because:

1.  **Shadowing**: A user-defined `class Array` will be mistaken for the built-in array.
2.  **Renaming**: If `Array` is aliased or renamed via imports, the compiler fails to recognize it.

**Solution**:

1.  **Symbol Identity**: The Type Checker should resolve all identifiers to unique `Symbol` objects.
2.  **Intrinsic Registry**: The compiler should maintain a registry of "Intrinsic Symbols" (e.g., `intrinsics.Array`, `intrinsics.String`).
3.  **Robust Checks**: The Code Generator should check `type.symbol === intrinsics.Array` instead of string matching.
