import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('mixin fields', () => {
  test('simple mixin field with i32', async () => {
    const source = `
mixin Chainable {
  var next: i32;
}

class ChainNode with Chainable {
  id: i32;
  
  new(id: i32) : id = id {}
  
  setNext(n: i32): i32 {
    this.next = n;
    return this.next;
  }
}

export let main = (): i32 => {
  let a = new ChainNode(1);
  return a.setNext(42);
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('mixin field with initializer', async () => {
    const source = `
mixin Chainable {
  var next: i32 = 99;
}

class ChainNode with Chainable {
  id: i32;
  
  new(id: i32) : id = id {}
  
  getNext(): i32 {
    return this.next;
  }
}

export let main = (): i32 => {
  let a = new ChainNode(1);
  return a.getNext();
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 99);
  });

  test('mixin field with nullable class reference', async () => {
    const source = `
class Node {
  value: i32;
  new(value: i32) : value = value {}
}

mixin Chainable {
  var next: Node | null;
}

class ChainNode with Chainable {
  id: i32;
  
  new(id: i32) : id = id {}
  
  setNext(n: Node): void {
    this.next = n;
  }
  
  getNextValue(): i32 {
    let n = this.next;
    if (n != null) {
      return n.value;
    }
    return 0;
  }
}

export let main = (): i32 => {
  let a = new ChainNode(1);
  let b = new Node(42);
  a.setNext(b);
  return a.getNextValue();
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('self-referential mixin field', async () => {
    // The mixin field type references the class that uses the mixin
    const source = `
mixin Chainable {
  var next: ChainNode | null;
}

class ChainNode with Chainable {
  id: i32;
  
  new(id: i32) : id = id {}
  
  setNext(n: ChainNode): void {
    this.next = n;
  }
  
  // Return 1 if next is not null, 0 otherwise
  hasNextAsInt(): i32 {
    if (this.next != null) {
      return 1;
    }
    return 0;
  }
  
  // Direct property access - no narrowing
  getNextDirect(): ChainNode | null {
    return this.next;
  }
}

export let main = (): i32 => {
  // Test if removing the mixin fixes it
  let b = new ChainNode(42);
  return b.id;
};
`;
    // This fails - b.id is 0 instead of 42
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('class without mixin for comparison', async () => {
    const source = `
class SimpleNode {
  id: i32;
  var next: SimpleNode | null;
  new(id: i32) : id = id {}
}

export let main = (): i32 => {
  let b = new SimpleNode(42);
  return b.id;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });
});
