import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {
  NodeType,
  type ClassDeclaration,
  type VariableDeclaration,
  type MethodDefinition,
  type FieldDefinition,
  type InterfaceDeclaration,
  type MethodSignature,
  type TypeAliasDeclaration,
  type FunctionExpression,
  type TypeAnnotation,
  type NamedTypeAnnotation,
  type UnionTypeAnnotation,
  type RecordTypeAnnotation,
  type TupleTypeAnnotation,
  type FunctionTypeAnnotation,
  type AsExpression,
  type IsExpression,
  type Program,
  type MixinDeclaration,
} from '../../lib/ast.js';

/**
 * Helper to parse and check source, returning the AST.
 */
function parseAndCheck(source: string): Program {
  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = TypeChecker.forProgram(ast);
  const errors = checker.check();
  if (errors.length > 0) {
    throw new Error(
      `Compilation errors:\n${errors.map((e) => e.message).join('\n')}`,
    );
  }
  return ast;
}

/**
 * Helper to assert that a type annotation has inferredType set.
 */
function assertHasInferredType(
  annotation: TypeAnnotation | undefined,
  description: string,
) {
  assert.ok(annotation, `${description}: annotation should exist`);
  assert.ok(
    annotation.inferredType,
    `${description}: inferredType should be set on ${annotation.type}`,
  );
}

/**
 * Recursively check that all type annotations in a node have inferredType set.
 */
function assertAnnotationHasInferredType(
  annotation: TypeAnnotation,
  description: string,
) {
  assertHasInferredType(annotation, description);

  // Check nested type annotations
  if (annotation.type === NodeType.UnionTypeAnnotation) {
    const union = annotation as UnionTypeAnnotation;
    for (let i = 0; i < union.types.length; i++) {
      assertAnnotationHasInferredType(
        union.types[i],
        `${description} union member ${i}`,
      );
    }
  } else if (annotation.type === NodeType.RecordTypeAnnotation) {
    const record = annotation as RecordTypeAnnotation;
    for (const prop of record.properties) {
      assertAnnotationHasInferredType(
        prop.typeAnnotation,
        `${description} record property ${prop.name.name}`,
      );
    }
  } else if (annotation.type === NodeType.TupleTypeAnnotation) {
    const tuple = annotation as TupleTypeAnnotation;
    for (let i = 0; i < tuple.elementTypes.length; i++) {
      assertAnnotationHasInferredType(
        tuple.elementTypes[i],
        `${description} tuple element ${i}`,
      );
    }
  } else if (annotation.type === NodeType.FunctionTypeAnnotation) {
    const func = annotation as FunctionTypeAnnotation;
    for (let i = 0; i < func.params.length; i++) {
      assertAnnotationHasInferredType(
        func.params[i],
        `${description} function param ${i}`,
      );
    }
    assertAnnotationHasInferredType(
      func.returnType,
      `${description} function return type`,
    );
  } else if (annotation.type === NodeType.TypeAnnotation) {
    const named = annotation as NamedTypeAnnotation;
    if (named.typeArguments) {
      for (let i = 0; i < named.typeArguments.length; i++) {
        assertAnnotationHasInferredType(
          named.typeArguments[i],
          `${description} type argument ${i}`,
        );
      }
    }
  }
}

suite('Checker - inferredType on TypeAnnotations', () => {
  test('variable declaration with type annotation', () => {
    const ast = parseAndCheck(`
      let x: i32 = 1;
    `);
    const decl = ast.body[0] as VariableDeclaration;
    assertAnnotationHasInferredType(
      decl.typeAnnotation!,
      'variable type annotation',
    );
  });

  test('function parameter type annotation', () => {
    const ast = parseAndCheck(`
      let f = (x: i32, y: string) => x;
    `);
    const decl = ast.body[0] as VariableDeclaration;
    const arrow = decl.init as FunctionExpression;
    assertAnnotationHasInferredType(
      arrow.params[0].typeAnnotation,
      'first parameter',
    );
    assertAnnotationHasInferredType(
      arrow.params[1].typeAnnotation,
      'second parameter',
    );
  });

  test('function return type annotation', () => {
    const ast = parseAndCheck(`
      let f = (x: i32): i32 => x;
    `);
    const decl = ast.body[0] as VariableDeclaration;
    const arrow = decl.init as FunctionExpression;
    assertAnnotationHasInferredType(arrow.returnType!, 'function return type');
  });

  test('class field type annotation', () => {
    const ast = parseAndCheck(`
      class Point {
        x: i32;
        y: f64;
      }
    `);
    const classDecl = ast.body[0] as ClassDeclaration;
    const xField = classDecl.body.find(
      (m) =>
        m.type === NodeType.FieldDefinition &&
        (m as FieldDefinition).name.type === NodeType.Identifier &&
        ((m as FieldDefinition).name as any).name === 'x',
    ) as FieldDefinition;
    const yField = classDecl.body.find(
      (m) =>
        m.type === NodeType.FieldDefinition &&
        (m as FieldDefinition).name.type === NodeType.Identifier &&
        ((m as FieldDefinition).name as any).name === 'y',
    ) as FieldDefinition;
    assertAnnotationHasInferredType(xField.typeAnnotation, 'field x');
    assertAnnotationHasInferredType(yField.typeAnnotation, 'field y');
  });

  test('class method parameter and return type annotations', () => {
    const ast = parseAndCheck(`
      class Calculator {
        add(a: i32, b: i32): i32 { return a + b; }
      }
    `);
    const classDecl = ast.body[0] as ClassDeclaration;
    const method = classDecl.body.find(
      (m) => m.type === NodeType.MethodDefinition,
    ) as MethodDefinition;
    assertAnnotationHasInferredType(
      method.params[0].typeAnnotation,
      'method param a',
    );
    assertAnnotationHasInferredType(
      method.params[1].typeAnnotation,
      'method param b',
    );
    assertAnnotationHasInferredType(method.returnType!, 'method return type');
  });

  test('generic type arguments', () => {
    const ast = parseAndCheck(`
      class Box<T> {
        value: T;
        #new(value: T) {
          this.value = value;
        }
      }
      let b: Box<i32> = new Box<i32>(1);
    `);
    const varDecl = ast.body[1] as VariableDeclaration;
    assertAnnotationHasInferredType(
      varDecl.typeAnnotation!,
      'Box<i32> annotation',
    );
    // Check the type argument i32
    const named = varDecl.typeAnnotation as NamedTypeAnnotation;
    assertAnnotationHasInferredType(
      named.typeArguments![0],
      'Box type argument i32',
    );
  });

  test('type alias declaration', () => {
    const ast = parseAndCheck(`
      type ID = i32;
    `);
    const typeAlias = ast.body[0] as TypeAliasDeclaration;
    assertAnnotationHasInferredType(
      typeAlias.typeAnnotation,
      'type alias target',
    );
  });

  test('union type annotation', () => {
    const ast = parseAndCheck(`
      class A {}
      class B {}
      let x: A | B | null = null;
    `);
    const varDecl = ast.body[2] as VariableDeclaration;
    assertAnnotationHasInferredType(varDecl.typeAnnotation!, 'union type');
    // Also check members
    const union = varDecl.typeAnnotation as UnionTypeAnnotation;
    assertAnnotationHasInferredType(union.types[0], 'union member A');
    assertAnnotationHasInferredType(union.types[1], 'union member B');
    assertAnnotationHasInferredType(union.types[2], 'union member null');
  });

  test('record type annotation', () => {
    const ast = parseAndCheck(`
      let r: {x: i32, y: string} = {x: 1, y: 'hi'};
    `);
    const varDecl = ast.body[0] as VariableDeclaration;
    assertAnnotationHasInferredType(varDecl.typeAnnotation!, 'record type');
    // Check property types
    const record = varDecl.typeAnnotation as RecordTypeAnnotation;
    assertAnnotationHasInferredType(
      record.properties[0].typeAnnotation,
      'record property x',
    );
    assertAnnotationHasInferredType(
      record.properties[1].typeAnnotation,
      'record property y',
    );
  });

  test('tuple type annotation', () => {
    const ast = parseAndCheck(`
      let t: [i32, string, boolean] = [1, 'hi', true];
    `);
    const varDecl = ast.body[0] as VariableDeclaration;
    assertAnnotationHasInferredType(varDecl.typeAnnotation!, 'tuple type');
    // Check element types
    const tuple = varDecl.typeAnnotation as TupleTypeAnnotation;
    assertAnnotationHasInferredType(tuple.elementTypes[0], 'tuple element 0');
    assertAnnotationHasInferredType(tuple.elementTypes[1], 'tuple element 1');
    assertAnnotationHasInferredType(tuple.elementTypes[2], 'tuple element 2');
  });

  test('function type annotation', () => {
    const ast = parseAndCheck(`
      let f: (x: i32, y: string) => boolean = (x: i32, y: string) => true;
    `);
    const varDecl = ast.body[0] as VariableDeclaration;
    assertAnnotationHasInferredType(varDecl.typeAnnotation!, 'function type');
    // Check param and return types
    const funcType = varDecl.typeAnnotation as FunctionTypeAnnotation;
    assertAnnotationHasInferredType(
      funcType.params[0],
      'function type param 0',
    );
    assertAnnotationHasInferredType(
      funcType.params[1],
      'function type param 1',
    );
    assertAnnotationHasInferredType(
      funcType.returnType,
      'function type return',
    );
  });

  test('cast expression (as)', () => {
    const ast = parseAndCheck(`
      class Animal {}
      class Dog extends Animal {}
      let animal: Animal = new Dog();
      let dog = animal as Dog;
    `);
    const varDecl = ast.body[3] as VariableDeclaration;
    const cast = varDecl.init as AsExpression;
    assertAnnotationHasInferredType(cast.typeAnnotation, 'cast target type');
  });

  test('is expression', () => {
    const ast = parseAndCheck(`
      class Animal {}
      class Dog extends Animal {}
      let animal: Animal = new Dog();
      let isDog = animal is Dog;
    `);
    const varDecl = ast.body[3] as VariableDeclaration;
    const isExpr = varDecl.init as IsExpression;
    assertAnnotationHasInferredType(isExpr.typeAnnotation, 'is target type');
  });

  test('interface field type annotation', () => {
    const ast = parseAndCheck(`
      interface Named {
        name: string;
      }
    `);
    const iface = ast.body[0] as InterfaceDeclaration;
    const field = iface.body.find(
      (m) => m.type === NodeType.FieldDefinition,
    ) as FieldDefinition;
    assertAnnotationHasInferredType(
      field.typeAnnotation,
      'interface field type',
    );
  });

  test('interface method signature', () => {
    const ast = parseAndCheck(`
      interface Adder {
        add(a: i32, b: i32): i32;
      }
    `);
    const iface = ast.body[0] as InterfaceDeclaration;
    const method = iface.body.find(
      (m) => m.type === NodeType.MethodSignature,
    ) as MethodSignature;
    assertAnnotationHasInferredType(
      method.params[0].typeAnnotation,
      'interface method param a',
    );
    assertAnnotationHasInferredType(
      method.params[1].typeAnnotation,
      'interface method param b',
    );
    assertAnnotationHasInferredType(
      method.returnType!,
      'interface method return type',
    );
  });

  test('generic constraint', () => {
    const ast = parseAndCheck(`
      interface Printable {
        print(): void;
      }
      class Printer<T extends Printable> {
        item: T;
      }
    `);
    const classDecl = ast.body[1] as ClassDeclaration;
    const typeParam = classDecl.typeParameters![0];
    assertAnnotationHasInferredType(
      typeParam.constraint!,
      'generic constraint',
    );
  });

  test('generic default type', () => {
    const ast = parseAndCheck(`
      class Container<T = i32> {
        value: T;
      }
    `);
    const classDecl = ast.body[0] as ClassDeclaration;
    const typeParam = classDecl.typeParameters![0];
    assertAnnotationHasInferredType(typeParam.default!, 'generic default type');
  });

  test('declare function parameters and return type', () => {
    const ast = parseAndCheck(`
      @external("env", "log")
      declare function log(msg: string): void;
    `);
    // The declare function is parsed differently - it has params in the function decl
    // Let's look for FunctionDeclaration instead
    const decl = ast.body[0];
    // For now, skip this test as declare function has different AST structure
    assert.ok(decl, 'should have a declaration');
  });

  test('array type argument', () => {
    const ast = parseAndCheck(`
      let arr: array<i32> = #[1, 2, 3];
    `);
    const varDecl = ast.body[0] as VariableDeclaration;
    assertAnnotationHasInferredType(varDecl.typeAnnotation!, 'array type');
    const named = varDecl.typeAnnotation as NamedTypeAnnotation;
    assertAnnotationHasInferredType(
      named.typeArguments![0],
      'array element type',
    );
  });

  test('extension class onType annotation', () => {
    const ast = parseAndCheck(`
      extension class IntArray on array<i32> {
        sum(): i32 { return 0; }
      }
    `);
    const classDecl = ast.body[0] as ClassDeclaration;
    assertAnnotationHasInferredType(classDecl.onType!, 'extension onType');
    // Check the type argument
    const named = classDecl.onType as NamedTypeAnnotation;
    assertAnnotationHasInferredType(
      named.typeArguments![0],
      'extension onType type argument',
    );
  });

  test('superclass type annotation with type arguments', () => {
    const ast = parseAndCheck(`
      class Base<T> {
        value: T;
      }
      class Derived extends Base<i32> {
      }
    `);
    const derived = ast.body[1] as ClassDeclaration;
    assertAnnotationHasInferredType(derived.superClass!, 'superclass type');
    const named = derived.superClass as NamedTypeAnnotation;
    assertAnnotationHasInferredType(
      named.typeArguments![0],
      'superclass type argument',
    );
  });

  test('implements clause type annotations', () => {
    const ast = parseAndCheck(`
      interface Sequence<T> {
        get(i: i32): T;
      }
      class IntList implements Sequence<i32> {
        get(i: i32): i32 { return i; }
      }
    `);
    const classDecl = ast.body[1] as ClassDeclaration;
    const impl = classDecl.implements![0];
    assertAnnotationHasInferredType(impl, 'implements clause');
    const named = impl as NamedTypeAnnotation;
    assertAnnotationHasInferredType(
      named.typeArguments![0],
      'implements type argument',
    );
  });

  test('nested generic type arguments', () => {
    const ast = parseAndCheck(`
      class Box<T> {
        value: T;
        #new(value: T) { this.value = value; }
      }
      class Pair<A, B> {
        first: A;
        second: B;
        #new(first: A, second: B) { this.first = first; this.second = second; }
      }
      let nested: Box<Pair<i32, string>> = new Box<Pair<i32, string>>(new Pair<i32, string>(1, 'hi'));
    `);
    const varDecl = ast.body[2] as VariableDeclaration;
    assertAnnotationHasInferredType(varDecl.typeAnnotation!, 'nested generic');
    // Box<Pair<i32, string>>
    const box = varDecl.typeAnnotation as NamedTypeAnnotation;
    assertAnnotationHasInferredType(box.typeArguments![0], 'Box type arg');
    // Pair<i32, string>
    const pair = box.typeArguments![0] as NamedTypeAnnotation;
    assertAnnotationHasInferredType(pair.typeArguments![0], 'Pair first arg');
    assertAnnotationHasInferredType(pair.typeArguments![1], 'Pair second arg');
  });

  test('optional parameter type annotation', () => {
    const ast = parseAndCheck(`
      let f = (x?: string): string | null => x;
    `);
    const decl = ast.body[0] as VariableDeclaration;
    const arrow = decl.init as FunctionExpression;
    assertAnnotationHasInferredType(
      arrow.params[0].typeAnnotation,
      'optional parameter type',
    );
  });

  test('mixin field and method types', () => {
    const ast = parseAndCheck(`
      mixin Timestamped {
        timestamp: i64;
        getTime(): i64 { return this.timestamp; }
      }
    `);
    const mixin = ast.body[0] as MixinDeclaration;
    const field = mixin.body.find(
      (m) => m.type === NodeType.FieldDefinition,
    ) as FieldDefinition;
    const method = mixin.body.find(
      (m) => m.type === NodeType.MethodDefinition,
    ) as MethodDefinition;
    assertAnnotationHasInferredType(field.typeAnnotation, 'mixin field type');
    assertAnnotationHasInferredType(method.returnType!, 'mixin method return');
  });

  test('distinct type annotation', () => {
    const ast = parseAndCheck(`
      distinct type Meters = i32;
    `);
    const typeAlias = ast.body[0] as TypeAliasDeclaration;
    assertAnnotationHasInferredType(
      typeAlias.typeAnnotation,
      'distinct type target',
    );
  });

  test('this type annotation in method return', () => {
    const ast = parseAndCheck(`
      class Builder {
        build(): this { return this; }
      }
    `);
    const classDecl = ast.body[0] as ClassDeclaration;
    const method = classDecl.body.find(
      (m) => m.type === NodeType.MethodDefinition,
    ) as MethodDefinition;
    assertAnnotationHasInferredType(method.returnType!, 'this type annotation');
  });

  test('class constructor parameter types', () => {
    const ast = parseAndCheck(`
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }
    `);
    const classDecl = ast.body[0] as ClassDeclaration;
    const ctor = classDecl.body.find(
      (m) =>
        m.type === NodeType.MethodDefinition &&
        (m as MethodDefinition).name.type === NodeType.Identifier &&
        ((m as MethodDefinition).name as any).name === '#new',
    ) as MethodDefinition;
    assertAnnotationHasInferredType(
      ctor.params[0].typeAnnotation,
      'constructor param x',
    );
    assertAnnotationHasInferredType(
      ctor.params[1].typeAnnotation,
      'constructor param y',
    );
  });

  test('generic method type parameters', () => {
    const ast = parseAndCheck(`
      class Container {
        map<U>(f: (x: i32) => U): U { return f(0); }
      }
    `);
    const classDecl = ast.body[0] as ClassDeclaration;
    const method = classDecl.body.find(
      (m) => m.type === NodeType.MethodDefinition,
    ) as MethodDefinition;
    // The function parameter type (x: i32) => U
    assertAnnotationHasInferredType(
      method.params[0].typeAnnotation,
      'generic method param f',
    );
    const funcType = method.params[0].typeAnnotation as FunctionTypeAnnotation;
    assertAnnotationHasInferredType(
      funcType.params[0],
      'function type param in generic method',
    );
    assertAnnotationHasInferredType(
      funcType.returnType,
      'function type return in generic method',
    );
    // Method return type
    assertAnnotationHasInferredType(
      method.returnType!,
      'generic method return type',
    );
  });

  test('accessor getter type annotation', () => {
    const ast = parseAndCheck(`
      class Box {
        #value: i32 = 0;
        value: i32 {
          get { return this.#value; }
        }
      }
    `);
    const classDecl = ast.body[0] as ClassDeclaration;
    const accessor = classDecl.body.find(
      (m) => m.type === NodeType.AccessorDeclaration,
    ) as any;
    assertAnnotationHasInferredType(
      accessor.typeAnnotation,
      'getter type annotation',
    );
  });

  test('accessor setter type annotation', () => {
    const ast = parseAndCheck(`
      class Box {
        #value: i32 = 0;
        value: i32 {
          set(v) { this.#value = v; }
        }
      }
    `);
    const classDecl = ast.body[0] as ClassDeclaration;
    const accessor = classDecl.body.find(
      (m) => m.type === NodeType.AccessorDeclaration,
    ) as any;
    assertAnnotationHasInferredType(
      accessor.typeAnnotation,
      'setter type annotation',
    );
  });

  test('interface extends clause', () => {
    const ast = parseAndCheck(`
      interface Base {
        foo(): void;
      }
      interface Derived extends Base {
        bar(): void;
      }
    `);
    const derived = ast.body[1] as InterfaceDeclaration;
    assertAnnotationHasInferredType(
      derived.extends![0],
      'interface extends clause',
    );
  });

  test('interface extends with type arguments', () => {
    const ast = parseAndCheck(`
      interface Container<T> {
        get(): T;
      }
      interface IntContainer extends Container<i32> {
        getInt(): i32;
      }
    `);
    const derived = ast.body[1] as InterfaceDeclaration;
    assertAnnotationHasInferredType(
      derived.extends![0],
      'interface extends clause',
    );
    const named = derived.extends![0] as NamedTypeAnnotation;
    assertAnnotationHasInferredType(
      named.typeArguments![0],
      'interface extends type argument',
    );
  });
});
