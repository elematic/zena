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
import {type ClassType, TypeKind} from '../../lib/types.js';

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

  /**
   * Parse and type-check, returning program and checker context for method usage tests.
   */
  const createProgramWithContext = (
    source: string,
    entryPoint = 'main.zena',
  ) => {
    const parser = new Parser(source, {path: entryPoint, isStdlib: false});
    const module = parser.parse();

    const checker = TypeChecker.forModule(module);
    checker.check();

    const program: Program = {
      modules: new Map([[entryPoint, module]]),
      entryPoint,
      preludeModules: [],
    };

    return {program, checker, module};
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

  test.skip('marks operator + method as used when called via + operator', () => {
    const {program, checker, module} = createProgramWithContext(`
      class Vector {
        x: i32;
        #new(x: i32) { this.x = x; }
        operator +(other: Vector): Vector {
          return new Vector(this.x + other.x);
        }
      }
      export let main = (): i32 => {
        let v1 = new Vector(1);
        let v2 = new Vector(2);
        let v3 = v1 + v2;
        return v3.x;
      };
    `);

    const result = analyzeUsage(program, {
      semanticContext: checker.semanticContext,
    });

    const vectorDecl = module.body[0] as ClassDeclaration;
    assert.ok(result.isUsed(vectorDecl), 'Vector class should be used');

    // Get the ClassType for Vector
    const vectorType = vectorDecl.inferredType;
    assert.ok(vectorType, 'Vector should have inferredType');
    assert.strictEqual(vectorType.kind, TypeKind.Class);

    // The operator + method should be marked as used
    assert.ok(
      result.isMethodUsed(vectorType as ClassType, '+'),
      'operator + method should be marked as used when called via + operator',
    );
  });

  test.skip('marks operator [] method as used when called via index expression', () => {
    const {program, checker, module} = createProgramWithContext(`
      class Box {
        value: i32;
        #new(value: i32) { this.value = value; }
        operator [](index: i32): i32 {
          return this.value + index;
        }
      }
      export let main = (): i32 => {
        let b = new Box(10);
        return b[5];
      };
    `);

    const result = analyzeUsage(program, {
      semanticContext: checker.semanticContext,
    });

    const boxDecl = module.body[0] as ClassDeclaration;
    assert.ok(result.isUsed(boxDecl), 'Box class should be used');

    const boxType = boxDecl.inferredType;
    assert.ok(boxType, 'Box should have inferredType');
    assert.strictEqual(boxType.kind, TypeKind.Class);

    // The operator [] method should be marked as used
    assert.ok(
      result.isMethodUsed(boxType as ClassType, '[]'),
      'operator [] method should be marked as used when called via index expression',
    );
  });

  test.skip('marks operator []= method as used when called via index assignment', () => {
    const {program, checker, module} = createProgramWithContext(`
      class Box {
        value: i32;
        #new() { this.value = 0; }
        operator []=(index: i32, val: i32): void {
          this.value = index + val;
        }
      }
      export let main = (): i32 => {
        let b = new Box();
        b[10] = 20;
        return 0;
      };
    `);

    const result = analyzeUsage(program, {
      semanticContext: checker.semanticContext,
    });

    const boxDecl = module.body[0] as ClassDeclaration;
    assert.ok(result.isUsed(boxDecl), 'Box class should be used');

    const boxType = boxDecl.inferredType;
    assert.ok(boxType, 'Box should have inferredType');
    assert.strictEqual(boxType.kind, TypeKind.Class);

    // The operator []= method should be marked as used
    assert.ok(
      result.isMethodUsed(boxType as ClassType, '[]='),
      'operator []= method should be marked as used when called via index assignment',
    );
  });

  test.skip('marks operator == method as used when called via equality syntax', () => {
    const {program, checker, module} = createProgramWithContext(`
      class Point {
        x: i32;
        #new(x: i32) { this.x = x; }
        operator ==(other: Point): boolean {
          return this.x == other.x;
        }
      }
      export let main = (): boolean => {
        return new Point(1) == new Point(1);
      };
    `);

    const result = analyzeUsage(program, {
      semanticContext: checker.semanticContext,
    });

    const pointDecl = module.body[0] as ClassDeclaration;
    assert.ok(result.isUsed(pointDecl), 'Point class should be used');

    const pointType = pointDecl.inferredType;
    assert.ok(pointType, 'Point should have inferredType');
    assert.strictEqual(pointType.kind, TypeKind.Class);

    // The operator == method should be marked as used
    assert.ok(
      result.isMethodUsed(pointType as ClassType, '=='),
      'operator == method should be marked as used when called via equality syntax',
    );
  });

  test('tracks field reads via member expression', () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }
      export let main = () => {
        let p = new Point(1, 2);
        return p.x;  // Read x, not y
      };
    `;
    const parser = new Parser(source, {path: 'main.zena', isStdlib: false});
    const module = parser.parse();

    const checker = TypeChecker.forModule(module);
    checker.check();

    const program: Program = {
      modules: new Map([['main.zena', module]]),
      entryPoint: 'main.zena',
      preludeModules: [],
    };

    const result = analyzeUsage(program, {
      semanticContext: checker.semanticContext,
    });

    const pointDecl = module.body[0] as ClassDeclaration;
    const classType = pointDecl.inferredType as ClassType;

    // Check field usage
    const xUsage = result.getFieldUsage(classType, 'x');
    const yUsage = result.getFieldUsage(classType, 'y');

    assert.ok(xUsage?.isRead, 'x should be marked as read');
    assert.ok(
      xUsage?.isWritten,
      'x should be marked as written (in constructor)',
    );
    assert.ok(!yUsage?.isRead, 'y should not be marked as read');
    assert.ok(
      yUsage?.isWritten,
      'y should be marked as written (in constructor)',
    );
  });

  test('tracks field writes via assignment expression', () => {
    const source = `
      class Counter {
        value: i32;
        #new() {
          this.value = 0;
        }
        increment(): void {
          this.value = this.value + 1;
        }
      }
      export let main = () => {
        let c = new Counter();
        c.increment();
      };
    `;
    const parser = new Parser(source, {path: 'main.zena', isStdlib: false});
    const module = parser.parse();

    const checker = TypeChecker.forModule(module);
    checker.check();

    const program: Program = {
      modules: new Map([['main.zena', module]]),
      entryPoint: 'main.zena',
      preludeModules: [],
    };

    const result = analyzeUsage(program, {
      semanticContext: checker.semanticContext,
    });

    const counterDecl = module.body[0] as ClassDeclaration;
    const classType = counterDecl.inferredType as ClassType;

    const valueUsage = result.getFieldUsage(classType, 'value');

    // value is both read and written (in increment)
    assert.ok(valueUsage?.isRead, 'value should be marked as read');
    assert.ok(valueUsage?.isWritten, 'value should be marked as written');
  });

  test('tracks write-only field', () => {
    const source = `
      class Logger {
        timestamp: i32;
        message: i32;
        #new() {
          this.timestamp = 0;
          this.message = 1;
        }
        log(): i32 {
          return this.message;
        }
      }
      export let main = () => {
        let l = new Logger();
        return l.log();
      };
    `;
    const parser = new Parser(source, {path: 'main.zena', isStdlib: false});
    const module = parser.parse();

    const checker = TypeChecker.forModule(module);
    checker.check();

    const program: Program = {
      modules: new Map([['main.zena', module]]),
      entryPoint: 'main.zena',
      preludeModules: [],
    };

    const result = analyzeUsage(program, {
      semanticContext: checker.semanticContext,
    });

    const loggerDecl = module.body[0] as ClassDeclaration;
    const classType = loggerDecl.inferredType as ClassType;

    const timestampUsage = result.getFieldUsage(classType, 'timestamp');
    const messageUsage = result.getFieldUsage(classType, 'message');

    // timestamp is write-only
    assert.ok(
      !timestampUsage?.isRead,
      'timestamp should not be marked as read',
    );
    assert.ok(
      timestampUsage?.isWritten,
      'timestamp should be marked as written',
    );

    // message is read and written
    assert.ok(messageUsage?.isRead, 'message should be marked as read');
    assert.ok(messageUsage?.isWritten, 'message should be marked as written');
  });
});
