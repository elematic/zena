import assert from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

function check(code: string) {
  const parser = new Parser(code);
  const ast = parser.parse();
  const checker = TypeChecker.forModule(ast);
  return checker.check();
}

suite('Checker: Destructuring', () => {
  test('checks record destructuring', () => {
    const diagnostics = check(`
      let p = { x: 1, y: 2 };
      let { x, y } = p;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks record destructuring with renaming', () => {
    const diagnostics = check(`
      let p = { x: 1, y: 2 };
      let { x as x1, y as y1 } = p;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks record destructuring with nesting', () => {
    const diagnostics = check(`
      let r = { p: { x: 1, y: 2 } };
      let { p: { x, y } } = r;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks tuple destructuring', () => {
    const diagnostics = check(`
      let t = [1, 2];
      let [x, y] = t;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks tuple destructuring with skipping', () => {
    const diagnostics = check(`
      let t = [1, 2, 3];
      let [x, , z] = t;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('detects missing property in record destructuring', () => {
    const diagnostics = check(`
      let p = { x: 1 };
      let { y } = p;
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('detects type mismatch in record destructuring', () => {
    // This is tricky because we don't have explicit type checks in patterns yet,
    // but if we use the variable later it should have the correct type.
    // Or if we had defaults...
    // For now, just ensure it binds correctly.
    const diagnostics = check(`
      let p = { x: 1 };
      let { x } = p;
      let s: string = x; // Error: i32 is not string
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('detects tuple index out of bounds', () => {
    const diagnostics = check(`
      let t = [1];
      let [x, y] = t;
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('checks defaults in record destructuring', () => {
    // Defaults without optional fields - the property must still exist
    const diagnostics = check(`
      let p = { x: 1 };
      let { x = 0 } = p;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('allows destructuring optional field with default', () => {
    const diagnostics = check(`
      let process = (opts: {timeout?: i32}) => {
        let {timeout = 30000} = opts;
        return timeout;
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('destructuring optional field without default is an error', () => {
    // Destructuring optional field without default should error -
    // you must provide a default for optional fields to avoid boxing
    const diagnostics = check(`
      let process = (opts: {timeout?: i32}) => {
        let {timeout} = opts;
        return 0;
      };
    `);
    // Should have an error - optional field requires default
    assert.strictEqual(diagnostics.length, 1);
  });

  test('checks default value type matches field type', () => {
    const diagnostics = check(`
      let p = { x: 1 };
      let { x = "wrong" } = p;
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('allows multiple fields with some optional having defaults', () => {
    const diagnostics = check(`
      let request = (opts: {url: string, timeout?: i32, retries?: i32}) => {
        let {url, timeout = 30000, retries = 3} = opts;
        return timeout + retries;
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  suite('spread with optional fields', () => {
    test('spread record preserves optional fields', () => {
      // When spreading a record with optional fields, the optional fields
      // should remain optional in the result
      const diagnostics = check(`
        let base: {url: string, timeout?: i32} = {url: "/api"};
        let extended = {...base, extra: true};
        // extended should have type {url: string, timeout?: i32, extra: bool}
        // So destructuring timeout still requires a default
        let {url, timeout = 30000, extra} = extended;
      `);
      assert.strictEqual(diagnostics.length, 0);
    });

    test('spread record with optional field overwritten becomes required', () => {
      // If you spread and then provide a value for an optional field,
      // it becomes required in the result
      const diagnostics = check(`
        let base: {url: string, timeout?: i32} = {url: "/api"};
        let withTimeout = {...base, timeout: 5000};
        // timeout is now required (has a concrete value)
        let {url, timeout} = withTimeout;  // No default needed
      `);
      assert.strictEqual(diagnostics.length, 0);
    });

    test('spread record still requires default for unoverwritten optional', () => {
      // Spread doesn't magically provide defaults
      const diagnostics = check(`
        let base: {url: string, timeout?: i32, retries?: i32} = {url: "/api"};
        let partial = {...base, timeout: 5000};
        // retries is still optional
        let {retries} = partial;  // Error: needs default
      `);
      assert.strictEqual(diagnostics.length, 1);
    });

    test('multiple spreads combine optional fields', () => {
      const diagnostics = check(`
        let a: {x?: i32} = {};
        let b: {y?: i32} = {};
        let combined = {...a, ...b};
        // Both x and y are optional
        let {x = 0, y = 0} = combined;
      `);
      assert.strictEqual(diagnostics.length, 0);
    });

    test('later spread overwrites earlier optional with required', () => {
      const diagnostics = check(`
        let a: {x?: i32} = {};
        let b: {x: i32} = {x: 10};
        let combined = {...a, ...b};
        // x is now required (from b)
        let {x} = combined;  // No default needed
      `);
      assert.strictEqual(diagnostics.length, 0);
    });

    test('spread of two optionals still requires default', () => {
      // Both sources have optional x, so result must have optional x
      const diagnostics = check(`
        let a: {x?: i32} = {};
        let b: {x?: i32} = {};
        let combined = {...a, ...b};
        let {x} = combined;  // Error: x is still optional
      `);
      assert.strictEqual(diagnostics.length, 1);
    });

    test('spread preserves optional - error without default', () => {
      // Verify that after spreading, optional fields still require defaults
      const diagnostics = check(`
        let base: {timeout?: i32} = {};
        let extended = {...base};
        let {timeout} = extended;  // Error: timeout is still optional
      `);
      assert.strictEqual(diagnostics.length, 1);
    });

    test('later spread with optional does not make required field optional', () => {
      // This is interesting - if a required field is spread, then an optional
      // field with the same name is spread, the result should be required
      // because we know a value exists from the first spread
      const diagnostics = check(`
        let a: {x: i32} = {x: 10};
        let b: {x?: i32} = {};
        let combined = {...a, ...b};
        // x should still be required - a provided a value
        let {x} = combined;
      `);
      assert.strictEqual(diagnostics.length, 0);
    });
  });
});
