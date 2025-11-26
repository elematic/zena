import {suite, test} from 'node:test';
import {strict as assert} from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Super', () => {
  test('should compile and run super constructor call', async () => {
    const source = `
      class A {
        x: i32;
        #new(x: i32) {
          this.x = x;
        }
      }
      class B extends A {
        y: i32;
        #new(x: i32, y: i32) {
          super(x);
          this.y = y;
        }
      }
      export let main = (): i32 => {
        let b = new B(10, 20);
        return b.x + b.y;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.equal(result, 30);
  });

  test('should compile and run super method call', async () => {
    const source = `
      class A {
        foo(): i32 { return 10; }
      }
      class B extends A {
        foo(): i32 { return 20; }
        callSuper(): i32 {
          return super.foo();
        }
      }
      export let main = (): i32 => {
        let b = new B();
        return b.callSuper();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.equal(result, 10);
  });

  test('should compile and run super field access', async () => {
    const source = `
      class A {
        x: i32;
        #new() { this.x = 100; }
      }
      class B extends A {
        getX(): i32 {
          return super.x;
        }
      }
      export let main = (): i32 => {
        let b = new B();
        return b.getX();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.equal(result, 100);
  });

  test('should compile and run super method call in override', async () => {
    const source = `
      class A {
        foo(): i32 { return 10; }
      }
      class B extends A {
        foo(): i32 { return super.foo() * 2; }
      }
      export let main = (): i32 => {
        let b = new B();
        return b.foo();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.equal(result, 20);
  });

  test('should resolve super to immediate parent in deep hierarchy', async () => {
    const source = `
      class A {
        foo(): i32 { return 1; }
      }
      class B extends A {
        foo(): i32 { return 2; }
      }
      class C extends B {
        foo(): i32 { return super.foo() + 10; }
      }
      export let main = (): i32 => {
        let c = new C();
        return c.foo();
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.equal(result, 12);
  });
});
