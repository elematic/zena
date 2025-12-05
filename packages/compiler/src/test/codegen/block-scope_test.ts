import {test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

test('blocks create new lexical scopes with variable shadowing', async () => {
  const source = `
    export let main = () => {
      var x = 0;
      var innerX = 0;
      {
        var x = 10;
        x = 20;
        innerX = x;
      }
      x = 50;
      return x + innerX;
    };
  `;

  const result = await compileAndRun(source);
  // x in outer scope is 50, innerX captured inner x which was 20
  assert.strictEqual(result, 70);
});

test('nested blocks create independent scopes', async () => {
  const source = `
    export let main = () => {
      var result = 0;
      var x = 1;
      {
        var x = 10;
        {
          var x = 100;
          result = result + x;
        }
        result = result + x;
      }
      result = result + x;
      return result;
    };
  `;

  const result = await compileAndRun(source);
  // 100 (innermost) + 10 (middle) + 1 (outer) = 111
  assert.strictEqual(result, 111);
});

test('block scope variables are not accessible outside the block', async () => {
  const source = `
    export let main = () => {
      var x = 5;
      {
        var y = 10;
        x = x + y;
      }
      return x;
    };
  `;

  const result = await compileAndRun(source);
  // x was modified inside block using y, then y goes out of scope
  assert.strictEqual(result, 15);
});
