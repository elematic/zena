import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker.js';

suite('TypeChecker - Inheritance', () => {
  test('should check valid inheritance', () => {
    const input = `
      class Animal {
        name: string;
        speak(): void {}
      }
      class Dog extends Animal {
        breed: string;
        bark(): void {}
      }
      let d = new Dog();
      d.name = "Rex";
      d.breed = "Lab";
      d.speak();
      d.bark();
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.deepStrictEqual(errors, []);
  });

  test('should detect unknown superclass', () => {
    const input = `
      class Dog extends Animal { }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Unknown superclass 'Animal'/);
  });

  test('should detect non-class superclass', () => {
    const input = `
      let Animal = 1;
      class Dog extends Animal { }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Superclass 'Animal' must be a class/);
  });

  test('should detect field redeclaration', () => {
    const input = `
      class Animal {
        name: string;
      }
      class Dog extends Animal {
        name: string;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Cannot redeclare field 'name' in subclass 'Dog'/,
    );
  });

  test('should allow valid method override', () => {
    const input = `
      class Animal {
        speak(): void {}
      }
      class Dog extends Animal {
        speak(): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.deepStrictEqual(errors, []);
  });

  test('should detect invalid method override', () => {
    const input = `
      class Animal {
        speak(): void {}
      }
      class Dog extends Animal {
        speak(volume: i32): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();
    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Method 'speak' in 'Dog' incorrectly overrides method in 'Animal'/,
    );
  });
});
