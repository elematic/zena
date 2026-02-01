/**
 * Binary size tests for DCE (Dead Code Elimination).
 *
 * These tests measure the size of compiled WASM binaries to verify that
 * unused code is eliminated. When DCE is disabled, the tests verify that
 * programs compile correctly; when enabled, they verify size constraints.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileToWasm} from './utils.js';

/**
 * Compile source with optional DCE and verify it produces valid WASM.
 * Returns the binary size in bytes.
 */
const compileAndValidate = async (
  source: string,
  dce = false,
): Promise<number> => {
  const bytes = compileToWasm(source, '/main.zena', {dce});

  // Validate the WASM is structurally correct
  await WebAssembly.compile(bytes.buffer as ArrayBuffer);

  return bytes.length;
};

suite('Binary Size', () => {
  suite('Minimal Programs', () => {
    test('export main only - no stdlib', async () => {
      const source = `export let main = () => 42;`;

      const sizeNoDce = await compileAndValidate(source, false);
      const sizeWithDce = await compileAndValidate(source, true);

      console.log(`  Without DCE: ${sizeNoDce} bytes`);
      console.log(`  With DCE: ${sizeWithDce} bytes`);

      assert.ok(sizeNoDce > 0, 'Should produce non-empty WASM');
      assert.ok(sizeWithDce > 0, 'Should produce non-empty WASM with DCE');

      // With DCE, size should be smaller or equal
      assert.ok(
        sizeWithDce <= sizeNoDce,
        `DCE should not increase size (${sizeWithDce} > ${sizeNoDce})`,
      );
    });

    test('export constant value', async () => {
      const source = `export let answer = 42;`;

      const sizeNoDce = await compileAndValidate(source, false);
      const sizeWithDce = await compileAndValidate(source, true);

      console.log(`  Without DCE: ${sizeNoDce} bytes`);
      console.log(`  With DCE: ${sizeWithDce} bytes`);

      assert.ok(sizeNoDce > 0, 'Should produce non-empty WASM');
      assert.ok(sizeWithDce > 0, 'Should produce non-empty WASM with DCE');
    });
  });

  suite('String Usage', () => {
    test('export string literal', async () => {
      const source = `export let main = () => "hello";`;

      const sizeNoDce = await compileAndValidate(source, false);
      const sizeWithDce = await compileAndValidate(source, true);

      console.log(`  Without DCE: ${sizeNoDce} bytes`);
      console.log(`  With DCE: ${sizeWithDce} bytes`);

      assert.ok(sizeNoDce > 0, 'Should produce non-empty WASM');
      assert.ok(sizeWithDce > 0, 'Should produce non-empty WASM with DCE');
    });

    test('string with length access', async () => {
      const source = `export let main = () => "hello".length;`;

      const sizeNoDce = await compileAndValidate(source, false);
      const sizeWithDce = await compileAndValidate(source, true);

      console.log(`  Without DCE: ${sizeNoDce} bytes`);
      console.log(`  With DCE: ${sizeWithDce} bytes`);

      assert.ok(sizeNoDce > 0, 'Should produce non-empty WASM');
      assert.ok(sizeWithDce > 0, 'Should produce non-empty WASM with DCE');
    });
  });

  suite('Unused Declarations', () => {
    test('unused function is eliminated with DCE', async () => {
      const withUnused = `
        let unused = () => 999;
        export let main = () => 42;
      `;
      const withoutUnused = `
        export let main = () => 42;
      `;

      // Without DCE
      const sizeWithNoDce = await compileAndValidate(withUnused, false);
      const sizeWithoutNoDce = await compileAndValidate(withoutUnused, false);

      // With DCE
      const sizeWithDce = await compileAndValidate(withUnused, true);
      const sizeWithoutDce = await compileAndValidate(withoutUnused, true);

      console.log(`  Without DCE - with unused: ${sizeWithNoDce} bytes`);
      console.log(`  Without DCE - without unused: ${sizeWithoutNoDce} bytes`);
      console.log(`  With DCE - with unused: ${sizeWithDce} bytes`);
      console.log(`  With DCE - without unused: ${sizeWithoutDce} bytes`);

      // Without DCE, unused function adds size
      assert.ok(
        sizeWithNoDce > sizeWithoutNoDce,
        'Without DCE, unused function should add size',
      );

      // With DCE, unused function should be eliminated - sizes should be equal
      assert.strictEqual(
        sizeWithDce,
        sizeWithoutDce,
        `With DCE, unused function should be eliminated (${sizeWithDce} != ${sizeWithoutDce})`,
      );
    });

    test('unused class is eliminated with DCE', async () => {
      const withUnused = `
        class Unused {
          x: i32;
          #new() { this.x = 0; }
        }
        export let main = () => 42;
      `;
      const withoutUnused = `
        export let main = () => 42;
      `;

      // Without DCE
      const sizeWithNoDce = await compileAndValidate(withUnused, false);
      const sizeWithoutNoDce = await compileAndValidate(withoutUnused, false);

      // With DCE
      const sizeWithDce = await compileAndValidate(withUnused, true);
      const sizeWithoutDce = await compileAndValidate(withoutUnused, true);

      console.log(`  Without DCE - with unused: ${sizeWithNoDce} bytes`);
      console.log(`  Without DCE - without unused: ${sizeWithoutNoDce} bytes`);
      console.log(`  With DCE - with unused: ${sizeWithDce} bytes`);
      console.log(`  With DCE - without unused: ${sizeWithoutDce} bytes`);

      // Without DCE, unused class adds significant size
      assert.ok(
        sizeWithNoDce > sizeWithoutNoDce,
        'Without DCE, unused class should add size',
      );

      // With DCE, unused class should be eliminated - sizes should be equal
      assert.strictEqual(
        sizeWithDce,
        sizeWithoutDce,
        `With DCE, unused class should be eliminated (${sizeWithDce} != ${sizeWithoutDce})`,
      );
    });
  });

  suite('Transitive Usage', () => {
    test('transitively used function is kept with DCE', async () => {
      const source = `
        let helper = () => 1;
        let used = () => helper();
        export let main = () => used();
      `;

      const sizeNoDce = await compileAndValidate(source, false);
      const sizeWithDce = await compileAndValidate(source, true);

      console.log(`  Without DCE: ${sizeNoDce} bytes`);
      console.log(`  With DCE: ${sizeWithDce} bytes`);

      // With DCE, transitive dependencies should still be included
      // Size will be much smaller because stdlib is eliminated, but program should work
      assert.ok(
        sizeWithDce < sizeNoDce,
        'DCE should reduce size by eliminating stdlib',
      );

      // Verify the program works correctly with DCE
      const bytes = compileToWasm(source, '/main.zena', {dce: true});
      const result = await WebAssembly.instantiate(
        bytes.buffer as ArrayBuffer,
        {
          console: {
            log_i32: () => {},
            log_f32: () => {},
            log_string: () => {},
            error_string: () => {},
            warn_string: () => {},
            info_string: () => {},
            debug_string: () => {},
          },
        },
      );
      const exports = result.instance.exports as {main: () => number};
      assert.strictEqual(
        exports.main(),
        1,
        'Should return 1 from helper chain',
      );
    });
  });

  suite('Size Comparisons', () => {
    test('string usage adds size compared to minimal', async () => {
      const minimal = `export let main = () => 42;`;
      const withString = `export let main = () => "hello";`;

      const minimalSize = await compileAndValidate(minimal, true);
      const stringSize = await compileAndValidate(withString, true);

      console.log(`  Minimal (DCE): ${minimalSize} bytes`);
      console.log(`  With string (DCE): ${stringSize} bytes`);
      console.log(`  Difference: ${stringSize - minimalSize} bytes`);

      // String usage should add size (String class, data, helpers)
      assert.ok(
        stringSize > minimalSize,
        'String usage should require more code than minimal program',
      );
    });
  });

  suite('Method-level DCE', () => {
    test('unused method is eliminated with DCE', async () => {
      const withUnusedMethod = `
        class Counter {
          #value: i32;
          #new() { this.#value = 0; }
          increment(): i32 { return this.#value = this.#value + 1; }
          decrement(): i32 { return this.#value = this.#value - 1; }
          getValue(): i32 { return this.#value; }
        }
        export let main = () => {
          let c = new Counter();
          c.increment();
          return c.getValue();
        };
      `;
      const withoutUnusedMethod = `
        class Counter {
          #value: i32;
          #new() { this.#value = 0; }
          increment(): i32 { return this.#value = this.#value + 1; }
          getValue(): i32 { return this.#value; }
        }
        export let main = () => {
          let c = new Counter();
          c.increment();
          return c.getValue();
        };
      `;

      // With DCE
      const sizeWithUnused = await compileAndValidate(withUnusedMethod, true);
      const sizeWithoutUnused = await compileAndValidate(
        withoutUnusedMethod,
        true,
      );

      console.log(`  With unused method (DCE): ${sizeWithUnused} bytes`);
      console.log(`  Without unused method (DCE): ${sizeWithoutUnused} bytes`);

      // With DCE, unused method should be eliminated - sizes should be equal
      assert.strictEqual(
        sizeWithUnused,
        sizeWithoutUnused,
        `With DCE, unused method should be eliminated (${sizeWithUnused} != ${sizeWithoutUnused})`,
      );
    });

    test('unused getter is eliminated with DCE', async () => {
      const withUnusedGetter = `
        class Point {
          #x: i32;
          #y: i32;
          #new(x: i32, y: i32) { this.#x = x; this.#y = y; }
          x: i32 { get { return this.#x; } }
          y: i32 { get { return this.#y; } }
        }
        export let main = () => {
          let p = new Point(10, 20);
          return p.x;
        };
      `;
      const withoutUnusedGetter = `
        class Point {
          #x: i32;
          #y: i32;
          #new(x: i32, y: i32) { this.#x = x; this.#y = y; }
          x: i32 { get { return this.#x; } }
        }
        export let main = () => {
          let p = new Point(10, 20);
          return p.x;
        };
      `;

      // With DCE
      const sizeWithUnused = await compileAndValidate(withUnusedGetter, true);
      const sizeWithoutUnused = await compileAndValidate(
        withoutUnusedGetter,
        true,
      );

      console.log(`  With unused getter (DCE): ${sizeWithUnused} bytes`);
      console.log(`  Without unused getter (DCE): ${sizeWithoutUnused} bytes`);

      // With DCE, unused getter should be eliminated - sizes should be equal
      assert.strictEqual(
        sizeWithUnused,
        sizeWithoutUnused,
        `With DCE, unused getter should be eliminated (${sizeWithUnused} != ${sizeWithoutUnused})`,
      );
    });

    test('unused implicit field getter is eliminated with DCE', async () => {
      // Test that a field's getter is eliminated when it's never read
      // Both programs have 2 fields, but only the first reads both, second reads only one
      const usesAllGetters = `
        class Person {
          name: i32;
          age: i32;
          #new(n: i32, a: i32) { this.name = n; this.age = a; }
        }
        export let main = () => {
          let p = new Person(1, 25);
          return p.name + p.age;
        };
      `;
      const usesOneGetter = `
        class Person {
          name: i32;
          age: i32;
          #new(n: i32, a: i32) { this.name = n; this.age = a; }
        }
        export let main = () => {
          let p = new Person(1, 25);
          return p.name;
        };
      `;

      // With DCE
      const sizeUsesAll = await compileAndValidate(usesAllGetters, true);
      const sizeUsesOne = await compileAndValidate(usesOneGetter, true);

      console.log(`  Uses both getters (DCE): ${sizeUsesAll} bytes`);
      console.log(`  Uses one getter (DCE): ${sizeUsesOne} bytes`);

      // With DCE, unused getter (get#age) should be eliminated
      // Size difference should be significant (getter function = ~15-30 bytes)
      assert.ok(
        sizeUsesOne < sizeUsesAll,
        `With DCE, unused getter should be eliminated (${sizeUsesOne} should be < ${sizeUsesAll})`,
      );
    });

    test('polymorphic method is kept for all subclasses', async () => {
      // When a method is called polymorphically through a base class,
      // all overrides must be kept (cannot be eliminated)
      const source = `
        class Animal {
          speak(): i32 { return 0; }
        }
        class Dog extends Animal {
          speak(): i32 { return 1; }
        }
        class Cat extends Animal {
          speak(): i32 { return 2; }
        }
        export let main = () => {
          let a: Animal = new Dog();
          return a.speak();
        };
      `;

      // This should compile successfully with DCE
      // Even though Cat is not instantiated, its speak() is kept because
      // Animal.speak() is called polymorphically
      const size = await compileAndValidate(source, true);
      console.log(`  Polymorphic method call (DCE): ${size} bytes`);
      assert.ok(size > 0, 'Should produce valid WASM');
    });

    test('multiple unused methods are all eliminated', async () => {
      const manyUnusedMethods = `
        class BigClass {
          #value: i32;
          #new() { this.#value = 0; }
          method1(): i32 { return 1; }
          method2(): i32 { return 2; }
          method3(): i32 { return 3; }
          method4(): i32 { return 4; }
          method5(): i32 { return 5; }
          getValue(): i32 { return this.#value; }
        }
        export let main = () => {
          let b = new BigClass();
          return b.getValue();
        };
      `;
      const minimalMethods = `
        class BigClass {
          #value: i32;
          #new() { this.#value = 0; }
          getValue(): i32 { return this.#value; }
        }
        export let main = () => {
          let b = new BigClass();
          return b.getValue();
        };
      `;

      // With DCE
      const sizeWithUnused = await compileAndValidate(manyUnusedMethods, true);
      const sizeMinimal = await compileAndValidate(minimalMethods, true);

      console.log(`  With 5 unused methods (DCE): ${sizeWithUnused} bytes`);
      console.log(`  Minimal methods (DCE): ${sizeMinimal} bytes`);

      // With DCE, all 5 unused methods should be eliminated - sizes should be equal
      assert.strictEqual(
        sizeWithUnused,
        sizeMinimal,
        `With DCE, all unused methods should be eliminated (${sizeWithUnused} != ${sizeMinimal})`,
      );
    });
  });
});
