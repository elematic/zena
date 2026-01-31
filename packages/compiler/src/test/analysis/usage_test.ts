import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {analyzeUsage} from '../../lib/analysis/usage.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {
  NodeType,
  type Program,
  type VariableDeclaration,
  type ClassDeclaration,
} from '../../lib/ast.js';

suite('Usage Analysis', () => {
  /**
   * Parse and type-check a single module, returning a minimal program.
   */
  const createProgram = (source: string, entryPoint = 'main.zena'): Program => {
    const parser = new Parser(source, {path: entryPoint, isStdlib: false});
    const module = parser.parse();

    // Type check for inferredType population
    const checker = TypeChecker.forModule(module);
    checker.check();

    return {
      modules: new Map([[entryPoint, module]]),
      entryPoint,
      preludeModules: [],
    };
  };

  test('marks exported functions as used', () => {
    const program = createProgram(`
      export let main = () => 42;
    `);

    const result = analyzeUsage(program);

    const module = program.modules.get('main.zena')!;
    const mainDecl = module.body[0] as VariableDeclaration;

    assert.ok(
      result.isUsed(mainDecl),
      'Exported function should be marked as used',
    );
    assert.ok(result.usedDeclarations.has(mainDecl));
  });

  test('marks unexported functions as unused', () => {
    const program = createProgram(`
      let unused = () => 1;
      export let main = () => 42;
    `);

    const result = analyzeUsage(program);

    const module = program.modules.get('main.zena')!;
    const unusedDecl = module.body[0] as VariableDeclaration;
    const mainDecl = module.body[1] as VariableDeclaration;

    assert.ok(
      !result.getUsage(unusedDecl)?.isUsed,
      'Unexported function should not be marked as used',
    );
    assert.ok(
      result.isUsed(mainDecl),
      'Exported function should be marked as used',
    );
  });

  test('marks transitively used functions as used', () => {
    const program = createProgram(`
      let helper = () => 1;
      let used = () => helper();
      export let main = () => used();
    `);

    const result = analyzeUsage(program, {includeReasons: true});

    const module = program.modules.get('main.zena')!;
    const helperDecl = module.body[0] as VariableDeclaration;
    const usedDecl = module.body[1] as VariableDeclaration;
    const mainDecl = module.body[2] as VariableDeclaration;

    assert.ok(result.isUsed(mainDecl), 'main should be used (exported)');
    assert.ok(result.isUsed(usedDecl), 'used should be used (called by main)');
    assert.ok(
      result.isUsed(helperDecl),
      'helper should be used (called by used)',
    );
  });

  test('marks classes used via new expression as used', () => {
    const program = createProgram(`
      class Point {
        x: i32;
        #new() { this.x = 0; }
      }
      export let main = () => new Point();
    `);

    const result = analyzeUsage(program);

    const module = program.modules.get('main.zena')!;
    const pointDecl = module.body[0] as ClassDeclaration;

    assert.ok(
      result.isUsed(pointDecl),
      'Class instantiated with new should be used',
    );
  });

  test('marks unused classes as unused', () => {
    const program = createProgram(`
      class Unused {
        x: i32;
        #new() { this.x = 0; }
      }
      export let main = () => 42;
    `);

    const result = analyzeUsage(program);

    const module = program.modules.get('main.zena')!;
    const unusedDecl = module.body[0] as ClassDeclaration;

    assert.ok(
      !result.getUsage(unusedDecl)?.isUsed,
      'Unused class should not be marked as used',
    );
  });

  test('marks superclass as used when subclass is used', () => {
    const program = createProgram(`
      class Base {
        x: i32;
        #new() { this.x = 0; }
      }
      class Derived extends Base {
        #new() { super(); }
      }
      export let main = () => new Derived();
    `);

    const result = analyzeUsage(program);

    const module = program.modules.get('main.zena')!;
    const baseDecl = module.body[0] as ClassDeclaration;
    const derivedDecl = module.body[1] as ClassDeclaration;

    assert.ok(result.isUsed(derivedDecl), 'Derived class should be used');
    assert.ok(
      result.isUsed(baseDecl),
      'Base class should be used (extended by used class)',
    );
  });

  test('detects module is used when it has used declarations', () => {
    const program = createProgram(`
      export let main = () => 42;
    `);

    const result = analyzeUsage(program);

    const module = program.modules.get('main.zena')!;
    assert.ok(
      result.isModuleUsed(module),
      'Module with exports should be used',
    );
  });

  test('handles multiple declarations with same name', () => {
    // This can happen with function overloads or in different modules
    const program = createProgram(`
      let helper = () => 1;
      export let main = () => helper();
    `);

    const result = analyzeUsage(program);

    const module = program.modules.get('main.zena')!;
    const helperDecl = module.body[0] as VariableDeclaration;

    assert.ok(result.isUsed(helperDecl), 'Helper should be marked as used');
  });

  test('marks type aliases as used when referenced', () => {
    const program = createProgram(`
      type ID = i32;
      export let getID = (): ID => 42;
    `);

    const result = analyzeUsage(program);

    const module = program.modules.get('main.zena')!;
    // Type alias should be marked as used
    const typeAlias = module.body.find(
      (s) => s.type === NodeType.TypeAliasDeclaration,
    );
    assert.ok(
      typeAlias && result.isUsed(typeAlias as any),
      'Type alias should be used',
    );
  });

  test('marks interfaces as used when implemented', () => {
    const program = createProgram(`
      interface Drawable {
        draw(): void;
      }
      class Circle implements Drawable {
        draw(): void { }
        #new() { }
      }
      export let main = () => new Circle();
    `);

    const result = analyzeUsage(program);

    const module = program.modules.get('main.zena')!;
    const drawableDecl = module.body[0];
    const circleDecl = module.body[1] as ClassDeclaration;

    assert.ok(result.isUsed(circleDecl), 'Circle should be used');
    assert.ok(
      result.isUsed(drawableDecl as any),
      'Drawable interface should be used',
    );
  });

  test('getUsage returns undefined for unknown declarations', () => {
    const program = createProgram('export let main = () => 42;');
    const result = analyzeUsage(program);

    // Create a fake declaration not in the program
    const fakeDecl = {
      type: NodeType.Identifier,
      name: 'fake',
    } as any;

    assert.strictEqual(result.getUsage(fakeDecl), undefined);
  });

  test('isUsed returns true for unknown declarations (conservative)', () => {
    const program = createProgram('export let main = () => 42;');
    const result = analyzeUsage(program);

    // Create a fake declaration not in the program
    const fakeDecl = {
      type: NodeType.Identifier,
      name: 'fake',
    } as any;

    // Conservative: assume unknown is used
    assert.ok(
      result.isUsed(fakeDecl),
      'Unknown declaration should be assumed used',
    );
  });

  test('includes reasons when option is enabled', () => {
    const program = createProgram(`
      let helper = () => 1;
      export let main = () => helper();
    `);

    const result = analyzeUsage(program, {includeReasons: true});

    const module = program.modules.get('main.zena')!;
    const mainDecl = module.body[1] as VariableDeclaration;

    const usage = result.getUsage(mainDecl);
    assert.ok(usage?.reason, 'Should include reason when enabled');
    assert.ok(
      usage?.reason?.includes('export'),
      'Reason should mention export',
    );
  });
});
