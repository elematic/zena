import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {wrapAsModule} from './utils.js';

async function compileAndRun(source: string): Promise<any> {
  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = TypeChecker.forProgram(ast);
  const errors = checker.check();
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  const generator = new CodeGenerator(wrapAsModule(ast, source));
  const wasmBytes = generator.generate();
  const result = (await WebAssembly.instantiate(wasmBytes, {})) as any;
  return result.instance.exports;
}

suite('CodeGenerator - Inheritance', () => {
  test('should inherit fields', async () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
      }
      class Point3D extends Point {
        z: i32;
        #new(x: i32, y: i32, z: i32) {
          super();
          this.x = x;
          this.y = y;
          this.z = z;
        }
        getZ(): i32 {
          return this.z;
        }
        getX(): i32 {
          return this.x;
        }
      }
      export let main = () => {
        let p = new Point3D(10, 20, 30);
        return p.getX() + p.getZ();
      };
    `;
    const exports = await compileAndRun(source);
    assert.strictEqual(exports.main(), 40);
  });

  test('should inherit methods', async () => {
    const source = `
      class Animal {
        speak(): i32 {
          return 1;
        }
      }
      class Dog extends Animal {
      }
      export let main = () => {
        let d = new Dog();
        return d.speak();
      };
    `;
    const exports = await compileAndRun(source);
    assert.strictEqual(exports.main(), 1);
  });

  test('should override methods (static dispatch)', async () => {
    const source = `
      class Animal {
        speak(): i32 {
          return 1;
        }
      }
      class Dog extends Animal {
        speak(): i32 {
          return 2;
        }
      }
      export let main = () => {
        let d = new Dog();
        return d.speak();
      };
    `;
    const exports = await compileAndRun(source);
    assert.strictEqual(exports.main(), 2);
  });
});
