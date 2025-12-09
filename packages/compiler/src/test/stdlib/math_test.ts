import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from '../codegen/utils.js';

suite('Stdlib: Math', () => {
  test('i32 bitwise operations', async () => {
    const source = `
      import { clz, ctz, popcnt } from 'zena:math';
      
      export let run = (): i32 => {
        // clz(0) = 32
        if (clz(0) != 32) return 1;
        // clz(1) = 31
        if (clz(1) != 31) return 2;
        // clz(-1) = 0 (all 1s)
        if (clz(-1) != 0) return 3;

        // ctz(0) = 32
        if (ctz(0) != 32) return 4;
        // ctz(1) = 0
        if (ctz(1) != 0) return 5;
        // ctz(8) = 3 (1000)
        if (ctz(8) != 3) return 6;

        // popcnt(0) = 0
        if (popcnt(0) != 0) return 7;
        // popcnt(1) = 1
        if (popcnt(1) != 1) return 8;
        // popcnt(3) = 2 (11)
        if (popcnt(3) != 2) return 9;
        // popcnt(-1) = 32
        if (popcnt(-1) != 32) return 10;

        return 0; // Success
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 0);
  });

  test('i64 bitwise operations', async () => {
    const source = `
      import { clz, ctz, popcnt } from 'zena:math';
      
      export let run = (): i32 => {
        // clz(0L) = 64
        if (clz(0 as i64) != (64 as i64)) return 1;
        // clz(1L) = 63
        if (clz(1 as i64) != (63 as i64)) return 2;

        // ctz(0L) = 64
        if (ctz(0 as i64) != (64 as i64)) return 3;
        // ctz(8L) = 3
        if (ctz(8 as i64) != (3 as i64)) return 4;

        // popcnt(0L) = 0
        if (popcnt(0 as i64) != (0 as i64)) return 5;
        // popcnt(-1L) = 64
        if (popcnt(-1 as i64) != (64 as i64)) return 6;

        return 0; // Success
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 0);
  });

  test('f32 operations', async () => {
    const source = `
      import { abs, neg, ceil, floor, trunc, nearest, sqrt, min, max, copysign } from 'zena:math';
      
      export let run = (): i32 => {
        // abs
        if (abs(-1.5 as f32) != 1.5 as f32) return 1;
        
        // neg
        if (neg(1.5 as f32) != -1.5 as f32) return 2;

        // ceil
        if (ceil(1.1 as f32) != 2.0 as f32) return 3;
        if (ceil(-1.1 as f32) != -1.0 as f32) return 4;

        // floor
        if (floor(1.9 as f32) != 1.0 as f32) return 5;
        if (floor(-1.1 as f32) != -2.0 as f32) return 6;

        // trunc
        if (trunc(1.9 as f32) != 1.0 as f32) return 7;
        if (trunc(-1.9 as f32) != -1.0 as f32) return 8;

        // nearest
        if (nearest(1.4 as f32) != 1.0 as f32) return 9;
        if (nearest(1.6 as f32) != 2.0 as f32) return 10;

        // sqrt
        if (sqrt(4.0 as f32) != 2.0 as f32) return 11;

        // min
        if (min(1.0 as f32, 2.0 as f32) != 1.0 as f32) return 12;

        // max
        if (max(1.0 as f32, 2.0 as f32) != 2.0 as f32) return 13;

        // copysign
        if (copysign(1.0 as f32, -2.0 as f32) != -1.0 as f32) return 14;

        return 0;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 0);
  });

  test('f64 operations', async () => {
    const source = `
      import { abs, neg, ceil, floor, trunc, nearest, sqrt, min, max, copysign } from 'zena:math';
      
      export let run = (): i32 => {
        // abs
        if (abs(-1.5) != 1.5) return 1;
        
        // neg
        if (neg(1.5) != -1.5) return 2;

        // ceil
        if (ceil(1.1) != 2.0) return 3;
        if (ceil(-1.1) != -1.0) return 4;

        // floor
        if (floor(1.9) != 1.0) return 5;
        if (floor(-1.1) != -2.0) return 6;

        // trunc
        if (trunc(1.9) != 1.0) return 7;
        if (trunc(-1.9) != -1.0) return 8;

        // nearest
        if (nearest(1.4) != 1.0) return 9;
        if (nearest(1.6) != 2.0) return 10;

        // sqrt
        if (sqrt(4.0) != 2.0) return 11;

        // min
        if (min(1.0, 2.0) != 1.0) return 12;

        // max
        if (max(1.0, 2.0) != 2.0) return 13;

        // copysign
        if (copysign(1.0, -2.0) != -1.0) return 14;

        return 0;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 0);
  });
});
