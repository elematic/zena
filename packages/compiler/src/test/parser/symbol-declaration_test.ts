import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Symbol Declarations', () => {
  test('parses exported symbol declaration', () => {
    const source = `export symbol iterator;`;
    const parser = new Parser(source);
    const module = parser.parse();

    assert.strictEqual(module.body.length, 1);
    const decl = module.body[0];
    assert.strictEqual(decl.type, NodeType.SymbolDeclaration);
    if (decl.type === NodeType.SymbolDeclaration) {
      assert.strictEqual(decl.name.name, 'iterator');
      assert.strictEqual(decl.exported, true);
    }
  });

  test('parses non-exported symbol declaration', () => {
    const source = `symbol privateSymbol;`;
    const parser = new Parser(source);
    const module = parser.parse();

    assert.strictEqual(module.body.length, 1);
    const decl = module.body[0];
    assert.strictEqual(decl.type, NodeType.SymbolDeclaration);
    if (decl.type === NodeType.SymbolDeclaration) {
      assert.strictEqual(decl.name.name, 'privateSymbol');
      assert.strictEqual(decl.exported, false);
    }
  });

  test('parses multiple symbol declarations', () => {
    const source = `
      export symbol iterator;
      symbol myPrivateSymbol;
      export symbol serialize;
    `;
    const parser = new Parser(source);
    const module = parser.parse();

    assert.strictEqual(module.body.length, 3);

    const decl1 = module.body[0];
    assert.strictEqual(decl1.type, NodeType.SymbolDeclaration);
    if (decl1.type === NodeType.SymbolDeclaration) {
      assert.strictEqual(decl1.name.name, 'iterator');
      assert.strictEqual(decl1.exported, true);
    }

    const decl2 = module.body[1];
    assert.strictEqual(decl2.type, NodeType.SymbolDeclaration);
    if (decl2.type === NodeType.SymbolDeclaration) {
      assert.strictEqual(decl2.name.name, 'myPrivateSymbol');
      assert.strictEqual(decl2.exported, false);
    }

    const decl3 = module.body[2];
    assert.strictEqual(decl3.type, NodeType.SymbolDeclaration);
    if (decl3.type === NodeType.SymbolDeclaration) {
      assert.strictEqual(decl3.name.name, 'serialize');
      assert.strictEqual(decl3.exported, true);
    }
  });
});
