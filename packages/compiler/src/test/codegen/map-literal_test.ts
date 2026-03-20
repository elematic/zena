import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Codegen - Map Literals', () => {
  test('should create map literal with string keys', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';

      export let main = (): i32 => {
        let m = {"a" => 1, "b" => 2, "c" => 3};
        let (value, _) = m.get("b");
        return value;
      };
    `);
    assert.strictEqual(result, 2);
  });

  test('should create map literal with number keys', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';

      export let main = (): i32 => {
        let m = {100 => 10, 200 => 20};
        let (value, _) = m.get(200);
        return value;
      };
    `);
    assert.strictEqual(result, 20);
  });

  test('should create map literal with single entry', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';

      export let main = (): i32 => {
        let m = {"key" => 42};
        let (value, _) = m.get("key");
        return value;
      };
    `);
    assert.strictEqual(result, 42);
  });

  test('should support map literal size', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';

      export let main = (): i32 => {
        let m = {"a" => 1, "b" => 2, "c" => 3, "d" => 4};
        return m.size;
      };
    `);
    assert.strictEqual(result, 4);
  });

  test('should support map literal with trailing comma', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';

      export let main = (): i32 => {
        let m = {
          "x" => 10,
          "y" => 20,
        };
        let (x, found1) = m.get("x");
        let (y, found2) = m.get("y");
        return x + y;
      };
    `);
    assert.strictEqual(result, 30);
  });

  test('should allow updating map created from literal', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';

      export let main = (): i32 => {
        let m = {"a" => 1};
        m.set("b", 2);
        return m.size;
      };
    `);
    assert.strictEqual(result, 2);
  });

  test('should support map literal in function return', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';

      let makeMap = (): HashMap<string, i32> => {
        return {"one" => 1, "two" => 2};
      };

      export let main = (): i32 => {
        let m = makeMap();
        let (value, _) = m.get("two");
        return value;
      };
    `);
    assert.strictEqual(result, 2);
  });
});
