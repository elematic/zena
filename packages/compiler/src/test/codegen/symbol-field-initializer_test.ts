import {suite, test} from 'node:test';
import {strict as assert} from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Codegen: Symbol Field Initializers', () => {
  test('symbol field with constant initializer', async () => {
    const result = await compileAndRun(`
symbol myField;

class Data {
  :myField: i32 = 42;
}

export let main = () => {
  let d = new Data();
  return d.:myField;
};
`);
    assert.strictEqual(result, 42);
  });

  test('symbol field with expression initializer', async () => {
    const result = await compileAndRun(`
symbol myField;

class Data {
  :myField: i32 = 10 + 32;
}

export let main = () => {
  let d = new Data();
  return d.:myField;
};
`);
    assert.strictEqual(result, 42);
  });

  test('symbol field with mixed regular fields', async () => {
    const result = await compileAndRun(`
symbol secret;

class Box {
  public_value: i32 = 100;
  :secret: i32 = 200;
}

export let main = () => {
  let b = new Box();
  return b.public_value + b.:secret;
};
`);
    assert.strictEqual(result, 300);
  });

  test('symbol-named accessor with getter', async () => {
    const result = await compileAndRun(`
symbol hidden;

class Container {
  #value: i32;
  
  #new(v: i32) {
    this.#value = v;
  }
  
  :hidden: i32 {
    get {
      return this.#value * 2;
    }
  }
}

export let main = () => {
  let c = new Container(21);
  return c.:hidden;
};
`);
    assert.strictEqual(result, 42);
  });

  test('symbol-named accessor with getter and setter', async () => {
    const result = await compileAndRun(`
symbol value;

class Wrapper {
  #data: i32;
  
  #new() {
    this.#data = 0;
  }
  
  :value: i32 {
    get {
      return this.#data;
    }
    set(v) {
      this.#data = v + 10;
    }
  }
}

export let main = () => {
  let w = new Wrapper();
  w.:value = 32;
  return w.:value;
};
`);
    assert.strictEqual(result, 42);
  });
});
