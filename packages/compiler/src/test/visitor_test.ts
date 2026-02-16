import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../lib/parser.js';
import {visit} from '../lib/visitor.js';
import {NodeType, type Module, type Identifier, type Node} from '../lib/ast.js';

suite('AST Visitor', () => {
  const parse = (source: string): Module => {
    const parser = new Parser(source, {path: 'test.zena', isStdlib: false});
    return parser.parse();
  };

  test('visits all identifiers in simple expression', () => {
    const ast = parse('let x = a + b;');
    const identifiers: string[] = [];

    visit<void>(
      ast,
      {
        visitIdentifier(node: Identifier) {
          identifiers.push(node.name);
        },
      },
      undefined,
    );

    // x is the binding, a and b are references
    assert.deepStrictEqual(identifiers, ['x', 'a', 'b']);
  });

  test('visits function parameters', () => {
    const ast = parse('let f = (x: i32, y: i32) => x + y;');
    const identifiers: string[] = [];

    visit<void>(
      ast,
      {
        visitIdentifier(node: Identifier) {
          identifiers.push(node.name);
        },
      },
      undefined,
    );

    // f is binding, x and y are param names, then x and y are references
    assert.deepStrictEqual(identifiers, ['f', 'x', 'y', 'x', 'y']);
  });

  test('visits class declaration members', () => {
    const ast = parse(`
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }
    `);

    const fieldNames: string[] = [];
    const methodNames: string[] = [];

    visit<void>(
      ast,
      {
        visitFieldDefinition(node) {
          if (node.name.type === NodeType.Identifier) {
            fieldNames.push(node.name.name);
          }
        },
        visitMethodDefinition(node) {
          if (node.name.type === NodeType.Identifier) {
            methodNames.push(node.name.name);
          }
        },
      },
      undefined,
    );

    assert.deepStrictEqual(fieldNames, ['x', 'y']);
    assert.deepStrictEqual(methodNames, ['#new']);
  });

  test('visits type annotations', () => {
    const ast = parse('let x: Map<string, i32> = null;');
    const typeNames: string[] = [];

    visit<void>(
      ast,
      {
        visitTypeAnnotation(node) {
          typeNames.push(node.name);
        },
      },
      undefined,
    );

    // Map, string, i32
    assert.deepStrictEqual(typeNames, ['Map', 'string', 'i32']);
  });

  test('visits new expression callee', () => {
    const ast = parse('let p = new Point(1, 2);');
    const newExprCallees: string[] = [];

    visit<void>(
      ast,
      {
        visitNewExpression(node) {
          newExprCallees.push(node.callee.name);
        },
      },
      undefined,
    );

    assert.deepStrictEqual(newExprCallees, ['Point']);
  });

  test('visits string literals', () => {
    const ast = parse('let s = "hello";');
    const strings: string[] = [];

    visit<void>(
      ast,
      {
        visitStringLiteral(node) {
          strings.push(node.value);
        },
      },
      undefined,
    );

    assert.deepStrictEqual(strings, ['hello']);
  });

  test('visits template literals', () => {
    const ast = parse('let s = `hello ${name}`;');
    let templateCount = 0;
    const identifiers: string[] = [];

    visit<void>(
      ast,
      {
        visitTemplateLiteral() {
          templateCount++;
        },
        visitIdentifier(node: Identifier) {
          identifiers.push(node.name);
        },
      },
      undefined,
    );

    assert.strictEqual(templateCount, 1);
    assert.ok(identifiers.includes('name'));
  });

  test('visits range expressions', () => {
    const ast = parse('let r = 1..10;');
    let rangeCount = 0;

    visit<void>(
      ast,
      {
        visitRangeExpression() {
          rangeCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(rangeCount, 1);
  });

  test('visits match expressions', () => {
    const ast = parse(`
      let result = match (x) {
        case 1: "one"
        case 2: "two"
        case _: "other"
      };
    `);

    let matchCount = 0;
    let caseCount = 0;

    visit<void>(
      ast,
      {
        visitMatchExpression() {
          matchCount++;
        },
        visitMatchCase() {
          caseCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(matchCount, 1);
    assert.strictEqual(caseCount, 3);
  });

  test('visits interface declarations', () => {
    const ast = parse(`
      interface Drawable {
        draw(): void;
      }
    `);

    let interfaceCount = 0;
    let methodSigCount = 0;

    visit<void>(
      ast,
      {
        visitInterfaceDeclaration() {
          interfaceCount++;
        },
        visitMethodSignature() {
          methodSigCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(interfaceCount, 1);
    assert.strictEqual(methodSigCount, 1);
  });

  test('visits mixin declarations', () => {
    const ast = parse(`
      mixin Timestamped {
        time: i64;
      }
    `);

    let mixinCount = 0;

    visit<void>(
      ast,
      {
        visitMixinDeclaration() {
          mixinCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(mixinCount, 1);
  });

  test('beforeVisit hook can skip nodes', () => {
    const ast = parse(`
      let x = 1;
      let y = 2;
    `);

    const identifiers: string[] = [];
    let skipped = false;

    visit<void>(
      ast,
      {
        beforeVisit(node: Node) {
          // Skip the second variable declaration
          if (node.type === NodeType.VariableDeclaration && skipped) {
            return false;
          }
          if (node.type === NodeType.VariableDeclaration) {
            skipped = true;
          }
          return true;
        },
        visitIdentifier(node: Identifier) {
          identifiers.push(node.name);
        },
      },
      undefined,
    );

    // Only x should be visited, y is skipped
    assert.deepStrictEqual(identifiers, ['x']);
  });

  test('afterVisit hook is called after children', () => {
    const ast = parse('let x = a + b;');
    const order: string[] = [];

    visit<void>(
      ast,
      {
        visitBinaryExpression() {
          order.push('binary-enter');
        },
        visitIdentifier(node: Identifier) {
          order.push(`id:${node.name}`);
        },
        afterVisit(node: Node) {
          if (node.type === NodeType.BinaryExpression) {
            order.push('binary-exit');
          }
        },
      },
      undefined,
    );

    // Binary is entered, then children (a, b), then binary is exited
    assert.ok(order.indexOf('binary-enter') < order.indexOf('id:a'));
    assert.ok(order.indexOf('id:b') < order.indexOf('binary-exit'));
  });

  test('passes context through traversal', () => {
    const ast = parse('let x = 1;');

    interface Context {
      depth: number;
      maxDepth: number;
    }

    const ctx: Context = {depth: 0, maxDepth: 0};

    visit<Context>(
      ast,
      {
        beforeVisit(_node: Node, context: Context) {
          context.depth++;
          context.maxDepth = Math.max(context.maxDepth, context.depth);
          return true;
        },
        afterVisit(_node: Node, context: Context) {
          context.depth--;
        },
      },
      ctx,
    );

    assert.ok(ctx.maxDepth > 0, 'Should have visited nested nodes');
    assert.strictEqual(
      ctx.depth,
      0,
      'Depth should return to 0 after traversal',
    );
  });

  test('visits try/catch expressions', () => {
    const ast = parse(`
      let result = try {
        riskyOperation();
      } catch (e) {
        handleError(e);
      };
    `);

    let tryCount = 0;
    let catchCount = 0;

    visit<void>(
      ast,
      {
        visitTryExpression() {
          tryCount++;
        },
        visitCatchClause() {
          catchCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(tryCount, 1);
    assert.strictEqual(catchCount, 1);
  });

  test('visits throw expressions', () => {
    const ast = parse(`
      let fail = () => throw new Error("oops");
    `);

    let throwCount = 0;

    visit<void>(
      ast,
      {
        visitThrowExpression() {
          throwCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(throwCount, 1);
  });

  test('visits if expressions', () => {
    const ast = parse('let x = if (cond) { 1 } else { 2 };');

    let ifExprCount = 0;

    visit<void>(
      ast,
      {
        visitIfExpression() {
          ifExprCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(ifExprCount, 1);
  });

  test('visits array literals', () => {
    const ast = parse('let arr = #[1, 2, 3];');

    let arrayCount = 0;
    let numberCount = 0;

    visit<void>(
      ast,
      {
        visitArrayLiteral() {
          arrayCount++;
        },
        visitNumberLiteral() {
          numberCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(arrayCount, 1);
    assert.strictEqual(numberCount, 3);
  });

  test('visits record literals', () => {
    const ast = parse('let obj = { x: 1, y: 2 };');

    let recordCount = 0;
    let propCount = 0;

    visit<void>(
      ast,
      {
        visitRecordLiteral() {
          recordCount++;
        },
        visitPropertyAssignment() {
          propCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(recordCount, 1);
    assert.strictEqual(propCount, 2);
  });

  test('visits tuple literals', () => {
    const ast = parse('let t = [1, "hello"];');

    let tupleCount = 0;

    visit<void>(
      ast,
      {
        visitTupleLiteral() {
          tupleCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(tupleCount, 1);
  });

  test('visits enum declarations', () => {
    const ast = parse(`
      enum Color { Red, Green, Blue }
    `);

    let enumCount = 0;

    visit<void>(
      ast,
      {
        visitEnumDeclaration() {
          enumCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(enumCount, 1);
  });

  test('visits LetPatternCondition in if statement', () => {
    const ast = parse(`
      let iter = getIterator();
      if (let value = iter.next()) {
        doSomething(value);
      }
    `);

    let letPatternCount = 0;
    const identifiers: string[] = [];

    visit<void>(
      ast,
      {
        visitLetPatternCondition() {
          letPatternCount++;
        },
        visitIdentifier(node: Identifier) {
          identifiers.push(node.name);
        },
      },
      undefined,
    );

    assert.strictEqual(letPatternCount, 1);
    // Should visit: iter (binding), getIterator (ref), value (pattern binding),
    // iter (ref), next (not visited - member property), doSomething (ref), value (ref)
    assert.ok(identifiers.includes('value'), 'should visit pattern binding');
    assert.ok(identifiers.includes('iter'), 'should visit init expression');
  });

  test('visits LetPatternCondition in while statement', () => {
    const ast = parse(`
      let iter = getIterator();
      while (let value = iter.next()) {
        process(value);
      }
    `);

    let letPatternCount = 0;

    visit<void>(
      ast,
      {
        visitLetPatternCondition() {
          letPatternCount++;
        },
      },
      undefined,
    );

    assert.strictEqual(letPatternCount, 1);
  });
});
