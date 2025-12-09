import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Codegen: Numeric Types', () => {
  test('i64 arithmetic', async () => {
    const source = `
      export let run = (): i32 => {
        let a = 10 as i64;
        let b = 20 as i64;
        
        // Addition
        if ((a + b) != (30 as i64)) return 1;
        
        // Subtraction
        if ((b - a) != (10 as i64)) return 2;
        
        // Multiplication
        if ((a * b) != (200 as i64)) return 3;
        
        // Division (Signed)
        if ((b / a) != (2 as i64)) return 4;
        
        // Modulo (Signed)
        if ((b % (3 as i64)) != (2 as i64)) return 5;
        
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 0);
  });

  test('i64 bitwise', async () => {
    const source = `
      export let run = (): i32 => {
        let a = 12 as i64; // 0b1100
        let b = 10 as i64; // 0b1010
        
        // AND
        if ((a & b) != (8 as i64)) return 1;
        
        // OR
        if ((a | b) != (14 as i64)) return 2;
        
        // XOR
        if ((a ^ b) != (6 as i64)) return 3;
        
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 0);
  });

  test('i64 comparison', async () => {
    const source = `
      export let run = (): i32 => {
        let a = 10 as i64;
        let b = 20 as i64;
        
        if (!(a < b)) return 1;
        if (a > b) return 2;
        if (a == b) return 3;
        if (a != (10 as i64)) return 4;
        if (!(a <= b)) return 5;
        if (b <= a) return 6;
        
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 0);
  });

  test('f64 arithmetic', async () => {
    const source = `
      export let run = (): i32 => {
        let a = 1.5 as f64;
        let b = 2.5 as f64;
        
        // Addition
        if ((a + b) != (4.0 as f64)) return 1;
        
        // Subtraction
        if ((b - a) != (1.0 as f64)) return 2;
        
        // Multiplication
        if ((a * (2.0 as f64)) != (3.0 as f64)) return 3;
        
        // Division
        if (((3.0 as f64) / (1.5 as f64)) != (2.0 as f64)) return 4;
        
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 0);
  });

  test('f64 comparison', async () => {
    const source = `
      export let run = (): i32 => {
        let a = 1.5 as f64;
        let b = 2.5 as f64;
        
        if (!(a < b)) return 1;
        if (a > b) return 2;
        if (a == b) return 3;
        if (a != (1.5 as f64)) return 4;
        
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 0);
  });
});
