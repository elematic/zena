import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Codegen - Pipeline', () => {
  test('simple pipeline with arithmetic', async () => {
    const source = `
      export let main = () => {
        return 10 |> $ + 5;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 15);
  });

  test('chained pipeline expressions', async () => {
    const source = `
      export let main = () => {
        return 5 |> $ + 5 |> $ * 2;
      };
    `;
    const result = await compileAndRun(source);
    // 5 |> $ + 5 = 10, then 10 |> $ * 2 = 20
    assert.strictEqual(result, 20);
  });

  test('pipeline with multiple $ references', async () => {
    const source = `
      export let main = () => {
        return 10 |> $ + $;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 20);
  });

  test('pipeline with function call', async () => {
    const source = `
      let double = (x: i32) => x * 2;
      
      export let main = () => {
        return 5 |> double($);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 10);
  });

  test('chained pipeline with function calls', async () => {
    const source = `
      let double = (x: i32) => x * 2;
      let addOne = (x: i32) => x + 1;
      
      export let main = () => {
        return 5 |> double($) |> addOne($);
      };
    `;
    const result = await compileAndRun(source);
    // 5 |> double($) = 10, then 10 |> addOne($) = 11
    assert.strictEqual(result, 11);
  });

  test('pipeline with multiple arguments', async () => {
    const source = `
      let add = (a: i32, b: i32) => a + b;
      
      export let main = () => {
        return 5 |> add($, 10);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 15);
  });

  test('pipeline with $ in different argument positions', async () => {
    const source = `
      let subtract = (a: i32, b: i32) => a - b;
      
      export let main = () => {
        return 10 |> subtract($, 3);
      };
    `;
    const result = await compileAndRun(source);
    // 10 - 3 = 7
    assert.strictEqual(result, 7);
  });

  test('pipeline with $ as second argument', async () => {
    const source = `
      let subtract = (a: i32, b: i32) => a - b;
      
      export let main = () => {
        return 3 |> subtract(10, $);
      };
    `;
    const result = await compileAndRun(source);
    // 10 - 3 = 7
    assert.strictEqual(result, 7);
  });

  test('nested pipeline expressions', async () => {
    const source = `
      let f = (x: i32) => x + 1;
      let g = (x: i32) => x * 2;
      
      export let main = () => {
        // (1 |> f($)) + (2 |> g($)) = 2 + 4 = 6
        return (1 |> f($)) + (2 |> g($));
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 6);
  });

  test('pipeline with conditional expression', async () => {
    const source = `
      export let main = () => {
        return 10 |> if ($ > 5) $ * 2 else $ + 2;
      };
    `;
    const result = await compileAndRun(source);
    // 10 > 5 is true, so 10 * 2 = 20
    assert.strictEqual(result, 20);
  });

  test('pipeline preserves evaluation order', async () => {
    const source = `
      var counter = 0;
      
      let sideEffect = () => {
        counter = counter + 1;
        return counter;
      };
      
      export let main = () => {
        return sideEffect() |> $ + sideEffect() |> $ + sideEffect();
      };
    `;
    const result = await compileAndRun(source);
    // sideEffect() returns 1, then 1 |> $ + sideEffect() = 1 + 2 = 3
    // then 3 |> $ + sideEffect() = 3 + 3 = 6
    assert.strictEqual(result, 6);
  });

  test('pipeline with float values', async () => {
    const source = `
      export let main = () => {
        return 5.0 |> $ + 2.5 |> $ * 2.0;
      };
    `;
    const result = await compileAndRun(source);
    // 5.0 + 2.5 = 7.5, then 7.5 * 2.0 = 15.0
    assert.strictEqual(result, 15.0);
  });

  test('pipeline in variable binding', async () => {
    const source = `
      let double = (x: i32) => x * 2;
      
      export let main = () => {
        let result = 5 |> double($) |> $ + 1;
        return result;
      };
    `;
    const result = await compileAndRun(source);
    // 5 |> double($) = 10, then 10 |> $ + 1 = 11
    assert.strictEqual(result, 11);
  });

  test('pipeline with boolean result', async () => {
    const source = `
      export let main = () => {
        return 10 |> $ > 5;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1); // true as i32
  });

  test('deeply chained pipeline', async () => {
    const source = `
      export let main = () => {
        return 1 |> $ + 1 |> $ + 1 |> $ + 1 |> $ + 1;
      };
    `;
    const result = await compileAndRun(source);
    // 1 -> 2 -> 3 -> 4 -> 5
    assert.strictEqual(result, 5);
  });
});
