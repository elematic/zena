import assert from 'node:assert';
import {suite, test} from 'node:test';
import {checkSource} from '../codegen/utils.js';

suite('Stdlib: TemplateStringsArray', () => {
  // TODO: Checker should reject index assignment without operator []=
  test('should reject index assignment on TemplateStringsArray', () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        strings[0] = "changed";
        return 0;
      };
    `;

    const diagnostics = checkSource(source);
    assert.ok(
      diagnostics.length > 0,
      'Expected type error for index assignment on TemplateStringsArray',
    );
  });

  // TODO: Checker should reject index assignment on ImmutableArray
  test('should reject index assignment on raw property', () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        strings.raw[0] = "changed";
        return 0;
      };
    `;

    const diagnostics = checkSource(source);
    assert.ok(
      diagnostics.length > 0,
      'Expected type error for index assignment on raw property',
    );
  });

  // TODO: Checker should reject assignment to getter-only properties
  test('should reject assignment to length property', () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        strings.length = 5;
        return 0;
      };
    `;

    const diagnostics = checkSource(source);
    assert.ok(
      diagnostics.length > 0,
      'Expected type error for assignment to length property',
    );
  });

  test('should reject access to private fields', () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        let s = strings.#strings;
        return 0;
      };
    `;

    const diagnostics = checkSource(source);
    assert.ok(
      diagnostics.length > 0,
      'Expected type error for accessing private field',
    );
  });
});
