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
});
