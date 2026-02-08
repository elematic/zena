import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

// These tests verify low-level WASM intrinsics work correctly.
// Higher-level Memory/Allocator tests are in tests/stdlib/memory/memory_test.zena

suite('linear memory intrinsics', () => {
  test('memory.size returns initial size', async () => {
    const source = `
      @intrinsic('memory.size')
      declare function memorySize(): i32;

      export let main = (): i32 => {
        return memorySize();
      };
    `;
    // Default memory is 1 page (64KB)
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('memory.grow increases memory size', async () => {
    const source = `
      @intrinsic('memory.size')
      declare function memorySize(): i32;

      @intrinsic('memory.grow')
      declare function memoryGrow(pages: i32): i32;

      export let main = (): i32 => {
        let before = memorySize();
        let oldSize = memoryGrow(2);  // Grow by 2 pages
        let after = memorySize();
        // Return: before should be 1, oldSize should be 1, after should be 3
        return before * 100 + oldSize * 10 + after;
      };
    `;
    // 1*100 + 1*10 + 3 = 113
    const result = await compileAndRun(source);
    assert.strictEqual(result, 113);
  });

  test('i32.load and i32.store', async () => {
    const source = `
      @intrinsic('memory.grow')
      declare function memoryGrow(pages: i32): i32;

      @intrinsic('i32.store')
      declare function store(ptr: i32, value: i32): void;

      @intrinsic('i32.load')
      declare function load(ptr: i32): i32;

      export let main = (): i32 => {
        // Grow memory to have space
        memoryGrow(1);
        
        // Store at offset 65536 (start of second page)
        let ptr = 65536;
        store(ptr, 42);
        store(ptr + 4, 100);
        
        // Load back
        return load(ptr) + load(ptr + 4);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 142);
  });

  test('i32.load8_u and i32.store8', async () => {
    const source = `
      @intrinsic('i32.store8')
      declare function store8(ptr: i32, value: i32): void;

      @intrinsic('i32.load8_u')
      declare function load8u(ptr: i32): i32;

      export let main = (): i32 => {
        // Use addresses in the first page (safe)
        store8(100, 255);
        store8(101, 128);
        store8(102, 0);
        
        // Load back - should be unsigned
        return load8u(100) + load8u(101) + load8u(102);
      };
    `;
    // 255 + 128 + 0 = 383
    const result = await compileAndRun(source);
    assert.strictEqual(result, 383);
  });
});
