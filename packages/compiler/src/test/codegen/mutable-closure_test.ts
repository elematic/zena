import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Codegen: Mutable Closures', () => {
  test('basic mutable capture from issue example', async () => {
    const source = `
      let run = (f: () => i32): i32 => f();

      export let main = () => {
        var x = 0;
        run(() => {
          x = 3;
          return 0; // Closure must return i32
        });
        return x; // should return 3
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 3);
  });

  test('mutable capture with read and write', async () => {
    const source = `
      export let test = () => {
        var x = 5;
        let f = () => {
          x = x + 10;
        };
        f();
        return x; // should return 15
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 15);
  });

  test('multiple closures sharing mutable variable', async () => {
    const source = `
      export let test = () => {
        var x = 0;
        let inc = () => {
          x = x + 1;
        };
        let add10 = () => {
          x = x + 10;
        };
        inc();
        inc();
        add10();
        return x; // should return 12
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 12);
  });

  test('nested closures with mutable capture', async () => {
    const source = `
      export let test = () => {
        var x = 0;
        let outer = () => {
          let inner = () => {
            x = x + 5;
          };
          inner();
          x = x + 1;
        };
        outer();
        return x; // should return 6
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 6);
  });

  test('mutable capture from outer scope', async () => {
    const source = `
      export let test = () => {
        var x = 1;
        let makeAdder = () => {
          return () => {
            x = x + 2;
          };
        };
        let adder = makeAdder();
        adder();
        adder();
        return x; // should return 5
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 5);
  });

  test('mix of mutable and immutable captures', async () => {
    const source = `
      export let test = () => {
        let a = 10;
        var b = 20;
        let f = () => {
          b = b + a; // reads a (immutable), writes b (mutable)
        };
        f();
        return b; // should return 30
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 30);
  });

  test('closure returns mutable captured value', async () => {
    const source = `
      export let test = () => {
        var x = 7;
        let f = () => {
          x = x * 2;
          return x;
        };
        let result = f();
        return result; // should return 14
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 14);
  });

  test('class method closes over module variable', async () => {
    const source = `
      var moduleVar = 0;

      let increment = () => {
        moduleVar = moduleVar + 1;
      };

      let getValue = () => {
        return moduleVar;
      };

      export let test = () => {
        increment();
        increment();
        increment();
        return getValue(); // should return 3
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 3);
  });
});
