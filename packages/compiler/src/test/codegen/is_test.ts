import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Is Operator', () => {
  test('should check class instances correctly', async () => {
    const source = `
      class Animal {}
      class Dog extends Animal {}
      class Cat extends Animal {}

      export let main = (): i32 => {
        let a: Animal = new Dog();
        let b: Animal = new Cat();
        let c: Animal = new Animal();
        let n: Animal | null = null;

        if (!(a is Dog)) return 1;
        if (a is Cat) return 2;
        if (b is Dog) return 3;
        if (!(b is Cat)) return 4;
        if (c is Dog) return 5;
        if (c is Cat) return 6;
        if (!(c is Animal)) return 7;
        
        if (n is Animal) return 8; // null is not Animal
        if (n is Dog) return 9;

        return 0;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });

  test('should discriminate class types behind anyref', async () => {
    const source = `
      class Cat { lives: i32; new(this.lives); }
      class Dog { tricks: i32; new(this.tricks); }
      export let main = (): i32 => {
        let x: anyref = new Cat(9);
        if (!(x is Cat)) return 10;
        if (x is Dog) return 11;

        let s: anyref = "hello";
        if (!(s is String)) return 12;
        if (s is Cat) return 13;

        return 0;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });

  test('should check primitives (direct)', async () => {
    const source = `
        export let main = (): i32 => {
          let x = 10;
          if (!(x is i32)) return 1;
          // if (x is f32) return 2; // This should be a compile error or false?
          // Currently checker allows it but codegen might fail or return false.
          // Since x is i32, x is f32 is statically false.
          // But let's see what happens.
          
          return 0;
        };
      `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });
});
