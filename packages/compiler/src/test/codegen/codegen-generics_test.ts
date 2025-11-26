import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {CodeGenerator} from '../../lib/codegen/index.js';

async function compile(input: string) {
  const parser = new Parser(input);
  const ast = parser.parse();
  let codegen = new CodeGenerator(ast);
  let bytes = codegen.generate();
  const result = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer);
  return result.instance.exports;
}

suite('CodeGenerator - Generics', () => {
  test('should compile and run a generic Box class with i32', async () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      export let test = (): i32 => {
        let b = new Box<i32>(42);
        return b.getValue();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 42);
  });

  test('should compile and run a generic Box class with f32', async () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      export let test = (): f32 => {
        let b = new Box<f32>(3.14);
        return b.getValue();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(Math.fround(test()), Math.fround(3.14));
  });

  test('should support recursive generic types', async () => {
    const input = `
      class Container<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      export let test = (): i32 => {
        let c = new Container<Container<i32>>(new Container<i32>(123));
        return c.getValue().getValue();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 123);
  });

  test('should support generic class with class type argument', async () => {
    const input = `
      class Foo {
        val: i32;
        #new(v: i32) {
          this.val = v;
        }
        getVal(): i32 {
          return this.val;
        }
      }

      class Container<T> {
        item: T;
        #new(i: T) {
          this.item = i;
        }
        getItem(): T {
          return this.item;
        }
      }
      
      export let test = (): i32 => {
        let f = new Foo(100);
        let c = new Container<Foo>(f);
        return c.getItem().getVal();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 100);
  });

  test('should support multiple type parameters', async () => {
    const input = `
      class Pair<K, V> {
        first: K;
        second: V;
        #new(a: K, b: V) {
          this.first = a;
          this.second = b;
        }
        getFirst(): K {
          return this.first;
        }
        getSecond(): V {
          return this.second;
        }
      }
      
      export let test = (): f32 => {
        let p = new Pair<i32, f32>(10, 20.5);
        return p.getSecond();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(Math.fround(test()), Math.fround(20.5));
  });

  test('should compile and run a generic function', async () => {
    const input = `
      let identity = <T>(x: T): T => x;
      
      export let test = (): i32 => {
        return identity<i32>(42);
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 42);
  });

  test('should compile and run a generic function with multiple types', async () => {
    const input = `
      let identity = <T>(x: T): T => x;
      
      export let testI32 = (): i32 => {
        return identity<i32>(123);
      };
      
      export let testF32 = (): f32 => {
        return identity<f32>(4.56);
      };
    `;
    const exports = (await compile(input)) as {
      testI32: () => number;
      testF32: () => number;
    };
    assert.strictEqual(exports.testI32(), 123);
    assert.strictEqual(Math.fround(exports.testF32()), Math.fround(4.56));
  });

  test('should support generic function with multiple type parameters', async () => {
    const input = `
      let pickSecond = <A, B>(a: A, b: B): B => b;
      
      export let test = (): f32 => {
        return pickSecond<i32, f32>(10, 20.5);
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(Math.fround(test()), Math.fround(20.5));
  });

  test('should support generic function with class reference type', async () => {
    const input = `
      class Container {
        val: i32;
        #new(v: i32) { this.val = v; }
      }

      let identity = <T>(x: T): T => x;

      export let test = (): i32 => {
        let c = new Container(42);
        let c2 = identity<Container>(c);
        return c2.val;
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 42);
  });

  test('should support generic function with string reference type', async () => {
    const input = `
      let identity = <T>(x: T): T => x;

      export let test = (): i32 => {
        let s = identity<string>('hello');
        return s.length;
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 5);
  });

  test('should infer type arguments for generic class instantiation', async () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      export let test = (): i32 => {
        let b = new Box(42);
        return b.getValue();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 42);
  });

  test('should infer type arguments for generic function call', async () => {
    const input = `
      let identity = <T>(x: T): T => x;
      
      export let test = (): i32 => {
        return identity(42);
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 42);
  });

  test('should fail when adding incompatible inferred types', async () => {
    const input = `
      class Box<T> {
        value: T;
        #new(v: T) {
          this.value = v;
        }
      }
      
      export let test = (): i32 => {
        let a = new Box(10);
        let b = new Box('hello');
        return a.value + b.value;
      };
    `;
    await assert.rejects(async () => {
      await compile(input);
    });
  });

  test('should use default type parameter when inference is not possible', async () => {
    const input = `
      class Holder<T = i32> {
        value: T;
        #new() {}
        set(v: T) { this.value = v; }
        get(): T { return this.value; }
      }
      export let test = (): i32 => {
        let h = new Holder();
        h.set(123);
        return h.get();
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 123);
  });

  test('should use default type parameter in generic function', async () => {
    const input = `
      class Container<T> {
        val: T;
        #new() {}
      }

      let createContainer = <T = i32>(): Container<T> => new Container<T>();

      export let test = (): i32 => {
        let c = createContainer();
        return 0;
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 0);
  });

  test('should compile and run non-generic function returning class', async () => {
    const input = `
      class Box {
        val: i32;
        #new() { this.val = 0; }
      }
      let createBox = (): Box => new Box();
      export let test = (): i32 => {
        let b = createBox();
        return b.val;
      };
    `;
    const {test} = (await compile(input)) as {test: () => number};
    assert.strictEqual(test(), 0);
  });
});
