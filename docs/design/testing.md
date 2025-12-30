# Testing Standard Library Design

## Status

- **Status**: Proposed
- **Date**: 2025-12-30

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

## API Design

### Module: `zena:assert`

The assertion module provides functions for making test assertions. All
assertion functions throw `AssertionError` on failure.

```zena
// zena:assert

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

// Core assertions
export let ok: (value: boolean, message?: string) => void;
export let equal: <T>(actual: T, expected: T, message?: string) => void;
export let notEqual: <T>(actual: T, expected: T, message?: string) => void;
export let strictEqual: <T>(actual: T, expected: T, message?: string) => void;
export let notStrictEqual: <T>(actual: T, expected: T, message?: string) => void;

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

| Function          | Comparison Used   | Description                            |
| ----------------- | ----------------- | -------------------------------------- |
| `ok`              | Truthiness        | Value is truthy (== true)              |
| `equal`           | `==` (operator)   | Structural equality via `operator ==`  |
| `notEqual`        | `!=` (operator)   | Structural inequality                  |
| `strictEqual`     | `==` (operator)   | Alias for `equal` (Zena has no ===/!==)|
| `same`            | `===` (reference) | Reference equality                     |
| `notSame`         | `!==` (reference) | Reference inequality                   |
| `greater`         | `>`               | actual > expected                      |
| `less`            | `<`               | actual < expected                      |
| `greaterOrEqual`  | `>=`              | actual >= expected                     |
| `lessOrEqual`     | `<=`              | actual <= expected                     |

**Note**: In Zena, `==` is structural equality (uses `operator ==` if defined),
while `===` is reference equality. This differs from JavaScript where `===` is
strict equality. Our API reflects Zena's semantics.

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

### Phase 1: AssertionError and Basic Assertions

**Prerequisites**: 
- `throw` expression (✅ Done)
- String concatenation (✅ Done)
- Generic functions (✅ Done)

**Tasks**:

1. Create `packages/compiler/stdlib/assert.zena`
2. Implement `AssertionError` class extending `Error`
3. Implement core assertions:
   - `ok(value: boolean, message?: string)`
   - `equal<T>(actual: T, expected: T, message?: string)`
   - `notEqual<T>(actual: T, expected: T, message?: string)`
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

### Phase 2: Extended Assertions

**Tasks**:

1. Implement comparison assertions: `greater`, `less`, `greaterOrEqual`, `lessOrEqual`
2. Implement null assertions: `isNull`, `isNotNull`
3. Implement boolean assertions: `isTrue`, `isFalse`
4. Implement reference equality: `same`, `notSame`

### Phase 3: Exception Assertions

**Prerequisites**:
- `try`/`catch` expressions (🔄 Planned)

**Tasks**:

1. Implement `throws(fn: () => void, message?: string)`
2. Implement `doesNotThrow(fn: () => void, message?: string)`

**Implementation Notes**:

```zena
export let throws = (fn: () => void, message: string = 'Expected function to throw') => {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
  }
  if (!threw) {
    throw new AssertionError(message, null, null, 'throws');
  }
};
```

### Phase 4: Test Runner Foundation

**Prerequisites**:
- Closures (✅ Done)
- `Array<T>` (✅ Done)

**Tasks**:

1. Create `packages/compiler/stdlib/test.zena`
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

| Feature            | Status      | Needed For                    |
| ------------------ | ----------- | ----------------------------- |
| Classes            | ✅ Done     | AssertionError, TestResult    |
| Inheritance        | ✅ Done     | AssertionError extends Error  |
| Generics           | ✅ Done     | Generic assertion functions   |
| Closures           | ✅ Done     | Test functions, hooks         |
| `throw`            | ✅ Done     | Assertion failures            |
| `try`/`catch`      | 🔄 Planned  | Exception assertions, runner  |
| Optional params    | ✅ Done     | Default messages              |
| `any` type         | ✅ Done     | Storing any value in errors   |
| Template literals  | ✅ Done     | Error message formatting      |
| `Array<T>`         | ✅ Done     | Test registry                 |
| Module-level vars  | ✅ Done     | Global test registry          |

### Required Stdlib Components

| Component          | Status      | Needed For                    |
| ------------------ | ----------- | ----------------------------- |
| `Error` class      | ✅ Done     | Base for AssertionError       |
| `console`          | ✅ Done     | Test output                   |
| `Array<T>`         | ✅ Done     | Test collection               |

---

## File Structure

```
packages/compiler/stdlib/
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
import { suite, test } from 'node:test';
import { compileAndRun } from '../codegen/utils.js';
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

1. **Phase 1**: `AssertionError`, `ok`, `equal`, `fail` (MVP)
2. **Phase 3**: `throws`, `doesNotThrow` (requires try/catch)
3. **Phase 4**: Basic `test()` and `run()` (requires try/catch)
4. **Phase 2**: Extended assertions (can be added incrementally)
5. **Phase 5-7**: Suites, hooks, reporters (nice-to-have)

The critical blocker is **try/catch support** (Phase 3 of Exceptions Design).
Without it, we cannot:
- Catch assertion failures in the test runner
- Implement `throws` assertion
- Report test failures without crashing

## Immediate Next Steps

1. **Implement try/catch** in the compiler (see `docs/design/exceptions.md`)
2. Create `assert.zena` with `AssertionError`, `ok`, `equal`, `fail`
3. Create basic tests for the assert module
4. Create `test.zena` with basic `test()` and `run()`
5. Dogfood by converting some stdlib tests to Zena
