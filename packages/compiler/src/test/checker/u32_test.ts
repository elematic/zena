import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - Unsigned Integers (u32)', () => {
  test('should allow u32 type annotation', () => {
    const input = `
      let x: u32 = 42 as u32;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should allow u32 in function parameters', () => {
    const input = `
      let add = (a: u32, b: u32): u32 => a + b;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should allow u32 arithmetic operations', () => {
    const input = `
      let compute = (a: u32, b: u32) => {
        let sum = a + b;
        let diff = a - b;
        let prod = a * b;
        let quot = a / b;
        let rem = a % b;
        return sum;
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should allow u32 comparison operations', () => {
    const input = `
      let compare = (a: u32, b: u32): boolean => {
        let lt = a < b;
        let le = a <= b;
        let gt = a > b;
        let ge = a >= b;
        let eq = a == b;
        let ne = a != b;
        return lt;
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should allow u32 bitwise operations', () => {
    const input = `
      let bitwise = (a: u32, b: u32) => {
        let andOp = a & b;
        let orOp = a | b;
        let xorOp = a ^ b;
        return andOp;
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should forbid mixing i32 and u32 in arithmetic', () => {
    const input = `
      let mixed = (a: i32, b: u32) => a + b;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Cannot mix signed.*unsigned/);
  });

  test('should forbid mixing u32 and i32 in comparison', () => {
    const input = `
      let compare = (a: u32, b: i32): boolean => a < b;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Cannot mix signed.*unsigned/);
  });

  test('should forbid mixing i32 and u32 in division', () => {
    const input = `
      let divide = (a: i32, b: u32) => a / b;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Cannot mix signed.*unsigned/);
  });

  test('should allow explicit cast from i32 to u32', () => {
    const input = `
      let toU32 = (x: i32): u32 => x as u32;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should allow explicit cast from u32 to i32', () => {
    const input = `
      let toI32 = (x: u32): i32 => x as i32;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should allow arithmetic after casting to same type', () => {
    const input = `
      let add = (a: i32, b: u32): u32 => (a as u32) + b;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should detect type mismatch in assignment', () => {
    const input = `
      let x: u32 = 42 as u32;
      var y: i32 = x;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });

  test('should detect type mismatch in function argument', () => {
    const input = `
      let takesU32 = (x: u32) => x;
      let y: i32 = 42;
      let result = takesU32(y);
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch in argument/);
  });

  test('should detect return type mismatch', () => {
    const input = `
      let getU32 = (x: i32): u32 => x;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });
});
