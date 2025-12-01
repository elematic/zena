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
- **`mapType`**: A function (in `codegen/classes.ts`) that converts a Zena AST type (e.g., `TypeAnnotation`) into a WASM binary type encoding (an array of bytes/numbers).
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
- **Key Function**: `parse(): Program`
- **Responsibility**: Performs recursive descent parsing to build the AST. It handles operator precedence and syntax validation.

### 3. AST (`packages/compiler/src/lib/ast.ts`)

- **Responsibility**: Defines the `Node` types and the `NodeType` constants.
- **Structure**: All nodes extend the base `Node` interface.
- **Key Types**: `Program`, `ClassDeclaration`, `MethodDefinition`, `Expression`, `Statement`.

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
- **`codegen/functions.ts`**: Generates function bodies.
- **`codegen/statements.ts`**: Generates code for statements (if, while, return).
- **`codegen/expressions.ts`**: Generates code for expressions (binary ops, calls).

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

- **Program**: The root AST node.
- **Scope**: A mapping of variable names to their types and indices.
- **ClassInfo**: Metadata about a class (struct index, field layout, method table). Stored in `CodegenContext.classes`.
- **InterfaceInfo**: Metadata about an interface (fat pointer layout, vtable layout). Stored in `CodegenContext.interfaces`.

## Future Refactoring

### Intrinsic Types & Symbol Identity

**Problem**: Currently, the compiler identifies built-in types (like `Array`, `String`) by checking their name (e.g., `name === 'Array'`). This is fragile because:

1.  **Shadowing**: A user-defined `class Array` will be mistaken for the built-in array.
2.  **Renaming**: If `Array` is aliased or renamed via imports, the compiler fails to recognize it.

**Solution**:

1.  **Symbol Identity**: The Type Checker should resolve all identifiers to unique `Symbol` objects.
2.  **Intrinsic Registry**: The compiler should maintain a registry of "Intrinsic Symbols" (e.g., `intrinsics.Array`, `intrinsics.String`).
3.  **Robust Checks**: The Code Generator should check `type.symbol === intrinsics.Array` instead of string matching.
