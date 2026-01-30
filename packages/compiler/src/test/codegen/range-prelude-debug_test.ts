/**
 * Debug test to investigate prelude + range module interaction
 */

import {test} from 'node:test';
import {compileToWasm} from './utils.js';

test('generic extension class with range in prelude', async () => {
  const source = `
    extension class ArrayExt<T> on array<T> {
      firstOrDefault(defaultVal: T): T {
        if (this.length > 0) {
          return this[0];
        }
        return defaultVal;
      }
    }
    
    export let main = (): i32 => {
      let arr: ArrayExt<i32> = #[42, 2, 3];
      return arr.firstOrDefault(0);
    };
  `;

  const bytes = compileToWasm(source);
  console.log('WASM bytes:', bytes.length);
});
