
import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';

suite('Parser - Operator Overloading', () => {
  test('should parse operator == in interface', () => {
    const input = `
      interface Hashable {
        operator ==(other: Hashable): boolean;
      }
    `;
    const parser = new Parser(input);
    const program = parser.parse();
    assert.ok(program);
  });

  test('should parse operator [] in class', () => {
    const input = `
      class MyList {
        operator [](index: i32): i32 { return 0; }
      }
    `;
    const parser = new Parser(input);
    const program = parser.parse();
    assert.ok(program);
  });
});
