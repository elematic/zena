import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('self-referential generic types', () => {
  test('class with self-referential field', async () => {
    const source = `
      class Node<T> {
        value: T;
        child: Node<T> | null;
        
        #new(value: T) {
          this.value = value;
          this.child = null;
        }
      }
      
      export let main = (): i32 => {
        let node = new Node(42);
        return node.value;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 42);
  });

  test('linked list with self-referential next pointer', async () => {
    const source = `
      class ListNode<T> {
        data: T;
        next: ListNode<T> | null;
        
        #new(data: T) {
          this.data = data;
          this.next = null;
        }
      }
      
      export let main = (): i32 => {
        let head = new ListNode(1);
        let second = new ListNode(2);
        let third = new ListNode(3);
        head.next = second;
        second.next = third;
        // Access the last node's data
        let last = head.next;
        if (last != null) {
          let last2 = last.next;
          if (last2 != null) {
            return last2.data;
          }
        }
        return 0;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 3);
  });

  test('tree with self-referential children', async () => {
    const source = `
      class TreeNode<T> {
        value: T;
        left: TreeNode<T> | null;
        right: TreeNode<T> | null;
        
        #new(value: T) {
          this.value = value;
          this.left = null;
          this.right = null;
        }
      }
      
      export let main = (): i32 => {
        let root = new TreeNode(10);
        root.left = new TreeNode(5);
        root.right = new TreeNode(15);
        var sum = 0;
        let leftChild = root.left;
        if (leftChild != null) {
          sum = sum + leftChild.value;
        }
        let rightChild = root.right;
        if (rightChild != null) {
          sum = sum + rightChild.value;
        }
        return sum;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 20);
  });
});
