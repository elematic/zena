import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Destructured Parameters', () => {
  test('record destructured parameter', async () => {
    const code = `
      let getX = ({x, y}: {x: i32, y: i32}) => x;

      export let main = () => {
        let p = { x: 10, y: 20 };
        return getX(p);
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 10);
  });

  test('record destructured parameter - sum fields', async () => {
    const code = `
      let sum = ({x, y}: {x: i32, y: i32}) => x + y;

      export let main = () => {
        let p = { x: 3, y: 7 };
        return sum(p);
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 10);
  });

  test('record destructured parameter with renaming', async () => {
    const code = `
      let getA = ({x as a, y as b}: {x: i32, y: i32}) => a + b;

      export let main = () => {
        let p = { x: 5, y: 15 };
        return getA(p);
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 20);
  });

  test('tuple destructured parameter', async () => {
    const code = `
      let first = ((a, b): (i32, i32)) => a;

      export let main = () => {
        let t = (42, 99);
        return first(t);
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 42);
  });

  test('tuple destructured parameter - sum', async () => {
    const code = `
      let sum = ((a, b): (i32, i32)) => a + b;

      export let main = () => {
        let t = (10, 20);
        return sum(t);
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 30);
  });

  test('destructured parameter with class type', async () => {
    const code = `
      class Point {
        x: i32;
        y: i32;
        new(this.x, this.y) {}
      }

      let getX = ({x, y}: Point) => x;

      export let main = () => {
        return getX(new Point(7, 8));
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 7);
  });

  test('mixed normal and destructured parameters', async () => {
    const code = `
      let add = (z: i32, {x, y}: {x: i32, y: i32}) => x + y + z;

      export let main = () => {
        let p = { x: 1, y: 2 };
        return add(10, p);
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 13);
  });

  test('destructured parameter with default value', async () => {
    const code = `
      let getX = ({x, y}: {x: i32, y: i32} = { x: 100, y: 200 }) => x;

      export let main = () => {
        return getX();
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 100);
  });

  test('destructured parameter with default - provided value wins', async () => {
    const code = `
      let getX = ({x, y}: {x: i32, y: i32} = { x: 100, y: 200 }) => x;

      export let main = () => {
        let p = { x: 5, y: 6 };
        return getX(p);
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 5);
  });

  test('class method with destructured parameter', async () => {
    const code = `
      class Calc {
        offset: i32;
        new(this.offset) {}

        add({x, y}: {x: i32, y: i32}): i32 {
          return this.offset + x + y;
        }
      }

      export let main = () => {
        let c = new Calc(100);
        let p = { x: 3, y: 4 };
        return c.add(p);
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 107);
  });

  test('multiple destructured parameters', async () => {
    const code = `
      let addPoints = ({x as x1, y as y1}: {x: i32, y: i32}, {x as x2, y as y2}: {x: i32, y: i32}) => {
        return x1 + x2 + y1 + y2;
      };

      export let main = () => {
        let a = { x: 1, y: 2 };
        let b = { x: 3, y: 4 };
        return addPoints(a, b);
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 10);
  });
});
