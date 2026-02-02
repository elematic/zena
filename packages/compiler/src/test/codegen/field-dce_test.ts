import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Field-level DCE', () => {
  test('write-only plain field is eliminated', async () => {
    const source = `
      class User {
        name: i32;
        unusedId: i32;  // Plain field - no decorator needed
        
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

    // unusedId is a plain field and only written, so getter/setter should be eliminated
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('read field is kept', async () => {
    const source = `
      class User {
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

  test('plain fields are eliminated when write-only', async () => {
    const source = `
      class Counter {
        value: i32;
        writeOnly: i32;  // Plain field - automatically pure
        
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

    // writeOnly is a plain field and write-only, so it's eliminated
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('multiple write-only plain fields eliminated', async () => {
    const source = `
      class Metadata {
        timestamp: i32;
        userId: i32;
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

    // timestamp, userId, sessionId are all plain fields and write-only
    const result = await compileAndRun(source);
    assert.strictEqual(result, 55);
  });

  test('field both read and written is kept', async () => {
    const source = `
      class Box {
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

  test('write-only plain field in constructor only', async () => {
    const source = `
      class Config {
        setting1: i32;
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

    // setting1 and setting2 are plain fields and only written in constructor
    const result = await compileAndRun(source);
    assert.strictEqual(result, 300);
  });

  test('private fields are not affected by field DCE', async () => {
    const source = `
      class Secret {
        #privateValue: i32;
        publicValue: i32;
        
        #new() {
          this.#privateValue = 42;
          this.publicValue = 100;  // Plain field, write-only, should be eliminated
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

    // Private fields don't have implicit getters/setters, so field DCE doesn't apply
    // Only publicValue (plain field, write-only) should be eliminated
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('@pure on explicit accessor enables elimination when write-only', async () => {
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
          this.metadata = 999;  // Written but never read
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

    // metadata accessor is @pure and write-only, so it's eliminated
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('explicit accessor without @pure is kept even if write-only', async () => {
    const source = `
      class Logger {
        #logCount: i32;
        
        // Accessor without @pure - might have side effects
        logLevel: i32 {
          get {
            return 0;
          }
          set(v) {
            // Could have side effects like logging
            this.#logCount = this.#logCount + 1;
          }
        }
        
        #new() {
          this.#logCount = 0;
          this.logLevel = 1;  // Written but never read
        }
        
        getCount(): i32 {
          return this.#logCount;
        }
      }
      
      export let main = (): i32 => {
        let logger = new Logger();
        return logger.getCount();
      };
    `;

    // logLevel setter has side effects (increments counter), so kept even if write-only
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('polymorphic field access keeps field', async () => {
    const source = `
      class Base {
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
