import assert from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

function checkSource(source: string) {
  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = TypeChecker.forModule(ast);
  return checker.check();
}

suite('Checker - Mixins', () => {
  test('should check valid mixin declaration', () => {
    const source = `
      mixin M {
        x: i32 = 10;
        getX(): i32 { return this.x; }
      }
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should check mixin application', () => {
    const source = `
      mixin M {
        x: i32 = 10;
      }
      class C with M {}
      
      let c = new C();
      let x = c.x;
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should check mixin on clause', () => {
    const source = `
      class Base {
        baseField: i32 = 1;
      }
      mixin M on Base {
        method(): i32 {
          return this.baseField;
        }
      }
      class C extends Base with M {}
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if mixin on clause is not satisfied', () => {
    const source = `
      class Base {}
      class Other {}
      mixin M on Base {}
      
      class C extends Other with M {}
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should fail if mixin on clause is not satisfied (no super)', () => {
    const source = `
      class Base {}
      mixin M on Base {}
      
      class C with M {}
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should allow mixin composition', () => {
    const source = `
      mixin A { a: i32 = 1; }
      mixin B { b: i32 = 2; }
      
      class C with A, B {}
      
      let c = new C();
      let sum = c.a + c.b;
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail mixin composition with incompatible on clause', () => {
    const source = `
      class Base {}
      class Other {}
      mixin A on Base {}
      
      mixin B on Other with A {} 
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should fail if mixin defines a constructor', () => {
    const source = `
      mixin M {
        #new() {}
      }
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.ConstructorInMixin);
  });

  test('should fail if mixin accesses unknown member on this', () => {
    const source = `
      mixin M {
        method(): void {
          let x = this.unknownField;
        }
      }
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.PropertyNotFound);
  });

  test('should fail if mixin accesses member not in on clause', () => {
    const source = `
      class Base { x: i32; }
      mixin M { // No 'on Base'
        method(): i32 {
          return this.x; // Error
        }
      }
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.PropertyNotFound);
  });

  test('should allow mixin to access member in on clause', () => {
    const source = `
      class Base { x: i32; }
      mixin M on Base {
        method(): i32 {
          return this.x; // OK
        }
      }
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if class applies mixins with incompatible signatures', () => {
    // This is tricky because mixins are applied sequentially.
    // If A defines foo(): i32 and B defines foo(): string
    // class C with A, B
    // C extends (Base+A)+B
    // (Base+A) has foo(): i32
    // B has foo(): string
    // B overrides foo.
    // If B overrides, it must be compatible with Base+A.
    // string is not compatible with i32 (invariant/covariant return type).
    const source = `
      mixin A {
        foo(): i32 { return 0; }
      }
      mixin B {
        foo(): string { return "s"; }
      }
      class C with A, B {}
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should fail if base class signature is incompatible with mixin', () => {
    const source = `
      class Base {
        foo(): string { return "s"; }
      }
      mixin M {
        foo(): i32 { return 0; }
      }
      class C extends Base with M {}
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should check private fields in mixins', () => {
    const source = `
      mixin M {
        #x: i32 = 0;
        getX(): i32 { return this.#x; }
      }
      class C with M {}
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail if mixin accesses private field of base', () => {
    const source = `
      class Base {
        #x: i32 = 0;
      }
      mixin M on Base {
        getX(): i32 { return this.#x; } // Error: private
      }
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.PropertyNotFound);
  });

  test('should require type arguments for generic mixin used as type', () => {
    const source = `
      mixin Timestamped<T> {
        timestamp: T;
      }
      class Log with Timestamped { // Missing type argument
      }
    `;
    const diagnostics = checkSource(source);
    const missingArgError = diagnostics.find((e) =>
      /Generic type 'Timestamped' requires 1 type arguments/.test(e.message),
    );
    assert.ok(missingArgError, 'Should report missing type arguments error');
  });

  test('should allow generic mixin with type arguments', () => {
    const source = `
      mixin Timestamped<T> {
        timestamp: T;
      }
      class Log with Timestamped<i32> {
      }
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should fail when applying a class as a mixin', () => {
    const source = `
      class A {}
      class B with A {}
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /'A' is not a mixin/);
  });

  test('should fail when applying an interface as a mixin', () => {
    const source = `
      interface I {}
      class B with I {}
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /'I' is not a mixin/);
  });

  test('should fail when applying a union type as a mixin', () => {
    const source = `
      mixin M {}
      mixin N {}
      type U = M | N;
      class B with U {}
    `;
    const diagnostics = checkSource(source);
    assert.strictEqual(diagnostics.length, 1);
    // The error message uses typeToString, which for a union is "T1 | T2"
    assert.match(diagnostics[0].message, /'M \| N' is not a mixin/);
  });
});
