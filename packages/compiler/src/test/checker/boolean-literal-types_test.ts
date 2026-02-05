import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {NodeType, type VariableDeclaration} from '../../lib/ast.js';
import {TypeKind, type LiteralType} from '../../lib/types.js';

const parseAndCheck = (source: string) => {
  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = TypeChecker.forModule(ast);
  const errors = checker.check();
  return {ast, errors};
};

suite('boolean literal types', () => {
  test('parses true as type annotation', () => {
    const parser = new Parser('let x: true = true;');
    const ast = parser.parse();
    const decl = ast.body[0] as VariableDeclaration;
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    const typeAnnotation = decl.typeAnnotation;
    assert.ok(typeAnnotation);
    assert.strictEqual(typeAnnotation.type, NodeType.LiteralTypeAnnotation);
    if (typeAnnotation.type === NodeType.LiteralTypeAnnotation) {
      assert.strictEqual(typeAnnotation.value, true);
    }
  });

  test('parses false as type annotation', () => {
    const parser = new Parser('let x: false = false;');
    const ast = parser.parse();
    const decl = ast.body[0] as VariableDeclaration;
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    const typeAnnotation = decl.typeAnnotation;
    assert.ok(typeAnnotation);
    assert.strictEqual(typeAnnotation.type, NodeType.LiteralTypeAnnotation);
    if (typeAnnotation.type === NodeType.LiteralTypeAnnotation) {
      assert.strictEqual(typeAnnotation.value, false);
    }
  });

  test('true literal is assignable to true type', () => {
    const {errors} = parseAndCheck('let x: true = true;');
    assert.strictEqual(errors.length, 0);
  });

  test('false literal is assignable to false type', () => {
    const {errors} = parseAndCheck('let x: false = false;');
    assert.strictEqual(errors.length, 0);
  });

  test('true literal type is assignable to boolean', () => {
    const {errors} = parseAndCheck('let x: boolean = true;');
    assert.strictEqual(errors.length, 0);
  });

  test('false literal type is assignable to boolean', () => {
    const {errors} = parseAndCheck('let x: boolean = false;');
    assert.strictEqual(errors.length, 0);
  });

  test('true literal is NOT assignable to false type', () => {
    const {errors} = parseAndCheck('let x: false = true;');
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('Type mismatch'));
  });

  test('false literal is NOT assignable to true type', () => {
    const {errors} = parseAndCheck('let x: true = false;');
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('Type mismatch'));
  });

  test('union of true and false is assignable to boolean', () => {
    const {errors} = parseAndCheck(`
      let t: true = true;
      let f: false = false;
      let b1: boolean = t;
      let b2: boolean = f;
    `);
    assert.strictEqual(errors.length, 0);
  });

  test('boolean is NOT assignable to true type', () => {
    const {errors} = parseAndCheck(`
      let b: boolean = true;
      let t: true = b;
    `);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('Type mismatch'));
  });

  test('boolean is NOT assignable to false type', () => {
    const {errors} = parseAndCheck(`
      let b: boolean = false;
      let f: false = b;
    `);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('Type mismatch'));
  });

  test('true | false union type', () => {
    // Same base type (boolean), so this is allowed
    const {errors} = parseAndCheck(`
      let x: true | false = true;
      let y: true | false = false;
    `);
    assert.strictEqual(errors.length, 0);
  });

  test('function returning true literal type', () => {
    const {errors} = parseAndCheck(`
      let isTrue = (): true => true;
      let result: true = isTrue();
    `);
    assert.strictEqual(errors.length, 0);
  });

  test('function returning false literal type', () => {
    const {errors} = parseAndCheck(`
      let isFalse = (): false => false;
      let result: false = isFalse();
    `);
    assert.strictEqual(errors.length, 0);
  });

  test('resolves true type annotation to LiteralType', () => {
    const {ast} = parseAndCheck('let x: true = true;');
    const decl = ast.body[0] as VariableDeclaration;
    const typeAnnotation = decl.typeAnnotation;
    assert.ok(typeAnnotation);
    assert.ok(typeAnnotation.inferredType);
    assert.strictEqual(typeAnnotation.inferredType.kind, TypeKind.Literal);
    const lit = typeAnnotation.inferredType as LiteralType;
    assert.strictEqual(lit.value, true);
  });

  // Note: Unions of primitives (including boolean literals) with reference types
  // or null are NOT supported because WASM has no storage type that can hold
  // both a value type (i32) and a reference type.
  // Valid patterns: reference | null, or use Box<boolean> for nullable booleans.

  test('true | null union is rejected (primitive in union)', () => {
    const {errors} = parseAndCheck(`
      let x: true | null = true;
    `);
    assert.strictEqual(errors.length, 1);
    assert.ok(
      errors[0].message.includes(
        'cannot mix primitive types with reference types',
      ),
    );
  });

  test('false | null union is rejected (primitive in union)', () => {
    const {errors} = parseAndCheck(`
      let x: false | null = false;
    `);
    assert.strictEqual(errors.length, 1);
    assert.ok(
      errors[0].message.includes(
        'cannot mix primitive types with reference types',
      ),
    );
  });

  test('boolean literals can union with same base type', () => {
    // Same base type (boolean), so this is allowed
    const {errors} = parseAndCheck(`
      let x: true | false = true;
      let y: true | false = false;
    `);
    assert.strictEqual(errors.length, 0);
  });

  test('var binding widens boolean literal to boolean', () => {
    const {errors, ast} = parseAndCheck(`
      var x = true;
      x = false;
    `);
    assert.strictEqual(errors.length, 0);
    // Verify the type was widened
    const decl = ast.body[0] as VariableDeclaration;
    assert.ok(decl.inferredType);
    assert.strictEqual(decl.inferredType.kind, TypeKind.Boolean);
  });

  test('let binding preserves boolean literal type', () => {
    const {ast} = parseAndCheck('let x = true;');
    const decl = ast.body[0] as VariableDeclaration;
    assert.ok(decl.inferredType);
    assert.strictEqual(decl.inferredType.kind, TypeKind.Literal);
    const lit = decl.inferredType as LiteralType;
    assert.strictEqual(lit.value, true);
  });

  test('boolean literal types work in function parameters', () => {
    const {errors} = parseAndCheck(`
      let check = (flag: true | false) => flag;
      let result = check(true);
      let result2 = check(false);
    `);
    assert.strictEqual(errors.length, 0);
  });

  test('boolean literal type not assignable to wrong literal union', () => {
    const {errors} = parseAndCheck(`
      let x: true | false = 5;
    `);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('Type mismatch'));
  });

  test('boolean not assignable to boolean literal union', () => {
    const {errors} = parseAndCheck(`
      let b: boolean = true;
      let x: true | false = b;
    `);
    // boolean is not assignable to true | false (would need narrowing)
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('Type mismatch'));
  });
});
