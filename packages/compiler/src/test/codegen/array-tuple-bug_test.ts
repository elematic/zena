import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun, compileAndInstantiate} from './utils.js';

suite('array of tuples bug', () => {
  test('Array<[i32, i32]> - tuple of primitives basic', async () => {
    const result = await compileAndRun(`
      import { Array } from 'zena:growable-array';

      export let main = (): i32 => {
        let chunks = new Array<[i32, i32]>();
        chunks.push([10, 20]);
        let [a, b] = chunks[0];
        return a + b;
      };
    `);
    assert.strictEqual(result, 30);
  });

  // Test nullable array of tuples WITHOUT cache
  test('Array<[Descriptor, string]> | null - nullable array', async () => {
    const result = await compileAndRun(`
      import { Array } from 'zena:growable-array';

      class Descriptor {
        handle: i32;
        #new(h: i32) { this.handle = h; }
      }

      export let main = (): i32 => {
        var arr: Array<[Descriptor, string]> | null = null;
        
        // Initialize
        let newArr = new Array<[Descriptor, string]>();
        newArr.push([new Descriptor(42), "hello"]);
        arr = newArr;
        
        // Access
        let a = arr;
        if (a != null) {
          let [desc, name] = a[0];
          return desc.handle + name.length;
        }
        return -1;
      };
    `);
    assert.strictEqual(result, 47); // 42 + 5
  });

  // Test global nullable array of tuples (the actual pattern from fs.zena)
  test('global Array<[Descriptor, string]> | null', async () => {
    const result = await compileAndRun(`
      import { Array } from 'zena:growable-array';

      class Descriptor {
        handle: i32;
        #new(h: i32) { this.handle = h; }
      }

      // Global cache like in fs.zena
      var __cache: Array<[Descriptor, string]> | null = null;

      export let main = (): i32 => {
        // Initialize
        let newArr = new Array<[Descriptor, string]>();
        newArr.push([new Descriptor(42), "hello"]);
        __cache = newArr;
        
        // Access through cache
        let cached = __cache;
        if (cached != null) {
          let [desc, name] = cached[0];
          return desc.handle + name.length;
        }
        return -1;
      };
    `);
    assert.strictEqual(result, 47); // 42 + 5
  });

  // Test that (i as string) is rejected by the checker
  test('rejects (i32 as string) cast at compile time', async () => {
    await assert.rejects(
      () =>
        compileAndInstantiate(`
        export let main = (): i32 => {
          var i = 42;
          let s = i as string;
          return s.length;
        };
      `),
      /Cannot cast primitive type 'i32' to reference type 'String'/,
    );
  });

  // Test that (boolean as string) is also rejected
  test('rejects (boolean as string) cast at compile time', async () => {
    await assert.rejects(
      () =>
        compileAndInstantiate(`
        export let main = (): i32 => {
          let b = true;
          let s = b as string;
          return s.length;
        };
      `),
      /Cannot cast primitive type 'true' to reference type 'String'/,
    );
  });

  // Control: same thing without cast (using string literals)
  test('Array<[class, string]> in loop without cast', async () => {
    const result = await compileAndRun(`
      import { Array } from 'zena:growable-array';

      class Descriptor {
        handle: i32;
        #new(h: i32) { this.handle = h; }
      }

      export let main = (): i32 => {
        let result = new Array<[Descriptor, string]>();
        
        for (var i = 0; i < 2; i = i + 1) {
          let path = "path";
          result.push([new Descriptor(10 + i), path]);
        }
        
        let [desc, path] = result[0];
        return desc.handle + path.length;
      };
    `);
    assert.strictEqual(result, 14); // handle 10 + path length 4 ("path")
  });

  // Simpler version without null union
  test('Array<[Descriptor, string]> - simple push and access', async () => {
    const result = await compileAndRun(`
      import { Array } from 'zena:growable-array';

      class Descriptor {
        handle: i32;
        #new(h: i32) { this.handle = h; }
      }

      export let main = (): i32 => {
        let arr = new Array<[Descriptor, string]>();
        arr.push([new Descriptor(42), "hello"]);
        let [desc, name] = arr[0];
        return desc.handle + name.length;
      };
    `);
    assert.strictEqual(result, 47); // 42 + 5
  });

  // Test try-catch returning boolean (related bug)
  test('try-catch returning boolean', async () => {
    const result = await compileAndRun(`
      import { Error } from 'zena:error';
      
      export let main = (): i32 => {
        let b = try {
          true
        } catch (e) {
          false
        };
        if (b) { return 1; }
        return 0;
      };
    `);
    assert.strictEqual(result, 1);
  });

  // Test try-catch with enum comparison (closer to fs.zena pattern)
  test('try-catch with enum comparison', async () => {
    const result = await compileAndRun(`
      import { Error } from 'zena:error';
      
      enum FileType {
        Unknown,
        File,
        Directory,
      }
      
      class Stat {
        fileType: FileType;
        #new(t: FileType) { this.fileType = t; }
      }
      
      let getStat = (): Stat => new Stat(FileType.File);
      
      export let main = (): i32 => {
        let b = try {
          let stat = getStat();
          stat.fileType == FileType.File
        } catch (e) {
          false
        };
        if (b) { return 1; }
        return 0;
      };
    `);
    assert.strictEqual(result, 1);
  });

  // Test try-catch returning i32 (i32 | literal number union)
  test('try-catch returning i32 with literal fallback', async () => {
    const result = await compileAndRun(`
      import { Error } from 'zena:error';
      
      let getValue = (): i32 => 42;
      
      export let main = (): i32 => {
        // This creates i32 | 0 union, which should collapse to i32
        let v = try {
          getValue()
        } catch (e) {
          0
        };
        return v;
      };
    `);
    assert.strictEqual(result, 42);
  });
});
