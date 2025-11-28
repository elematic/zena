# Zena Compiler Architecture

This document describes the high-level architecture of the Zena compiler.

## Overview

The compiler is implemented in TypeScript and follows a standard pipeline:
`Source Code -> Lexer -> Parser -> AST -> Type Checker -> Code Generator -> WASM Binary`

## Components

### 1. Lexer (`lexer.ts`)

- **Input**: Source string.
- **Output**: Stream of `Token`s.
- **Responsibility**: Tokenizes the input, handling whitespace, comments, and literals.

### 2. Parser (`parser.ts`)

- **Input**: `Token` stream (from Lexer).
- **Output**: Abstract Syntax Tree (AST).
- **Responsibility**: Performs recursive descent parsing to build the AST. It handles operator precedence and syntax validation.

### 3. AST (`ast.ts`)

- Defines the `Node` types and the `NodeType` constants.
- All nodes extend the base `Node` interface.

### 4. Type Checker (`checker.ts`)

- **Input**: AST.
- **Output**: List of errors (if any).
- **Responsibility**:
  - Performs semantic analysis.
  - Resolves symbols (variables, functions, classes).
  - Infers types for variables and expressions.
  - Validates type compatibility (e.g., assignment, function arguments).
  - Populates the symbol table (scopes).

### 5. Code Generator (`codegen/index.ts`)

- **Input**: AST (type-checked).
- **Output**: WASM Binary (`Uint8Array`).
- **Responsibility**:
  - Traverses the AST and emits WASM instructions.
  - Manages WASM locals, globals, and memory.
  - Handles class layout (structs) and vtables.
  - Manages string and array allocations.
  - Uses `emitter.ts` to write the binary format.

### 6. Emitter (`emitter.ts`)

- **Responsibility**: Low-level WASM binary construction.
- Handles encoding of sections (Type, Function, Code, Data, etc.).
- Handles LEB128 encoding.

### 7. WASM Definitions (`wasm.ts`)

- Contains WASM Opcodes, Value Types, and other constants.

## Key Data Structures

- **Program**: The root AST node.
- **Scope**: A mapping of variable names to their types and indices.
- **ClassInfo**: Metadata about a class (struct index, field layout, method table).

## Future Refactoring

The `TypeChecker` class is currently monolithic. Future work involves splitting it into smaller, feature-specific modules.

### 1. Split `TypeChecker`

- Extract a `CheckerContext` class to hold shared state (scopes, diagnostics, etc.).
- Break down logic into smaller modules:
  - `checker/statements.ts`: Statement checking.
  - `checker/expressions.ts`: Expression checking.
  - `checker/types.ts`: Type resolution.

### 2. Standardize Error Handling

- Implement a unified `Diagnostic` system instead of ad-hoc error collection/throwing.

### 3. Intrinsic Types & Symbol Identity

**Problem**: Currently, the compiler identifies built-in types (like `Array`, `String`) by checking their name (e.g., `name === 'Array'`). This is fragile because:
1.  **Shadowing**: A user-defined `class Array` will be mistaken for the built-in array.
2.  **Renaming**: If `Array` is aliased or renamed via imports, the compiler fails to recognize it.

**Solution**:
1.  **Symbol Identity**: The Type Checker should resolve all identifiers to unique `Symbol` objects.
2.  **Intrinsic Registry**: The compiler should maintain a registry of "Intrinsic Symbols" (e.g., `intrinsics.Array`, `intrinsics.String`).
3.  **Robust Checks**: The Code Generator should check `type.symbol === intrinsics.Array` instead of string matching.

## Completed Refactoring

### Split `CodeGenerator`

- Extracted `CodegenContext` class.
- Broken down logic into:
  - `codegen/classes.ts`
  - `codegen/functions.ts`
  - `codegen/statements.ts`
  - `codegen/expressions.ts`
