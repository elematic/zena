import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileToWasm} from './utils.js';

suite('CodeGenerator - Cast Optimization', () => {
  test('should elide cast for distinct type alias of string', () => {
    const codeNoCast = `
      type ID = string;
      export let main = (s: string): string => {
        return s;
      };
    `;

    const codeWithCast = `
      type ID = string;
      export let main = (s: string): string => {
        return s as ID;
      };
    `;

    const wasmNoCast = compileToWasm(codeNoCast);
    const wasmWithCast = compileToWasm(codeWithCast);

    // If cast is elided, the binaries should be identical (or at least same size)
    // Note: They might differ slightly if type names are embedded or something,
    // but the code section size should be key.
    // For now, let's check total size.
    assert.strictEqual(
      wasmWithCast.length,
      wasmNoCast.length,
      'Cast should be elided (binary size mismatch)',
    );
  });

  test('should elide cast for distinct type alias of class', () => {
    const codeNoCast = `
      class Person {}
      type Manager = Person;
      export let main = (p: Person): Person => {
        return p;
      };
    `;

    const codeWithCast = `
      class Person {}
      type Manager = Person;
      export let main = (p: Person): Person => {
        return p as Manager;
      };
    `;

    const wasmNoCast = compileToWasm(codeNoCast);
    const wasmWithCast = compileToWasm(codeWithCast);

    assert.strictEqual(
      wasmWithCast.length,
      wasmNoCast.length,
      'Cast should be elided (binary size mismatch)',
    );
  });
});
