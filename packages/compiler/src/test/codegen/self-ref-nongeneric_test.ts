import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('self-referential non-generic classes', () => {
  test('class with self-referential field', async () => {
    const source = `
class Node {
  value: i32;
  child: Node;
  
  #new(value: i32, child: Node) {
    this.value = value;
    this.child = child;
  }
}

export let main = () => {
  let leaf = new Node(1, null as Node);
  let parent = new Node(2, leaf);
  return parent.child.value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('linked list traversal', async () => {
    const source = `
class ListNode {
  value: i32;
  next: ListNode;
  
  #new(value: i32, next: ListNode) {
    this.value = value;
    this.next = next;
  }
}

export let main = () => {
  let n3 = new ListNode(30, null as ListNode);
  let n2 = new ListNode(20, n3);
  let n1 = new ListNode(10, n2);
  return n1.next.next.value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 30);
  });
});
