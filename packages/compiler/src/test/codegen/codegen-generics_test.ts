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

  test.skip('should compile generic class with constraint', async () => {
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

  test.skip('should compile generic function with constraint', async () => {
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

  // TODO: Codegen doesn't yet handle generic superclass instantiation.
  // The checker now properly handles type arguments in superclass (e.g., class Derived<T> extends Base<T>).
  // But codegen needs to instantiate Base<T> appropriately when processing Derived<T>.
  test.skip('should compile generic class extending generic class', async () => {
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
});
