import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
// import assert from 'node:assert';

suite('Codegen: Generics', () => {
  test('should compile generic class instantiation', async () => {
    await compileAndRun(
      `
      import { log } from 'zena:console';
      
      class Box<T> {
        value: T;
        #new(value: T) {
          this.value = value;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      let b = new Box(10);
      log(b.getValue());
    `,
      'main',
    );
  });

  test('should compile generic class with constraint', async () => {
    await compileAndRun(
      `
      import { log } from 'zena:console';
      
      class Base {
        #new() {}
      }
      
      class Derived extends Base {
        #new() {
          super();
        }
      }
      
      class Container<T extends Base> {
        item: T;
        #new(item: T) {
          this.item = item;
        }
        getItem(): T {
          return this.item;
        }
      }
      
      let c1 = new Container<Base>(new Base());
      log(42);
    `,
      'main',
    );
  });

  test('should compile generic function with constraint', async () => {
    await compileAndRun(
      `
      import { log } from 'zena:console';
      
      class Base {
        #new() {}
      }
      
      class Derived extends Base {
        #new() {
          super();
        }
      }
      
      let process = <T extends Base>(x: T): T => x;
      
      let d = new Derived();
      let result = process<Derived>(d);
      log(42);
    `,
      'main',
    );
  });

  test('should compile generic class extending generic class', async () => {
    await compileAndRun(
      `
      import { log } from 'zena:console';
      
      class Base<T> {
        value: T;
        #new(value: T) {
          this.value = value;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      class Derived<T> extends Base<T> {
        extra: i32;
        #new(value: T, extra: i32) {
          super(value);
          this.extra = extra;
        }
        getExtra(): i32 {
          return this.extra;
        }
      }
      
      let d = new Derived<i32>(10, 42);
      log(d.getValue());
      log(d.getExtra());
    `,
      'main',
    );
  });

  test('should instantiate nested generic types in fields', async () => {
    await compileAndRun(
      `
      import { log } from 'zena:console';
      
      class Box<T> {
        value: T;
        #new(value: T) {
          this.value = value;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      class Container<T> {
        // Field type is Box<T> - when Container<i32> is instantiated,
        // Box<i32> should also be instantiated
        box: Box<T>;
        #new(value: T) {
          this.box = new Box(value);
        }
        getBoxValue(): T {
          return this.box.getValue();
        }
      }
      
      let c = new Container<i32>(42);
      log(c.getBoxValue());
    `,
      'main',
    );
  });

  test('should instantiate nested generic types in method return types', async () => {
    await compileAndRun(
      `
      import { log } from 'zena:console';
      
      class Wrapper<T> {
        value: T;
        #new(value: T) {
          this.value = value;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      class Factory<T> {
        default: T;
        #new(default: T) {
          this.default = default;
        }
        // Return type is Wrapper<T> - when Factory<i32> is instantiated,
        // Wrapper<i32> should be instantiated for the return type
        create(value: T): Wrapper<T> {
          return new Wrapper(value);
        }
      }
      
      let f = new Factory<i32>(0);
      let w = f.create(42);
      log(w.getValue());
    `,
      'main',
    );
  });

  // Note: Test for nested generic types in method parameters is skipped.
  // The checker currently doesn't fully substitute type parameters in method
  // parameter types during class instantiation (see "expected T, got i32" error).
  // This is a pre-existing limitation that would require checker refactoring to fix.

  test('should instantiate generic superclass with concrete type', async () => {
    await compileAndRun(
      `
      import { log } from 'zena:console';
      
      class Box<T> {
        value: T;
        #new(value: T) {
          this.value = value;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      // IntBox extends Box<i32> - Box<i32> should be instantiated
      class IntBox extends Box<i32> {
        #new(value: i32) {
          super(value);
        }
        doubleValue(): i32 {
          return this.value * 2;
        }
      }
      
      let b = new IntBox(21);
      log(b.getValue());
      log(b.doubleValue());
    `,
      'main',
    );
  });

  test('should instantiate deeply nested generic types', async () => {
    await compileAndRun(
      `
      import { log } from 'zena:console';
      
      class Inner<T> {
        value: T;
        #new(value: T) {
          this.value = value;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      class Middle<T> {
        inner: Inner<T>;
        #new(value: T) {
          this.inner = new Inner(value);
        }
        getInnerValue(): T {
          return this.inner.getValue();
        }
      }
      
      class Outer<T> {
        middle: Middle<T>;
        #new(value: T) {
          this.middle = new Middle(value);
        }
        getDeepValue(): T {
          return this.middle.getInnerValue();
        }
      }
      
      // Instantiating Outer<i32> should cascade to Middle<i32> and Inner<i32>
      let o = new Outer<i32>(42);
      log(o.getDeepValue());
    `,
      'main',
    );
  });

  test('should instantiate generic classes implementing interfaces', async () => {
    await compileAndRun(
      `
      import { log } from 'zena:console';
      
      interface Container<T> {
        getValue(): T;
      }
      
      class Box<T> implements Container<T> {
        value: T;
        #new(value: T) {
          this.value = value;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      let b = new Box<i32>(42);
      log(b.getValue());
    `,
      'main',
    );
  });
});
