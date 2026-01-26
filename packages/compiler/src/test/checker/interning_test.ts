import {suite, test} from 'node:test';
import assert from 'node:assert';
import {SemanticContext} from '../../lib/checker/index.js';
import {CheckerContext} from '../../lib/checker/context.js';
import {substituteType} from '../../lib/checker/types.js';
import {
  TypeKind,
  Types,
  type ClassType,
  type TypeParameterType,
} from '../../lib/types.js';

/**
 * Tests for substituteType interning behavior.
 *
 * These tests verify that substituteType properly interns ClassTypes,
 * ensuring that identity-based lookups work in codegen even for types
 * accessed through member type resolution.
 */
suite('substituteType Interning', () => {
  test('substituteType returns interned ClassType', () => {
    // Create a simple generic type directly
    const tParam: TypeParameterType = {kind: TypeKind.TypeParameter, name: 'T'};
    const boxType: ClassType = {
      kind: TypeKind.Class,
      name: 'Box',
      typeParameters: [tParam],
      typeArguments: [tParam],
      implements: [],
      fields: new Map(),
      methods: new Map(),
      statics: new Map(),
      vtable: [],
    };

    // Create a minimal context for interning
    const ctx = new CheckerContext(undefined, new SemanticContext());

    const typeMap = new Map<string, any>();
    typeMap.set('T', Types.I32);

    // Should return the same interned instance
    const result1 = substituteType(boxType, typeMap, ctx) as ClassType;
    const result2 = substituteType(boxType, typeMap, ctx) as ClassType;

    // With interning, these should be the exact same object
    assert.strictEqual(
      result1,
      result2,
      'substituteType should return interned ClassType instances',
    );
  });

  test('nested generic types are interned through substituteType', () => {
    // Create Entry<K, V> type
    const kParam: TypeParameterType = {kind: TypeKind.TypeParameter, name: 'K'};
    const vParam: TypeParameterType = {kind: TypeKind.TypeParameter, name: 'V'};
    const entryType: ClassType = {
      kind: TypeKind.Class,
      name: 'Entry',
      typeParameters: [kParam, vParam],
      typeArguments: [Types.String, vParam], // Entry<String, V> - partially substituted
      implements: [],
      fields: new Map(),
      methods: new Map(),
      statics: new Map(),
      vtable: [],
    };

    const ctx = new CheckerContext(undefined, new SemanticContext());

    const typeMap = new Map<string, any>();
    typeMap.set('V', Types.I32);

    // Substitute V -> i32 twice
    const result1 = substituteType(entryType, typeMap, ctx) as ClassType;
    const result2 = substituteType(entryType, typeMap, ctx) as ClassType;

    // Should be interned
    assert.strictEqual(
      result1,
      result2,
      'Nested generic ClassTypes should be interned when ctx is provided',
    );

    // Verify the substituted type
    assert.ok(result1.typeArguments);
    assert.strictEqual(result1.typeArguments.length, 2);
    // First arg should be String (unchanged)
    assert.strictEqual((result1.typeArguments[0] as ClassType).name, 'String');
    // Second arg should be i32 (substituted)
    assert.strictEqual(result1.typeArguments[1], Types.I32);
  });

  test('ArrayType with same element type is interned', () => {
    const ctx = new CheckerContext(undefined, new SemanticContext());

    // Create two ArrayTypes with i32 element type
    const array1 = ctx.getOrCreateArrayType(Types.I32);
    const array2 = ctx.getOrCreateArrayType(Types.I32);

    // Should be the same interned instance
    assert.strictEqual(
      array1,
      array2,
      'ArrayTypes with same element type should be interned',
    );
  });

  test('ArrayType interning through substituteType', () => {
    const ctx = new CheckerContext(undefined, new SemanticContext());

    // Create array<T> type
    const tParam: TypeParameterType = {kind: TypeKind.TypeParameter, name: 'T'};
    const arrayT = ctx.getOrCreateArrayType(tParam);

    // Substitute T -> i32
    const typeMap = new Map<string, any>();
    typeMap.set('T', Types.I32);

    const result1 = substituteType(arrayT, typeMap, ctx);
    const result2 = substituteType(arrayT, typeMap, ctx);

    // Should be interned
    assert.strictEqual(
      result1,
      result2,
      'ArrayType substitution should return interned instance',
    );

    // Should be the same as creating directly
    const directArray = ctx.getOrCreateArrayType(Types.I32);
    assert.strictEqual(
      result1,
      directArray,
      'Substituted ArrayType should match directly created ArrayType',
    );
  });

  test('ClassType onType substitution interns ArrayType', () => {
    const ctx = new CheckerContext(undefined, new SemanticContext());

    // Create a type parameter
    const tParam: TypeParameterType = {kind: TypeKind.TypeParameter, name: 'T'};

    // Create an extension class type like FixedArray<T> on array<T>
    const arrayT = ctx.getOrCreateArrayType(tParam);
    const fixedArrayType: ClassType = {
      kind: TypeKind.Class,
      name: 'FixedArray',
      isExtension: true,
      typeParameters: [tParam],
      typeArguments: [tParam],
      onType: arrayT,
      implements: [],
      fields: new Map(),
      methods: new Map(),
      statics: new Map(),
      vtable: [],
    };

    // Substitute T -> i32 (simulating FixedArray<i32>)
    const typeMap = new Map<string, any>();
    typeMap.set('T', Types.I32);

    const result1 = substituteType(fixedArrayType, typeMap, ctx) as ClassType;
    const result2 = substituteType(fixedArrayType, typeMap, ctx) as ClassType;

    // ClassType itself should be interned
    assert.strictEqual(
      result1,
      result2,
      'Substituted ClassType should be interned',
    );

    // The onType should be the interned array<i32>
    const directArrayI32 = ctx.getOrCreateArrayType(Types.I32);
    assert.strictEqual(
      result1.onType,
      directArrayI32,
      'ClassType.onType should be interned ArrayType',
    );
  });
});
