import {suite, test} from 'node:test';
import {strict as assert} from 'node:assert';
import {compileAndRun, compileAndInstantiate} from './utils.js';

suite('Codegen: Symbol-Keyed Access', () => {
  test('symbol-keyed field access', async () => {
    const result = await compileAndRun(`
symbol myField;

class Data {
  [myField]: i32;
  
  #new(val: i32) {
    this[myField] = val;
  }
}

export let main = () => {
  let d = new Data(42);
  return d[myField];
};
`);
    assert.strictEqual(result, 42);
  });

  test('symbol-keyed method call', async () => {
    const result = await compileAndRun(`
symbol compute;

class Calculator {
  value: i32;
  
  #new(v: i32) {
    this.value = v;
  }
  
  [compute](x: i32): i32 {
    return this.value + x;
  }
}

export let main = () => {
  let c = new Calculator(10);
  return c[compute](5);
};
`);
    assert.strictEqual(result, 15);
  });

  test('multiple symbol-keyed members', async () => {
    const result = await compileAndRun(`
symbol first;
symbol second;

class Pair {
  [first]: i32;
  [second]: i32;
  
  #new(a: i32, b: i32) {
    this[first] = a;
    this[second] = b;
  }
}

export let main = () => {
  let p = new Pair(3, 7);
  return p[first] + p[second];
};
`);
    assert.strictEqual(result, 10);
  });

  test('symbols are unique by identity', async () => {
    // Two symbols with same name from different modules should be distinct
    const exports = await compileAndInstantiate({
      '/main.zena': `
import {sym as otherSym} from '/other.zena';

// This is a different symbol, even if called 'sym'
symbol sym;

class Data {
  [sym]: i32;
  [otherSym]: i32;
  
  #new() {
    this[sym] = 10;
    this[otherSym] = 20;
  }
}

export let getFirst = () => {
  let d = new Data();
  return d[sym];
};

export let getSecond = () => {
  let d = new Data();
  return d[otherSym];
};
`,
      '/other.zena': `
export symbol sym;
`,
    });
    assert.strictEqual(exports.getFirst(), 10);
    assert.strictEqual(exports.getSecond(), 20);
  });

  test('symbol-keyed method with no args', async () => {
    const result = await compileAndRun(`
symbol getValue;

class Box {
  value: i32;
  
  #new(v: i32) {
    this.value = v;
  }
  
  [getValue](): i32 {
    return this.value;
  }
}

export let main = () => {
  let b = new Box(99);
  return b[getValue]();
};
`);
    assert.strictEqual(result, 99);
  });

  test('mixing symbol-keyed and regular members', async () => {
    const result = await compileAndRun(`
symbol secretValue;

class Mixed {
  publicValue: i32;
  [secretValue]: i32;
  
  #new(pub: i32, secret: i32) {
    this.publicValue = pub;
    this[secretValue] = secret;
  }
  
  getSum(): i32 {
    return this.publicValue + this[secretValue];
  }
}

export let main = () => {
  let m = new Mixed(100, 23);
  return m.getSum();
};
`);
    assert.strictEqual(result, 123);
  });
});
