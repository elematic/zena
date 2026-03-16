import {strict as assert} from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';

const check = (source: string) => {
  const parser = new Parser(source);
  const module = parser.parse();
  const checker = TypeChecker.forModule(module);
  return checker.check();
};

const expectError = (source: string, messagePattern: RegExp | string) => {
  const diagnostics = check(source);
  assert.ok(diagnostics.length > 0, 'Expected at least one error');
  const pattern =
    typeof messagePattern === 'string'
      ? new RegExp(messagePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      : messagePattern;
  assert.ok(
    diagnostics.some((d) => pattern.test(d.message)),
    `Expected error matching ${pattern}, got: ${diagnostics.map((d) => d.message).join(', ')}`,
  );
};

const expectNoErrors = (source: string) => {
  const diagnostics = check(source);
  assert.equal(
    diagnostics.length,
    0,
    `Expected no errors, got: ${diagnostics.map((d) => d.message).join(', ')}`,
  );
};

suite('Field Initialization Required', () => {
  suite('Classes with constructors', () => {
    test('reports error for uninitialized non-nullable field', () => {
      expectError(
        `
        class Foo {
          x: i32;
          new() {}
        }
        `,
        "Field 'x' must be initialized",
      );
    });

    test('allows field with inline initializer', () => {
      expectNoErrors(`
        class Foo {
          x: i32 = 0;
          new() {}
        }
      `);
    });

    test('allows field initialized in initializer list', () => {
      expectNoErrors(`
        class Foo {
          x: i32;
          new() : x = 0 {}
        }
      `);
    });

    test('allows nullable field without initializer', () => {
      expectNoErrors(`
        class Bar {}
        class Foo {
          x: Bar | null;
          new() {}
        }
      `);
    });

    test('reports error for non-nullable reference field', () => {
      expectError(
        `
        class Bar {
          y: i32 = 0;
        }
        class Foo {
          x: Bar;
          new() {}
        }
        `,
        "Field 'x' must be initialized",
      );
    });

    test('allows initializer list with private field', () => {
      expectNoErrors(`
        class Foo {
          #x: i32;
          new() : #x = 0 {}
        }
      `);
    });

    test('reports error for uninitialized private field', () => {
      expectError(
        `
        class Foo {
          #x: i32;
          new() {}
        }
        `,
        "Field '#x' must be initialized",
      );
    });

    test('does not report error for inherited fields', () => {
      expectNoErrors(`
        class Base {
          x: i32 = 0;
        }
        class Derived extends Base {
          new() : super() {}
        }
      `);
    });

    test('reports error for own field in derived class', () => {
      expectError(
        `
        class Base {
          x: i32 = 0;
        }
        class Derived extends Base {
          y: i32;
          new() : super() {}
        }
        `,
        "Field 'y' must be initialized",
      );
    });

    test('allows derived class with own field initialized', () => {
      expectNoErrors(`
        class Base {
          x: i32 = 0;
        }
        class Derived extends Base {
          y: i32;
          new() : y = 1, super() {}
        }
      `);
    });

    test('requires boolean field initialization', () => {
      // Booleans are NOT nullable, so they need initialization
      expectError(
        `
        class Foo {
          flag: boolean;
          new() {}
        }
        `,
        "Field 'flag' must be initialized",
      );
    });

    test('allows boolean field with inline initializer', () => {
      expectNoErrors(`
        class Foo {
          flag: boolean = false;
          new() {}
        }
      `);
    });
  });

  suite('Classes without constructors', () => {
    test('reports error for uninitialized non-nullable field', () => {
      expectError(
        `
        class Foo {
          x: i32;
        }
        `,
        "Field 'x' must be initialized",
      );
    });

    test('allows all fields with initializers', () => {
      expectNoErrors(`
        class Foo {
          x: i32 = 0;
          y: boolean = false;
        }
      `);
    });

    test('allows nullable fields without initializers', () => {
      expectNoErrors(`
        class Bar {
          y: i32 = 0;
        }
        class Foo {
          x: Bar | null;
        }
      `);
    });

    test('reports error for multiple uninitialized fields', () => {
      expectError(
        `
        class Foo {
          x: i32;
          y: boolean;
        }
        `,
        "Field 'x' must be initialized",
      );
    });

    test('does not require constructor for class with only nullable fields', () => {
      expectNoErrors(`
        class Bar {
          y: i32 = 0;
        }
        class Foo {
          x: Bar | null;
          y: Bar | null;
        }
      `);
    });
  });

  suite('Abstract classes', () => {
    test('allows abstract class with uninitialized fields', () => {
      // Abstract classes cannot be instantiated directly, so they don't need
      // to have all fields initialized - the concrete subclass will handle it
      expectNoErrors(`
        abstract class Base {
          x: i32;
        }
      `);
    });

    test('concrete subclass must initialize own fields', () => {
      expectError(
        `
        abstract class Base {
          x: i32;
        }
        class Derived extends Base {
          y: i32;
          new() : x = 0, super() {}
        }
        `,
        "Field 'y' must be initialized",
      );
    });

    test('concrete subclass can initialize inherited abstract fields', () => {
      expectNoErrors(`
        abstract class Base {
          x: i32;
        }
        class Derived extends Base {
          new() : x = 0, super() {}
        }
      `);
    });
  });
});
