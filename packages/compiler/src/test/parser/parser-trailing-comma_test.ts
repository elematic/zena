import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

const parse = (source: string) => new Parser(source).parse();

suite('Parser - Trailing Commas', () => {
  test('function parameters', () => {
    const ast = parse(`let add = (a: i32, b: i32,) => a;`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        assert.strictEqual(fn.params.length, 2);
      }
    }
  });

  test('function call arguments', () => {
    const ast = parse(`export let main = () => add(1, 2,);`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        const call = fn.body;
        assert.strictEqual(call.type, NodeType.CallExpression);
        if (call.type === NodeType.CallExpression) {
          assert.strictEqual(call.arguments.length, 2);
        }
      }
    }
  });

  test('new expression arguments', () => {
    const ast = parse(`export let main = () => new Foo(1, 2,);`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        const expr = fn.body;
        assert.strictEqual(expr.type, NodeType.NewExpression);
        if (expr.type === NodeType.NewExpression) {
          assert.strictEqual(expr.arguments.length, 2);
        }
      }
    }
  });

  test('array literal', () => {
    const ast = parse(`export let main = () => [1, 2, 3,];`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        const arr = fn.body;
        assert.strictEqual(arr.type, NodeType.ArrayLiteral);
        if (arr.type === NodeType.ArrayLiteral) {
          assert.strictEqual(arr.elements.length, 3);
        }
      }
    }
  });

  test('record literal', () => {
    const ast = parse(`export let main = () => { let r = {x: 1, y: 2,}; return r; };`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression && fn.body.type === NodeType.BlockStatement) {
        const varDecl = fn.body.body[0];
        assert.strictEqual(varDecl.type, NodeType.VariableDeclaration);
        if (varDecl.type === NodeType.VariableDeclaration) {
          assert.strictEqual(varDecl.init.type, NodeType.RecordLiteral);
          if (varDecl.init.type === NodeType.RecordLiteral) {
            assert.strictEqual(varDecl.init.properties.length, 2);
          }
        }
      }
    }
  });

  test('tuple literal', () => {
    const ast = parse(`export let main = (): (i32, i32) => { return (1, 2,); };`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression && fn.body.type === NodeType.BlockStatement) {
        const ret = fn.body.body[0];
        assert.strictEqual(ret.type, NodeType.ReturnStatement);
        if (ret.type === NodeType.ReturnStatement && ret.argument) {
          assert.strictEqual(ret.argument.type, NodeType.TupleLiteral);
          if (ret.argument.type === NodeType.TupleLiteral) {
            assert.strictEqual(ret.argument.elements.length, 2);
          }
        }
      }
    }
  });

  test('import specifiers', () => {
    const ast = parse(`import {Foo, Bar,} from 'mod';`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ImportDeclaration);
    if (decl.type === NodeType.ImportDeclaration) {
      assert.strictEqual(decl.imports.length, 2);
    }
  });

  test('type parameters', () => {
    const ast = parse(`class Pair<K, V,> { k: K; v: V; }`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);
    if (decl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(decl.typeParameters!.length, 2);
    }
  });

  test('type arguments', () => {
    const ast = parse(`export let main = () => new Pair<i32, i32,>();`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        const expr = fn.body;
        assert.strictEqual(expr.type, NodeType.NewExpression);
        if (expr.type === NodeType.NewExpression) {
          assert.strictEqual(expr.typeArguments!.length, 2);
        }
      }
    }
  });

  test('case class parameters', () => {
    const ast = parse(`class Point(x: f64, y: f64,)`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);
    if (decl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(decl.caseParams!.length, 2);
    }
  });

  test('class method parameters', () => {
    const ast = parse(`class Foo { foo(a: i32, b: i32,): i32 { return a; } }`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);
    if (decl.type === NodeType.ClassDeclaration) {
      const method = decl.body[0];
      assert.strictEqual(method.type, NodeType.MethodDefinition);
      if (method.type === NodeType.MethodDefinition) {
        assert.strictEqual(method.params.length, 2);
      }
    }
  });

  test('interface method parameters', () => {
    const ast = parse(`interface Foo { bar(a: i32, b: i32,): void; }`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.InterfaceDeclaration);
    if (decl.type === NodeType.InterfaceDeclaration) {
      const method = decl.body[0];
      assert.strictEqual(method.type, NodeType.MethodSignature);
      if (method.type === NodeType.MethodSignature) {
        assert.strictEqual(method.params.length, 2);
      }
    }
  });

  test('declare function parameters', () => {
    const ast = parse(`declare function log(msg: string, level: i32,): void;`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.DeclareFunction);
    if (decl.type === NodeType.DeclareFunction) {
      assert.strictEqual(decl.params.length, 2);
    }
  });

  test('record type annotation', () => {
    const ast = parse(`let f = (x: {a: i32, b: i32,}) => x;`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        const param = fn.params[0];
        assert.strictEqual(param.typeAnnotation!.type, NodeType.RecordTypeAnnotation);
        if (param.typeAnnotation!.type === NodeType.RecordTypeAnnotation) {
          assert.strictEqual(param.typeAnnotation!.properties.length, 2);
        }
      }
    }
  });

  test('tuple type annotation', () => {
    const ast = parse(`let f = (x: (i32, string,)) => x;`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        const param = fn.params[0];
        assert.strictEqual(param.typeAnnotation!.type, NodeType.TupleTypeAnnotation);
        if (param.typeAnnotation!.type === NodeType.TupleTypeAnnotation) {
          assert.strictEqual(param.typeAnnotation!.elementTypes.length, 2);
        }
      }
    }
  });

  test('function type annotation', () => {
    const ast = parse(`let f = (cb: (a: i32, b: i32,) => void) => cb;`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        const param = fn.params[0];
        assert.strictEqual(param.typeAnnotation!.type, NodeType.FunctionTypeAnnotation);
        if (param.typeAnnotation!.type === NodeType.FunctionTypeAnnotation) {
          assert.strictEqual(param.typeAnnotation!.params.length, 2);
        }
      }
    }
  });

  test('record destructuring pattern', () => {
    const ast = parse(`export let main = () => { let {x, y,} = p; return x; };`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression && fn.body.type === NodeType.BlockStatement) {
        const varDecl = fn.body.body[0];
        assert.strictEqual(varDecl.type, NodeType.VariableDeclaration);
        if (varDecl.type === NodeType.VariableDeclaration) {
          assert.strictEqual(varDecl.pattern.type, NodeType.RecordPattern);
          if (varDecl.pattern.type === NodeType.RecordPattern) {
            assert.strictEqual(varDecl.pattern.properties.length, 2);
          }
        }
      }
    }
  });

  test('record destructuring in function parameters', () => {
    const ast = parse(`let f = ({x, y,}: {x: i32, y: i32,}) => x;`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        assert.strictEqual(fn.params.length, 1);
        const param = fn.params[0];
        assert.strictEqual(param.pattern!.type, NodeType.RecordPattern);
        if (param.pattern!.type === NodeType.RecordPattern) {
          assert.strictEqual(param.pattern!.properties.length, 2);
        }
      }
    }
  });

  test('decorator arguments', () => {
    const ast = parse(`@external('mod', 'fn',)\ndeclare function log(x: string): void;`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.DeclareFunction);
    if (decl.type === NodeType.DeclareFunction) {
      assert.ok(decl.externalModule);
    }
  });

  test('inline tuple type', () => {
    const ast = parse(`let f = (): inline (i32, string,) => { return (1, 'a'); };`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        assert.strictEqual(fn.returnType!.type, NodeType.InlineTupleTypeAnnotation);
        if (fn.returnType!.type === NodeType.InlineTupleTypeAnnotation) {
          assert.strictEqual(fn.returnType!.elementTypes.length, 2);
        }
      }
    }
  });

  test('match class field pattern', () => {
    const ast = parse(`
      export let main = () => match (x) {
        case Foo {a, b,}: 1
      };
    `);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        const match = fn.body;
        assert.strictEqual(match.type, NodeType.MatchExpression);
        if (match.type === NodeType.MatchExpression) {
          const arm = match.cases[0];
          assert.strictEqual(arm.pattern.type, NodeType.ClassPattern);
          if (arm.pattern.type === NodeType.ClassPattern) {
            assert.strictEqual(arm.pattern.properties.length, 2);
          }
        }
      }
    }
  });

  test('match record pattern', () => {
    const ast = parse(`
      export let main = () => match (x) {
        case {a, b,}: 1
      };
    `);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        const match = fn.body;
        assert.strictEqual(match.type, NodeType.MatchExpression);
        if (match.type === NodeType.MatchExpression) {
          const arm = match.cases[0];
          assert.strictEqual(arm.pattern.type, NodeType.RecordPattern);
          if (arm.pattern.type === NodeType.RecordPattern) {
            assert.strictEqual(arm.pattern.properties.length, 2);
          }
        }
      }
    }
  });

  test('sealed variant params', () => {
    const ast = parse(`sealed class Shape { case Circle(radius: f64,) case Rect(w: f64, h: f64,) }`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);
    if (decl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(decl.sealedVariants!.length, 2);
      const circle = decl.sealedVariants![0];
      assert.strictEqual(circle.params!.length, 1);
      const rect = decl.sealedVariants![1];
      assert.strictEqual(rect.params!.length, 2);
    }
  });

  test('map literal', () => {
    const ast = parse(`export let main = () => { let m = { 'a' => 1, 'b' => 2, }; return m; };`);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression && fn.body.type === NodeType.BlockStatement) {
        const varDecl = fn.body.body[0];
        assert.strictEqual(varDecl.type, NodeType.VariableDeclaration);
        if (varDecl.type === NodeType.VariableDeclaration) {
          assert.strictEqual(varDecl.init.type, NodeType.MapLiteral);
          if (varDecl.init.type === NodeType.MapLiteral) {
            assert.strictEqual(varDecl.init.entries.length, 2);
          }
        }
      }
    }
  });

  test('super call arguments in constructor initializer', () => {
    const ast = parse(`
      class Base { new(x: i32) {} }
      class Child extends Base { new(x: i32) : super(x,) {} }
    `);
    assert.strictEqual(ast.body.length, 2);
  });
});
