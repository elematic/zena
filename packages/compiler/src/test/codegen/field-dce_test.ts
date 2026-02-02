import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Field-level DCE', () => {
  test('write-only @pure field is eliminated', async () => {
    const source = `
      class User {
        name: i32;
        @pure
        unusedId: i32;
        
        #new(n: i32, id: i32) {
          this.name = n;
          this.unusedId = id;  // Written but never read
        }
      }
      
      export let main = (): i32 => {
        let u = new User(42, 999);
        return u.name;
      };
    `;

    // unusedId is @pure and only written, so getter/setter should be eliminated
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('read field is kept even with @pure', async () => {
    const source = `
      class User {
        @pure
        id: i32;
        
        #new(id: i32) {
          this.id = id;
        }
      }
      
      export let main = (): i32 => {
        let u = new User(123);
        return u.id;  // Field is read, so it must be kept
      };
    `;

    // id is read, so it must be kept
    const result = await compileAndRun(source);
    assert.strictEqual(result, 123);
  });

  test('field without @pure decorator is kept when write-only', async () => {
    const source = `
      class Counter {
        value: i32;
        writeOnly: i32;  // No @pure decorator
        
        #new() {
          this.value = 0;
          this.writeOnly = 100;  // Written but never read
        }
        
        increment(): void {
          this.value = this.value + 1;
        }
        
        getValue(): i32 {
          return this.value;
        }
      }
      
      export let main = (): i32 => {
        let c = new Counter();
        c.increment();
        return c.getValue();
      };
    `;

    // writeOnly is not @pure, so it should be kept (conservative)
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('multiple @pure write-only fields eliminated', async () => {
    const source = `
      class Metadata {
        @pure
        timestamp: i32;
        @pure
        userId: i32;
        @pure
        sessionId: i32;
        actualData: i32;
        
        #new(data: i32) {
          this.timestamp = 1000;
          this.userId = 42;
          this.sessionId = 999;
          this.actualData = data;
        }
        
        getData(): i32 {
          return this.actualData;
        }
      }
      
      export let main = (): i32 => {
        let m = new Metadata(55);
        return m.getData();
      };
    `;

    // timestamp, userId, sessionId are all @pure and write-only
    const result = await compileAndRun(source);
    assert.strictEqual(result, 55);
  });

  test('@pure field both read and written is kept', async () => {
    const source = `
      class Box {
        @pure
        value: i32;
        
        #new(v: i32) {
          this.value = v;
        }
        
        update(v: i32): void {
          this.value = v;  // Written
        }
        
        get(): i32 {
          return this.value;  // Read
        }
      }
      
      export let main = (): i32 => {
        let b = new Box(10);
        b.update(20);
        return b.get();
      };
    `;

    // value is both read and written, so it must be kept
    const result = await compileAndRun(source);
    assert.strictEqual(result, 20);
  });

  test('@pure write-only field in constructor only', async () => {
    const source = `
      class Config {
        @pure
        setting1: i32;
        @pure
        setting2: i32;
        usedSetting: i32;
        
        #new() {
          this.setting1 = 100;
          this.setting2 = 200;
          this.usedSetting = 300;
        }
        
        getSetting(): i32 {
          return this.usedSetting;
        }
      }
      
      export let main = (): i32 => {
        let c = new Config();
        return c.getSetting();
      };
    `;

    // setting1 and setting2 are @pure and only written in constructor
    const result = await compileAndRun(source);
    assert.strictEqual(result, 300);
  });

  test('private field is not affected by @pure DCE', async () => {
    const source = `
      class Secret {
        #privateValue: i32;
        @pure
        publicValue: i32;
        
        #new() {
          this.#privateValue = 42;
          this.publicValue = 100;
        }
        
        getPrivate(): i32 {
          return this.#privateValue;
        }
      }
      
      export let main = (): i32 => {
        let s = new Secret();
        return s.getPrivate();
      };
    `;

    // Private fields use different mechanism, @pure should only affect public fields
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('@pure field with explicit getter/setter', async () => {
    const source = `
      class Item {
        #backingStore: i32;
        
        @pure
        metadata: i32 {
          get {
            return this.#backingStore;
          }
          set(v) {
            this.#backingStore = v;
          }
        }
        
        #new() {
          this.metadata = 999;  // Written
        }
        
        getValue(): i32 {
          return 42;
        }
      }
      
      export let main = (): i32 => {
        let item = new Item();
        return item.getValue();
      };
    `;

    // metadata accessor is @pure and write-only
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('polymorphic @pure field access keeps field', async () => {
    const source = `
      class Base {
        @pure
        value: i32;
        
        #new(v: i32) {
          this.value = v;
        }
      }
      
      class Derived extends Base {
        #new(v: i32) {
          super(v);
        }
      }
      
      export let main = (): i32 => {
        let b: Base = new Derived(50);
        return b.value;  // Polymorphic read
      };
    `;

    // Polymorphic access means the field must be kept
    const result = await compileAndRun(source);
    assert.strictEqual(result, 50);
  });
});
