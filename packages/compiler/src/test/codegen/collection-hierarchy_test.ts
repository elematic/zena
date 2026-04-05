import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('collection hierarchy', () => {
  test('Sequence is Iterable - for-in over Sequence', async () => {
    const result = await compileAndRun(
      `
      import {Sequence} from 'zena:sequence';

      let sum = (seq: Sequence<i32>): i32 => {
        var total = 0;
        for (let x in seq) {
          total = total + x;
        }
        return total;
      };

      export let run = (): i32 => {
        let arr = [10, 20, 30];
        return sum(arr);
      };
    `,
      'run',
    );
    assert.strictEqual(result, 60);
  });

  test('FixedArray assignable to Sequence', async () => {
    const result = await compileAndRun(
      `
      import {Sequence} from 'zena:sequence';

      let first = (seq: Sequence<i32>): i32 => {
        return seq[0];
      };

      export let run = (): i32 => {
        let arr = [10, 20, 30];
        return first(arr);
      };
    `,
      'run',
    );
    assert.strictEqual(result, 10);
  });

  test('Array assignable to Sequence', async () => {
    const result = await compileAndRun(
      `
      import {Sequence} from 'zena:sequence';
      import {Array} from 'zena:growable-array';

      let sum = (seq: Sequence<i32>): i32 => {
        var total = 0;
        var i = 0;
        while (i < seq.length) {
          total = total + seq[i];
          i = i + 1;
        }
        return total;
      };

      export let run = (): i32 => {
        let arr = new Array<i32>();
        arr.push(10);
        arr.push(20);
        arr.push(30);
        return sum(arr);
      };
    `,
      'run',
    );
    assert.strictEqual(result, 60);
  });

  test('Array assignable to Iterable via Sequence', async () => {
    const result = await compileAndRun(
      `
      import {Iterable} from 'zena:iterator';
      import {Array} from 'zena:growable-array';

      let count = (items: Iterable<i32>): i32 => {
        var n = 0;
        for (let x in items) {
          n = n + 1;
        }
        return n;
      };

      export let run = (): i32 => {
        let arr = new Array<i32>();
        arr.push(1);
        arr.push(2);
        arr.push(3);
        return count(arr);
      };
    `,
      'run',
    );
    assert.strictEqual(result, 3);
  });

  test('FixedArray assignable to Iterable via Sequence', async () => {
    const result = await compileAndRun(
      `
      import {Iterable} from 'zena:iterator';

      let count = (items: Iterable<i32>): i32 => {
        var n = 0;
        for (let x in items) {
          n = n + 1;
        }
        return n;
      };

      export let run = (): i32 => {
        return count([10, 20, 30]);
      };
    `,
      'run',
    );
    assert.strictEqual(result, 3);
  });

  test('for-in over Sequence with Array', async () => {
    const result = await compileAndRun(
      `
      import {Sequence} from 'zena:sequence';
      import {Array} from 'zena:growable-array';

      let sum = (seq: Sequence<i32>): i32 => {
        var total = 0;
        for (let x in seq) {
          total = total + x;
        }
        return total;
      };

      export let run = (): i32 => {
        let arr = new Array<i32>();
        arr.push(5);
        arr.push(15);
        arr.push(25);
        return sum(arr);
      };
    `,
      'run',
    );
    assert.strictEqual(result, 45);
  });

  test('ImmutableArray is iterable', async () => {
    const result = await compileAndRun(
      `
      import {ImmutableArray} from 'zena:immutable-array';

      export let run = (): i32 => {
        let arr = [10, 20, 30] as ImmutableArray<i32>;
        var sum = 0;
        for (let x in arr) {
          sum = sum + x;
        }
        return sum;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 60);
  });

  test('for-in over array literal directly', async () => {
    const result = await compileAndRun(
      `
      export let run = (): i32 => {
        var sum = 0;
        for (let x in [1, 2, 3]) {
          sum = sum + x;
        }
        return sum;
      };
    `,
      'run',
    );
    assert.strictEqual(result, 6);
  });

  test('Sequence.length and indexing via interface', async () => {
    const result = await compileAndRun(
      `
      import {Sequence} from 'zena:sequence';

      let last = (seq: Sequence<i32>): i32 => {
        return seq[seq.length - 1];
      };

      export let run = (): i32 => {
        return last([100, 200, 300]);
      };
    `,
      'run',
    );
    assert.strictEqual(result, 300);
  });
});
