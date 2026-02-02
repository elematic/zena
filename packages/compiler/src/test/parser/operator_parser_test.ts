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
    const module = parser.parse();
    assert.ok(module);
  });

  test('should parse operator [] in class', () => {
    const input = `
      class MyList {
        operator [](index: i32): i32 { return 0; }
      }
    `;
    const parser = new Parser(input);
    const module = parser.parse();
    assert.ok(module);
  });

  test('should parse operator + in class', () => {
    const input = `
      class Vector {
        x: i32;
        operator +(other: Vector): Vector {
          return new Vector();
        }
      }
    `;
    const parser = new Parser(input);
    const module = parser.parse();
    assert.ok(module);
  });

  test('should parse operator + in interface', () => {
    const input = `
      interface Addable {
        operator +(other: Addable): Addable;
      }
    `;
    const parser = new Parser(input);
    const module = parser.parse();
    assert.ok(module);
  });
});
