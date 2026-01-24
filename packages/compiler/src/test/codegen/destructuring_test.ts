import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {wrapAsModule} from './utils.js';

async function compileAndRun(
  input: string,
  entryPoint: string = 'main',
): Promise<number> {
  const parser = new Parser(input);
  const ast = parser.parse();
  const checker = TypeChecker.forProgram(ast);
  checker.check();
  const codegen = new CodeGenerator(
    wrapAsModule(ast, input),
    undefined,
    checker.semanticContext,
  );
  const bytes = codegen.generate();
  const result = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer);
  const exports = result.instance.exports as any;
  return exports[entryPoint]();
}

suite('CodeGenerator - Destructuring', () => {
  test('should destructure record', async () => {
    const code = `
      export let main = () => {
        let p = { x: 10, y: 20 };
        let { x, y } = p;
        return x + y;
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 30);
  });

  test('should destructure record with renaming', async () => {
    const code = `
      export let main = () => {
        let p = { x: 10, y: 20 };
        let { x as a, y as b } = p;
        return a + b;
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 30);
  });

  test('should destructure nested record', async () => {
    const code = `
      export let main = () => {
        let r = { p1: { x: 1, y: 2 }, p2: { x: 3, y: 4 } };
        let { p1: { x }, p2: { y } } = r;
        return x + y;
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 5);
  });

  test('should destructure tuple', async () => {
    const code = `
      export let main = () => {
        let t = [10, 20];
        let [a, b] = t;
        return a + b;
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 30);
  });

  test('should destructure tuple with skipping', async () => {
    const code = `
      export let main = () => {
        let t = [10, 20, 30];
        let [a, , c] = t;
        return a + c;
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 40);
  });

  test('should destructure class instance', async () => {
    const code = `
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }
      export let main = () => {
        let p = new Point(10, 20);
        let { x, y } = p;
        return x + y;
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 30);
  });

  test('should destructure nested class instance', async () => {
    const code = `
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }
      class Rect {
        p1: Point;
        p2: Point;
        #new(p1: Point, p2: Point) {
          this.p1 = p1;
          this.p2 = p2;
        }
      }
      export let main = () => {
        let r = new Rect(new Point(1, 2), new Point(3, 4));
        let { p1: { x }, p2: { y } } = r;
        return x + y;
      };
    `;
    const result = await compileAndRun(code);
    assert.strictEqual(result, 5);
  });
});
