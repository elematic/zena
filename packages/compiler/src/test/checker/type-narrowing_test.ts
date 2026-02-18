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

  suite('immutable field narrowing', () => {
    test('should narrow immutable field after null check', () => {
      const input = `
        class Container {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        class Wrapper {
          let inner: Container | null;
          #new() : inner = null { }
        }

        let process = (w: Wrapper): i32 => {
          if (w.inner !== null) {
            return w.inner.value;
          }
          return 0;
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

    test('should NOT narrow mutable field after null check', () => {
      const input = `
        class Container {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        class Wrapper {
          var inner: Container | null;
          #new() {
            this.inner = null;
          }
        }

        let process = (w: Wrapper): i32 => {
          if (w.inner !== null) {
            // This should error - field is mutable, could change
            return w.inner.value;
          }
          return 0;
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      // Should have an error because mutable field can't be narrowed
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].message, /null/);
    });

    test('should narrow immutable field to null in else branch', () => {
      const input = `
        class Container {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        class Wrapper {
          let inner: Container | null;
          #new() : inner = null { }
        }

        let process = (w: Wrapper): i32 => {
          if (w.inner !== null) {
            return w.inner.value;
          } else {
            // w.inner is null here, accessing value should error
            return w.inner.value;
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

    test('should narrow immutable nested field', () => {
      const input = `
        class Inner {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        class Middle {
          let inner: Inner | null;
          #new() : inner = null { }
        }

        class Outer {
          let middle: Middle;
          #new(m: Middle) : middle = m { }
        }

        let process = (o: Outer): i32 => {
          if (o.middle.inner !== null) {
            return o.middle.inner.value;
          }
          return 0;
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

    test('should NOT narrow if any field in chain is mutable', () => {
      const input = `
        class Inner {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        class Middle {
          let inner: Inner | null;
          #new() : inner = null { }
        }

        class Outer {
          var middle: Middle;
          #new(m: Middle) {
            this.middle = m;
          }
        }

        let process = (o: Outer): i32 => {
          if (o.middle.inner !== null) {
            // This should error - o.middle is mutable
            return o.middle.inner.value;
          }
          return 0;
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      // Should error because mutable field in chain prevents narrowing
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].message, /null/);
    });
  });

  suite('record field narrowing', () => {
    test('should narrow record field after null check', () => {
      const input = `
        class Container {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (r: {inner: Container | null}): i32 => {
          if (r.inner !== null) {
            return r.inner.value;
          }
          return 0;
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

    test('should narrow nested record field after null check', () => {
      const input = `
        class Container {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (r: {outer: {inner: Container | null}}): i32 => {
          if (r.outer.inner !== null) {
            return r.outer.inner.value;
          }
          return 0;
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

    test('should narrow record field to null in else branch', () => {
      const input = `
        class Container {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (r: {inner: Container | null}): i32 => {
          if (r.inner !== null) {
            return r.inner.value;
          } else {
            // r.inner is null here, accessing value should error
            return r.inner.value;
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
  });

  suite('tuple element narrowing', () => {
    test('should narrow tuple element after null check', () => {
      const input = `
        class Container {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (t: [Container | null, i32]): i32 => {
          if (t[0] !== null) {
            return t[0].value;
          }
          return 0;
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

    test('should narrow tuple element to null in else branch', () => {
      const input = `
        class Container {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (t: [Container | null, i32]): i32 => {
          if (t[0] !== null) {
            return t[0].value;
          } else {
            // t[0] is null here, accessing value should error
            return t[0].value;
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

    test('should narrow nested tuple element', () => {
      const input = `
        class Container {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (t: [[Container | null, i32], string]): i32 => {
          if (t[0][0] !== null) {
            return t[0][0].value;
          }
          return 0;
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

  suite('compile-time known tuple indices', () => {
    test('should support let variable with literal value as index', () => {
      const input = `
        class Container {
          value: i32;
          #new(value: i32) {
            this.value = value;
          }
        }

        let process = (t: [Container | null, i32]): i32 => {
          let idx = 0;
          if (t[idx] !== null) {
            return t[idx].value;
          }
          return 0;
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

    test('should support tuple access with let index', () => {
      const input = `
        let getTupleElement = (t: [i32, string]): i32 => {
          let idx = 0;
          return t[idx];
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

    test('should error on var index (not compile-time known)', () => {
      const input = `
        let getTupleElement = (t: [i32, string]): i32 => {
          var idx = 0;
          return t[idx];
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].message, /compile-time known/);
    });

    test('should error on parameter index (not compile-time known)', () => {
      const input = `
        let getTupleElement = (t: [i32, string], idx: i32): i32 => {
          return t[idx];
        };
      `;
      const parser = new Parser(input);
      const ast = parser.parse();
      const checker = TypeChecker.forModule(ast);
      const errors = checker.check();

      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].message, /compile-time known/);
    });
  });
});
