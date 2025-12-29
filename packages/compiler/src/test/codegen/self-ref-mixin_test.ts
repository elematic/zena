import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('self-referential mixins', () => {
  // These tests document a current limitation: mixins cannot have fields
  // that reference classes which apply the mixin. This is because the mixin
  // is type-checked before the class that uses it is defined.
  // TODO: Support forward references in mixin field types.

  test.skip('mixin with field referencing class that applies it', async () => {
    // This is the key self-referential mixin case:
    // The mixin has a field of type TreeNode, but TreeNode uses the mixin
    const source = `
mixin TreeLike {
  left: TreeNode;
  right: TreeNode;
}

class TreeNode with TreeLike {
  value: i32;
  
  #new(value: i32) {
    this.value = value;
  }
  
  setChildren(l: TreeNode, r: TreeNode): void {
    this.left = l;
    this.right = r;
  }
  
  sumChildren(): i32 {
    return this.left.value + this.right.value;
  }
}

export let main = (): i32 => {
  let root = new TreeNode(1);
  let left = new TreeNode(10);
  let right = new TreeNode(20);
  root.setChildren(left, right);
  return root.sumChildren();
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 30);
  });

  test.skip('simple mixin with next pointer', async () => {
    const source = `
mixin Chainable {
  next: ChainNode;
}

class ChainNode with Chainable {
  id: i32;
  
  #new(id: i32) {
    this.id = id;
  }
  
  setNext(n: ChainNode): void {
    this.next = n;
  }
  
  getNextId(): i32 {
    return this.next.id;
  }
}

export let main = (): i32 => {
  let a = new ChainNode(1);
  let b = new ChainNode(2);
  a.setNext(b);
  return a.getNextId();
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 2);
  });
});
