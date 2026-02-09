# Portable Testing Design

## Status

- **Status**: Proposed
- **Date**: 2026-01-02

## Overview

This document outlines the plan for creating a portable, compiler-agnostic test suite for the Zena language. The goal is to decouple language conformance tests from the specific implementation details of the current TypeScript-based compiler, enabling the development of alternative compilers (including a self-hosted Zena compiler) using the same test corpus.

## Goals

1.  **Portability**: Tests should be runnable by any Zena compiler implementation (TS, Zena, etc.).
2.  **Self-Contained**: Tests should ideally be single files containing both source and expectations, where practical.
3.  **Granularity**: Support testing at different compiler stages: Parsing, Type Checking, and Code Generation/Execution.
4.  **Simplicity**: The format should be easy to read and write.

## Test File Format

All tests will be standard `.zena` source files. Metadata and expectations will be defined using special comment directives.

### Directives

Directives are single-line comments starting with `// @`.

- `// @mode: <mode>`: Specifies the test mode. Options: `parse`, `check`, `run`. (Defaults can be inferred from directory structure).
- `// @target: <target>`: Specifies the parsing target. Options: `module` (default), `statement`, `expression`.
- `// @result: <value>`: Expected return value for execution tests.
- `// @stdout: <string>`: Expected stdout output for execution tests.
- `// @throws: <type>`: Expected exception type. Currently supports `wasm` for WebAssembly.Exception.
- `// @error: <regex>`: Expected compiler error message (for checker tests). Can be placed on the line of the error or at the top.
- `// @requires: <runtime>`: Specifies runtime requirements for the test. Options: `wasmtime`, `wasi`, `node`. Tests with unmet requirements are skipped by the corresponding runner.

### Runtime Requirements

Tests may require specific runtime features not available in all environments:

- **`wasmtime`**: Test requires wasmtime runtime (e.g., for WASI filesystem access)
- **`wasi`**: Test uses WASI interfaces (implies wasmtime or jco)
- **`node`**: Test requires Node.js runtime (default for most tests)

Tests with `@requires: wasmtime` are run via `npm run test:wasmtime -w @zena-lang/stdlib` using wasmtime.
Tests without this directive are run via `npm test` using Node.js.

### Suite Metadata

Test folders can contain a `test-suite.json` file to provide metadata and expected test counts:

```json
{
  "name": "Array",
  "description": "Tests for the Array stdlib class",
  "expected": {
    "pass": 8,
    "fail": 0,
    "skip": 0
  }
}
```

Fields:

- `name`: Display name for the suite (shown in test output).
- `description`: Optional description of the test suite.
- `expected`: Expected test counts. If provided, a validation test runs after all tests to verify counts match.
  - `pass`: Number of tests expected to pass.
  - `fail`: Number of tests expected to fail (useful for tracking known issues).
  - `skip`: Number of tests expected to be skipped.

## Test Categories

### 1. Syntax Tests (Parser)

**Goal**: Verify that the source code is parsed into the correct Abstract Syntax Tree (AST).

**Format**:

- Source: `tests/language/syntax/*.zena`
- Expectation: `tests/language/syntax/*.ast.json`

Since ASTs are large and complex, it is impractical to embed them in the source file. Instead, we will use a **snapshot testing** approach.

- The test runner parses the `.zena` file.
- It serializes the AST to a canonical JSON format.
- It compares the result against a corresponding `.ast.json` file.
- If the `.ast.json` file is missing, it is generated.

**Portable AST Format**:
To ensure portability, we need a simplified, canonical JSON representation of the AST that abstracts away implementation-specific details (like specific node class names if they differ, though ideally they shouldn't).

**Example**:
`tests/language/syntax/assignment.zena`:

```zena
// @target: statement
x = 1;
```

`tests/language/syntax/assignment.ast.json`:

```json
{
  "type": "ExpressionStatement",
  "expression": {
    "type": "AssignmentExpression",
    "left": {"type": "Identifier", "name": "x"},
    "right": {"type": "NumberLiteral", "value": 1}
  }
}
```

### 2. Semantic Tests (Checker)

**Goal**: Verify that the type checker accepts valid code and rejects invalid code with the correct errors.

**Format**:

- Source: `tests/language/semantics/*.zena`
- Expectations: Embedded `// @error` comments.

**Positive Tests**:
Code that should compile without errors.

```zena
// @mode: check
let x: i32 = 10;
```

**Negative Tests**:
Code that should produce specific errors. The `// @error` directive asserts that an error occurs on the **preceding line** (or same line).

```zena
// @mode: check
let x: i32 = "hello"; // @error: Type mismatch.*i32.*string
```

Or for multiple errors:

```zena
// @mode: check
unknown_func();
// @error: Unknown identifier 'unknown_func'
```

### 3. Execution Tests (Codegen)

**Goal**: Verify that the compiled code executes correctly and produces the expected runtime behavior.

**Format**:

- Source: `tests/language/execution/*.zena`
- Expectations: `// @result` or `// @stdout` directives.

**Simple Value Tests**:
The test runner wraps the code (if it's a fragment) or calls the `main` function and checks the return value.

```zena
// @mode: run
// @result: 42
export let main = () => 40 + 2;
```

**Stdout Tests**:
For tests that print to the console.

```zena
// @mode: run
// @stdout: Hello\nWorld
import { console } from 'zena:console';
export let main = () => {
  console.log("Hello");
  console.log("World");
};
```

**Fragment Support**:
For simple expression tests, we can avoid the boilerplate of `export let main ...`.

```zena
// @mode: run
// @target: expression
// @result: 10
5 * 2
```

The test runner will wrap this in a `main` function automatically.

## Directory Structure

```
tests/                       # Language tests (in repo root)
  language/
    syntax/                  # Parser tests (.zena + .ast.json)
      basic/
      classes/
    semantics/               # Checker tests (.zena with @error)
      types/
      control-flow/
    execution/               # Codegen tests (.zena with @result)
      arithmetic/
      functions/

packages/stdlib/tests/       # Standard library tests (with stdlib package)
  array/                     # Array class tests + test-suite.json
  map/                       # Map class tests + test-suite.json
  fs/                        # Filesystem tests (@requires: wasmtime)
  hello_test.zena            # Basic WASI smoke test (@requires: wasmtime)
  memory_test.zena           # Linear memory tests (@requires: wasmtime)
  out/                       # Compiled .wasm files (gitignored)

packages/stdlib/scripts/     # Build and test runner scripts
  build-wasi-tests.js        # Compiles tests with @requires:wasmtime to .wasm
  run-wasmtime.js            # Runs .wasm tests with wasmtime
```

## Running Tests

### Node.js Tests (Default)

```bash
npm test                    # Run all Node.js tests
npm test -w @zena-lang/cli  # Run CLI package tests
```

### WASI Tests (wasmtime)

WASI tests require features that Node.js doesn't provide (filesystem, etc.).
These are run via wasmtime using the Nix development environment:

```bash
npm run test:wasmtime -w @zena-lang/stdlib    # Build and run all WASI tests
```

The tests are built using Wireit, which caches the `.wasm` files and only
rebuilds when source files change. This makes subsequent runs very fast.

**Note**: wasmtime tests require the Nix environment (`direnv allow` or `nix develop`).

### Building WASI Tests Manually

```bash
npm run build:wasi-tests -w @zena-lang/stdlib   # Build WASI tests to .wasm
```

### Writing WASI Tests

WASI tests must export a `main` function that returns the number of failed tests:

```zena
// @requires: wasmtime
import {suite, test, TestContext} from 'zena:test';
import {equal} from 'zena:assert';

let tests = suite('My WASI Tests', (): void => {
  test('example', (ctx: TestContext): void => {
    equal(1, 1);
  });
});

// Entry point - returns number of failed tests (0 = success)
export let main = (): i32 => {
  let result = tests.run();
  return result.failed;
};
```

## Test Runner Implementation

The portable test runner is implemented in `packages/compiler/src/test/portable-runner.ts`.

**Responsibilities**:

1.  **Discovery**: Walk `tests/` and `packages/stdlib/tests/` directories.
2.  **Filtering**: Skip tests with `@requires: wasmtime` (those run separately via wasmtime).
3.  **Parsing**: Read `.zena` files and parse directives.
4.  **Suite Metadata**: Load `test-suite.json` files for folder metadata.
5.  **Execution**:
    - **Parse Mode**: Call Compiler Parser -> Serialize AST -> Compare with JSON.
    - **Check Mode**: Call Compiler Checker -> Collect Diagnostics -> Match against `@error` regexes.
    - **Run Mode**: Call Compiler Codegen -> Instantiate WASM -> Run `main` -> Compare result/stdout/throws.
6.  **Validation**: Verify test counts match suite expectations.
7.  **Reporting**: Output pass/fail statistics.

## Migration Plan

1.  **Create Runner**: Implement the basic `scripts/test-runner.ts`. ✅
2.  **Port Parser Tests**: Convert a subset of `packages/compiler/src/test/parser/` to `tests/language/syntax/`.
3.  **Port Checker Tests**: Convert `packages/compiler/src/test/checker/` to `tests/language/semantics/`.
4.  **Port Codegen Tests**: Convert `packages/compiler/src/test/codegen/` to `tests/language/execution/`.
5.  **Port Stdlib Tests**: Convert `packages/compiler/src/test/stdlib/` to `tests/language/stdlib/`. ✅ (In Progress)
6.  **CI Integration**: Add the new runner to `npm test`. ✅

## Future Considerations

- **WASI**: As the language adopts WASI, execution tests should run in a WASI environment.
- **Self-Hosting**: Once the Zena compiler is self-hosted, it should be able to run this test suite against itself.
