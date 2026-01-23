import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';

suite('Checker: Records and Tuples', () => {
  function check(source: string) {
    const parser = new Parser(source);
    const program = parser.parse();
    const checker = TypeChecker.forProgram(program);
    const diagnostics = checker.check();
    return {body: program.body, diagnostics};
  }

  test('infers record literal type', () => {
    const {diagnostics} = check(`
      let r = { x: 1, y: 2 };
      let check: { x: i32, y: i32 } = r;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('infers record literal type (mismatch)', () => {
    const {diagnostics} = check(`
      let r = { x: 1, y: 2 };
      let check: { x: string, y: i32 } = r;
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch/);
  });

  test('infers tuple literal type', () => {
    const {diagnostics} = check(`
      let t = [1, true];
      let check: [i32, boolean] = t;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('infers tuple literal type (mismatch)', () => {
    const {diagnostics} = check(`
      let t = [1, true];
      let check: [string, boolean] = t;
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch/);
  });

  test('resolves record type annotation', () => {
    const {diagnostics} = check('let r: { x: i32 } = { x: 1 };');
    assert.strictEqual(diagnostics.length, 0);
  });

  test('resolves tuple type annotation', () => {
    const {diagnostics} = check('let t: [i32, boolean] = [1, true];');
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks record assignability (width subtyping)', () => {
    // { x: i32, y: i32 } is assignable to { x: i32 }
    const {diagnostics} = check('let r: { x: i32 } = { x: 1, y: 2 };');
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks record assignability (missing property)', () => {
    const {diagnostics} = check('let r: { x: i32, y: i32 } = { x: 1 };');
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch/);
  });

  test('checks tuple assignability (exact length)', () => {
    const {diagnostics} = check('let t: [i32] = [1, 2];');
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch/);
  });

  test('checks tuple assignability (element mismatch)', () => {
    const {diagnostics} = check('let t: [i32] = [true];');
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Type mismatch/);
  });

  test('checks record property access', () => {
    const {diagnostics} = check(`
      let r = { x: 1 };
      let x: i32 = r.x;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks record property access (missing)', () => {
    const {diagnostics} = check('let r = { x: 1 }; let y = r.y;');
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Property 'y' does not exist/);
  });

  test('checks tuple index access', () => {
    const {diagnostics} = check(`
      let t = [1, true];
      let x: i32 = t[0];
      let y: boolean = t[1];
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('checks tuple index access (out of bounds)', () => {
    const {diagnostics} = check('let t = [1]; let x = t[1];');
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Tuple index out of bounds/);
  });

  test('checks tuple index access (non-literal)', () => {
    const {diagnostics} = check('let t = [1]; let i = 0; let x = t[i];');
    assert.strictEqual(diagnostics.length, 1);
    assert.match(
      diagnostics[0].message,
      /Tuple index must be a number literal/,
    );
  });
});
