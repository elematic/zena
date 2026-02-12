import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import * as assert from 'node:assert';

suite('Nested Generic Type Resolution Bug', () => {
  // This test verifies that calling a generic function from within a generic
  // class method works correctly. The inner function's type parameter gets
  // resolved through the outer class's type arguments.
  //
  // Previously this failed with:
  // "Unresolved type parameter: U, currentTypeArguments keys: [T]"
  //
  // The fix resolves type arguments through the enclosing context before
  // instantiating the generic function.
  test('generic function called from generic class method', async () => {
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
  // the inner T to the outer U.
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
