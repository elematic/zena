import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compile} from '../../lib/index.js';

suite('CodeGenerator - Casts', () => {
  test('should compile and run valid downcast', async () => {
    const source = `
      class Animal {
        name: string;
        #new(name: string) { this.name = name; }
      }
      class Dog extends Animal {
        breed: string;
        #new(name: string, breed: string) {
          super(name);
          this.breed = breed;
        }
      }

      export let main = (): boolean => {
        let a: Animal = new Dog("Buddy", "Golden");
        let d = a as Dog;
        // TODO (justinfagnani): we shouldn't need the parens
        return (d.breed == "Golden");
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm);
    const {main} = module.instance.exports;
    assert.strictEqual(main(), 1); // boolean true is 1
  });

  test('should trap on invalid downcast', async () => {
    const source = `
      class Animal {
        name: string;
        #new(name: string) { this.name = name; }
      }
      class Dog extends Animal {
        breed: string;
        #new(name: string, breed: string) {
          super(name);
          this.breed = breed;
        }
      }
      class Cat extends Animal {
        lives: i32;
        #new(name: string) {
          super(name);
          this.lives = 9;
        }
      }

      export let main = (): void => {
        let a: Animal = new Cat("Whiskers");
        let d = a as Dog; // Should trap
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm);
    const {main} = module.instance.exports;

    try {
      main();
      assert.fail('Should have trapped');
    } catch (e: any) {
      // WebAssembly.RuntimeError: null function or func signature mismatch or similar
      // The exact error message depends on the engine, but it should be a RuntimeError
      assert.ok(
        e instanceof WebAssembly.RuntimeError,
        'Expected WebAssembly.RuntimeError',
      );
    }
  });

  test.skip('should cast anyref to specific type', async () => {
    const source = `
      class Box {
        value: i32;
        #new(v: i32) { this.value = v; }
      }

      export let main = (): i32 => {
        let b = new Box(42);
        let a: anyref = b; // Implicit upcast to anyref (if supported, or maybe explicit?)
        // Actually Zena might not support implicit upcast to anyref yet without 'as anyref'
        // Let's try explicit if needed, or just rely on assignment compatibility if it exists.
        // Assuming assignment to anyref works.
        
        let b2 = a as Box;
        return b2.value;
      };
    `;
    // Note: 'anyref' might not be directly exposed as a type keyword in Zena yet,
    // but 'any' might be, or we might need to use a generic function to get an anyref.
    // Let's check if 'anyref' is a valid type annotation.
    // Based on previous grep, 'anyref' maps to ValType.anyref in mapType.

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm);
    const {main} = module.instance.exports;
    assert.strictEqual(main(), 42);
  });
});
