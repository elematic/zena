/**
 * Integration test for Range syntax
 * 
 * This test demonstrates the usage of Range expressions in Zena.
 * 
 * Note: This test requires Node 25+ to run due to WASM-GC requirements.
 * To run: npm test -w @zena-lang/compiler -- test/codegen/range_test.js
 */

import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun, compileAndInstantiate} from './utils.js';

suite('Codegen - Range expressions', () => {
  test('should create BoundedRange with a..b', async () => {
    const source = `
      import { BoundedRange } from 'zena:range';
      
      export const getRange = () => {
        let r = 1..10;
        return r;
      };
      
      export const getStart = () => {
        let r = 5..15;
        return r.start;
      };
      
      export const getEnd = () => {
        let r = 5..15;
        return r.end;
      };
    `;

    const instance = await compileAndInstantiate(source);
    const range = instance.exports.getRange();
    assert.ok(range, 'Range should be created');
    
    const start = instance.exports.getStart();
    assert.strictEqual(start, 5, 'Range start should be 5');
    
    const end = instance.exports.getEnd();
    assert.strictEqual(end, 15, 'Range end should be 15');
  });

  test('should create FromRange with a..', async () => {
    const source = `
      import { FromRange } from 'zena:range';
      
      export const getRange = () => {
        let r = 10..;
        return r;
      };
      
      export const getStart = () => {
        let r = 20..;
        return r.start;
      };
    `;

    const instance = await compileAndInstantiate(source);
    const range = instance.exports.getRange();
    assert.ok(range, 'FromRange should be created');
    
    const start = instance.exports.getStart();
    assert.strictEqual(start, 20, 'FromRange start should be 20');
  });

  test('should create ToRange with ..b', async () => {
    const source = `
      import { ToRange } from 'zena:range';
      
      export const getRange = () => {
        let r = ..25;
        return r;
      };
      
      export const getEnd = () => {
        let r = ..30;
        return r.end;
      };
    `;

    const instance = await compileAndInstantiate(source);
    const range = instance.exports.getRange();
    assert.ok(range, 'ToRange should be created');
    
    const end = instance.exports.getEnd();
    assert.strictEqual(end, 30, 'ToRange end should be 30');
  });

  test('should create FullRange with ..', async () => {
    const source = `
      import { FullRange } from 'zena:range';
      
      export const getRange = () => {
        let r = ..;
        return r;
      };
    `;

    const instance = await compileAndInstantiate(source);
    const range = instance.exports.getRange();
    assert.ok(range, 'FullRange should be created');
  });

  test('should evaluate expressions in range bounds', async () => {
    const source = `
      import { BoundedRange } from 'zena:range';
      
      export const getRangeWithExpressions = (x: i32, y: i32) => {
        let r = (x + 1)..(y * 2);
        return r;
      };
      
      export const getStart = (x: i32) => {
        let r = (x + 1)..10;
        return r.start;
      };
      
      export const getEnd = (y: i32) => {
        let r = 0..(y * 2);
        return r.end;
      };
    `;

    const instance = await compileAndInstantiate(source);
    
    const start = instance.exports.getStart(4);
    assert.strictEqual(start, 5, 'Start should be 4 + 1 = 5');
    
    const end = instance.exports.getEnd(7);
    assert.strictEqual(end, 14, 'End should be 7 * 2 = 14');
  });

  test('should handle ranges in arrays', async () => {
    const source = `
      import { BoundedRange } from 'zena:range';
      
      export const getFirstRangeStart = () => {
        let ranges = [1..5, 10..20];
        return ranges[0].start;
      };
      
      export const getSecondRangeEnd = () => {
        let ranges = [1..5, 10..20];
        return ranges[1].end;
      };
    `;

    const instance = await compileAndInstantiate(source);
    
    const firstStart = instance.exports.getFirstRangeStart();
    assert.strictEqual(firstStart, 1);
    
    const secondEnd = instance.exports.getSecondRangeEnd();
    assert.strictEqual(secondEnd, 20);
  });

  test('should handle ranges as function arguments', async () => {
    const source = `
      import { BoundedRange } from 'zena:range';
      
      const processRange = (r: BoundedRange) => {
        return r.end - r.start;
      };
      
      export const testRangeArg = () => {
        return processRange(5..15);
      };
    `;

    const result = await compileAndRun(source, 'testRangeArg');
    assert.strictEqual(result, 10, 'Range length should be 10');
  });
});
