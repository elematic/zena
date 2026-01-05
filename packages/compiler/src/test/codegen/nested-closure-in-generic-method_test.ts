import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';

// Nested closure passed to generic method causes codegen error "reached end
// while decoding local decls count"
//
// Repro: When a closure is defined inside another closure and passed to a
// generic method like Array.map(), the generated WASM is malformed.
//
// This works:
//   let arr = new Array<i32>(4);
//   arr.map<i32>((x: i32) => x * 2);  // top-level closure
//
// This fails:
//   let outer = () => {
//     let arr = new Array<i32>(4);
//     arr.map<i32>((x: i32) => x * 2);  // nested closure - FAILS
//   };

suite('Nested closure in generic method', () => {
  test('closure passed to generic method inside doubly nested closure', async () => {
    const source = `
      import {Array} from 'zena:array';
      
      export let run = (): i32 => {
        let level1 = (): i32 => {
          let level2 = (): i32 => {
            let arr = new Array<i32>(4);
            arr.push(1);
            arr.push(2);
            arr.push(3);
            
            let mapped = arr.map<i32>((x: i32) => x * 2);
            
            return mapped[0] + mapped[1] + mapped[2]; // 2 + 4 + 6 = 12
          };
          return level2();
        };
        return level1();
      };
    `;
    const exports = await compileAndInstantiate(source);
    assert.strictEqual((exports.run as Function)(), 12);
  });

  test('minimal repro: nested closure in higher-order function', async () => {
    const source = `
      class Container<T> {
        value: T;
        
        #new(v: T) {
          this.value = v;
        }
        
        transform<U>(f: (v: T) => U): Container<U> {
          return new Container<U>(f(this.value));
        }
      }
      
      export let run = (): i32 => {
        let outer = (): i32 => {
          let c = new Container<i32>(5);
          let result = c.transform<i32>((x: i32) => x * 2);
          return result.value;
        };
        return outer();
      };
    `;
    const exports = await compileAndInstantiate(source);
    assert.strictEqual((exports.run as Function)(), 10);
  });
});
