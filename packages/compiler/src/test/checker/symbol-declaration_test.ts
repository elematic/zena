import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {TypeKind, type SymbolType, type ClassType} from '../../lib/types.js';
import {NodeType} from '../../lib/ast.js';

suite('Checker: Symbol Declarations', () => {
  test('symbol declaration creates SymbolType with debugName', () => {
    const source = `export symbol iterator;`;
    const parser = new Parser(source, {path: 'test.zena'});
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0, 'No diagnostics expected');

    // Check that the symbol is exported with a SymbolType
    const exportInfo = module.exports.get('value:iterator');
    assert.ok(exportInfo, 'Symbol should be exported');
    assert.strictEqual(exportInfo.type.kind, TypeKind.Symbol);

    const symbolType = exportInfo.type as SymbolType;
    assert.ok(symbolType.debugName, 'Symbol should have a debugName');
    // The debugName should include the module path for diagnostics
    assert.ok(
      symbolType.debugName.includes('iterator'),
      'debugName should include symbol name',
    );
    assert.ok(
      symbolType.debugName.includes(':'),
      'debugName should include module path separator',
    );
    assert.ok(
      symbolType.debugName.includes('test.zena'),
      'debugName should include module path',
    );
  });

  test('symbol declaration is accessible by name', () => {
    const source = `
      symbol mySymbol;
      let x = mySymbol;
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0, 'No diagnostics expected');

    // Find the variable declaration
    const varDecl = module.body.find(
      (stmt) => stmt.type === NodeType.VariableDeclaration,
    );
    assert.ok(varDecl);
    if (varDecl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(varDecl.inferredType?.kind, TypeKind.Symbol);
    }
  });

  test('different symbols are distinct by identity', () => {
    const source = `
      export symbol symbolA;
      export symbol symbolB;
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0, 'No diagnostics expected');

    const exportA = module.exports.get('value:symbolA');
    const exportB = module.exports.get('value:symbolB');
    assert.ok(exportA && exportB);

    const symbolA = exportA.type as SymbolType;
    const symbolB = exportB.type as SymbolType;

    // Different symbols should be different objects (identity check)
    assert.notStrictEqual(
      symbolA,
      symbolB,
      'Different symbols should be different objects',
    );
  });

  test('static symbol in class has debugName', () => {
    const source = `
      export class Iterable {
        static symbol iterator;
      }
    `;
    const parser = new Parser(source, {path: 'mymodule.zena'});
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0, 'No diagnostics expected');

    // Find the class declaration
    const classDecl = module.body.find(
      (stmt) => stmt.type === NodeType.ClassDeclaration,
    );
    assert.ok(classDecl);
    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);
    const classType = classDecl.inferredType as ClassType;
    assert.ok(classType);
    assert.strictEqual(classType.kind, TypeKind.Class);

    const iteratorSymbol = classType.statics.get('iterator');
    assert.ok(iteratorSymbol, 'Static symbol should exist');
    assert.strictEqual(iteratorSymbol.kind, TypeKind.Symbol);
    const symbolType = iteratorSymbol as SymbolType;
    assert.ok(
      symbolType.debugName?.includes(':'),
      'debugName should include module path separator',
    );
    assert.ok(
      symbolType.debugName?.includes('Iterable.iterator'),
      'debugName should include class and symbol name',
    );
    assert.ok(
      symbolType.debugName?.includes('mymodule.zena'),
      'debugName should include module path',
    );
  });

  test('same symbol reference has identical type object', () => {
    const source = `
      symbol mySymbol;
      let x = mySymbol;
      let y = mySymbol;
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0, 'No diagnostics expected');

    // Find the variable declarations
    const varDecls = module.body.filter(
      (stmt) => stmt.type === NodeType.VariableDeclaration,
    );
    assert.strictEqual(varDecls.length, 2);

    const [xDecl, yDecl] = varDecls;
    if (
      xDecl.type === NodeType.VariableDeclaration &&
      yDecl.type === NodeType.VariableDeclaration
    ) {
      // Both should reference the SAME SymbolType object (identity)
      assert.strictEqual(
        xDecl.inferredType,
        yDecl.inferredType,
        'Same symbol should resolve to identical type object',
      );
    }
  });

  test('symbol-keyed field access', () => {
    const source = `
      symbol key;
      class Container {
        [key]: i32;
        #new() {
          this[key] = 42;
        }
      }
      let c = new Container();
      let x = c[key];
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0, 'No diagnostics expected');

    // Find the last variable declaration (let x = c[key])
    const varDecls = module.body.filter(
      (stmt) => stmt.type === NodeType.VariableDeclaration,
    );
    const xDecl = varDecls[varDecls.length - 1];
    if (xDecl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(xDecl.inferredType?.kind, TypeKind.Number);
    }
  });

  test('symbol-keyed method definition and access returns function type', () => {
    const source = `
      symbol iterator;
      class MyIterable {
        [iterator](): i32 {
          return 0;
        }
      }
      let iter = new MyIterable();
      let fn = iter[iterator];
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0, 'No diagnostics expected');

    // Find the last variable declaration (let fn = iter[iterator])
    const varDecls = module.body.filter(
      (stmt) => stmt.type === NodeType.VariableDeclaration,
    );
    const fnDecl = varDecls[varDecls.length - 1];
    if (fnDecl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(fnDecl.inferredType?.kind, TypeKind.Function);
    }
  });

  test('symbol-keyed access on non-existent symbol reports error', () => {
    const source = `
      symbol key1;
      symbol key2;
      class Container {
        [key1]: i32;
      }
      let c = new Container();
      let x = c[key2];
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const checker = TypeChecker.forModule(module);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('key2'));
  });
});
