import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Template Literals in Closures', () => {
  test('should compile tagged template literal inside a closure', async () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let outer = (): i32 => {
        let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
          return strings.length;
        };
        return tag\`hello\`;
      };
      
      export let main = (): i32 => {
        return outer();
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should compile tagged template literal inside nested closures', async () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let outer = (): i32 => {
        let middle = (): i32 => {
          let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
            return strings.length;
          };
          return tag\`hello \${42} world\`;
        };
        return middle();
      };
      
      export let main = (): i32 => {
        return outer();
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 2); // "hello " and " world"
  });

  test('should compile tagged template with closure as tag function', async () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      export let main = (): i32 => {
        let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
          return strings.length;
        };
        return tag\`hello\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should compile tagged template accessing values in closure', async () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      export let main = (): i32 => {
        let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
          return values[0] + values[1];
        };
        let a = 10;
        let b = 32;
        return tag\`\${a} plus \${b}\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('should compile tagged template with zena:test-like imports', async () => {
    // This test imports the actual zena:test module to check for type registration issues
    const source = `
      import {suite, test, TestContext} from 'zena:test';
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      var result = 0;
      
      export let tests = suite("MySuite", (): void => {
        test("mytest", (ctx: TestContext): void => {
          let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
            return strings.length;
          };
          result = tag\`hello\`;
        });
      });
      
      export let main = (): i32 => {
        let _ = tests.run();
        return result;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should compile tagged template with wrapper-like pattern (CLI test runner)', async () => {
    // This test mimics the CLI test runner pattern with a wrapper module
    // that imports the test file
    const files = {
      '/test.zena': `
        import {suite, test, TestContext} from 'zena:test';
        import {TemplateStringsArray} from 'zena:template-strings-array';
        
        export let tests = suite("MySuite", (): void => {
          test("mytest", (ctx: TestContext): void => {
            let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
              return strings.length;
            };
            // Store result in a global that wrapper can access
          });
        });
      `,
      '/wrapper.zena': `
        import {tests} from '/test.zena';
        import {SuiteResult} from 'zena:test';
        
        var _result: SuiteResult | null = null;
        
        export let main = (): i32 => {
          _result = tests.run();
          if (_result !== null) {
            return _result.failed;
          }
          return 0;
        };
      `,
    };

    const result = await compileAndRun(files, {path: '/wrapper.zena'});
    assert.strictEqual(result, 0); // No failures
  });
});
