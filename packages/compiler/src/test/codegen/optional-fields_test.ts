import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Codegen - Optional Fields', () => {
  test('optional class field defaults to null', async () => {
    const source = `
      class Bar {
        x: i32;
        new(x: i32) : x = x {}
      }

      class Foo {
        var bar?: Bar;
        new() {}
      }

      export let main = (): i32 => {
        let foo = new Foo();
        if (foo.bar == null) {
          return 1;
        }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('optional class field can be assigned', async () => {
    const source = `
      class Bar {
        x: i32;
        new(x: i32) : x = x {}
      }

      class Foo {
        var bar?: Bar;
        new() {}
      }

      export let main = (): i32 => {
        let foo = new Foo();
        foo.bar = new Bar(42);
        if (foo.bar != null) {
          return 1;
        }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('optional class field can be set to null', async () => {
    const source = `
      class Bar {
        x: i32;
        new(x: i32) : x = x {}
      }

      class Foo {
        var bar?: Bar;
        new() {}
      }

      export let main = (): i32 => {
        let foo = new Foo();
        foo.bar = new Bar(42);
        foo.bar = null;
        if (foo.bar == null) {
          return 1;
        }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('optional string field', async () => {
    const source = `
      class Config {
        var name?: string;
        new() {}
      }

      export let main = (): i32 => {
        let cfg = new Config();
        if (cfg.name == null) {
          cfg.name = 'hello';
          if (cfg.name != null) {
            return 1;
          }
        }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
