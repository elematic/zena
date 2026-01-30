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
      export let getRange = () => {
        let r = 1..10;
        return r;
      };
      
      export let getStart = () => {
        let r = 5..15;
        return r.start;
      };
      
      export let getEnd = () => {
        let r = 5..15;
        return r.end;
      };
    `;

    const {getRange, getStart, getEnd} = await compileAndInstantiate(source);
    const range = getRange();
    assert.ok(range, 'Range should be created');

    const start = getStart();
    assert.strictEqual(start, 5, 'Range start should be 5');

    const end = getEnd();
    assert.strictEqual(end, 15, 'Range end should be 15');
  });

  test('should create FromRange with a..', async () => {
    const source = `
      export let getRange = () => {
        let r = 10..;
        return r;
      };
      
      export let getStart = () => {
        let r = 20..;
        return r.start;
      };
    `;

    const {getRange, getStart} = await compileAndInstantiate(source);
    const range = getRange();
    assert.ok(range, 'FromRange should be created');

    const start = getStart();
    assert.strictEqual(start, 20, 'FromRange start should be 20');
  });

  test('should create ToRange with ..b', async () => {
    const source = `
      export let getRange = () => {
        let r = ..25;
        return r;
      };
      
      export let getEnd = () => {
        let r = ..30;
        return r.end;
      };
    `;

    const {getRange, getEnd} = await compileAndInstantiate(source);
    const range = getRange();
    assert.ok(range, 'ToRange should be created');

    const end = getEnd();
    assert.strictEqual(end, 30, 'ToRange end should be 30');
  });

  test('should create FullRange with ..', async () => {
    const source = `
      export let getRange = () => {
        let r = ..;
        return r;
      };
    `;

    const {getRange} = await compileAndInstantiate(source);
    const range = getRange();
    assert.ok(range, 'FullRange should be created');
  });

  test('should evaluate expressions in range bounds', async () => {
    const source = `
      export let getRangeWithExpressions = (x: i32, y: i32) => {
        let r = (x + 1)..(y * 2);
        return r;
      };
      
      export let getStart = (x: i32) => {
        let r = (x + 1)..10;
        return r.start;
      };
      
      export let getEnd = (y: i32) => {
        let r = 0..(y * 2);
        return r.end;
      };
    `;

    const {getStart, getEnd} = await compileAndInstantiate(source);

    const start = getStart(4);
    assert.strictEqual(start, 5, 'Start should be 4 + 1 = 5');

    const end = getEnd(7);
    assert.strictEqual(end, 14, 'End should be 7 * 2 = 14');
  });

  test('should handle ranges in tuples', async () => {
    const source = `
      export let getFirstRangeStart = () => {
        let ranges = [1..5, 10..20];
        return ranges[0].start;
      };
      
      export let getSecondRangeEnd = () => {
        let ranges = [1..5, 10..20];
        return ranges[1].end;
      };
    `;

    const {getFirstRangeStart, getSecondRangeEnd} =
      await compileAndInstantiate(source);

    const firstStart = getFirstRangeStart();
    assert.strictEqual(firstStart, 1);

    const secondEnd = getSecondRangeEnd();
    assert.strictEqual(secondEnd, 20);
  });

  test('should handle ranges as function arguments', async () => {
    const source = `
      let processRange = (r: BoundedRange) => {
        return r.end - r.start;
      };
      
      export let testRangeArg = () => {
        return processRange(5..15);
      };
    `;

    const result = await compileAndRun(source, 'testRangeArg');
    assert.strictEqual(result, 10, 'Range length should be 10');
  });
});
