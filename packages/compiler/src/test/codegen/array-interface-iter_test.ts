/**
 * Test for Array collecting results from interface-based iteration.
 *
 * This tests the scenario where a growable Array collects values from
 * an interface method that returns erased types (anyref). The issue is
 * that calling interface methods through fat-pointer dispatch returns
 * anyref, but Array<T> expects concrete types (e.g., ref $String).
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Codegen: Array collecting from interface iterators', () => {
  test('collect from forEach with Array<string>', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';
      import {Array} from 'zena:growable-array';

      export let main = (): i32 => {
        let m = new HashMap<string, i32>();
        m["a"] = 1;
        m["b"] = 2;
        m["c"] = 3;

        let keys = new Array<string>();
        m.forEach((key: string, value: i32): void => {
          keys.push(key);
        });

        return keys.length;
      };
    `);
    assert.strictEqual(result, 3);
  });

  test('collect from for-in loop with Array<string>', async () => {
    const result = await compileAndRun(`
      import {HashMap, MapEntry} from 'zena:map';
      import {Array} from 'zena:growable-array';

      export let main = (): i32 => {
        let m = new HashMap<string, i32>();
        m["x"] = 10;
        m["y"] = 20;

        let keys = new Array<string>();
        for (let entry in m) {
          keys.push(entry.key);
        }

        return keys.length;
      };
    `);
    assert.strictEqual(result, 2);
  });

  test('collect i32 values from interface forEach into Array<i32>', async () => {
    const result = await compileAndRun(`
      import {HashMap} from 'zena:map';
      import {Array} from 'zena:growable-array';

      export let main = (): i32 => {
        let m = new HashMap<string, i32>();
        m["a"] = 10;
        m["b"] = 20;
        m["c"] = 30;

        let vals = new Array<i32>();
        m.forEach((key: string, value: i32): void => {
          vals.push(value);
        });

        return vals[0] + vals[1] + vals[2];
      };
    `);
    assert.strictEqual(result, 60);
  });

  test('OrderedMap keys collected into Array<string>', async () => {
    const result = await compileAndRun(`
      import {OrderedMap} from 'zena:ordered-map';
      import {Array} from 'zena:growable-array';

      export let main = (): i32 => {
        let m = new OrderedMap<string, i32>();
        m["first"] = 1;
        m["second"] = 2;
        m["third"] = 3;

        let keys = new Array<string>();
        m.forEach((key: string, value: i32): void => {
          keys.push(key);
        });

        return keys.length;
      };
    `);
    assert.strictEqual(result, 3);
  });

  test('OrderedMap for-in entries collected into Array', async () => {
    const result = await compileAndRun(`
      import {OrderedMap} from 'zena:ordered-map';
      import {MapEntry} from 'zena:map';
      import {Array} from 'zena:growable-array';

      export let main = (): i32 => {
        let m = new OrderedMap<string, i32>();
        m["a"] = 10;
        m["b"] = 20;

        let entries = new Array<MapEntry<string, i32>>();
        for (let entry in m) {
          entries.push(entry);
        }

        return entries[0].value + entries[1].value;
      };
    `);
    assert.strictEqual(result, 30);
  });
});
