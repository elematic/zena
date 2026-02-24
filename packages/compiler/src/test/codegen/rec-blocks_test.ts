import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileToWasm, compileAndRun} from './utils.js';

// ─── Binary analysis helpers ───────────────────────────────────────────────────

const readULEB128 = (bytes: Uint8Array, offset: number): [number, number] => {
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

const readSLEB128 = (bytes: Uint8Array, offset: number): [number, number] => {
  let result = 0;
  let shift = 0;
  let pos = offset;
  let byte: number;
  do {
    byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (shift < 32 && byte & 0x40) result |= -(1 << shift);
  return [result, pos];
};

const skipValType = (bytes: Uint8Array, pos: number): number => {
  const byte = bytes[pos++];
  if (byte === 0x63 || byte === 0x64) {
    // ref null (0x63) or ref (0x64) — followed by heap type (sLEB128)
    const [, newPos] = readSLEB128(bytes, pos);
    return newPos;
  }
  return pos; // Simple value type (i32, f64, etc.)
};

const skipFieldType = (bytes: Uint8Array, pos: number): number => {
  pos = skipValType(bytes, pos);
  pos++; // mutability byte
  return pos;
};

/** Skip a composite type body (func/struct/array) starting at the composite byte. */
const skipCompositeType = (bytes: Uint8Array, pos: number): number => {
  const byte = bytes[pos++];
  if (byte === 0x60) {
    // func type: param_count param* result_count result*
    const [paramCount, pPos] = readULEB128(bytes, pos);
    pos = pPos;
    for (let i = 0; i < paramCount; i++) pos = skipValType(bytes, pos);
    const [resultCount, rPos] = readULEB128(bytes, pos);
    pos = rPos;
    for (let i = 0; i < resultCount; i++) pos = skipValType(bytes, pos);
    return pos;
  } else if (byte === 0x5f) {
    // struct type: field_count (valtype mutability)*
    const [fieldCount, fPos] = readULEB128(bytes, pos);
    pos = fPos;
    for (let i = 0; i < fieldCount; i++) pos = skipFieldType(bytes, pos);
    return pos;
  } else if (byte === 0x5e) {
    // array type: valtype mutability
    return skipFieldType(bytes, pos);
  }
  throw new Error(`Unknown composite type: 0x${byte.toString(16)}`);
};

/** Skip a full type definition (with optional sub/sub_final wrapper). */
const skipTypeDef = (bytes: Uint8Array, pos: number): number => {
  const byte = bytes[pos];
  if (byte === 0x4f || byte === 0x50) {
    // sub final (0x4f) or sub (0x50) — skip header
    pos++;
    const [superCount, sPos] = readULEB128(bytes, pos);
    pos = sPos;
    for (let i = 0; i < superCount; i++) {
      const [, nPos] = readULEB128(bytes, pos);
      pos = nPos;
    }
    return skipCompositeType(bytes, pos);
  }
  return skipCompositeType(bytes, pos);
};

/** Returns true if the composite type at the given position is a func type (0x60). */
const isFuncTypeDef = (bytes: Uint8Array, pos: number): boolean => {
  const byte = bytes[pos];
  if (byte === 0x4f || byte === 0x50) {
    // sub final / sub — skip header to find composite byte
    let p = pos + 1;
    const [superCount, sPos] = readULEB128(bytes, p);
    p = sPos;
    for (let i = 0; i < superCount; i++) {
      const [, nPos] = readULEB128(bytes, p);
      p = nPos;
    }
    return bytes[p] === 0x60;
  }
  return byte === 0x60;
};

interface TypeSectionInfo {
  /** Number of rec blocks (0x4e opcodes) in the type section. */
  recBlockCount: number;
  /** Total types inside all rec blocks. */
  typesInRecBlocks: number;
  /** Total standalone types (outside any rec block). */
  standaloneTypes: number;
  /** Number of standalone types that are function types. */
  standaloneFuncTypes: number;
}

/**
 * Parse the WASM type section and collect statistics about rec blocks
 * and standalone types.
 */
const analyzeTypeSection = (wasmBytes: Uint8Array): TypeSectionInfo => {
  let pos = 8; // Skip magic + version
  const info: TypeSectionInfo = {
    recBlockCount: 0,
    typesInRecBlocks: 0,
    standaloneTypes: 0,
    standaloneFuncTypes: 0,
  };

  while (pos < wasmBytes.length) {
    const sectionId = wasmBytes[pos++];
    const [sectionSize, nextPos] = readULEB128(wasmBytes, pos);
    pos = nextPos;

    if (sectionId === 1) {
      // Type section
      const sectionEnd = pos + sectionSize;
      const [entryCount, entryPos] = readULEB128(wasmBytes, pos);
      pos = entryPos;

      for (let i = 0; i < entryCount && pos < sectionEnd; i++) {
        if (wasmBytes[pos] === 0x4e) {
          // rec block
          info.recBlockCount++;
          pos++;
          const [recCount, rPos] = readULEB128(wasmBytes, pos);
          pos = rPos;
          info.typesInRecBlocks += recCount;
          for (let j = 0; j < recCount && pos < sectionEnd; j++) {
            pos = skipTypeDef(wasmBytes, pos);
          }
        } else {
          // Standalone type
          const isFunc = isFuncTypeDef(wasmBytes, pos);
          info.standaloneTypes++;
          if (isFunc) info.standaloneFuncTypes++;
          pos = skipTypeDef(wasmBytes, pos);
        }
      }
      break;
    } else {
      pos += sectionSize;
    }
  }

  return info;
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

suite('rec block optimization', () => {
  test('minimal program — function types extracted from rec block', async () => {
    const result = await compileAndRun(`
      export let main = () => 42;
    `);
    assert.strictEqual(result, 42);

    const wasm = compileToWasm(`export let main = () => 42;`);
    const info = analyzeTypeSection(wasm);

    // The minimal program has only function types (no classes/structs).
    // With optimization, all types can be standalone (no rec block needed),
    // OR there's a small rec block for stdlib struct types + standalone func types.
    assert.ok(
      info.standaloneTypes > 0 || info.recBlockCount <= 1,
      `Expected standalone types or at most 1 rec block, got: ${JSON.stringify(info)}`,
    );
  });

  test('minimal program byte size with DCE', () => {
    // With DCE and debug off, `export let main = () => 42;` should produce
    // the smallest possible valid WASM module:
    //   8  magic + version
    //   7  type section (1 standalone bare func type)
    //   4  function section
    //  10  export section ("main")
    //   8  code section (i32.const 42)
    //  --
    //  37  total
    const wasm = compileToWasm('export let main = () => 42;', '/main.zena', {
      dce: true,
      debug: false,
    });
    assert.strictEqual(
      wasm.length,
      37,
      `Expected 37 bytes, got ${wasm.length}`,
    );

    // No rec block — only standalone function types
    const info = analyzeTypeSection(wasm);
    assert.strictEqual(
      info.recBlockCount,
      0,
      'Minimal program should have no rec block',
    );
    assert.strictEqual(
      info.standaloneTypes,
      1,
      'Should have exactly 1 standalone func type',
    );
  });

  test('program with class — struct types in rec block, func types standalone', async () => {
    const result = await compileAndRun(`
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }
      export let main = () => {
        let p = new Point(1, 2);
        return p.x + p.y;
      };
    `);
    assert.strictEqual(result, 3);

    const wasm = compileToWasm(`
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }
      export let main = () => {
        let p = new Point(1, 2);
        return p.x + p.y;
      };
    `);
    const info = analyzeTypeSection(wasm);

    // Struct types go in a rec block; trailing function types are standalone.
    assert.strictEqual(
      info.recBlockCount,
      1,
      'Should have exactly 1 rec block for nominal types',
    );
    assert.ok(
      info.standaloneTypes > 0,
      `Expected some standalone function types, got: ${JSON.stringify(info)}`,
    );
    assert.strictEqual(
      info.standaloneFuncTypes,
      info.standaloneTypes,
      'All standalone types should be function types',
    );
  });

  test('self-referential class compiles and runs correctly', async () => {
    const result = await compileAndRun(`
      class Node {
        value: i32;
        next: Node | null;
        #new(value: i32) {
          this.value = value;
          this.next = null;
        }
      }
      export let main = () => {
        let n = new Node(42);
        return n.value;
      };
    `);
    assert.strictEqual(result, 42);

    const wasm = compileToWasm(`
      class Node {
        value: i32;
        next: Node | null;
        #new(value: i32) {
          this.value = value;
          this.next = null;
        }
      }
      export let main = () => {
        let n = new Node(42);
        return n.value;
      };
    `);
    const info = analyzeTypeSection(wasm);

    assert.strictEqual(
      info.recBlockCount,
      1,
      'Self-referential class needs 1 rec block',
    );
    assert.ok(
      info.typesInRecBlocks > 0,
      'Rec block should contain struct types',
    );
  });

  test('mutually recursive classes compile and run correctly', async () => {
    const result = await compileAndRun(`
      class A {
        b: B | null;
        #new() { this.b = null; }
      }
      class B {
        a: A | null;
        #new() { this.a = null; }
      }
      export let main = () => {
        let a = new A();
        return 42;
      };
    `);
    assert.strictEqual(result, 42);

    const wasm = compileToWasm(`
      class A {
        b: B | null;
        #new() { this.b = null; }
      }
      class B {
        a: A | null;
        #new() { this.a = null; }
      }
      export let main = () => {
        let a = new A();
        return 42;
      };
    `);
    const info = analyzeTypeSection(wasm);

    assert.strictEqual(
      info.recBlockCount,
      1,
      'Mutually recursive classes need 1 rec block',
    );
    assert.ok(
      info.typesInRecBlocks >= 4,
      'Rec block should contain struct types for both classes',
    );
  });

  test('standalone function types reduce rec block size', () => {
    const wasm = compileToWasm(`
      class Foo {
        value: i32;
        #new(v: i32) { this.value = v; }
        getV(): i32 { return this.value; }
        setV(v: i32) { this.value = v; }
      }
      export let main = () => {
        let f = new Foo(10);
        f.setV(20);
        return f.getV();
      };
    `);
    const info = analyzeTypeSection(wasm);
    const totalTypes = info.typesInRecBlocks + info.standaloneTypes;

    // Verify that function types were extracted — rec block should be
    // smaller than total type count.
    assert.ok(
      info.typesInRecBlocks < totalTypes,
      `Rec block (${info.typesInRecBlocks} types) should be smaller than total (${totalTypes})`,
    );
    assert.ok(
      info.standaloneFuncTypes > 0,
      `Should have standalone function types, got: ${JSON.stringify(info)}`,
    );
  });

  test('is-check works correctly after rec block optimization', async () => {
    // This test ensures that brand structs maintain distinct nominal identities
    // even though they may be structurally identical (e.g., i32 box vs boolean box).
    const result = await compileAndRun(`
      class Animal {}
      class Dog extends Animal {}
      class Cat extends Animal {}

      export let main = () => {
        let d: Animal = new Dog();
        if (d is Dog) {
          return 1;
        }
        return 0;
      };
    `);
    assert.strictEqual(result, 1);
  });
});
