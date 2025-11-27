import {describe, it} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

describe('Parser - Imports', () => {
  it('parses standard import syntax', () => {
    const source = `import { x, y as z } from './foo.zena';`;
    const parser = new Parser(source);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ImportDeclaration);
    if (decl.type === NodeType.ImportDeclaration) {
      assert.strictEqual(decl.moduleSpecifier.value, './foo.zena');
      assert.strictEqual(decl.imports.length, 2);
      assert.strictEqual(decl.imports[0].imported.name, 'x');
      assert.strictEqual(decl.imports[0].local.name, 'x');
      assert.strictEqual(decl.imports[1].imported.name, 'y');
      assert.strictEqual(decl.imports[1].local.name, 'z');
    }
  });

  it('parses flipped import syntax', () => {
    const source = `from './foo.zena' import { x, y as z };`;
    const parser = new Parser(source);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ImportDeclaration);
    if (decl.type === NodeType.ImportDeclaration) {
      assert.strictEqual(decl.moduleSpecifier.value, './foo.zena');
      assert.strictEqual(decl.imports.length, 2);
    }
  });

  it('enforces imports at top', () => {
    const source = `
      let x = 1;
      import { y } from './foo.zena';
    `;
    const parser = new Parser(source);
    assert.throws(() => parser.parse(), /Imports must appear at the top/);
  });
});
