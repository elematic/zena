import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Equality', () => {
  // Helper to compile and run a function that returns a boolean (0 or 1)
  async function runEqualityTest(body: string, setup = '') {
    const source = `
      ${setup}
      export let main = (): i32 => {
        ${body}
      };
    `;
    return await compileAndRun(source);
  }

  function check(expr: string): string {
    return `if (${expr}) { return 1; } return 0;`;
  }

  // Primitives
  test('i32 equality', async () => {
    assert.strictEqual(await runEqualityTest(check('1 == 1')), 1);
    assert.strictEqual(await runEqualityTest(check('1 == 2')), 0);
    assert.strictEqual(await runEqualityTest(check('1 != 1')), 0);
    assert.strictEqual(await runEqualityTest(check('1 != 2')), 1);
  });

  test('bool equality', async () => {
    assert.strictEqual(await runEqualityTest(check('true == true')), 1);
    assert.strictEqual(await runEqualityTest(check('false == false')), 1);
    assert.strictEqual(await runEqualityTest(check('true == false')), 0);
    assert.strictEqual(await runEqualityTest(check('true != true')), 0);
    assert.strictEqual(await runEqualityTest(check('true != false')), 1);
  });

  // Strings (Value Equality)
  test('string equality (literals)', async () => {
    assert.strictEqual(await runEqualityTest(check('"hello" == "hello"')), 1);
    assert.strictEqual(await runEqualityTest(check('"hello" == "world"')), 0);
    assert.strictEqual(await runEqualityTest(check('"hello" != "hello"')), 0);
    assert.strictEqual(await runEqualityTest(check('"hello" != "world"')), 1);
  });

  test('string equality (constructed)', async () => {
    // Concatenation creates new string objects
    assert.strictEqual(
      await runEqualityTest(check('("he" + "llo") == "hello"')),
      1,
    );
    assert.strictEqual(
      await runEqualityTest(check('("he" + "llo") == ("he" + "llo")')),
      1,
    );
  });

  // Classes (Reference Equality)
  test('class reference equality', async () => {
    const setup = `
      class Point { x: i32; y: i32; #new(x: i32, y: i32) { this.x = x; this.y = y; } }
    `;

    assert.strictEqual(
      await runEqualityTest(
        `
      let p1 = new Point(1, 2);
      let p2 = p1;
      ${check('p1 == p2')}
    `,
        setup,
      ),
      1,
    );

    assert.strictEqual(
      await runEqualityTest(
        `
      let p1 = new Point(1, 2);
      let p2 = new Point(1, 2);
      ${check('p1 == p2')}
    `,
        setup,
      ),
      0,
    );

    assert.strictEqual(
      await runEqualityTest(
        `
      let p1 = new Point(1, 2);
      let p2 = new Point(1, 2);
      ${check('p1 != p2')}
    `,
        setup,
      ),
      1,
    );
  });

  // Arrays (Reference Equality)
  test('array reference equality', async () => {
    assert.strictEqual(
      await runEqualityTest(`
      let a1 = #[1, 2, 3];
      let a2 = a1;
      ${check('a1 == a2')}
    `),
      1,
    );

    assert.strictEqual(
      await runEqualityTest(`
      let a1 = #[1, 2, 3];
      let a2 = #[1, 2, 3];
      ${check('a1 == a2')}
    `),
      0,
    );
  });

  // Records (Reference Equality currently)
  test('record reference equality', async () => {
    assert.strictEqual(
      await runEqualityTest(`
      let r1 = { x: 1 };
      let r2 = r1;
      ${check('r1 == r2')}
    `),
      1,
    );

    assert.strictEqual(
      await runEqualityTest(`
      let r1 = { x: 1 };
      let r2 = { x: 1 };
      ${check('r1 == r2')}
    `),
      0,
    );
  });

  // Tuples (Reference Equality currently)
  test('tuple reference equality', async () => {
    assert.strictEqual(
      await runEqualityTest(`
      let t1 = [1, 2];
      let t2 = t1;
      ${check('t1 == t2')}
    `),
      1,
    );

    assert.strictEqual(
      await runEqualityTest(`
      let t1 = [1, 2];
      let t2 = [1, 2];
      ${check('t1 == t2')}
    `),
      0,
    );
  });

  // Null
  test('null equality', async () => {
    const setup = `class A { #new() {} }`;

    assert.strictEqual(
      await runEqualityTest(
        `
      let a: A = null;
      ${check('a == null')}
    `,
        setup,
      ),
      1,
    );

    assert.strictEqual(
      await runEqualityTest(
        `
      let a = new A();
      ${check('a == null')}
    `,
        setup,
      ),
      0,
    );

    assert.strictEqual(
      await runEqualityTest(
        `
      let a = new A();
      ${check('a != null')}
    `,
        setup,
      ),
      1,
    );
  });

  // Functions (Reference Equality)
  test('function reference equality', async () => {
    assert.strictEqual(
      await runEqualityTest(`
      let f1 = () => 1;
      let f2 = f1;
      ${check('f1 == f2')}
    `),
      1,
    );

    // Note: Two identical function expressions might or might not be equal
    // depending on implementation details (deduplication), but typically they
    // create new closures if they capture context, or might be same code
    // pointer if not. In Zena, closures are structs.
    assert.strictEqual(
      await runEqualityTest(`
      let f1 = () => 1;
      let f2 = () => 1;
      ${check('f1 == f2')}
    `),
      0,
    );
  });
});
