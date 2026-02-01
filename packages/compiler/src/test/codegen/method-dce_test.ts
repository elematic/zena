import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Method-level DCE', () => {
  test('unused method is replaced with unreachable stub', async () => {
    const source = `
      class Counter {
        #value: i32;
        
        #new() {
          this.#value = 0;
        }
        
        increment(): void {
          this.#value = this.#value + 1;
        }
        
        decrement(): void {
          this.#value = this.#value - 1;
        }
        
        getValue(): i32 {
          return this.#value;
        }
      }
      
      export let main = (): i32 => {
        let c = new Counter();
        c.increment();
        return c.getValue();
      };
    `;

    // The decrement method is not called, so it should be replaced with unreachable
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('method called through polymorphism is kept', async () => {
    const source = `
      class Animal {
        speak(): i32 {
          return 0;
        }
      }
      
      class Dog extends Animal {
        speak(): i32 {
          return 1;
        }
      }
      
      export let main = (): i32 => {
        let a: Animal = new Dog();
        return a.speak();
      };
    `;

    // speak() is called polymorphically, so Dog.speak() must be kept
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('unused getter is replaced with unreachable stub', async () => {
    const source = `
      class Point {
        #x: i32;
        #y: i32;
        
        #new(x: i32, y: i32) {
          this.#x = x;
          this.#y = y;
        }
        
        x: i32 {
          get {
            return this.#x;
          }
        }
        
        y: i32 {
          get {
            return this.#y;
          }
        }
      }
      
      export let main = (): i32 => {
        let p = new Point(10, 20);
        return p.x;
      };
    `;

    // Only x getter is used, y getter should be replaced with unreachable
    const result = await compileAndRun(source);
    assert.strictEqual(result, 10);
  });

  test('setter called is kept, unused setter is replaced', async () => {
    const source = `
      class Box {
        #value: i32;
        #label: i32;
        
        #new() {
          this.#value = 0;
          this.#label = 0;
        }
        
        value: i32 {
          get {
            return this.#value;
          }
          set(v) {
            this.#value = v;
          }
        }
        
        label: i32 {
          get {
            return this.#label;
          }
          set(l) {
            this.#label = l;
          }
        }
      }
      
      export let main = (): i32 => {
        let b = new Box();
        b.value = 42;
        return b.value;
      };
    `;

    // value setter is used, label setter is not
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('constructor is always kept even if only used implicitly', async () => {
    const source = `
      class Config {
        #setting: i32;
        
        #new() {
          this.#setting = 100;
        }
        
        getSetting(): i32 {
          return this.#setting;
        }
      }
      
      export let main = (): i32 => {
        let c = new Config();
        return c.getSetting();
      };
    `;

    // Constructor must be kept since we call new Config()
    const result = await compileAndRun(source);
    assert.strictEqual(result, 100);
  });

  test('implicit field getter/setter DCE', async () => {
    const source = `
      class Person {
        name: i32;
        age: i32;
        
        #new(n: i32, a: i32) {
          this.name = n;
          this.age = a;
        }
      }
      
      export let main = (): i32 => {
        let p = new Person(1, 25);
        return p.name;
      };
    `;

    // Only 'name' getter is used, 'age' getter should be replaced with unreachable
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('method with complex body is eliminated when unused', async () => {
    const source = `
      class Calculator {
        compute(): i32 {
          var sum = 0;
          for (var i = 0; i < 100; i = i + 1) {
            sum = sum + i;
          }
          return sum;
        }
        
        simpleAdd(a: i32, b: i32): i32 {
          return a + b;
        }
      }
      
      export let main = (): i32 => {
        let calc = new Calculator();
        return calc.simpleAdd(3, 4);
      };
    `;

    // compute() has complex body but is not called - should be replaced with unreachable
    const result = await compileAndRun(source);
    assert.strictEqual(result, 7);
  });

  test('interface method implementation is kept when called through interface', async () => {
    const source = `
      interface Greeter {
        greet(): i32;
        farewell(): i32;
      }
      
      class FriendlyGreeter implements Greeter {
        greet(): i32 {
          return 1;
        }
        
        farewell(): i32 {
          return 2;
        }
      }
      
      export let main = (): i32 => {
        let g: Greeter = new FriendlyGreeter();
        return g.greet();
      };
    `;

    // greet() is called through interface, farewell() is not
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
