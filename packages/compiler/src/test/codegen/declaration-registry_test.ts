import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileWithDetails} from './utils.js';
import {NodeType, type VariableDeclaration} from '../../lib/ast.js';

suite('Codegen Declaration Registry', () => {
  test('should register functions by declaration', async () => {
    const source = `
export let add = (a: i32, b: i32) => a + b;
export let sub = (a: i32, b: i32) => a - b;
`;
    const {codegen, exports, modules} = await compileWithDetails(source);

    // Find the entry point module (the one with our declarations)
    const entryModule = modules.find((m) => m.path === '/main.zena');
    assert.ok(entryModule, 'Should find entry module');
    const ast = entryModule.ast;

    // Find variable declarations
    const varDecls = ast.body.filter(
      (s): s is VariableDeclaration => s.type === NodeType.VariableDeclaration,
    );
    const addDecl = varDecls.find(
      (d) => d.pattern.type === NodeType.Identifier && d.pattern.name === 'add',
    );
    const subDecl = varDecls.find(
      (d) => d.pattern.type === NodeType.Identifier && d.pattern.name === 'sub',
    );

    assert.ok(addDecl, 'Should find add declaration');
    assert.ok(subDecl, 'Should find sub declaration');

    // Get the function expressions
    const addFunc = addDecl.init;
    const subFunc = subDecl.init;

    // Access codegen context via public getter
    const ctx = codegen.context;
    const addIndex = ctx.getFunctionIndexByDecl(addFunc);
    const subIndex = ctx.getFunctionIndexByDecl(subFunc);

    assert.ok(addIndex !== undefined, 'add function should be registered');
    assert.ok(subIndex !== undefined, 'sub function should be registered');
    assert.notStrictEqual(
      addIndex,
      subIndex,
      'Functions should have different indices',
    );

    // Verify the functions work correctly
    assert.strictEqual((exports.add as Function)(3, 5), 8);
    assert.strictEqual((exports.sub as Function)(10, 4), 6);
  });

  test('should register global variables by declaration', async () => {
    const source = `
export let globalA: i32 = 42;
export let globalB: i32 = 100;
`;
    const {codegen, exports, modules} = await compileWithDetails(source);

    // Find the entry point module
    const entryModule = modules.find((m) => m.path === '/main.zena');
    assert.ok(entryModule, 'Should find entry module');
    const ast = entryModule.ast;

    // Find variable declarations
    const varDecls = ast.body.filter(
      (s): s is VariableDeclaration => s.type === NodeType.VariableDeclaration,
    );

    const globalADecl = varDecls.find(
      (d) =>
        d.pattern.type === NodeType.Identifier && d.pattern.name === 'globalA',
    );
    const globalBDecl = varDecls.find(
      (d) =>
        d.pattern.type === NodeType.Identifier && d.pattern.name === 'globalB',
    );

    assert.ok(globalADecl, 'Should find globalA declaration');
    assert.ok(globalBDecl, 'Should find globalB declaration');

    // Access codegen context via public getter
    const ctx = codegen.context;
    const globalAIndex = ctx.getGlobalIndexByDecl(globalADecl);
    const globalBIndex = ctx.getGlobalIndexByDecl(globalBDecl);

    assert.ok(globalAIndex !== undefined, 'globalA should be registered');
    assert.ok(globalBIndex !== undefined, 'globalB should be registered');
    assert.notStrictEqual(
      globalAIndex,
      globalBIndex,
      'Globals should have different indices',
    );

    // Verify the globals have correct values
    assert.strictEqual((exports.globalA as WebAssembly.Global).value, 42);
    assert.strictEqual((exports.globalB as WebAssembly.Global).value, 100);
  });
});
