import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import * as assert from 'node:assert';

suite('Nested Generic Type Resolution Bug', () => {
  // TODO: This test documents a codegen bug where calling a generic function
  // from within a generic class method fails when the inner function's type
  // parameter is resolved to the outer class's type parameter.
  //
  // Error: "Unresolved type parameter: T, currentTypeArguments keys: [U]"
  //
  // The bug occurs because the inner function's type context doesn't have
  // visibility into the outer class's type arguments.
  test.todo('generic function called from generic class method', async () => {
    const source = `
// A generic wrapper class (like Option's Some<T>)
class Wrapper<T> {
  value: T;
  #new(value: T) {
    this.value = value;
  }
}

// A generic helper function (like some<T>())
let wrap = <T>(value: T): Wrapper<T> => new Wrapper(value);

// A generic container class (like Map<K, V>)
class Container<U> {
  item: U;
  
  #new(item: U) {
    this.item = item;
  }
  
  // This method calls wrap<U>(this.item), which should resolve
  // the inner T to the outer U, but codegen fails here.
  getWrapped(): Wrapper<U> {
    return wrap(this.item);
  }
}

export let main = (): i32 => {
  let c = new Container<i32>(42);
  let w = c.getWrapped();
  return w.value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  // Simpler case: works if you use new Wrapper<U>() directly instead of
  // calling a generic function
  test('direct generic instantiation in generic class works', async () => {
    const source = `
class Wrapper<T> {
  value: T;
  #new(value: T) {
    this.value = value;
  }
}

class Container<U> {
  item: U;
  
  #new(item: U) {
    this.item = item;
  }
  
  // Direct instantiation works - no intermediate generic function
  getWrapped(): Wrapper<U> {
    return new Wrapper<U>(this.item);
  }
}

export let main = (): i32 => {
  let c = new Container<i32>(42);
  let w = c.getWrapped();
  return w.value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });
});
