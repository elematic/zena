import {test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {compileAndRun} from './utils.js';

test('checker allows referencing earlier parameter in default', () => {
  const source = `
    class List {
      length: i32;
      
      #new() {
        this.length = 10;
      }
      
      slice(start: i32 = 0, end: i32 = this.length - start): i32 {
        return end - start;
      }
    }
  `;

  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = TypeChecker.forModule(ast);
  const errors = checker.check();

  console.log('Diagnostics:', errors.length);
  errors.forEach((d: {message: string}) => console.log('-', d.message));

  assert.strictEqual(errors.length, 0, 'Should have no errors');
});

test('codegen handles earlier parameter reference in default', async () => {
  const source = `
    class List {
      length: i32;
      
      #new(len: i32) {
        this.length = len;
      }
      
      // end defaults to this.length - start
      slice(start: i32 = 0, end: i32 = this.length - start): i32 {
        return end - start;
      }
    }
    
    export let main = (): i32 => {
      let list = new List(10);
      // slice(2) -> start=2, end=10-2=8, return 8-2=6
      return list.slice(2);
    };
  `;

  const result = await compileAndRun(source);
  assert.strictEqual(result, 6);
});
