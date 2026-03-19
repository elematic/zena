import assert from 'node:assert';
import {suite, test} from 'node:test';
import {checkSource, compileAndRun} from './utils.js';

suite('Void Union Types', () => {
  suite('explicit void unions are rejected', () => {
    test('i32 | void variable type is rejected', () => {
      const diagnostics = checkSource(`
        let x: i32 | void = 42;
      `);
      assert.ok(diagnostics.length > 0, 'Should have errors');
      assert.ok(
        diagnostics.some((d) => d.message.includes('cannot contain')),
        'Should reject void in union',
      );
    });

    test('i32 | void return type is rejected', () => {
      const diagnostics = checkSource(`
        let foo = (x: boolean): i32 | void => {
          if (x) { return 42; }
        };
      `);
      assert.ok(diagnostics.length > 0, 'Should have errors');
      assert.ok(
        diagnostics.some((d) => d.message.includes('cannot contain')),
        'Should reject void in union',
      );
    });

    test('void | String is rejected', () => {
      const diagnostics = checkSource(`
        let x: void | String = 'hello';
      `);
      assert.ok(diagnostics.length > 0, 'Should have errors');
      assert.ok(
        diagnostics.some((d) => d.message.includes('cannot contain')),
        'Should reject void in union',
      );
    });
  });

  suite('inferred void unions compile correctly', () => {
    test('if expression with assignment in then and empty else should compile', async () => {
      // When then branch is assignment (returns i32) and else branch is empty
      // (returns void), the inferred type is i32 | void. Codegen treats this as void.
      const result = await compileAndRun(`
      class MyBox {
        value: i32;
        new(value: i32) : value = value { }
      }

      let test = (y: MyBox | null): i32 => {
        var result = 0;
        if (y != null) {
          result = result + 1;
        } else { }
        return result;
      };

      export let main = (): i32 => {
        return test(null);
      };
    `);
      assert.strictEqual(result, 0);
    });

    test('if expression inside match case with empty else should compile', async () => {
      // This is the original reproducer from ast-json.zena (simplified)
      const result = await compileAndRun(`
      class MyBox {
        value: i32;
        new(value: i32) : value = value { }
      }

      class Base {
        tag: i32;
        new(tag: i32) : tag = tag { }
      }

      class A extends Base {
        x: i32;
        maybeY: MyBox | null;
        new(x: i32, maybeY: MyBox | null) : x = x, maybeY = maybeY, super(1) { }
      }

      class B extends Base {
        y: i32;
        new(y: i32) : y = y, super(2) { }
      }

      let process = (node: Base): i32 => {
        var result = 0;
        match (node) {
          case A { x, maybeY }: {
            result = x;
            if (maybeY != null) {
              result = result + 1;
            } else { }
          }
          case B { y }: {
            result = y;
          }
          case _: {
            result = -1;
          }
        }
        return result;
      };

      export let main = (): i32 => {
        let a = new A(42, null);
        return process(a);
      };
    `);
      assert.strictEqual(result, 42);
    });

    test('if expression inside match case with value in then should work', async () => {
      // When maybeY is not null, should add 1
      const result = await compileAndRun(`
      class MyBox {
        value: i32;
        new(value: i32) : value = value { }
      }

      class Base {
        tag: i32;
        new(tag: i32) : tag = tag { }
      }

      class A extends Base {
        x: i32;
        maybeY: MyBox | null;
        new(x: i32, maybeY: MyBox | null) : x = x, maybeY = maybeY, super(1) { }
      }

      class B extends Base {
        y: i32;
        new(y: i32) : y = y, super(2) { }
      }

      let process = (node: Base): i32 => {
        var result = 0;
        match (node) {
          case A { x, maybeY }: {
            result = x;
            if (maybeY != null) {
              result = result + 1;
            } else { }
          }
          case B { y }: {
            result = y;
          }
          case _: {
            result = -1;
          }
        }
        return result;
      };

      export let main = (): i32 => {
        let a = new A(42, new MyBox(10));
        return process(a);
      };
    `);
      assert.strictEqual(result, 43);
    });
  });
});
