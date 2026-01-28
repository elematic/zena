import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker: Type Narrowing', () => {
  suite('null checks with !==', () => {
    test('should narrow nullable type after !== null check', () => {
      const input = `
        class Node {
          value: i32;
          next: Node | null;
          #new(value: i32) {
            this.value = value;
            this.next = null;
          }
        }

        let process = (node: Node | null): void => {
          if (node !== null) {
            let v = node.value;
          }
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.deepStrictEqual(
        errors.map((e) => e.message),
        [],
      );
    });

    test('should narrow nullable type after null !== x check', () => {
      const input = `
        class Node {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (node: Node | null): void => {
          if (null !== node) {
            let v = node.value;
          }
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.deepStrictEqual(
        errors.map((e) => e.message),
        [],
      );
    });

    test('should not narrow in else branch (variable is null)', () => {
      // In the else branch, we know node IS null, so accessing .value should fail
      const input = `
        class Node {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (node: Node | null): void => {
          if (node !== null) {
            let v = node.value;
          } else {
            let v = node.value;
          }
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].message, /null/);
    });

    test('should restore original type after if block', () => {
      const input = `
        class Node {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (node: Node | null): void => {
          if (node !== null) {
            let v = node.value;
          }
          if (node !== null) {
            let v2 = node.value;
          }
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.deepStrictEqual(
        errors.map((e) => e.message),
        [],
      );
    });
  });

  suite('null checks with !=', () => {
    test('should narrow nullable type after != null check', () => {
      const input = `
        class Node {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (node: Node | null): void => {
          if (node != null) {
            let v = node.value;
          }
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.deepStrictEqual(
        errors.map((e) => e.message),
        [],
      );
    });
  });

  suite('non-narrowing conditions', () => {
    test('should narrow to null on == null (truthy branch means null)', () => {
      // With == null, the truthy branch means the value IS null
      const input = `
        class Node {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (node: Node | null): void => {
          if (node == null) {
            let v = node.value;
          }
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      // Should error because node is null in this branch
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].message, /null/);
    });

    test('should narrow to non-null in else branch of == null', () => {
      const input = `
        class Node {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (node: Node | null): void => {
          if (node == null) {
            // can't use node here
          } else {
            // node is NOT null here
            let v = node.value;
          }
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.deepStrictEqual(
        errors.map((e) => e.message),
        [],
      );
    });

    test('should narrow with === null', () => {
      const input = `
        class Node {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (node: Node | null): void => {
          if (node === null) {
            // node is null
          } else {
            // node is NOT null
            let v = node.value;
          }
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.deepStrictEqual(
        errors.map((e) => e.message),
        [],
      );
    });
  });

  suite('nested narrowing', () => {
    test('should support narrowing in nested if statements', () => {
      const input = `
        class Node {
          value: i32;
          next: Node | null;
          #new(value: i32) {
            this.value = value;
            this.next = null;
          }
        }

        let process = (node: Node | null): void => {
          if (node !== null) {
            let v = node.value;
            let next = node.next;
            if (next !== null) {
              let v2 = next.value;
            }
          }
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.deepStrictEqual(
        errors.map((e) => e.message),
        [],
      );
    });
  });

  suite('is expression narrowing', () => {
    test('should narrow type after is check', () => {
      const input = `
        class Animal {
          name: string;
          #new(name: string) {
            this.name = name;
          }
        }

        class Dog extends Animal {
          breed: string;
          #new(name: string, breed: string) {
            super(name);
            this.breed = breed;
          }
        }

        let process = (animal: Animal): string => {
          if (animal is Dog) {
            return animal.breed;
          }
          return animal.name;
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.deepStrictEqual(
        errors.map((e) => e.message),
        [],
      );
    });

    test('should narrow union type with is check', () => {
      const input = `
        class Cat {
          #new() {}
          meow(): string { return "meow"; }
        }

        class Dog {
          #new() {}
          bark(): string { return "woof"; }
        }

        let process = (pet: Cat | Dog): string => {
          if (pet is Cat) {
            return pet.meow();
          }
          return "unknown";
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.deepStrictEqual(
        errors.map((e) => e.message),
        [],
      );
    });

    test('should narrow in else branch of is check', () => {
      const input = `
        class Cat {
          #new() {}
          meow(): string { return "meow"; }
        }

        class Dog {
          #new() {}
          bark(): string { return "woof"; }
        }

        let process = (pet: Cat | Dog): string => {
          if (pet is Cat) {
            return pet.meow();
          } else {
            return pet.bark();
          }
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.deepStrictEqual(
        errors.map((e) => e.message),
        [],
      );
    });

    test('should error when accessing wrong property after is check', () => {
      const input = `
        class Cat {
          #new() {}
          meow(): string { return "meow"; }
        }

        class Dog {
          #new() {}
          bark(): string { return "woof"; }
        }

        let process = (pet: Cat | Dog): string => {
          if (pet is Cat) {
            return pet.bark();
          }
          return "unknown";
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      // Expect at least one error about 'bark' not existing on Cat
      assert.ok(errors.length >= 1);
      assert.ok(errors.some((e) => e.message.includes('bark')));
    });
  });
});
