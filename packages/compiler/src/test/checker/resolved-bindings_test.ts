import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker, SemanticContext} from '../../lib/checker/index.js';
import {
  NodeType,
  type Identifier,
  type VariableDeclaration,
} from '../../lib/ast.js';
import {CheckerContext} from '../../lib/checker/context.js';

/**
 * Find all Identifier nodes in a VariableDeclaration's init expression.
 */
const findIdentifiersInInit = (decl: VariableDeclaration): Identifier[] => {
  const identifiers: Identifier[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === NodeType.Identifier) {
      identifiers.push(node as Identifier);
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object') {
        visit(value);
      }
    }
  };
  if (decl.init) {
    visit(decl.init);
  }
  return identifiers;
};

/**
 * Create a TypeChecker with exposed semanticContext for testing.
 */
const createCheckerWithContext = (source: string) => {
  const parser = new Parser(source);
  const ast = parser.parse();
  const semanticContext = new SemanticContext();
  const ctx = new CheckerContext(undefined, semanticContext);
  ctx.setCurrentLibrary({
    path: '<test>',
    isStdlib: false,
    source,
    ast,
    imports: new Map(),
    exports: new Map(),
    diagnostics: [],
  });
  const checker = new TypeChecker(ctx, {
    path: '<test>',
    isStdlib: false,
    source,
    ast,
    imports: new Map(),
    exports: new Map(),
    diagnostics: [],
  });
  return {checker, semanticContext, ast};
};

suite('Resolved Bindings', () => {
  test('should resolve local variable reference', () => {
    const input = `
let foo = () => {
  let x = 42;
  let y = x;
  return y;
};
`;
    const {checker, semanticContext, ast} = createCheckerWithContext(input);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0, 'Should have no errors');

    // Find the function body
    const funcDecl = ast.body[0] as VariableDeclaration;
    const funcExpr = funcDecl.init as any;
    const funcBody = funcExpr.body.body;

    // Find the `y = x` declaration
    const yDecl = funcBody[1] as VariableDeclaration;
    const xRef = findIdentifiersInInit(yDecl)[0];

    assert.ok(xRef, 'Should find x identifier');
    assert.strictEqual(xRef.name, 'x');

    // Check that the binding was stored
    const binding = semanticContext.getResolvedBinding(xRef);

    assert.ok(binding, 'Should have a resolved binding for x');
    assert.strictEqual(binding.kind, 'local', 'x should be a local binding');
  });

  test('should resolve global variable reference', () => {
    const input = `
let global = 100;
let foo = () => global;
`;
    const {checker, semanticContext, ast} = createCheckerWithContext(input);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0, 'Should have no errors');

    // Find the function
    const funcDecl = ast.body[1] as VariableDeclaration;
    const funcExpr = funcDecl.init as any;

    // The function body is just the identifier `global`
    const globalRef = funcExpr.body as Identifier;

    assert.ok(globalRef, 'Should find global identifier');
    assert.strictEqual(globalRef.name, 'global');

    const binding = semanticContext.getResolvedBinding(globalRef);

    assert.ok(binding, 'Should have a resolved binding for global');
    // In standalone mode, top-level vars may be treated as local or global
    assert.ok(
      binding.kind === 'global' || binding.kind === 'local',
      `Expected global or local binding, got ${binding.kind}`,
    );
  });

  test('should resolve function reference', () => {
    const input = `
let add = (a: i32, b: i32) => a + b;
let result = add(1, 2);
`;
    const {checker, semanticContext, ast} = createCheckerWithContext(input);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0, 'Should have no errors');

    // Find the call expression
    const resultDecl = ast.body[1] as VariableDeclaration;
    const callExpr = resultDecl.init as any;
    const addRef = callExpr.callee as Identifier;

    assert.ok(addRef, 'Should find add identifier');
    assert.strictEqual(addRef.name, 'add');

    const binding = semanticContext.getResolvedBinding(addRef);

    assert.ok(binding, 'Should have a resolved binding for add');
    // The function is stored in a variable, so it's a local/global binding
    assert.ok(
      ['local', 'global', 'function'].includes(binding.kind),
      `Expected local, global, or function binding, got ${binding.kind}`,
    );
  });

  test('semanticContext tracks binding count', () => {
    const input = `
let a = 1;
let b = a;
let c = a + b;
`;
    const {checker, semanticContext} = createCheckerWithContext(input);
    checker.check();

    const stats = semanticContext.stats;

    // We should have bindings for:
    // - 'a' in `b = a`
    // - 'a' in `c = a + b`
    // - 'b' in `c = a + b`
    assert.ok(
      stats.resolvedBindings >= 3,
      `Expected at least 3 resolved bindings, got ${stats.resolvedBindings}`,
    );
  });
});
