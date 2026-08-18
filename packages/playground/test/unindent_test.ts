import {suite, test} from 'node:test';
import assert from 'node:assert';
import {unindent} from '../lib/util.js';

suite('unindent', () => {
  test('removes uniform leading indentation', () => {
    const input = `
      export let main = () => {
        console.log('hello');
      };
    `;
    const expected = `export let main = () => {
  console.log('hello');
};`;
    assert.strictEqual(unindent(input), expected);
  });

  test('handles code without leading indentation', () => {
    const input = `export let x = 42;\nconsole.log(x);`;
    assert.strictEqual(unindent(input), input);
  });

  test('preserves empty lines within body', () => {
    const input = `
      let a = 1;

      let b = 2;
    `;
    const expected = `let a = 1;\n\nlet b = 2;`;
    assert.strictEqual(unindent(input), expected);
  });

  test('handles empty and whitespace-only strings', () => {
    assert.strictEqual(unindent(''), '');
    assert.strictEqual(unindent('   \n\n   '), '');
  });

  test('handles single line without outer whitespace', () => {
    assert.strictEqual(unindent('  let x = 1;'), 'let x = 1;');
  });
});
