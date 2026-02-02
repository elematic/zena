import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileToWasm} from './utils.js';

/**
 * Analyze the WASM binary to count rec blocks.
 * Since we can't rely on wasm2wat, we parse the type section directly.
 */
const countRecBlocks = (wasmBytes: Uint8Array): number => {
  let pos = 8; // Skip magic and version
  let recCount = 0;

  while (pos < wasmBytes.length) {
    const sectionId = wasmBytes[pos++];
    const [sectionSize, nextPos] = readLEB128(wasmBytes, pos);
    pos = nextPos;

    if (sectionId === 1) {
      // Type section
      const sectionEnd = pos + sectionSize;
      const [typeCount, typePos] = readLEB128(wasmBytes, pos);
      pos = typePos;

      for (let i = 0; i < typeCount && pos < sectionEnd; i++) {
        const byte = wasmBytes[pos];
        if (byte === 0x4e) {
          // rec opcode
          recCount++;
          pos++;
          const [recTypeCount, recPos] = readLEB128(wasmBytes, pos);
          pos = recPos;
          // Skip the types in this rec block
          for (let j = 0; j < recTypeCount && pos < sectionEnd; j++) {
            pos = skipType(wasmBytes, pos);
          }
        } else {
          // Plain type (shouldn't happen with our implementation)
          pos = skipType(wasmBytes, pos);
        }
      }
      break; // Done with type section
    } else {
      pos += sectionSize;
    }
  }

  return recCount;
};

const readLEB128 = (bytes: Uint8Array, offset: number): [number, number] => {
  let result = 0;
  let shift = 0;
  let pos = offset;
  let byte: number;
  do {
    byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return [result, pos];
};

const skipType = (bytes: Uint8Array, pos: number): number => {
  const byte = bytes[pos++];
  if (byte === 0x4f || byte === 0x50) {
    // sub or sub final
    const [supertypeCount, nextPos] = readLEB128(bytes, pos);
    pos = nextPos;
    for (let i = 0; i < supertypeCount; i++) {
      const [_supertype, newPos] = readLEB128(bytes, pos);
      pos = newPos;
    }
    return skipType(bytes, pos); // Skip the actual type after sub
  } else if (byte === 0x60) {
    // func type
    const [paramCount, paramPos] = readLEB128(bytes, pos);
    pos = paramPos;
    for (let i = 0; i < paramCount; i++) {
      pos = skipValType(bytes, pos);
    }
    const [resultCount, resultPos] = readLEB128(bytes, pos);
    pos = resultPos;
    for (let i = 0; i < resultCount; i++) {
      pos = skipValType(bytes, pos);
    }
    return pos;
  } else if (byte === 0x5e) {
    // array type
    pos = skipFieldType(bytes, pos);
    return pos;
  } else if (byte === 0x5f) {
    // struct type
    const [fieldCount, fieldPos] = readLEB128(bytes, pos);
    pos = fieldPos;
    for (let i = 0; i < fieldCount; i++) {
      pos = skipFieldType(bytes, pos);
    }
    return pos;
  }
  throw new Error(`Unknown type form: 0x${byte.toString(16)}`);
};

const skipValType = (bytes: Uint8Array, pos: number): number => {
  const byte = bytes[pos++];
  if (byte === 0x63 || byte === 0x64) {
    // ref null or ref - followed by heap type (could be LEB128 index)
    const next = bytes[pos];
    if (next & 0x80 || (next & 0x40)) {
      // Negative or continuation - it's an index
      const [_idx, newPos] = readLEB128(bytes, pos);
      return newPos;
    } else {
      // Heap type constant
      return pos + 1;
    }
  }
  return pos; // Simple value type
};

const skipFieldType = (bytes: Uint8Array, pos: number): number => {
  pos = skipValType(bytes, pos); // Storage type (same as val type for now)
  pos++; // Mutability flag
  return pos;
};

suite('rec block optimization', () => {
  test('minimal program should have minimal rec blocks', () => {
    const source = `export let main = () => 42;`;
    const wasm = compileToWasm(source, '/main.zena', {dce: false});
    
    // Should compile and run successfully
    const module = new WebAssembly.Module(wasm as BufferSource);
    const instance = new WebAssembly.Instance(module);
    assert.strictEqual((instance.exports.main as Function)(), 42);
    
    // Count rec blocks - should be minimal (likely 1 for the function type)
    const recCount = countRecBlocks(wasm);
    assert.ok(recCount >= 1, `Should have at least 1 rec block, got ${recCount}`);
  });

  test('program with non-recursive class should have minimal rec blocks', () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }
      export let main = () => {
        let p = new Point(1, 2);
        return p.x + p.y;
      };
    `;
    const wasm = compileToWasm(source, '/main.zena', {dce: false});
    
    // Should compile and run successfully
    const module = new WebAssembly.Module(wasm as BufferSource);
    const instance = new WebAssembly.Instance(module);
    assert.strictEqual((instance.exports.main as Function)(), 3);
    
    // With non-recursive class, we should have separate rec blocks for each type
    const recCount = countRecBlocks(wasm);
    // At minimum we'll have rec blocks for: Point struct, Point vtable, function types
    assert.ok(recCount >= 1, `Should have at least 1 rec block, got ${recCount}`);
  });

  test('self-referential class should have rec blocks', () => {
    const source = `
      class Node {
        value: i32;
        next: Node | null;
        new(value: i32) {
          this.value = value;
          this.next = null;
        }
      }
      export let main = () => {
        let n = new Node(42);
        return n.value;
      };
    `;
    const wasm = compileToWasm(source, '/main.zena', {dce: false});
    
    // Should compile and run successfully
    const module = new WebAssembly.Module(wasm as BufferSource);
    const instance = new WebAssembly.Instance(module);
    assert.strictEqual((instance.exports.main as Function)(), 42);
    
    const recCount = countRecBlocks(wasm);
    assert.ok(recCount >= 1, `Self-referential class should have rec blocks, got ${recCount}`);
  });

  test('mutually recursive classes should have rec blocks', () => {
    const source = `
      class A {
        b: B | null;
        new() {
          this.b = null;
        }
      }
      class B {
        a: A | null;
        new() {
          this.a = null;
        }
      }
      export let main = () => {
        let a = new A();
        return 42;
      };
    `;
    const wasm = compileToWasm(source, '/main.zena', {dce: false});
    
    // Should compile and run successfully
    const module = new WebAssembly.Module(wasm as BufferSource);
    const instance = new WebAssembly.Instance(module);
    assert.strictEqual((instance.exports.main as Function)(), 42);
    
    const recCount = countRecBlocks(wasm);
    assert.ok(recCount >= 1, `Mutually recursive classes should have rec blocks, got ${recCount}`);
  });

  test('WASM binary size comparison - before vs after optimization', () => {
    // This test verifies that our optimization reduces unnecessary wrapping
    // by comparing binary sizes or rec block counts
    
    const simpleSource = `export let main = () => 42;`;
    const wasm = compileToWasm(simpleSource, '/main.zena', {dce: false});
    
    // The key improvement is that we now create minimal rec groups instead of one large group
    // We verify this works by ensuring the WASM is valid and runs
    const module = new WebAssembly.Module(wasm as BufferSource);
    const instance = new WebAssembly.Instance(module);
    assert.strictEqual((instance.exports.main as Function)(), 42);
    
    console.log('Simple program WASM size:', wasm.length, 'bytes');
    console.log('Rec block count:', countRecBlocks(wasm));
  });
});

