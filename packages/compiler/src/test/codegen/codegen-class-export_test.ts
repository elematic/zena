import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compile} from '../../lib/index.js';

const imports = {
  console: {
    log_i32: () => {},
    log_f32: () => {},
    log_string: () => {},
    error_string: () => {},
    warn_string: () => {},
    info_string: () => {},
    debug_string: () => {},
  },
};

suite('CodeGenerator - Class Exports', () => {
  test('should export class constructor and allow usage in host', async () => {
    const source = `
      export class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
        getX(): i32 {
          return this.x;
        }
      }

      export let checkPoint = (p: Point): i32 => {
        return p.getX();
      };
    `;

    const wasm = compile(source);
    const result: any = await WebAssembly.instantiate(wasm, imports);
    const exports = result.instance.exports;

    assert.ok(exports.Point, 'Point should be exported');
    assert.ok(exports.checkPoint, 'checkPoint should be exported');

    const p = exports.Point(10, 20);
    const x = exports.checkPoint(p);

    assert.strictEqual(x, 10);
  });

  test('should export function', async () => {
    const source = `
      export let add = (a: i32, b: i32): i32 => {
        return a + b;
      };
    `;

    const wasm = compile(source);
    const result: any = await WebAssembly.instantiate(wasm, imports);
    const exports = result.instance.exports;

    assert.ok(exports.add, 'add should be exported');
    assert.strictEqual(exports.add(1, 2), 3);
  });
});
