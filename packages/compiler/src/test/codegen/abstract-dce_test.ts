import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Abstract Class DCE', () => {
  test('abstract class field getter is included in vtable when accessed polymorphically', async () => {
    const source = `
      abstract class Node {
        nodeType: i32;
        
        new(nodeType: i32) : nodeType = nodeType { }
      }
      
      class Leaf extends Node {
        value: i32;
        
        new(value: i32) : value = value, super(1) { }
      }
      
      export let main = (): i32 => {
        let node: Node = new Leaf(42);
        return node.nodeType;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('abstract class string field getter works polymorphically', async () => {
    const source = `
      abstract class Base {
        name: string;
        
        new(name: string) : name = name { }
      }
      
      class Child extends Base {
        new() : super('test') { }
      }
      
      // Access string field through base class type
      let getName = (b: Base): string => b.name;
      
      export let main = (): i32 => {
        let child = new Child();
        let base: Base = child;
        let n = getName(base);
        // Return 1 if we got here without crashing
        return 1;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('abstract class boolean field getter works polymorphically', async () => {
    const source = `
      abstract class Base {
        active: boolean;
        
        new(active: boolean) : active = active { }
      }
      
      class Child extends Base {
        new() : super(true) { }
      }
      
      // Access boolean field through base class type
      let isActive = (b: Base): boolean => b.active;
      
      export let main = (): i32 => {
        let child = new Child();
        let base: Base = child;
        if (isActive(base)) { return 1; }
        return 0;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('abstract class field getter works with enum field - no match', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      abstract class Base {
        kind: Kind;
        
        new(kind: Kind) : kind = kind { }
      }
      
      class Child extends Base {
        new() : super(Kind.B) { }
      }
      
      // Access enum field through base class type
      let getKind = (b: Base): Kind => b.kind;
      
      export let main = (): i32 => {
        let child = new Child();
        let base: Base = child;
        let k = getKind(base);
        // Just compare the enum - no match expression
        if (k == Kind.B) { return 1; }
        return 0;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('match on enum local variable in block body', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      export let main = (): i32 => {
        let k = Kind.B;
        return match (k) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        };
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('match on enum without abstraction works', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      // Use a helper function like the passing tests do
      let kindToInt = (k: Kind): i32 => {
        return match (k) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        };
      };
      
      export let main = (): i32 => {
        return kindToInt(Kind.B);
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('match on enum from non-polymorphic class field', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      class Container {
        kind: Kind;
        
        new(kind: Kind) : kind = kind { }
      }
      
      export let main = (): i32 => {
        let c = new Container(Kind.B);
        let k = c.kind;
        return match (k) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        };
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('match on enum from polymorphic class field (non-abstract)', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      class Base {
        kind: Kind;
        
        new(kind: Kind) : kind = kind { }
      }
      
      class Child extends Base {
        new() : super(Kind.B) { }
      }
      
      let getKind = (b: Base): Kind => b.kind;
      
      export let main = (): i32 => {
        let child = new Child();
        let base: Base = child;
        let k = getKind(base);
        return match (k) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        };
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('simple enum match - direct assign implicit return', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      export let main = (): i32 => {
        let k = Kind.B;
        return match (k) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        };
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('simple enum match - implicit return fails', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      let createB = (): Kind => Kind.B;
      
      export let main = (): i32 => {
        let k = createB();
        match (k) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        }
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('simple enum match - explicit return works', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      let createB = (): Kind => Kind.B;
      
      export let main = (): i32 => {
        let k = createB();
        return match (k) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        };
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('non-abstract class enum field - via local no return keyword', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      class Base {
        kind: Kind;
        
        new(kind: Kind) : kind = kind { }
      }
      
      class Child extends Base {
        new() : super(Kind.B) { }
      }
      
      // Access enum field through base class type
      let getKind = (b: Base): Kind => b.kind;
      
      export let main = (): i32 => {
        let child = new Child();
        let base: Base = child;
        // NO ABSTRACT - test if issue is specific to abstract
        let k = getKind(base);
        match (k) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        }
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('abstract class field getter works with enum field - via local no return keyword', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      abstract class Base {
        kind: Kind;
        
        new(kind: Kind) : kind = kind { }
      }
      
      class Child extends Base {
        new() : super(Kind.B) { }
      }
      
      // Access enum field through base class type
      let getKind = (b: Base): Kind => b.kind;
      
      export let main = (): i32 => {
        let child = new Child();
        let base: Base = child;
        // Assign to local first, then match on local WITHOUT return keyword
        let k = getKind(base);
        match (k) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        }
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('abstract class field getter works with enum field - via local', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      abstract class Base {
        kind: Kind;
        
        new(kind: Kind) : kind = kind { }
      }
      
      class Child extends Base {
        new() : super(Kind.B) { }
      }
      
      // Access enum field through base class type
      let getKind = (b: Base): Kind => b.kind;
      
      export let main = (): i32 => {
        let child = new Child();
        let base: Base = child;
        // Assign to local first, then match on local
        let k = getKind(base);
        return match (k) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        };
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('abstract class field getter works with enum field', async () => {
    const source = `
      enum Kind {
        A,
        B,
        C
      }
      
      abstract class Base {
        kind: Kind;
        
        new(kind: Kind) : kind = kind { }
      }
      
      class Child extends Base {
        new() : super(Kind.B) { }
      }
      
      // Access enum field through base class type
      let getKind = (b: Base): Kind => b.kind;
      
      export let main = (): i32 => {
        let child = new Child();
        let base: Base = child;
        // Match directly on the call result, no intermediate variable
        return match (getKind(base)) {
          case Kind.A: 0
          case Kind.B: 1
          case Kind.C: 2
        };
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
