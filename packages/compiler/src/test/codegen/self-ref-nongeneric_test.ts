import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('self-referential non-generic classes', () => {
  test('class with self-referential field', async () => {
    const source = `
class Node {
  value: i32;
  child: Node | null;
  
  new(value: i32, child: Node | null) : value = value, child = child {}
}

export let main = () => {
  let leaf = new Node(1, null);
  let parent = new Node(2, leaf);
  return (parent.child as Node).value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('linked list traversal', async () => {
    const source = `
class ListNode {
  value: i32;
  var next: ListNode | null;
  
  new(value: i32, next: ListNode | null) : value = value, next = next {}
}

export let main = () => {
  let n3 = new ListNode(30, null);
  let n2 = new ListNode(20, n3);
  let n1 = new ListNode(10, n2);
  let next1 = n1.next as ListNode;
  let next2 = next1.next as ListNode;
  return next2.value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 30);
  });
});
