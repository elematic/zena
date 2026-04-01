import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {compileAndRun} from './utils.js';

suite('Case class optional parameters', () => {
  test('optional param defaults to null', async () => {
    const result = await compileAndRun(`
      class Node(value: i32, label?: String)

      export let main = (): boolean => {
        let n = new Node(1);
        return n.label === null;
      };
    `);
    assert.equal(result, 1);
  });

  test('optional param can be provided', async () => {
    const result = await compileAndRun(`
      class Node(value: i32, label?: String)

      export let main = (): i32 => {
        let n = new Node(1, 'hello');
        return n.value;
      };
    `);
    assert.equal(result, 1);
  });

  test('multiple optional params', async () => {
    const result = await compileAndRun(`
      class Config(a: i32, b?: i32, c?: i32)

      export let main = (): boolean => {
        let cfg = new Config(10);
        return cfg.b === null;
      };
    `);
    assert.equal(result, 1);
  });

  test('optional param with class type', async () => {
    const result = await compileAndRun(`
      class Inner(x: i32)
      class Outer(value: i32, child?: Inner)

      export let main = (): boolean => {
        let o = new Outer(1);
        return o.child === null;
      };
    `);
    assert.equal(result, 1);
  });

  test('provide optional class param', async () => {
    const result = await compileAndRun(`
      class Inner(x: i32)
      class Outer(value: i32, child?: Inner)

      export let main = (): i32 => {
        let inner = new Inner(42);
        let o = new Outer(1, inner);
        let c = o.child;
        if (c !== null) {
          return c.x;
        }
        return 0;
      };
    `);
    assert.equal(result, 42);
  });
});
