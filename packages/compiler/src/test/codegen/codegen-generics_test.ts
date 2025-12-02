import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
// import assert from 'node:assert';

suite('Codegen: Generics', () => {
  test('should compile generic class instantiation', async () => {
    await compileAndRun(
      `
      import { log } from 'zena:console';
      
      class Box<T> {
        value: T;
        #new(value: T) {
          this.value = value;
        }
        getValue(): T {
          return this.value;
        }
      }
      
      let b = new Box(10);
      log(b.getValue());
    `,
      'main',
    );
  });
});
