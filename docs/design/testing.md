# Testing Standard Library Design

## Status

- **Status**: In Progress (Phase 3 Complete)
- **Date**: 2026-01-01

## Overview

This document describes the design for `zena:test` and `zena:assert` standard
library modules, modeled after Node.js's `node:test` and `node:assert`. These
modules will enable writing tests directly in Zena, which is essential for:

1. **Self-hosting**: Testing the Zena compiler written in Zena
2. **Library development**: Testing Zena libraries
3. **Application testing**: Unit and integration tests for Zena applications

## Goals

1. **Familiar API**: Mirror Node.js's `node:test` and `node:assert` APIs for
   familiarity
2. **Static Typing**: Leverage Zena's type system for type-safe assertions
3. **Zero-Cost Abstractions**: Assertions should compile to minimal WASM code
4. **Clear Error Messages**: Provide helpful failure messages with expected vs
   actual values
5. **Minimal Dependencies**: Keep the test framework self-contained within stdlib

## Non-Goals

1. **Test discovery**: Initially, tests must be explicitly run (no automatic
   file scanning)
2. **Async testing**: Deferred until async/await is implemented in Zena
3. **Mocking/Spying**: Out of scope for MVP
4. **Code coverage**: Out of scope for MVP

---

## Test Execution Modes

Until Zena has native I/O capabilities (via WASI or similar), test execution is
orchestrated by Node.js. There are two primary modes:

### Mode 1: Inline Zena in Node Tests

For compiler codegen tests and quick validation, embed Zena code directly in
Node test files:

```typescript
// packages/compiler/src/test/stdlib/math_test.ts
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from '../codegen/utils.js';

suite('Math stdlib', () => {
  test('abs returns positive value', async () => {
    const result = await compileAndRun(`
      import { equal } from 'zena:assert';
      import { abs } from 'zena:math';

      export let main = (): i32 => {
        equal(abs(-5), 5);
        equal(abs(5), 5);
        return 1;  // success sentinel
      };
    `);
    assert.strictEqual(result, 1);
  });
});
```

**Characteristics**:

- Zena assertions (`equal`, `throws`, etc.) run inside WASM
- Better error messages without serializing values to JS
- Node just checks for successful completion (return value or no exception)
- Good for: unit tests, codegen validation, quick iteration

### Mode 2: Standalone Zena Test Files

For larger test suites (stdlib, self-hosted compiler), write tests in `.zena`
files. However, note the **current limitation**: Zena does not execute top-level
expression statements. This means the common DSL pattern won't work:

```zena
// THIS WON'T WORK - top-level calls are not executed
import { suite, test } from 'zena:test';

suite('Array', () => {  // <-- This call is ignored!
  test('push', (ctx) => { ... });
});
```

**Workaround**: Use explicit registration functions that get called by the host:

```zena
// packages/compiler/stdlib-tests/array_test.zena
import { suite, test, getRootSuite, TestContext, Suite } from 'zena:test';
import { equal, throws } from 'zena:assert';
import { Array } from 'zena:array';

// Register tests in an exported function
export let registerTests = (): void => {
  suite('Array', (): void => {
    test('push increases length', (ctx: TestContext): void => {
      let arr = new Array<i32>();
      equal(arr.length, 0);
      arr.push(1);
      equal(arr.length, 1);
    });

    test('pop returns last element', (ctx: TestContext): void => {
      let arr = new Array<i32>();
      arr.push(10);
      arr.push(20);
      equal(arr.pop(), 20);
    });
  });
};

// Return root suite for external runner
export let getRoot = (): Suite => getRootSuite();
```

The Node test runner calls `registerTests()` first, then inspects the suite:

```typescript
// packages/compiler/src/test/stdlib-runner.ts
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './codegen/utils.js';

suite('Array tests', async () => {
  const {exports} = await compileAndInstantiate(source);

  // Register tests first
  exports.registerTests();

  // Then get the suite structure
  const rootSuite = exports.getRoot();
  // ... run tests from suite
});
```

**Future**: Once Zena supports top-level statement execution (via a module
initialization function or start function enhancement), the DSL pattern will
work directly.

**Characteristics**:

- Tests are pure Zena code
- Node handles file discovery and process orchestration
- Test results reported back to Node (via exports or return value)
- Good for: stdlib tests, integration tests, self-hosting tests

### Future: Native Zena Test Runner

Once Zena has WASI file I/O and console output, we can implement a fully native
test runner:

```zena
// Run tests directly in Zena
import { run } from 'zena:test';

let results = run();
// Output results, exit with appropriate code
```

This is deferred until WASI interfaces are more complete.

---

## Future Direction: Macro-Based Assert

The current API uses separate functions for each operator (`equal`, `notEqual`,
`same`, etc.). Once Zena has declarative macros (see `docs/design/macros.md`),
this can be simplified to a single `assert` macro:

```zena
// Instead of:
equal(foo, bar);
notEqual(a, b);
same(x, y);

// Write:
assert(foo == bar);
assert(a != b);
assert(x === y);
```

The macro would introspect the AST at compile time and generate rich error
messages including the source expression, operator, and actual values:

```
AssertionError: Assertion failed: foo == bar
  left:  42
  right: 43
  operator: ==
```

This is planned for after the macro system is implemented. The current
function-based API serves as a working MVP.

---

## API Design

### Module: `zena:assert`

The assertion module provides functions for making test assertions. All
assertion functions throw `AssertionError` on failure.

**Note**: Unlike Node.js's `assert.ok()`, Zena does not have a truthiness-based
assertion because Zena has no implicit type coercion. Use `isTrue()` instead.

```zena
// zena:assert

export class AssertionError extends Error {
  operator: string;

  #new(message: string, operator: string) {
    super(message);
    this.operator = operator;
  }
}

// Core assertions
export let equal: <T>(actual: T, expected: T, message?: string) => void;
export let notEqual: <T>(actual: T, expected: T, message?: string) => void;

// Reference equality (===)
export let same: <T>(actual: T, expected: T, message?: string) => void;
export let notSame: <T>(actual: T, expected: T, message?: string) => void;

// Comparison assertions
export let greater: <T>(actual: T, expected: T, message?: string) => void;
export let greaterOrEqual: <T>(actual: T, expected: T, message?: string) => void;
export let less: <T>(actual: T, expected: T, message?: string) => void;
export let lessOrEqual: <T>(actual: T, expected: T, message?: string) => void;

// Null/boolean assertions
export let isNull: <T>(value: T | null, message?: string) => void;
export let isNotNull: <T>(value: T | null, message?: string) => void;
export let isTrue: (value: boolean, message?: string) => void;
export let isFalse: (value: boolean, message?: string) => void;

// Type assertions
export let isInstanceOf: <T>(value: any, type: T, message?: string) => void;

// Exception assertions
export let throws: (fn: () => void, message?: string) => void;
export let doesNotThrow: (fn: () => void, message?: string) => void;

// Unconditional failure
export let fail: (message?: string) => never;
```

#### Assertion Semantics

| Function         | Comparison Used   | Description                           |
| ---------------- | ----------------- | ------------------------------------- |
| `equal`          | `==` (operator)   | Structural equality via `operator ==` |
| `notEqual`       | `!=` (operator)   | Structural inequality                 |
| `same`           | `===` (reference) | Reference equality                    |
| `notSame`        | `!==` (reference) | Reference inequality                  |
| `isTrue`         | `=== true`        | Value is exactly `true`               |
| `isFalse`        | `=== false`       | Value is exactly `false`              |
| `isNull`         | `=== null`        | Value is `null`                       |
| `isNotNull`      | `!== null`        | Value is not `null`                   |
| `greater`        | `>`               | actual > expected                     |
| `less`           | `<`               | actual < expected                     |
| `greaterOrEqual` | `>=`              | actual >= expected                    |
| `lessOrEqual`    | `<=`              | actual <= expected                    |

**Note**: In Zena, `==` is structural equality (uses `operator ==` if defined),
while `===` is reference equality. This differs from JavaScript where `===` is
strict equality. Our API reflects Zena's semantics.

**Note**: There is no `ok()` assertion because Zena has no concept of
"truthiness" - values don't coerce to booleans. Use `isTrue()` for boolean
checks.

### Module: `zena:test`

The test module provides the test runner and organization functions.

```zena
// zena:test

export class TestContext {
  name: string;
  #new(name: string) {
    this.name = name;
  }

  // Diagnostic output during test
  diagnostic(message: string): void;
}

// Test result tracking
export class TestResult {
  name: string;
  passed: boolean;
  error: Error | null;
  duration: i32;  // milliseconds (when we have timing)

  #new(name: string, passed: boolean, error: Error | null) {
    this.name = name;
    this.passed = passed;
    this.error = error;
  }
}

export class SuiteResult {
  name: string;
  tests: Array<TestResult>;
  passed: i32;
  failed: i32;

  #new(name: string) {
    this.name = name;
    this.tests = new Array<TestResult>();
    this.passed = 0;
    this.failed = 0;
  }
}

// Test registration and execution
export let test: (name: string, fn: (ctx: TestContext) => void) => void;
export let suite: (name: string, fn: () => void) => void;

// Skip/only modifiers (for test isolation)
export let skip: (name: string, fn: (ctx: TestContext) => void) => void;
export let only: (name: string, fn: (ctx: TestContext) => void) => void;

// Lifecycle hooks
export let beforeEach: (fn: () => void) => void;
export let afterEach: (fn: () => void) => void;
export let beforeAll: (fn: () => void) => void;
export let afterAll: (fn: () => void) => void;

// Run all registered tests and return results
export let run: () => SuiteResult;

// Alternative: Get the global test runner
export let getRunner: () => TestRunner;
```

### Usage Example

```zena
import { suite, test, beforeEach, run } from 'zena:test';
import { equal, ok, throws } from 'zena:assert';

suite('Math operations', () => {
  test('addition', (ctx: TestContext) => {
    equal(1 + 1, 2);
    equal(0 + 0, 0);
  });

  test('subtraction', (ctx: TestContext) => {
    equal(5 - 3, 2);
  });
});

suite('String operations', () => {
  test('concatenation', (ctx: TestContext) => {
    let s = 'hello' + ' ' + 'world';
    equal(s, 'hello world');
  });

  test('length', (ctx: TestContext) => {
    ok('hello'.length == 5);
  });
});

suite('Error handling', () => {
  test('throws on invalid input', (ctx: TestContext) => {
    throws(() => {
      throw new Error('expected error');
    });
  });
});

// Run and get results
let results = run();
console.log(`Passed: ${results.passed}, Failed: ${results.failed}`);
```

---

## Implementation Plan

### Phase 1: AssertionError and Basic Assertions ✅ COMPLETE

**Prerequisites**:

- `throw` expression (✅ Done)
- String concatenation (✅ Done)
- Generic functions (✅ Done)

**Status**: ✅ Completed 2025-12-31

**Implemented**:

- `packages/stdlib/zena/assert.zena` created
- `AssertionError` class extending `Error`
- Core assertions:
  - `ok(value: boolean, message?: string): void`
  - `equal<T>(actual: T, expected: T, message?: string): void`
  - `notEqual<T>(actual: T, expected: T, message?: string): void`
  - `strictEqual<T>` (alias for `equal`)
  - `notStrictEqual<T>` (alias for `notEqual`)
  - `fail(message?: string): never`
- Extended assertions (from Phase 2):
  - `same<T>(actual: T, expected: T, message?: string): void` (reference equality)
  - `notSame<T>(actual: T, expected: T, message?: string): void`
  - `isNull<T>(value: T | null, message?: string): void`
  - `isNotNull<T>(value: T | null, message?: string): void`
  - `isTrue(value: boolean, message?: string): void`
  - `isFalse(value: boolean, message?: string): void`
- Test file: `packages/compiler/src/test/stdlib/assert_test.ts`

**Note**: The `AssertionError` class currently only stores `message` and `operator`,
not `actual`/`expected` values. This is because we don't have an `any` type or
boxing mechanism for arbitrary values yet.

**Original Tasks**:

1. ~~Create `packages/stdlib/zena/assert.zena`~~
2. ~~Implement `AssertionError` class extending `Error`~~
3. ~~Implement core assertions:~~
   - ~~`ok(value: boolean, message?: string)`~~
   - ~~`equal<T>(actual: T, expected: T, message?: string)`~~
   - ~~`notEqual<T>(actual: T, expected: T, message?: string)`~~
   - ~~`fail(message?: string): never`~~
   - `fail(message?: string): never`

**Implementation Notes**:

```zena
// assert.zena
import { Error } from 'zena:error';

export class AssertionError extends Error {
  actual: any;
  expected: any;
  operator: string;

  #new(message: string, actual: any, expected: any, operator: string) {
    super(message);
    this.actual = actual;
    this.expected = expected;
    this.operator = operator;
  }
}

export let ok = (value: boolean, message: string = 'Expected truthy value') => {
  if (!value) {
    throw new AssertionError(message, value as any, true as any, 'ok');
  }
};

export let equal = <T>(actual: T, expected: T, message: string = 'Values not equal') => {
  if (actual != expected) {
    throw new AssertionError(message, actual as any, expected as any, '==');
  }
};

export let fail = (message: string = 'Test failed'): never => {
  throw new AssertionError(message, null, null, 'fail');
};
```

### Phase 2: Extended Assertions ✅ COMPLETE

**Status**: Completed 2025-12-31

**Implemented**:

- `isNull<T>(value: T | null, message?: string)` ✅
- `isNotNull<T>(value: T | null, message?: string)` ✅
- `isTrue(value: boolean, message?: string)` ✅
- `isFalse(value: boolean, message?: string)` ✅
- `same<T>(actual: T, expected: T, message?: string)` ✅ (reference equality)
- `notSame<T>(actual: T, expected: T, message?: string)` ✅
- `greater<T>(actual: T, expected: T, message?: string)` ✅
- `greaterOrEqual<T>(actual: T, expected: T, message?: string)` ✅
- `less<T>(actual: T, expected: T, message?: string)` ✅
- `lessOrEqual<T>(actual: T, expected: T, message?: string)` ✅

### Phase 3: Exception Assertions ✅ COMPLETE

**Status**: Completed 2025-12-31

**Implemented**:

- `throws(fn: () => void, message?: string)` ✅
- `doesNotThrow(fn: () => void, message?: string)` ✅

**Implementation Notes**:

Since `try`/`catch` is an expression in Zena (not a statement), exception assertions
use the expression form to capture whether an exception was thrown:

```zena
export let throws = (fn: () => void, message: string = 'Expected function to throw'): void => {
  let threw = try {
    fn();
    false
  } catch (e) {
    true
  };
  if (!threw) {
    throw new AssertionError(message, 'throws');
  }
};
```

### Phase 4: Test Runner Foundation

**Prerequisites**:

- Closures (✅ Done)
- `Array<T>` (✅ Done)

**Tasks**:

1. Create `packages/stdlib/zena/test.zena`
2. Implement `TestContext` and `TestResult` classes
3. Implement global test registry (module-level state)
4. Implement `test(name, fn)` function

**Implementation Notes**:

```zena
// test.zena
import { AssertionError } from 'zena:assert';
import { Array } from 'zena:array';
import { console } from 'zena:console';

export class TestContext {
  name: string;

  #new(name: string) {
    this.name = name;
  }

  diagnostic(message: string): void {
    console.log(`  # ${message}`);
  }
}

export class TestResult {
  name: string;
  passed: boolean;
  error: Error | null;

  #new(name: string, passed: boolean, error: Error | null) {
    this.name = name;
    this.passed = passed;
    this.error = error;
  }
}

class TestCase {
  name: string;
  fn: (ctx: TestContext) => void;

  #new(name: string, fn: (ctx: TestContext) => void) {
    this.name = name;
    this.fn = fn;
  }
}

// Global test registry
var tests = new Array<TestCase>();
var passedCount: i32 = 0;
var failedCount: i32 = 0;

export let test = (name: string, fn: (ctx: TestContext) => void) => {
  tests.push(new TestCase(name, fn));
};

export let run = () => {
  var i = 0;
  while (i < tests.length) {
    let testCase = tests[i];
    let ctx = new TestContext(testCase.name);

    try {
      testCase.fn(ctx);
      console.log(`✓ ${testCase.name}`);
      passedCount = passedCount + 1;
    } catch (e) {
      console.log(`✗ ${testCase.name}`);
      console.error(`  ${e.message}`);
      failedCount = failedCount + 1;
    }

    i = i + 1;
  }

  console.log('');
  console.log(`${passedCount} passing, ${failedCount} failing`);
};
```

### Phase 5: Suites and Lifecycle Hooks

**Tasks**:

1. Implement `suite(name, fn)` for grouping tests
2. Implement `beforeEach`, `afterEach` hooks
3. Implement `beforeAll`, `afterAll` hooks
4. Implement nested suite support

### Phase 6: Test Modifiers

**Tasks**:

1. Implement `skip(name, fn)` to skip tests
2. Implement `only(name, fn)` to run only specific tests
3. Implement `todo(name)` for placeholder tests

### Phase 7: Reporter and Output

**Prerequisites**:

- Template literals (✅ Done)
- Better string formatting

**Tasks**:

1. Implement TAP (Test Anything Protocol) output format
2. Implement summary statistics
3. Implement failure details with stack traces (when available)

---

## Design Decisions

### 1. Synchronous-First Design

Since Zena doesn't yet have async/await, the initial implementation is purely
synchronous. When async is added, we can extend the API:

```zena
// Future async support
export let test: (name: string, fn: (ctx: TestContext) => void | Promise<void>) => void;
```

### 2. Global Test Registry vs Explicit Runner

We use a global test registry (like Node.js `node:test`) for simplicity:

```zena
// Simple: tests auto-register
test('example', (ctx) => { ... });
run();

// vs. Explicit runner (more verbose)
let runner = new TestRunner();
runner.add('example', (ctx) => { ... });
runner.run();
```

The global approach is more ergonomic for most use cases.

### 3. Assertion Style

We follow Node.js `assert` style (function-based) rather than Jest/Chai style
(chained matchers):

```zena
// Node.js style (our choice)
equal(actual, expected);

// Jest style (not chosen)
expect(actual).toBe(expected);
```

Reasons:

- Simpler implementation (no fluent builder pattern needed)
- More familiar to Node.js developers
- Better static typing (no dynamic method chains)

### 4. Error Message Formatting

Assertions should provide clear, helpful error messages. The format follows
Node.js conventions:

```
AssertionError: Values not equal
  actual: 42
  expected: 43
  operator: ==
```

For Phase 1, we start with simple messages. Enhanced formatting can come later
when we have better string interpolation and reflection capabilities.

### 5. `any` Type for AssertionError Fields

`AssertionError.actual` and `expected` use `any` type to hold values of any
type. This requires auto-boxing for primitives but enables storing any value
for error reporting.

---

## Dependencies

### Required Language Features

| Feature           | Status     | Needed For                   |
| ----------------- | ---------- | ---------------------------- |
| Classes           | ✅ Done    | AssertionError, TestResult   |
| Inheritance       | ✅ Done    | AssertionError extends Error |
| Generics          | ✅ Done    | Generic assertion functions  |
| Closures          | ✅ Done    | Test functions, hooks        |
| `throw`           | ✅ Done    | Assertion failures           |
| `try`/`catch`     | 🔄 Planned | Exception assertions, runner |
| Optional params   | ✅ Done    | Default messages             |
| `any` type        | ✅ Done    | Storing any value in errors  |
| Template literals | ✅ Done    | Error message formatting     |
| `Array<T>`        | ✅ Done    | Test registry                |
| Module-level vars | ✅ Done    | Global test registry         |

### Required Stdlib Components

| Component     | Status  | Needed For              |
| ------------- | ------- | ----------------------- |
| `Error` class | ✅ Done | Base for AssertionError |
| `console`     | ✅ Done | Test output             |
| `Array<T>`    | ✅ Done | Test collection         |

---

## File Structure

```
packages/stdlib/zena/
├── assert.zena          # Assertion functions
├── test.zena            # Test runner and registration
└── ... (existing files)
```

---

## Testing the Test Framework

The test framework itself will be tested using the existing TypeScript test
infrastructure:

```typescript
// packages/compiler/src/test/stdlib/assert_test.ts
import {suite, test} from 'node:test';
import {compileAndRun} from '../codegen/utils.js';
import assert from 'node:assert';

suite('Stdlib: assert', () => {
  test('ok passes for true', async () => {
    const source = `
      import { ok } from 'zena:assert';
      export let run = (): i32 => {
        ok(true);
        return 1;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 1);
  });

  test('ok throws for false', async () => {
    const source = `
      import { ok } from 'zena:assert';
      export let run = (): i32 => {
        ok(false);
        return 1;
      };
    `;
    await assert.rejects(compileAndRun(source, 'run'));
  });
});
```

---

## Future Enhancements

### 1. Async Test Support

When async/await is implemented:

```zena
test('async operation', async (ctx) => {
  let result = await fetchData();
  equal(result.status, 200);
});
```

### 2. Parameterized Tests

```zena
testEach([
  [1, 1, 2],
  [2, 2, 4],
  [0, 0, 0],
], 'add($0, $1) = $2', (a, b, expected) => {
  equal(a + b, expected);
});
```

### 3. Snapshot Testing

```zena
test('renders correctly', (ctx) => {
  let output = render(component);
  ctx.matchSnapshot(output);
});
```

### 4. Test Isolation

Run tests in isolated contexts to prevent state leakage.

### 5. Parallel Execution

When threading/workers are available.

### 6. Custom Matchers

```zena
assert.register('toBeWithinRange', (actual, min, max) => {
  return actual >= min && actual <= max;
});

test('is within range', (ctx) => {
  assert.toBeWithinRange(value, 1, 10);
});
```

---

## Implementation Priority

1. **Phase 1**: `AssertionError`, `ok`, `equal`, `fail` (MVP) ✅ DONE
2. **Phase 3**: `throws`, `doesNotThrow` (requires try/catch) ← NEXT
3. **Phase 4**: Basic `test()` and `run()` (requires try/catch)
4. **Phase 2**: Extended assertions (mostly done, comparison assertions remaining)
5. **Phase 5-7**: Suites, hooks, reporters (nice-to-have)

The critical blocker (**try/catch support**) has been implemented!

## Immediate Next Steps

1. ~~**Implement try/catch** in the compiler~~ ✅ DONE
2. ~~Create `assert.zena` with `AssertionError`, `ok`, `equal`, `fail`~~ ✅ DONE
3. ~~Create basic tests for the assert module~~ ✅ DONE
4. **Implement `throws` and `doesNotThrow`** in `assert.zena` (Phase 3)
5. **Create `test.zena`** with basic `test()` and `run()` (Phase 4)
6. Dogfood by converting some stdlib tests to Zena
