import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('Codegen: Throw', () => {
  test('should throw an exception', async () => {
    const source = `
      class Error {
        message: string;
        #new(message: string) { this.message = message; }
      }
      
      export function main() {
        throw new Error("Something went wrong");
      }
    `;

    await assert.rejects(async () => {
      await compileAndRun(source, 'main');
    });
  });

  test('throw in expression context', async () => {
    const source = `
      class Error {
        message: string;
        #new(message: string) { this.message = message; }
      }
      
      export function main() {
        let x = 1 + (throw new Error("Boom"));
      }
    `;

    await assert.rejects(async () => {
      await compileAndRun(source, 'main');
    });
  });

  test('should use global Error class', async () => {
    const source = `
      export function main() {
        throw new Error("Global Error");
      }
    `;

    // We need to provide the path as 'zena:test' or similar to trigger prelude injection if needed,
    // but compileAndRun usually handles it if we don't specify path?
    // Actually compileAndRun uses a mock host.
    // We need to make sure the mock host has 'zena:error'.

    await assert.rejects(async () => {
      await compileAndRun(source, 'main');
    });
  });
});
