/**
 * Tests for generic class instantiation from within another generic class.
 *
 * This tests a bug where creating an instance of a generic class (like MapEntry<K, V>)
 * from within another generic class (like MapEntryIterator<K, V>) would cause duplicate
 * struct types to be generated because the type parameters weren't being resolved
 * through the current type context before interning.
 *
 * The symptom was a WASM compile error like:
 * "struct.set[0] expected type (ref null 232), found local.get of type (ref null 272)"
 *
 * The fix ensures type parameters are resolved through ctx.currentTypeArguments before
 * computing interning keys in instantiateClass and mapCheckerTypeToWasmType.
 */
import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Generic Nested Instantiation', () => {
  // Core regression test: a generic class that creates instances of another
  // generic class using its own type parameters in a method return.
  test('generic class creates instance of another generic class in method', async () => {
    const source = `
// A simple generic pair class (similar to MapEntry<K, V>)
class Pair<K, V> {
  first: K;
  second: V;

  #new(first: K, second: V) {
    this.first = first;
    this.second = second;
  }
}

// A generic iterator-like class that creates Pair instances
// (similar to MapEntryIterator<K, V>)
class PairFactory<K, V> {
  keyValue: K;
  valueValue: V;

  #new(k: K, v: V) {
    this.keyValue = k;
    this.valueValue = v;
  }

  // This method creates a new Pair<K, V> - the type parameters must be
  // resolved through the current context to avoid duplicate struct types
  makePair(): Pair<K, V> {
    return new Pair<K, V>(this.keyValue, this.valueValue);
  }
}

export let main = (): i32 => {
  let factory = new PairFactory<i32, i32>(10, 32);
  let pair = factory.makePair();
  return pair.first + pair.second;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  // Test with nested generic types as type arguments
  test('generic class creates instance with nested generic type arguments', async () => {
    const source = `
class Box<T> {
  value: T;
  #new(v: T) { this.value = v; }
}

class Pair<K, V> {
  first: K;
  second: V;
  #new(first: K, second: V) {
    this.first = first;
    this.second = second;
  }
}

// Factory that uses Box<T> as type arguments
class BoxPairFactory<T> {
  boxedValue: Box<T>;

  #new(v: T) {
    this.boxedValue = new Box<T>(v);
  }

  // Creates Pair<string, Box<T>> - both the outer Pair and inner Box
  // must be correctly resolved
  makePair(key: string): Pair<string, Box<T>> {
    return new Pair<string, Box<T>>(key, this.boxedValue);
  }
}

export let main = (): i32 => {
  let factory = new BoxPairFactory<i32>(42);
  let pair = factory.makePair("answer");
  return pair.second.value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  // Test with multi-value return (union of inline tuples) which was part of
  // the original failure in MapEntryIterator.next()
  test('generic class with multi-value return creating another generic', async () => {
    const source = `
class Entry<K, V> {
  key: K;
  value: V;
  #new(k: K, v: V) {
    this.key = k;
    this.value = v;
  }
}

class EntryIterator<K, V> {
  currentKey: K;
  currentValue: V;
  hasMore: boolean;

  #new(k: K, v: V) {
    this.currentKey = k;
    this.currentValue = v;
    this.hasMore = true;
  }

  // Multi-value return with a generic class - the return type involves
  // Entry<K, V> which must be correctly resolved
  next(): inline (true, Entry<K, V>) | inline (false, never) {
    if (this.hasMore) {
      this.hasMore = false;
      return (true, new Entry<K, V>(this.currentKey, this.currentValue));
    }
    return (false, _);
  }
}

export let main = (): i32 => {
  let iter = new EntryIterator<string, i32>("test", 42);
  let (hasValue, entry) = iter.next();
  if (hasValue) {
    // Use cast to access the entry since narrowing may not work through union
    return (entry as Entry<string, i32>).value;
  }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  // Test multiple instantiations of the same nested generic class
  // to verify they all share the same struct type
  test('multiple instantiations share same struct type', async () => {
    const source = `
class Result<T> {
  value: T;
  #new(v: T) { this.value = v; }
}

class Producer<T> {
  val: T;
  #new(v: T) { this.val = v; }

  // Multiple methods that all create Result<T>
  produce1(): Result<T> { return new Result<T>(this.val); }
  produce2(): Result<T> { return new Result<T>(this.val); }
  produce3(): Result<T> { return new Result<T>(this.val); }
}

export let main = (): i32 => {
  let p = new Producer<i32>(14);
  let r1 = p.produce1();
  let r2 = p.produce2();
  let r3 = p.produce3();
  return r1.value + r2.value + r3.value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });
});
