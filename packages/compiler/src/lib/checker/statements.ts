import {
  NodeType,
  type AccessorDeclaration,
  type AsPattern,
  type AssignmentPattern,
  type BinaryExpression,
  type BreakStatement,
  type ClassDeclaration,
  type ContinueStatement,
  type DeclareFunction,
  type EnumDeclaration,
  type ExportAllDeclaration,
  type Expression,
  type ForInStatement,
  type ForStatement,
  type Identifier,
  type IfStatement,
  type ImportDeclaration,
  type InterfaceDeclaration,
  type IsExpression,
  // type LetPatternCondition,
  type MethodDefinition,
  type MixinDeclaration,
  type Parameter,
  type Pattern,
  type RecordPattern,
  type ReturnStatement,
  type Statement,
  type SymbolDeclaration,
  type SymbolPropertyName,
  type TuplePattern,
  type TypeAliasDeclaration,
  type TypeParameter,
  type UnboxedTuplePattern,
  type VariableDeclaration,
  type WhileStatement,
} from '../ast.js';
import {DiagnosticCode} from '../diagnostics.js';
import {
  getGetterName,
  getPropertyNameFromAccessor,
  getSetterName,
  isGetterName,
  isSetterName,
} from '../names.js';
import {
  Decorators,
  TypeKind,
  TypeNames,
  Types,
  type ClassType,
  type ArrayType,
  type FunctionType,
  type InterfaceType,
  type LiteralType,
  type MixinType,
  type RecordType,
  type SymbolType,
  type TupleType,
  type Type,
  type TypeAliasType,
  type TypeParameterType,
  type UnboxedTupleType,
  type UnionType,
} from '../types.js';
import type {CheckerContext} from './context.js';
import {checkExpression, checkMatchPattern} from './expressions.js';
import {
  instantiateGenericClass,
  isBooleanType,
  isAssignableTo,
  resolveTypeAnnotation,
  substituteType,
  typeToString,
  validateType,
  validateNoUnboxedTuple,
  widenLiteralType,
} from './types.js';

// =============================================================================
// Type Narrowing
// =============================================================================

/**
 * Represents a type narrowing discovered from a condition.
 * For example, `x !== null` narrows `x` by removing `null`.
 */
interface TypeNarrowing {
  variableName: string;
  narrowedType: Type;
}

/**
 * Subtract `typeToRemove` from `originalType`.
 * For unions, this removes matching members.
 * E.g., subtractTypeFromUnion(T | null, null) => T
 */
const subtractTypeFromUnion = (
  originalType: Type,
  typeToRemove: Type,
): Type => {
  if (originalType.kind !== TypeKind.Union) {
    // If the original type equals the type to remove, return never
    if (typesEqual(originalType, typeToRemove)) {
      return Types.Never;
    }
    // Otherwise, no change
    return originalType;
  }

  const union = originalType as UnionType;
  const remainingTypes = union.types.filter(
    (t) => !typesEqual(t, typeToRemove),
  );

  if (remainingTypes.length === 0) {
    return Types.Never;
  }
  if (remainingTypes.length === 1) {
    return remainingTypes[0];
  }
  return {kind: TypeKind.Union, types: remainingTypes} as UnionType;
};

/**
 * Check if two types are equal (shallow comparison for null checks).
 */
const typesEqual = (a: Type, b: Type): boolean => {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;

  // For null, just compare kind
  if (a.kind === TypeKind.Null) return true;

  // For classes, compare by name or reference
  if (a.kind === TypeKind.Class) {
    return (a as ClassType).name === (b as ClassType).name;
  }

  // For other types, fall back to reference equality
  return false;
};

// =============================================================================
// Method Overloading Helpers
// =============================================================================

/**
 * Check if two function types have the same signature (parameter types and arity).
 * Used to detect duplicate method declarations vs valid overloads.
 * Note: We compare parameter types structurally, not return types.
 */
const hasSameSignature = (a: FunctionType, b: FunctionType): boolean => {
  if (a.parameters.length !== b.parameters.length) {
    return false;
  }
  for (let i = 0; i < a.parameters.length; i++) {
    if (typeToString(a.parameters[i]) !== typeToString(b.parameters[i])) {
      return false;
    }
  }
  return true;
};

/**
 * Find a matching overload in a method (checking both the method itself and its overloads).
 * Returns the matching FunctionType, or undefined if no match.
 */
const findMatchingOverload = (
  method: FunctionType,
  signature: FunctionType,
): FunctionType | undefined => {
  if (hasSameSignature(method, signature)) {
    return method;
  }
  if (method.overloads) {
    for (const overload of method.overloads) {
      if (hasSameSignature(overload, signature)) {
        return overload;
      }
    }
  }
  return undefined;
};

/**
 * Extract type narrowing information from a condition expression.
 * Returns narrowings that should be applied when the condition is TRUE.
 *
 * Supported patterns:
 * - `x !== null` / `x != null` -> narrows x by removing null (true branch)
 * - `null !== x` / `null != x` -> narrows x by removing null (true branch)
 * - `x === null` / `x == null` -> narrows x to null (true branch)
 * - `null === x` / `null == x` -> narrows x to null (true branch)
 * - `x is T` -> narrows x to T (true branch)
 */
const extractNarrowingFromCondition = (
  ctx: CheckerContext,
  condition: Expression,
): TypeNarrowing | null => {
  // Handle `x is T` pattern
  if (condition.type === NodeType.IsExpression) {
    const isExpr = condition as IsExpression;
    if (isExpr.expression.type !== NodeType.Identifier) {
      return null;
    }
    const identifier = isExpr.expression as Identifier;
    const targetType = resolveTypeAnnotation(ctx, isExpr.typeAnnotation);
    return {variableName: identifier.name, narrowedType: targetType};
  }

  if (condition.type !== NodeType.BinaryExpression) {
    return null;
  }

  const binary = condition as BinaryExpression;
  const op = binary.operator;

  // Handle !== and != (not equal to null)
  if (op === '!==' || op === '!=') {
    const identifier = extractNullComparisonIdentifier(binary);
    if (!identifier) return null;

    const variableName = identifier.name;
    const originalType = ctx.resolveValue(variableName);
    if (!originalType) return null;

    // Narrow by removing null
    const narrowedType = subtractTypeFromUnion(originalType, Types.Null);
    if (narrowedType === originalType) return null;

    return {variableName, narrowedType};
  }

  // Handle === and == (equal to null)
  if (op === '===' || op === '==') {
    const identifier = extractNullComparisonIdentifier(binary);
    if (!identifier) return null;

    // In the true branch of `x == null`, x is null
    return {variableName: identifier.name, narrowedType: Types.Null};
  }

  return null;
};

/**
 * Helper to extract the identifier from a null comparison expression.
 * Works for both `x op null` and `null op x` patterns.
 */
const extractNullComparisonIdentifier = (
  binary: BinaryExpression,
): Identifier | null => {
  // Check pattern: x op null
  if (
    binary.left.type === NodeType.Identifier &&
    binary.right.type === NodeType.NullLiteral
  ) {
    return binary.left as Identifier;
  }
  // Check pattern: null op x
  if (
    binary.left.type === NodeType.NullLiteral &&
    binary.right.type === NodeType.Identifier
  ) {
    return binary.right as Identifier;
  }
  return null;
};

/**
 * Extract the inverse narrowing from a condition.
 * This is used for the else branch.
 *
 * - `x !== null` else branch -> x is null
 * - `x === null` else branch -> x is non-null
 * - `x is T` else branch -> x with T subtracted (if union)
 */
const extractInverseNarrowingFromCondition = (
  ctx: CheckerContext,
  condition: Expression,
): TypeNarrowing | null => {
  // Handle `x is T` pattern - in else branch, we know x is NOT T
  if (condition.type === NodeType.IsExpression) {
    const isExpr = condition as IsExpression;
    if (isExpr.expression.type !== NodeType.Identifier) {
      return null;
    }
    const identifier = isExpr.expression as Identifier;
    const variableName = identifier.name;
    const originalType = ctx.resolveValue(variableName);
    if (!originalType) return null;

    const targetType = resolveTypeAnnotation(ctx, isExpr.typeAnnotation);
    const narrowedType = subtractTypeFromUnion(originalType, targetType);
    if (narrowedType === originalType) return null;

    return {variableName, narrowedType};
  }

  if (condition.type !== NodeType.BinaryExpression) {
    return null;
  }

  const binary = condition as BinaryExpression;
  const op = binary.operator;

  const identifier = extractNullComparisonIdentifier(binary);
  if (!identifier) return null;

  // For !== and !=, the else branch means IS null
  if (op === '!==' || op === '!=') {
    return {variableName: identifier.name, narrowedType: Types.Null};
  }

  // For === and ==, the else branch means NOT null
  if (op === '===' || op === '==') {
    const variableName = identifier.name;
    const originalType = ctx.resolveValue(variableName);
    if (!originalType) return null;

    const narrowedType = subtractTypeFromUnion(originalType, Types.Null);
    if (narrowedType === originalType) return null;

    return {variableName, narrowedType};
  }

  return null;
};

// =============================================================================
// Type Pre-declaration (First Pass)
// =============================================================================

/**
 * Pre-declares a type (class, mixin, interface) so it can be referenced
 * by other types before its full definition is processed.
 * This enables forward references (e.g., a mixin field referencing a class
 * that uses the mixin).
 */
export function predeclareType(ctx: CheckerContext, stmt: Statement) {
  switch (stmt.type) {
    case NodeType.ClassDeclaration:
      predeclareClass(ctx, stmt as ClassDeclaration);
      break;
    case NodeType.MixinDeclaration:
      predeclareMixin(ctx, stmt as MixinDeclaration);
      break;
    case NodeType.InterfaceDeclaration:
      predeclareInterface(ctx, stmt as InterfaceDeclaration);
      break;
  }
}

/**
 * Pre-declares a class type with empty fields/methods.
 * The actual members will be filled in during the full check pass.
 */
const predeclareClass = (ctx: CheckerContext, decl: ClassDeclaration) => {
  const className = decl.name.name;

  // Skip if already declared IN CURRENT SCOPE (e.g., imported types)
  // Don't skip for prelude types - allow user to shadow them
  const existingInScope = ctx.resolveTypeLocal(className);
  if (existingInScope && existingInScope.kind === TypeKind.Class) {
    return;
  }

  // If the AST node already has an inferred type (e.g., from a previous type-check
  // pass before bundling), reuse it instead of creating a new one.
  // This preserves type identity across bundling.
  if (decl.inferredType && decl.inferredType.kind === TypeKind.Class) {
    const existingType = decl.inferredType as ClassType;
    // Update the name to match the (possibly renamed) declaration
    existingType.name = className;
    ctx.declare(className, existingType, 'type', decl);
    ctx.declare(className, existingType, 'let', decl);

    if (decl.exported && ctx.module) {
      ctx.module!.exports!.set(`type:${className}`, {
        type: existingType,
        kind: 'type',
        declaration: decl,
      });
      ctx.module!.exports!.set(`value:${className}`, {
        type: existingType,
        kind: 'let',
        declaration: decl,
      });
    }
    return;
  }

  // Create type parameters
  const typeParameters: TypeParameterType[] = [];
  if (decl.typeParameters) {
    for (const param of decl.typeParameters) {
      typeParameters.push({
        kind: TypeKind.TypeParameter,
        name: param.name,
      });
    }
  }

  // Create a placeholder class type
  const classType: ClassType = {
    kind: TypeKind.Class,
    name: className,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    superType: undefined, // Will be resolved in full check
    implements: [],
    fields: new Map(),
    methods: new Map(),
    statics: new Map(),
    symbolFields: new Map(),
    symbolMethods: new Map(),
    constructorType: undefined,
    vtable: [],
    isFinal: decl.isFinal,
    isAbstract: decl.isAbstract,
    isExtension: decl.isExtension,
    onType: undefined,
  };

  ctx.declare(className, classType, 'type', decl);
  ctx.declare(className, classType, 'let', decl);

  // Store reference for the full check pass to update
  decl.inferredType = classType;

  if (decl.exported && ctx.module) {
    ctx.module!.exports!.set(`type:${className}`, {
      type: classType,
      kind: 'type',
      declaration: decl,
    });
    ctx.module!.exports!.set(`value:${className}`, {
      type: classType,
      kind: 'let',
      declaration: decl,
    });
  }
};

/**
 * Pre-declares a mixin type with empty fields/methods.
 */
const predeclareMixin = (ctx: CheckerContext, decl: MixinDeclaration) => {
  const mixinName = decl.name.name;

  // Skip if already declared
  if (ctx.resolveType(mixinName)) {
    return;
  }

  // If the AST node already has an inferred type, reuse it
  if (decl.inferredType && decl.inferredType.kind === TypeKind.Mixin) {
    const existingType = decl.inferredType as MixinType;
    existingType.name = mixinName;
    ctx.declare(mixinName, existingType, 'type');

    if (decl.exported && ctx.module) {
      ctx.module!.exports!.set(`type:${mixinName}`, {
        type: existingType,
        kind: 'type',
      });
    }
    return;
  }

  // Create type parameters
  const typeParameters: TypeParameterType[] = [];
  if (decl.typeParameters) {
    for (const param of decl.typeParameters) {
      typeParameters.push({
        kind: TypeKind.TypeParameter,
        name: param.name,
      });
    }
  }

  // Create a placeholder mixin type
  const mixinType: MixinType = {
    kind: TypeKind.Mixin,
    name: mixinName,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    onType: undefined, // Will be resolved in full check
    fields: new Map(),
    methods: new Map(),
    symbolFields: new Map(),
    symbolMethods: new Map(),
  };

  ctx.declare(mixinName, mixinType, 'type');

  // Store reference for the full check pass to update
  decl.inferredType = mixinType;

  if (decl.exported && ctx.module) {
    ctx.module!.exports!.set(`type:${mixinName}`, {
      type: mixinType,
      kind: 'type',
    });
  }
};

/**
 * Pre-declares an interface type with empty members.
 */
const predeclareInterface = (
  ctx: CheckerContext,
  decl: InterfaceDeclaration,
) => {
  const interfaceName = decl.name.name;

  // Skip if already declared IN CURRENT SCOPE (not prelude)
  // Allow user to shadow prelude types with their own interfaces
  const existingInScope = ctx.resolveTypeLocal(interfaceName);
  if (existingInScope && existingInScope.kind === TypeKind.Interface) {
    return;
  }

  // If the AST node already has an inferred type, reuse it
  if (decl.inferredType && decl.inferredType.kind === TypeKind.Interface) {
    const existingType = decl.inferredType as InterfaceType;
    existingType.name = interfaceName;
    ctx.declare(interfaceName, existingType, 'type');

    if (decl.exported && ctx.module) {
      ctx.module!.exports!.set(`type:${interfaceName}`, {
        type: existingType,
        kind: 'type',
      });
    }
    return;
  }

  // Create type parameters
  const typeParameters: TypeParameterType[] = [];
  if (decl.typeParameters) {
    for (const param of decl.typeParameters) {
      typeParameters.push({
        kind: TypeKind.TypeParameter,
        name: param.name,
      });
    }
  }

  // Create a placeholder interface type
  const interfaceType: InterfaceType = {
    kind: TypeKind.Interface,
    name: interfaceName,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    extends: [],
    fields: new Map(),
    methods: new Map(),
    symbolFields: new Map(),
    symbolMethods: new Map(),
  };

  ctx.declare(interfaceName, interfaceType, 'type');

  // Store reference for the full check pass to update
  decl.inferredType = interfaceType;

  if (decl.exported && ctx.module) {
    ctx.module!.exports!.set(`type:${interfaceName}`, {
      type: interfaceType,
      kind: 'type',
    });
  }
};

// =============================================================================
// Statement Checking
// =============================================================================

export function checkStatement(ctx: CheckerContext, stmt: Statement) {
  switch (stmt.type) {
    case NodeType.ImportDeclaration:
      checkImportDeclaration(ctx, stmt as ImportDeclaration);
      break;
    case NodeType.ExportAllDeclaration:
      checkExportAllDeclaration(ctx, stmt as ExportAllDeclaration);
      break;
    case NodeType.VariableDeclaration:
      checkVariableDeclaration(ctx, stmt as VariableDeclaration);
      break;
    case NodeType.ExpressionStatement:
      checkExpression(ctx, stmt.expression);
      break;
    case NodeType.BlockStatement:
      ctx.enterScope();
      for (const s of stmt.body) {
        checkStatement(ctx, s);
      }
      ctx.exitScope();
      break;
    case NodeType.ReturnStatement:
      checkReturnStatement(ctx, stmt as ReturnStatement);
      break;
    case NodeType.BreakStatement:
      checkBreakStatement(ctx, stmt as BreakStatement);
      break;
    case NodeType.ContinueStatement:
      checkContinueStatement(ctx, stmt as ContinueStatement);
      break;
    case NodeType.IfStatement:
      checkIfStatement(ctx, stmt as IfStatement);
      break;
    case NodeType.WhileStatement:
      checkWhileStatement(ctx, stmt as WhileStatement);
      break;
    case NodeType.ForStatement:
      checkForStatement(ctx, stmt as ForStatement);
      break;
    case NodeType.ForInStatement:
      checkForInStatement(ctx, stmt as ForInStatement);
      break;
    case NodeType.ClassDeclaration:
      checkClassDeclaration(ctx, stmt as ClassDeclaration);
      break;
    case NodeType.MixinDeclaration:
      checkMixinDeclaration(ctx, stmt as MixinDeclaration);
      break;
    case NodeType.InterfaceDeclaration:
      checkInterfaceDeclaration(ctx, stmt as InterfaceDeclaration);
      break;
    case NodeType.DeclareFunction:
      checkDeclareFunction(ctx, stmt as DeclareFunction);
      break;
    case NodeType.TypeAliasDeclaration:
      checkTypeAliasDeclaration(ctx, stmt as TypeAliasDeclaration);
      break;
    case NodeType.EnumDeclaration:
      checkEnumDeclaration(ctx, stmt as EnumDeclaration);
      break;
    case NodeType.SymbolDeclaration:
      checkSymbolDeclaration(ctx, stmt as SymbolDeclaration);
      break;
  }
}

function resolveParameterType(ctx: CheckerContext, param: Parameter): Type {
  if (!param.typeAnnotation) {
    // This function is used for class methods which always require type annotations.
    // If called on a contextually-typed closure parameter, this is a bug.
    ctx.diagnostics.reportError(
      `Parameter '${param.name.name}' requires a type annotation in this context.`,
      DiagnosticCode.TypeMismatch,
    );
    return Types.Unknown;
  }
  let type = resolveTypeAnnotation(ctx, param.typeAnnotation);
  if (param.optional && !param.initializer) {
    if (type.kind === TypeKind.Union) {
      type = {
        kind: TypeKind.Union,
        types: [...(type as UnionType).types, Types.Null],
      } as UnionType;
    } else {
      type = {
        kind: TypeKind.Union,
        types: [type, Types.Null],
      } as UnionType;
    }
    validateType(type, ctx);
  }
  return type;
}

function checkTypeAliasDeclaration(
  ctx: CheckerContext,
  decl: TypeAliasDeclaration,
) {
  const name = decl.name.name;

  // If the AST node already has an inferred type (from a previous type-check pass),
  // reuse it to preserve type identity across bundling.
  if (decl.inferredType && decl.inferredType.kind === TypeKind.TypeAlias) {
    const existingType = decl.inferredType as TypeAliasType;
    // Update the name to match the (possibly renamed) declaration
    existingType.name = name;
    ctx.declare(name, existingType, 'type');
    if (decl.exported && ctx.module) {
      ctx.module!.exports!.set(`type:${name}`, {
        type: existingType,
        kind: 'type',
      });
    }
    return;
  }

  ctx.enterScope();
  const typeParameters = createTypeParameters(ctx, decl.typeParameters);

  const target = resolveTypeAnnotation(ctx, decl.typeAnnotation);

  ctx.exitScope();

  const typeAlias: TypeAliasType = {
    kind: TypeKind.TypeAlias,
    name,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    target,
    isDistinct: decl.isDistinct,
  };

  ctx.declare(name, typeAlias, 'type');
  decl.inferredType = typeAlias;

  if (decl.exported && ctx.module) {
    ctx.module!.exports!.set(`type:${name}`, {type: typeAlias, kind: 'type'});
  }
}

/**
 * Check a symbol declaration: `symbol name;` or `export symbol name;`
 * Symbols are compile-time unique identifiers used for method/field names.
 */
function checkSymbolDeclaration(ctx: CheckerContext, decl: SymbolDeclaration) {
  const name = decl.name.name;

  // Generate a debug name based on module path + symbol name for diagnostics
  const modulePath = ctx.module?.path ?? '<anonymous>';
  const debugName = `${modulePath}:${name}`;

  const symbolType: SymbolType = {
    kind: TypeKind.Symbol,
    debugName,
    id: ctx.nextSymbolId(),
  };

  // Declare the symbol as a 'let' binding (it's a value, not a type)
  ctx.declare(name, symbolType, 'let', decl);
  decl.inferredType = symbolType;

  if (decl.exported && ctx.module) {
    ctx.module!.exports!.set(`value:${name}`, {
      type: symbolType,
      kind: 'let',
      declaration: decl,
    });
  }
}

function checkExportAllDeclaration(
  ctx: CheckerContext,
  decl: ExportAllDeclaration,
) {
  if (!ctx.module || !ctx.compiler) {
    return;
  }

  const specifier = decl.moduleSpecifier.value;
  const resolvedPath = ctx.module!.imports!.get(specifier);

  if (!resolvedPath) {
    ctx.diagnostics.reportError(
      `Could not resolve module '${specifier}'`,
      DiagnosticCode.ModuleNotFound,
    );
    return;
  }

  const importedModule = ctx.compiler.getModule(resolvedPath);
  if (!importedModule) {
    ctx.diagnostics.reportError(
      `Module '${specifier}' not found (resolved to '${resolvedPath}')`,
      DiagnosticCode.ModuleNotFound,
    );
    return;
  }

  // Re-export all symbols
  for (const [name, symbolInfo] of importedModule.exports!) {
    if (ctx.module!.exports!.has(name)) {
      // Conflict?
      // If we have multiple export * from different modules exporting same name, it's a conflict.
      // Or if we have local export with same name, local wins (shadows).
      // But here we are populating exports.
      // If local export exists, it should have been added already?
      // Statements are checked in order.
      // If export * comes first, it adds.
      // If later we have export let x, it overwrites?
      // Usually explicit export wins.
      // For now, let's just warn or error on conflict if it's not identical.
      const existing = ctx.module!.exports!.get(name)!;
      if (existing.type !== symbolInfo.type) {
        // Error?
      }
    }
    ctx.module!.exports!.set(name, symbolInfo);
  }
}

function checkImportDeclaration(ctx: CheckerContext, decl: ImportDeclaration) {
  if (!ctx.module || !ctx.compiler) {
    // If we are not in a module context (e.g. simple test), we can't check imports.
    // Or maybe we should error? For now, let's ignore.
    return;
  }

  const specifier = decl.moduleSpecifier.value;
  const resolvedPath = ctx.module!.imports!.get(specifier);

  if (!resolvedPath) {
    ctx.diagnostics.reportError(
      `Could not resolve module '${specifier}'`,
      DiagnosticCode.ModuleNotFound,
    );
    return;
  }

  const importedModule = ctx.compiler.getModule(resolvedPath);
  if (!importedModule) {
    ctx.diagnostics.reportError(
      `Module '${specifier}' not found (resolved to '${resolvedPath}')`,
      DiagnosticCode.ModuleNotFound,
    );
    return;
  }

  // Ensure the imported module is checked (or at least its exports are available)
  // The compiler should have already loaded it.
  // But we might need to ensure it's checked?
  // For now, let's assume the compiler orchestrates checking in order.
  // If the imported module hasn't been checked, its exports map will be empty.
  // This implies we need a topological sort or recursive check.

  // Let's assume the compiler handles the order.

  for (const importSpecifier of decl.imports) {
    const importedName = importSpecifier.imported.name;
    const localName = importSpecifier.local.name;

    const valueExport = importedModule.exports!.get(`value:${importedName}`);
    const typeExport = importedModule.exports!.get(`type:${importedName}`);
    const legacyExport = importedModule.exports!.get(importedName);

    if (!valueExport && !typeExport && !legacyExport) {
      ctx.diagnostics.reportError(
        `Module '${specifier}' does not export '${importedName}'`,
        DiagnosticCode.ImportError,
      );
      continue;
    }

    if (valueExport) {
      // Pass the exported declaration (if any) and modulePath to track the binding
      ctx.declare(
        localName,
        valueExport.type,
        'let',
        valueExport.declaration,
        importedModule.path,
      );
    }
    if (typeExport) {
      ctx.declare(
        localName,
        typeExport.type,
        'type',
        typeExport.declaration,
        importedModule.path,
      );
    }
    if (legacyExport) {
      ctx.declare(
        localName,
        legacyExport.type,
        legacyExport.kind,
        legacyExport.declaration,
        importedModule.path,
      );
    }
  }
}

function checkDeclareFunction(ctx: CheckerContext, decl: DeclareFunction) {
  ctx.enterScope();
  const typeParameters = createTypeParameters(ctx, decl.typeParameters);

  const paramTypes: Type[] = [];
  const parameterNames: string[] = [];
  const optionalParameters: boolean[] = [];
  const parameterInitializers: any[] = [];

  for (const param of decl.params) {
    const type = resolveParameterType(ctx, param);
    paramTypes.push(type);
    parameterNames.push(param.name.name);
    optionalParameters.push(param.optional);
    parameterInitializers.push(param.initializer);
  }

  const returnType = resolveTypeAnnotation(ctx, decl.returnType);

  ctx.exitScope();

  const functionType: FunctionType = {
    kind: TypeKind.Function,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    parameters: paramTypes,
    parameterNames,
    returnType,
    optionalParameters,
    parameterInitializers,
  };

  decl.inferredType = functionType;
  ctx.declare(decl.name.name, functionType, 'let');

  if (decl.exported && ctx.module) {
    // Retrieve the type from the scope to ensure we export the aggregated overloads
    // (if this is an overload)
    const exportedType = ctx.resolveValue(decl.name.name) || functionType;
    ctx.module!.exports!.set(`value:${decl.name.name}`, {
      type: exportedType,
      kind: 'let',
    });
  }
}

function checkIfStatement(ctx: CheckerContext, stmt: IfStatement) {
  if (stmt.test.type === NodeType.LetPatternCondition) {
    // if (let pattern = expr) { consequent } else { alternate }
    // Pattern variables are bound inside the consequent scope only
    const initType = checkExpression(ctx, stmt.test.init);

    // Check the consequent with pattern bindings
    ctx.enterScope();
    checkMatchPattern(ctx, stmt.test.pattern, initType);
    checkStatement(ctx, stmt.consequent);
    ctx.exitScope();

    // Check the alternate (no pattern bindings)
    if (stmt.alternate) {
      ctx.enterScope();
      checkStatement(ctx, stmt.alternate);
      ctx.exitScope();
    }
    return;
  }

  // Regular expression condition
  const testType = checkExpression(ctx, stmt.test);
  if (!isBooleanType(testType) && testType.kind !== TypeKind.Unknown) {
    ctx.diagnostics.reportError(
      `Expected boolean condition in if statement, got ${typeToString(testType)}`,
      DiagnosticCode.TypeMismatch,
    );
  }

  // Extract narrowing information from the condition
  const narrowing = extractNarrowingFromCondition(ctx, stmt.test);

  // Check the consequent branch with narrowing applied
  ctx.enterScope();
  if (narrowing) {
    ctx.narrowType(narrowing.variableName, narrowing.narrowedType);
  }
  checkStatement(ctx, stmt.consequent);
  ctx.exitScope();

  // Check the alternate branch with inverse narrowing applied
  if (stmt.alternate) {
    const inverseNarrowing = extractInverseNarrowingFromCondition(
      ctx,
      stmt.test,
    );
    ctx.enterScope();
    if (inverseNarrowing) {
      ctx.narrowType(
        inverseNarrowing.variableName,
        inverseNarrowing.narrowedType,
      );
    }
    checkStatement(ctx, stmt.alternate);
    ctx.exitScope();
  }
}

function checkWhileStatement(ctx: CheckerContext, stmt: WhileStatement) {
  if (stmt.test.type === NodeType.LetPatternCondition) {
    // while (let pattern = expr) { body }
    // Pattern variables are bound inside the loop body
    const initType = checkExpression(ctx, stmt.test.init);
    ctx.enterLoop();
    ctx.enterScope();
    checkMatchPattern(ctx, stmt.test.pattern, initType);
    checkStatement(ctx, stmt.body);
    ctx.exitScope();
    ctx.exitLoop();
    return;
  }
  const testType = checkExpression(ctx, stmt.test);
  if (!isBooleanType(testType) && testType.kind !== TypeKind.Unknown) {
    ctx.diagnostics.reportError(
      `Expected boolean condition in while statement, got ${typeToString(testType)}`,
      DiagnosticCode.TypeMismatch,
    );
  }

  ctx.enterLoop();
  checkStatement(ctx, stmt.body);
  ctx.exitLoop();
}

function checkForStatement(ctx: CheckerContext, stmt: ForStatement) {
  ctx.enterScope();

  // Check init
  if (stmt.init) {
    if (stmt.init.type === NodeType.VariableDeclaration) {
      checkVariableDeclaration(ctx, stmt.init as VariableDeclaration);
    } else {
      checkExpression(ctx, stmt.init);
    }
  }

  // Check test
  if (stmt.test) {
    const testType = checkExpression(ctx, stmt.test);
    if (!isBooleanType(testType) && testType.kind !== TypeKind.Unknown) {
      ctx.diagnostics.reportError(
        `Expected boolean condition in for statement, got ${typeToString(testType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }
  }

  // Check update
  if (stmt.update) {
    checkExpression(ctx, stmt.update);
  }

  // Check body
  ctx.enterLoop();
  checkStatement(ctx, stmt.body);
  ctx.exitLoop();

  ctx.exitScope();
}

/**
 * Check a for-in statement: `for (let pattern in iterable) body`
 * The iterable must implement Iterable<T>, and pattern variables are typed as T.
 */
function checkForInStatement(ctx: CheckerContext, stmt: ForInStatement) {
  // Check the iterable expression
  const iterableType = checkExpression(ctx, stmt.iterable);

  // Find if the type implements Iterable<T>
  const iterableInfo = getIterableInfo(ctx, iterableType);

  if (!iterableInfo) {
    ctx.diagnostics.reportError(
      `Type '${typeToString(iterableType)}' does not implement Iterable<T>`,
      DiagnosticCode.TypeMismatch,
    );
    // Use unknown type to continue checking
    stmt.elementType = Types.Unknown;
  } else {
    stmt.elementType = iterableInfo.elementType;
    stmt.iteratorType = iterableInfo.iteratorType;
  }

  // Enter scope for pattern bindings and loop body
  ctx.enterScope();
  ctx.enterLoop();

  // Bind pattern variables with element type
  checkMatchPattern(ctx, stmt.pattern, stmt.elementType);

  // Check body
  checkStatement(ctx, stmt.body);

  ctx.exitLoop();
  ctx.exitScope();
}

interface IterableInfo {
  elementType: Type;
  iteratorType: InterfaceType;
}

/**
 * Find the element type T and Iterator type if the type implements Iterable<T>.
 * Returns undefined if the type does not implement Iterable.
 */
function getIterableInfo(
  ctx: CheckerContext,
  type: Type,
): IterableInfo | undefined {
  // Handle class types
  if (type.kind === TypeKind.Class) {
    const classType = type as ClassType;
    return findIterableInImplements(ctx, classType);
  }

  // Handle interface types (if the iterable is typed as Iterable<T> directly)
  if (type.kind === TypeKind.Interface) {
    const interfaceType = type as InterfaceType;
    const iterableInterface = findIterableInterface(interfaceType);
    if (iterableInterface) {
      const elementType = iterableInterface.typeArguments?.[0] ?? Types.Unknown;
      // Get the Iterator type from Iterable's iterator() method return type
      const iteratorMethod = iterableInterface.methods.get('iterator');
      if (iteratorMethod && iteratorMethod.returnType) {
        return {
          elementType,
          iteratorType: iteratorMethod.returnType as InterfaceType,
        };
      }
    }
  }

  // Handle array types via FixedArray extension class
  if (type.kind === TypeKind.Array) {
    const arrayType = type as ArrayType;
    const genericArrayType = ctx.getWellKnownType(TypeNames.FixedArray);
    if (genericArrayType && genericArrayType.kind === TypeKind.Class) {
      const genericClassType = genericArrayType as ClassType;

      // Instantiate FixedArray<T> with the actual element type
      let instantiatedClassType = genericClassType;
      if (
        genericClassType.typeParameters &&
        genericClassType.typeParameters.length > 0
      ) {
        instantiatedClassType = instantiateGenericClass(
          genericClassType,
          [arrayType.elementType],
          ctx,
        );
      }

      return findIterableInImplements(ctx, instantiatedClassType);
    }
  }

  return undefined;
}

/**
 * Search through a class's implements list (and superclasses) for Iterable<T>.
 */
function findIterableInImplements(
  ctx: CheckerContext,
  classType: ClassType,
): IterableInfo | undefined {
  let current: ClassType | undefined = classType;

  while (current) {
    let implementsList = current.implements;

    // If implements is empty but we have genericSource, re-instantiate
    if (
      implementsList.length === 0 &&
      current.genericSource &&
      current.genericSource.implements.length > 0 &&
      current.typeArguments
    ) {
      const typeMap = new Map<string, Type>();
      current.genericSource.typeParameters!.forEach((param, index) => {
        typeMap.set(param.name, current!.typeArguments![index]);
      });
      implementsList = current.genericSource.implements.map(
        (impl) => substituteType(impl, typeMap, ctx) as InterfaceType,
      );
    }

    for (const impl of implementsList) {
      const iterableInterface = findIterableInterface(impl);
      if (iterableInterface) {
        const elementType =
          iterableInterface.typeArguments?.[0] ?? Types.Unknown;
        // Get the Iterator type from Iterable's iterator() method
        const iteratorMethod = iterableInterface.methods.get('iterator');
        if (iteratorMethod && iteratorMethod.returnType) {
          return {
            elementType,
            iteratorType: iteratorMethod.returnType as InterfaceType,
          };
        }
      }
    }

    current = current.superType;
  }

  return undefined;
}

/**
 * Check if an interface is Iterable or extends Iterable.
 * Returns the Iterable interface type if found, undefined otherwise.
 */
function findIterableInterface(
  interfaceType: InterfaceType,
): InterfaceType | undefined {
  // Check if this interface is Iterable
  const name = interfaceType.genericSource?.name ?? interfaceType.name;
  if (name === 'Iterable') {
    return interfaceType;
  }

  // Check extended interfaces
  if (interfaceType.extends) {
    for (const ext of interfaceType.extends) {
      const found = findIterableInterface(ext);
      if (found) return found;
    }
  }

  return undefined;
}

function checkBreakStatement(ctx: CheckerContext, stmt: BreakStatement) {
  if (ctx.loopDepth === 0) {
    ctx.diagnostics.reportError(
      'Break statement outside of loop.',
      DiagnosticCode.BreakOutsideLoop,
    );
  }
}

function checkContinueStatement(ctx: CheckerContext, stmt: ContinueStatement) {
  if (ctx.loopDepth === 0) {
    ctx.diagnostics.reportError(
      'Continue statement outside of loop.',
      DiagnosticCode.ContinueOutsideLoop,
    );
  }
}

function checkReturnStatement(ctx: CheckerContext, stmt: ReturnStatement) {
  if (!ctx.currentFunctionReturnType) {
    ctx.diagnostics.reportError(
      'Return statement outside of function.',
      DiagnosticCode.ReturnOutsideFunction,
      ctx.getLocation(stmt.loc),
    );
    return;
  }

  const argType = stmt.argument
    ? checkExpression(ctx, stmt.argument)
    : Types.Void;

  if (ctx.currentFunctionReturnType.kind !== Types.Unknown.kind) {
    // If we know the expected return type, check against it
    if (!isAssignableTo(ctx, argType, ctx.currentFunctionReturnType)) {
      ctx.diagnostics.reportError(
        `Type mismatch: expected return type ${typeToString(ctx.currentFunctionReturnType)}, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(stmt.argument?.loc ?? stmt.loc),
      );
    }
  } else {
    // Infer return type
    ctx.inferredReturnTypes.push(argType);
  }
}

function checkLiteralMatch(
  expr: Expression,
  literalType: LiteralType,
): boolean {
  // Check if the expression is a literal that matches the type
  if (expr.type === NodeType.StringLiteral) {
    return (
      typeof literalType.value === 'string' && expr.value === literalType.value
    );
  }
  if (expr.type === NodeType.NumberLiteral) {
    return (
      typeof literalType.value === 'number' && expr.value === literalType.value
    );
  }
  if (expr.type === NodeType.BooleanLiteral) {
    return (
      typeof literalType.value === 'boolean' && expr.value === literalType.value
    );
  }
  return false;
}

function checkVariableDeclaration(
  ctx: CheckerContext,
  decl: VariableDeclaration,
) {
  let type = checkExpression(ctx, decl.init);

  // For mutable variables (var), widen literal types to their base types
  // This allows reassignment like: var x = true; x = false;
  if (decl.kind === 'var' && !decl.typeAnnotation) {
    type = widenLiteralType(type, ctx);
  }

  if (decl.typeAnnotation) {
    const explicitType = resolveTypeAnnotation(ctx, decl.typeAnnotation);

    // Unboxed tuples cannot appear in variable type annotations
    validateNoUnboxedTuple(explicitType, ctx, 'variable types');

    // Special handling for literal types
    let compatible = isAssignableTo(ctx, type, explicitType);
    if (!compatible) {
      if (explicitType.kind === TypeKind.Literal) {
        // Check if the init expression is a matching literal
        compatible = checkLiteralMatch(decl.init, explicitType as LiteralType);
      } else if (explicitType.kind === TypeKind.Union) {
        // Check if the init expression matches any literal in the union
        const unionType = explicitType as UnionType;
        compatible = unionType.types.some((t) => {
          if (t.kind === TypeKind.Literal) {
            return checkLiteralMatch(decl.init, t as LiteralType);
          }
          return isAssignableTo(ctx, type, t);
        });
      }
    }

    if (!compatible) {
      ctx.diagnostics.reportError(
        `Type mismatch: expected ${typeToString(explicitType)}, got ${typeToString(type)}`,
        DiagnosticCode.TypeMismatch,
        ctx.getLocation(decl.init.loc),
      );
    }
    type = explicitType;
  }

  // Set the inferred type on the declaration
  decl.inferredType = type;

  if (decl.pattern.type === NodeType.Identifier) {
    ctx.declare(decl.pattern.name, type, decl.kind, decl);

    if (decl.exported && ctx.module) {
      ctx.module!.exports!.set(`value:${decl.pattern.name}`, {
        type,
        kind: decl.kind,
        declaration: decl,
      });
    }
  } else {
    checkPattern(ctx, decl.pattern, type, decl.kind, decl);
  }
}

function checkPattern(
  ctx: CheckerContext,
  pattern: Pattern,
  type: Type,
  kind: 'let' | 'var',
  declaration?: VariableDeclaration,
) {
  switch (pattern.type) {
    case NodeType.Identifier:
      // Use the Identifier pattern itself as the declaration for binding resolution
      ctx.declare(pattern.name, type, kind, pattern);
      break;

    case NodeType.AsPattern: {
      const asPattern = pattern as AsPattern;
      // Use the Identifier in the AsPattern for binding resolution
      ctx.declare(asPattern.name.name, type, kind, asPattern.name);
      checkPattern(ctx, asPattern.pattern, type, kind, declaration);
      break;
    }

    case NodeType.RecordPattern:
      checkRecordPattern(ctx, pattern, type, kind, declaration);
      break;

    case NodeType.TuplePattern:
      checkTuplePattern(ctx, pattern, type, kind, declaration);
      break;

    case NodeType.UnboxedTuplePattern:
      checkUnboxedTuplePattern(
        ctx,
        pattern as UnboxedTuplePattern,
        type,
        kind,
        declaration,
      );
      break;

    case NodeType.AssignmentPattern:
      checkAssignmentPattern(ctx, pattern, type, kind, declaration);
      break;
  }
}

function checkRecordPattern(
  ctx: CheckerContext,
  pattern: RecordPattern,
  type: Type,
  kind: 'let' | 'var',
  declaration?: VariableDeclaration,
) {
  // Ensure type has properties
  // We support RecordType, ClassType, InterfaceType, MixinType
  // We need a helper to get property type.

  for (const prop of pattern.properties) {
    const propName = prop.name.name;
    const propType = getPropertyType(ctx, type, propName);

    if (!propType) {
      ctx.diagnostics.reportError(
        `Type '${typeToString(type)}' has no property '${propName}'`,
        DiagnosticCode.TypeMismatch,
      );
      continue;
    }

    checkPattern(ctx, prop.value, propType, kind, declaration);
  }
}

function checkTuplePattern(
  ctx: CheckerContext,
  pattern: TuplePattern,
  type: Type,
  kind: 'let' | 'var',
  declaration?: VariableDeclaration,
) {
  if (type.kind === TypeKind.Tuple) {
    const tupleType = type as TupleType;
    // Check length?
    // Tuple destructuring can be partial: let [x] = [1, 2];
    // But cannot exceed: let [x, y, z] = [1, 2];
    if (pattern.elements.length > tupleType.elementTypes.length) {
      ctx.diagnostics.reportError(
        `Tuple pattern has ${pattern.elements.length} elements but type has ${tupleType.elementTypes.length}`,
        DiagnosticCode.TypeMismatch,
      );
    }

    for (let i = 0; i < pattern.elements.length; i++) {
      const elemPattern = pattern.elements[i];
      if (!elemPattern) continue; // Skipped

      if (i >= tupleType.elementTypes.length) break; // Already reported error

      checkPattern(
        ctx,
        elemPattern,
        tupleType.elementTypes[i],
        kind,
        declaration,
      );
    }
  } else if (type.kind === TypeKind.Array) {
    const arrayType = type as ArrayType;
    for (const elemPattern of pattern.elements) {
      if (!elemPattern) continue;
      checkPattern(ctx, elemPattern, arrayType.elementType, kind, declaration);
    }
  } else {
    ctx.diagnostics.reportError(
      `Type '${typeToString(type)}' is not a tuple or array`,
      DiagnosticCode.TypeMismatch,
    );
  }
}

/**
 * Check an unboxed tuple pattern like `let (a, b) = expr`.
 * The initializer must be an UnboxedTupleType or a union of UnboxedTupleTypes
 * with matching element count.
 */
function checkUnboxedTuplePattern(
  ctx: CheckerContext,
  pattern: UnboxedTuplePattern,
  type: Type,
  kind: 'let' | 'var',
  declaration?: VariableDeclaration,
) {
  // Handle union of unboxed tuples: (true, T) | (false, never)
  // Compute element types as unions across all tuple variants
  const elementTypes = getUnboxedTupleElementTypes(type);

  if (elementTypes === null) {
    ctx.diagnostics.reportError(
      `Unboxed tuple pattern requires an unboxed tuple type, got '${typeToString(type)}'`,
      DiagnosticCode.TypeMismatch,
    );
    return;
  }

  if (pattern.elements.length !== elementTypes.length) {
    ctx.diagnostics.reportError(
      `Unboxed tuple pattern has ${pattern.elements.length} elements but type has ${elementTypes.length}`,
      DiagnosticCode.TypeMismatch,
    );
    return;
  }

  for (let i = 0; i < pattern.elements.length; i++) {
    checkPattern(ctx, pattern.elements[i], elementTypes[i], kind, declaration);
  }
}

/**
 * Extract element types from an unboxed tuple type or union of unboxed tuples.
 * For unions, returns the union of element types at each position.
 * Returns null if the type is not an unboxed tuple or union of unboxed tuples.
 *
 * Examples:
 * - `(i32, boolean)` -> [i32, boolean]
 * - `(true, i32) | (false, never)` -> [true | false, i32 | never]
 */
function getUnboxedTupleElementTypes(type: Type): Type[] | null {
  if (type.kind === TypeKind.UnboxedTuple) {
    return (type as UnboxedTupleType).elementTypes;
  }

  if (type.kind === TypeKind.Union) {
    const unionType = type as UnionType;
    const tuples: UnboxedTupleType[] = [];

    for (const t of unionType.types) {
      if (t.kind !== TypeKind.UnboxedTuple) {
        return null; // Union contains non-tuple type
      }
      tuples.push(t as UnboxedTupleType);
    }

    if (tuples.length === 0) {
      return null;
    }

    // All tuples must have the same arity
    const arity = tuples[0].elementTypes.length;
    for (const tuple of tuples) {
      if (tuple.elementTypes.length !== arity) {
        return null; // Mismatched arity
      }
    }

    // Compute union of element types at each position
    const elementTypes: Type[] = [];
    for (let i = 0; i < arity; i++) {
      const typesAtPosition = tuples.map((t) => t.elementTypes[i]);
      // Create a union of all types at this position
      // Simplify if all types are the same
      const uniqueTypes = deduplicateTypes(typesAtPosition);
      if (uniqueTypes.length === 1) {
        elementTypes.push(uniqueTypes[0]);
      } else {
        elementTypes.push({
          kind: TypeKind.Union,
          types: uniqueTypes,
        } as UnionType);
      }
    }

    return elementTypes;
  }

  return null;
}

/**
 * Deduplicate types by comparing with typeToString.
 * This is a simple deduplication that works for most cases.
 */
function deduplicateTypes(types: Type[]): Type[] {
  const seen = new Map<string, Type>();
  for (const t of types) {
    const key = typeToString(t);
    if (!seen.has(key)) {
      seen.set(key, t);
    }
  }
  return Array.from(seen.values());
}

function checkAssignmentPattern(
  ctx: CheckerContext,
  pattern: AssignmentPattern,
  type: Type,
  kind: 'let' | 'var',
  declaration?: VariableDeclaration,
) {
  // pattern.right is default value
  const defaultType = checkExpression(ctx, pattern.right);

  // Ensure default value is assignable to the expected type
  if (!isAssignableTo(ctx, defaultType, type)) {
    ctx.diagnostics.reportError(
      `Type mismatch: default value ${typeToString(defaultType)} is not assignable to ${typeToString(type)}`,
      DiagnosticCode.TypeMismatch,
    );
  }

  // Recurse with the expected type (or union?)
  // If we had optional types, the incoming 'type' might be T | null.
  // And default value handles the null case.
  // But Zena doesn't have optional properties yet in the way TS does.
  // So 'type' is the type of the value being destructured.
  // The default value is used if the value is undefined?
  // But we don't have undefined.
  // So defaults are currently useless unless we support nullable types and treat null as trigger?
  // Or maybe just for future proofing.
  // For now, just check the pattern against the type.

  checkPattern(ctx, pattern.left, type, kind, declaration);
}

function getPropertyType(
  ctx: CheckerContext,
  type: Type,
  name: string,
): Type | undefined {
  switch (type.kind) {
    case TypeKind.Record:
      return (type as RecordType).properties.get(name);
    case TypeKind.Class: {
      const classType = type as ClassType;
      // Check fields
      if (classType.fields.has(name)) return classType.fields.get(name);
      // Check methods? Destructuring methods?
      // Usually we destructure data.
      // Check super
      if (classType.superType) {
        return getPropertyType(ctx, classType.superType, name);
      }
      return undefined;
    }
    case TypeKind.Interface: {
      const ifaceType = type as InterfaceType;
      if (ifaceType.fields.has(name)) return ifaceType.fields.get(name);
      if (ifaceType.extends) {
        for (const base of ifaceType.extends) {
          const t = getPropertyType(ctx, base, name);
          if (t) return t;
        }
      }
      return undefined;
    }
    // TODO: Mixins, etc.
    default:
      return undefined;
  }
}

function resolveMemberName(
  ctx: CheckerContext,
  name: Identifier | SymbolPropertyName,
): {name: string; isSymbol: boolean; symbolType?: SymbolType} {
  if (name.type === NodeType.Identifier) {
    return {name: name.name, isSymbol: false};
  } else {
    // SymbolPropertyName - look up the symbol identifier
    const type = ctx.resolveValue(name.symbol.name);
    if (type && type.kind === TypeKind.Symbol) {
      const symbolType = type as SymbolType;
      // Set inferredType on the symbol identifier so codegen can access it
      name.symbol.inferredType = symbolType;
      // Use the SymbolType object for identity; debugName is for diagnostics
      return {
        name: symbolType.debugName ?? '<symbol>',
        isSymbol: true,
        symbolType,
      };
    }
    ctx.diagnostics.reportError(
      `Symbol '${name.symbol.name}' is not defined or is not a symbol.`,
      DiagnosticCode.TypeMismatch,
    );
    return {name: '<error>', isSymbol: false};
  }
}

function checkClassDeclaration(ctx: CheckerContext, decl: ClassDeclaration) {
  const className = decl.name.name;

  // Local classes (classes declared inside functions) are not supported
  if (ctx.currentFunctionReturnType !== null) {
    ctx.diagnostics.reportError(
      `Local class declarations are not supported. Class '${className}' must be declared at the top level.`,
      DiagnosticCode.UnsupportedFeature,
    );
    return;
  }

  // Create type parameters without constraints/defaults
  const typeParameters: TypeParameterType[] = [];
  if (decl.typeParameters) {
    for (const param of decl.typeParameters) {
      typeParameters.push({
        kind: TypeKind.TypeParameter,
        name: param.name,
      });
    }
  }

  // Temporarily enter a scope and declare type parameters so they're available
  // when resolving superclass type arguments (e.g., class Derived<T> extends Base<T>)
  // We'll exit this scope after resolving superclass/mixins and re-enter properly later.
  if (typeParameters.length > 0) {
    ctx.enterScope();
    for (const tp of typeParameters) {
      ctx.declare(tp.name, tp, 'type');
    }

    // Resolve constraints early so type parameters have them when checking superclass
    // This is needed for constraint compatibility checking (e.g., T extends Dog satisfies T extends Animal)
    if (decl.typeParameters) {
      for (let i = 0; i < decl.typeParameters.length; i++) {
        const param = decl.typeParameters[i];
        if (param.constraint) {
          typeParameters[i].constraint = resolveTypeAnnotation(
            ctx,
            param.constraint,
          );
        }
      }
    }
  }

  let superType: ClassType | undefined;
  if (decl.superClass) {
    const resolvedSuperType = resolveTypeAnnotation(ctx, decl.superClass);
    if (resolvedSuperType.kind === TypeKind.Unknown) {
      // Error already reported by resolveTypeAnnotation
    } else if (resolvedSuperType.kind !== TypeKind.Class) {
      ctx.diagnostics.reportError(
        `Superclass '${typeToString(resolvedSuperType)}' must be a class.`,
        DiagnosticCode.TypeMismatch,
      );
    } else {
      superType = resolvedSuperType as ClassType;
      if (superType.isFinal) {
        ctx.diagnostics.reportError(
          `Cannot extend final class '${superType.name}'.`,
          DiagnosticCode.TypeMismatch,
        );
      }
    }
  }

  // Apply Mixins
  if (decl.mixins) {
    for (const mixinAnnotation of decl.mixins) {
      const mixinType = resolveTypeAnnotation(ctx, mixinAnnotation);
      if (mixinType.kind === TypeKind.Unknown) {
        // Error already reported by resolveTypeAnnotation
        continue;
      }
      if (mixinType.kind !== TypeKind.Mixin) {
        ctx.diagnostics.reportError(
          `'${typeToString(mixinType)}' is not a mixin.`,
          DiagnosticCode.TypeMismatch,
        );
        continue;
      }

      const mixin = mixinType as MixinType;

      // Check 'on' constraint
      if (mixin.onType) {
        // If there is no superType, we assume it's Object (or empty struct), which likely fails unless onType is empty.
        // For now, if no superType, we can't satisfy a specific class constraint.
        if (!superType) {
          // TODO: Check if onType is compatible with empty object?
          // For now, error if onType is present but no super class.
          ctx.diagnostics.reportError(
            `Mixin '${mixin.name}' requires superclass to extend '${mixin.onType.name}', but no superclass is defined.`,
            DiagnosticCode.TypeMismatch,
          );
        } else if (!isAssignableTo(ctx, superType, mixin.onType)) {
          ctx.diagnostics.reportError(
            `Mixin '${mixin.name}' requires superclass to extend '${mixin.onType.name}'.`,
            DiagnosticCode.TypeMismatch,
          );
        }
      }

      // Create intermediate class type
      const baseName = superType ? superType.name : 'Object';
      const intermediateName = `${baseName}_${mixin.name}`;

      const intermediateType: ClassType = {
        kind: TypeKind.Class,
        _debugId: Math.floor(Math.random() * 1000000),
        name: intermediateName,
        superType: superType,
        implements: [], // TODO: Mixins might implement interfaces
        fields: new Map(),
        methods: new Map(),
        statics: new Map(),
        symbolFields: new Map(),
        symbolMethods: new Map(),
        vtable: superType ? [...superType.vtable] : [],
        isFinal: false, // Intermediate classes are not final
        isMixinIntermediate: true, // Mark as synthetic mixin intermediate
      };

      // Inherit from superType
      if (superType) {
        for (const [name, type] of superType.fields) {
          intermediateType.fields.set(name, type);
        }
        for (const [name, type] of superType.methods) {
          intermediateType.methods.set(name, type);
        }
      }

      // Add mixin members
      for (const [name, type] of mixin.fields) {
        if (intermediateType.fields.has(name)) {
          // Shadowing check?
          // If it shadows a base field, check compatibility
          const baseFieldType = intermediateType.fields.get(name)!;
          if (!isAssignableTo(ctx, type, baseFieldType)) {
            ctx.diagnostics.reportError(
              `Mixin '${mixin.name}' field '${name}' is incompatible with base class field.`,
              DiagnosticCode.TypeMismatch,
            );
          }
        }
        intermediateType.fields.set(name, type);
      }

      for (const [name, type] of mixin.methods) {
        if (intermediateType.methods.has(name)) {
          // Check override compatibility
          const baseMethod = intermediateType.methods.get(name)!;
          if (baseMethod.isFinal) {
            ctx.diagnostics.reportError(
              `Mixin '${mixin.name}' cannot override final method '${name}'.`,
              DiagnosticCode.TypeMismatch,
            );
          }
          // Check signature compatibility
          // 1. Return type must be assignable to base return type (covariant)
          if (!isAssignableTo(ctx, type.returnType, baseMethod.returnType)) {
            ctx.diagnostics.reportError(
              `Mixin '${mixin.name}' method '${name}' return type ${typeToString(type.returnType)} is not compatible with base method return type ${typeToString(baseMethod.returnType)}.`,
              DiagnosticCode.TypeMismatch,
            );
          }
          // 2. Parameter types must be assignable FROM base parameter types (contravariant)
          // But for now we enforce invariance or simple assignability check
          if (type.parameters.length !== baseMethod.parameters.length) {
            ctx.diagnostics.reportError(
              `Mixin '${mixin.name}' method '${name}' has different number of parameters than base method.`,
              DiagnosticCode.TypeMismatch,
            );
          } else {
            for (let i = 0; i < type.parameters.length; i++) {
              // Contravariance: base param must be assignable to override param
              if (
                !isAssignableTo(
                  ctx,
                  baseMethod.parameters[i],
                  type.parameters[i],
                )
              ) {
                ctx.diagnostics.reportError(
                  `Mixin '${mixin.name}' method '${name}' parameter ${i} type is incompatible with base method.`,
                  DiagnosticCode.TypeMismatch,
                );
              }
            }
          }
        } else {
          intermediateType.vtable.push(name);
        }
        intermediateType.methods.set(name, type);
      }

      // Update superType to point to this new intermediate type
      superType = intermediateType;
    }
  }

  // Exit the temporary scope we created for type parameter resolution
  if (typeParameters.length > 0) {
    ctx.exitScope();
  }

  // Get the pre-declared class type (from the first pass)
  // The type was already declared and stored in decl.inferredType
  // If not pre-declared (e.g., imported types or special cases), create the type now
  let classType = decl.inferredType as ClassType | undefined;
  if (!classType) {
    classType = {
      kind: TypeKind.Class,
      _debugId: Math.floor(Math.random() * 1000000),
      name: className,
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      superType: undefined,
      implements: [],
      fields: new Map(),
      methods: new Map(),
      statics: new Map(),
      symbolFields: new Map(),
      symbolMethods: new Map(),
      constructorType: undefined,
      vtable: [],
      isFinal: decl.isFinal,
      isAbstract: decl.isAbstract,
      isExtension: decl.isExtension,
      onType: undefined,
    };
    ctx.declare(className, classType, 'type');
    ctx.declare(className, classType, 'let');
    decl.inferredType = classType;

    if (decl.exported && ctx.module) {
      ctx.module!.exports!.set(`type:${className}`, {
        type: classType,
        kind: 'type',
        declaration: decl,
      });
      ctx.module!.exports!.set(`value:${className}`, {
        type: classType,
        kind: 'let',
        declaration: decl,
      });
    }
  }

  // Update the type parameters (with resolved constraints)
  if (typeParameters.length > 0) {
    classType.typeParameters = typeParameters;
  }

  // Update superType and inherited members
  classType.superType = superType;
  classType.vtable = superType ? [...superType.vtable] : [];

  if (superType) {
    // Inherit fields
    for (const [name, type] of superType.fields) {
      if (!name.startsWith('#')) {
        classType.fields.set(name, type);
      }
    }
    // Inherit methods
    for (const [name, type] of superType.methods) {
      if (!name.startsWith('#')) {
        classType.methods.set(name, type);
      }
    }
  }

  if (decl.exported && ctx.module) {
    ctx.module!.exports!.set(`type:${className}`, {
      type: classType,
      kind: 'type',
      declaration: decl,
    });
    ctx.module!.exports!.set(`value:${className}`, {
      type: classType,
      kind: 'let',
      declaration: decl,
    });
  }

  ctx.enterClass(classType);

  // Enter the class body scope and declare type parameters
  ctx.enterScope();
  for (const tp of typeParameters) {
    ctx.declare(tp.name, tp, 'type');
  }

  // Resolve constraints and defaults (type params now in scope)
  if (decl.typeParameters) {
    for (let i = 0; i < decl.typeParameters.length; i++) {
      const param = decl.typeParameters[i];
      if (param.constraint) {
        typeParameters[i].constraint = resolveTypeAnnotation(
          ctx,
          param.constraint,
        );
      }
      if (param.default) {
        typeParameters[i].defaultType = resolveTypeAnnotation(
          ctx,
          param.default,
        );
      }
    }
  }

  if (decl.isExtension && decl.onType) {
    classType.onType = resolveTypeAnnotation(ctx, decl.onType);
    // Also update ctx.currentClass.onType since enterClass may have created
    // a copy with typeArguments added, and it needs onType for 'this' resolution.
    if (ctx.currentClass && ctx.currentClass !== classType) {
      ctx.currentClass.onType = classType.onType;
    }
  }

  // 1. First pass: Collect members to build the ClassType
  const localFields = new Set<string>();
  const localMethods = new Set<string>();

  for (const member of decl.body) {
    if (member.type === NodeType.FieldDefinition) {
      if (decl.isExtension && !member.isStatic && !member.isDeclare) {
        ctx.diagnostics.reportError(
          `Extension classes cannot have instance fields.`,
          DiagnosticCode.ExtensionClassField,
        );
        continue;
      }

      // Check for static symbol declaration
      if (
        member.isStatic &&
        member.typeAnnotation.type === NodeType.TypeAnnotation &&
        member.typeAnnotation.name === 'symbol' &&
        member.name.type === NodeType.Identifier
      ) {
        const symbolName = member.name.name;
        // Use module-qualified name for debug name
        const modulePath = ctx.module?.path ?? '<anonymous>';
        const debugName = `${modulePath}:${className}.${symbolName}`;
        const symbolType: SymbolType = {
          kind: TypeKind.Symbol,
          debugName,
          id: ctx.nextSymbolId(),
        };
        classType.statics.set(symbolName, symbolType);
        continue;
      }

      const memberNameInfo = resolveMemberName(ctx, member.name);
      const fieldType = resolveTypeAnnotation(ctx, member.typeAnnotation);

      // Unboxed tuples cannot appear in field types
      validateNoUnboxedTuple(fieldType, ctx, 'field types');

      if (memberNameInfo.isSymbol) {
        classType.symbolFields!.set(memberNameInfo.symbolType!, fieldType);
        continue;
      }

      const memberName = memberNameInfo.name;

      if (localFields.has(memberName)) {
        ctx.diagnostics.reportError(
          `Duplicate field '${memberName}' in class '${className}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
        continue;
      }
      localFields.add(memberName);

      // Check if it's a redeclaration of an inherited field
      if (classType.fields.has(memberName)) {
        if (superType && superType.fields.has(memberName)) {
          // Allow shadowing/overriding of fields
          // Check type compatibility
          const superFieldType = superType.fields.get(memberName)!;
          // If mutable, types should be invariant (identical). If immutable, covariant.
          // For now, we enforce covariance (fieldType extends superFieldType).
          if (!isAssignableTo(ctx, fieldType, superFieldType)) {
            ctx.diagnostics.reportError(
              `Field '${memberName}' in subclass '${className}' must be compatible with inherited field.`,
              DiagnosticCode.TypeMismatch,
            );
          }
        } else {
          // Should not happen if localFields check passed, unless classType.fields has it but superType doesn't?
          // This could happen if we have mixins or other mechanisms populating fields.
          // But for now, if it's in classType.fields but not localFields, it must be inherited.
        }
      }

      if (classType.methods.has(memberName)) {
        // Check if it conflicts with a method
        // If the method is inherited, it's a conflict (field shadowing method?)
        // In many languages, field cannot shadow method.
        // If it's a local method, we'll catch it when processing the method (or here if method came first).

        // If method came first locally:
        if (localMethods.has(memberName)) {
          ctx.diagnostics.reportError(
            `Field '${memberName}' conflicts with method '${memberName}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        } else {
          // Inherited method
          ctx.diagnostics.reportError(
            `Field '${memberName}' conflicts with inherited method '${memberName}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        }
      }

      classType.fields.set(memberName, fieldType);

      // Register implicit accessors for public fields
      if (!memberName.startsWith('#')) {
        const getterName = getGetterName(memberName);
        const setterName = getSetterName(memberName);

        // Getter
        classType.vtable.push(getterName);
        classType.methods.set(getterName, {
          kind: TypeKind.Function,
          parameters: [],
          returnType: fieldType,
          isFinal: false,
        });

        // Setter (if mutable)
        if (!member.isFinal) {
          classType.vtable.push(setterName);
          classType.methods.set(setterName, {
            kind: TypeKind.Function,
            parameters: [fieldType],
            returnType: Types.Void,
            isFinal: false,
          });
        }
      }
    } else if (member.type === NodeType.AccessorDeclaration) {
      const memberNameInfo = resolveMemberName(ctx, member.name);
      const fieldType = resolveTypeAnnotation(ctx, member.typeAnnotation);

      // Unboxed tuples cannot appear in accessor types
      validateNoUnboxedTuple(fieldType, ctx, 'accessor types');

      if (memberNameInfo.isSymbol) {
        classType.symbolFields!.set(memberNameInfo.symbolType!, fieldType);
        if (member.getter) {
          classType.symbolMethods!.set(memberNameInfo.symbolType!, {
            kind: TypeKind.Function,
            parameters: [],
            returnType: fieldType,
            isFinal: member.isFinal,
          });
        }
        continue;
      }

      const memberName = memberNameInfo.name;

      if (localFields.has(memberName)) {
        ctx.diagnostics.reportError(
          `Duplicate field '${memberName}' in class '${className}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
      }
      // Accessors are not fields, but they conflict with fields
      // classType.fields.set(memberName, fieldType);

      // Register getter/setter methods
      if (member.getter) {
        const getterName = getGetterName(memberName);
        const methodType: FunctionType = {
          kind: TypeKind.Function,
          parameters: [],
          returnType: fieldType,
          isFinal: member.isFinal,
        };

        if (!classType.methods.has(getterName)) {
          classType.vtable.push(getterName);
        }

        if (classType.methods.has(getterName)) {
          if (superType && superType.methods.has(getterName)) {
            const superMethod = superType.methods.get(getterName)!;
            if (superMethod.isFinal) {
              ctx.diagnostics.reportError(
                `Cannot override final method '${getterName}'.`,
                DiagnosticCode.TypeMismatch,
              );
            }
          }
        }
        classType.methods.set(getterName, methodType);
      }

      if (member.setter) {
        const setterName = getSetterName(memberName);
        const methodType: FunctionType = {
          kind: TypeKind.Function,
          parameters: [fieldType],
          returnType: Types.Void,
          isFinal: member.isFinal,
        };

        if (!classType.methods.has(setterName)) {
          classType.vtable.push(setterName);
        }

        if (classType.methods.has(setterName)) {
          if (superType && superType.methods.has(setterName)) {
            const superMethod = superType.methods.get(setterName)!;
            if (superMethod.isFinal) {
              ctx.diagnostics.reportError(
                `Cannot override final method '${setterName}'.`,
                DiagnosticCode.TypeMismatch,
              );
            }
          }
        }
        classType.methods.set(setterName, methodType);
      }
    } else if (member.type === NodeType.MethodDefinition) {
      ctx.enterScope();
      const typeParameters = createTypeParameters(ctx, member.typeParameters);

      const paramTypes = member.params.map((p) => resolveParameterType(ctx, p));
      const parameterNames = member.params.map((p) => p.name.name);
      const optionalParameters = member.params.map((p) => p.optional);
      const parameterInitializers = member.params.map((p) => p.initializer);

      const returnType = member.returnType
        ? resolveTypeAnnotation(ctx, member.returnType)
        : Types.Void;

      ctx.exitScope();

      const methodType: FunctionType = {
        kind: TypeKind.Function,
        typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
        parameters: paramTypes,
        parameterNames,
        returnType,
        isFinal: member.isFinal,
        isAbstract: member.isAbstract,
        optionalParameters,
        parameterInitializers,
      };

      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (memberNameInfo.isSymbol) {
        classType.symbolMethods!.set(memberNameInfo.symbolType!, methodType);
        continue;
      }
      const memberName = memberNameInfo.name;

      if (member.isAbstract && !decl.isAbstract) {
        ctx.diagnostics.reportError(
          `Abstract method '${memberName}' can only appear within an abstract class.`,
          DiagnosticCode.AbstractMethodInConcreteClass,
        );
      }

      if (member.isDeclare) {
        const hasIntrinsic = member.decorators?.some(
          (d) => d.name === Decorators.Intrinsic,
        );
        if (!hasIntrinsic) {
          ctx.diagnostics.reportError(
            `Declared method '${memberName}' must be decorated with @intrinsic.`,
            DiagnosticCode.MissingDecorator,
          );
        }

        if (member.body) {
          ctx.diagnostics.reportError(
            `Declared method '${memberName}' cannot have a body.`,
            DiagnosticCode.UnexpectedBody,
          );
        }
      }

      if (memberName === '#new') {
        if (classType.constructorType) {
          ctx.diagnostics.reportError(
            `Duplicate constructor in class '${className}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        }
        classType.constructorType = methodType;
      } else {
        if (classType.fields.has(memberName)) {
          if (localFields.has(memberName)) {
            ctx.diagnostics.reportError(
              `Method '${memberName}' conflicts with field '${memberName}'.`,
              DiagnosticCode.DuplicateDeclaration,
            );
          } else {
            // Inherited field
            ctx.diagnostics.reportError(
              `Method '${memberName}' conflicts with inherited field '${memberName}'.`,
              DiagnosticCode.DuplicateDeclaration,
            );
          }
        }

        // Check for method overloading or duplicate
        if (localMethods.has(memberName)) {
          // Method with same name exists locally - check if it's a valid overload
          const existingMethod = classType.methods.get(memberName)!;
          if (hasSameSignature(existingMethod, methodType)) {
            ctx.diagnostics.reportError(
              `Duplicate method '${memberName}' in class '${className}'.`,
              DiagnosticCode.DuplicateDeclaration,
            );
          } else {
            // Valid overload - add to the existing method's overloads array
            if (!existingMethod.overloads) {
              existingMethod.overloads = [];
            }
            existingMethod.overloads.push(methodType);
          }
        } else {
          localMethods.add(memberName);

          if (
            !memberName.startsWith('#') &&
            !classType.methods.has(memberName)
          ) {
            classType.vtable.push(memberName);
          }

          if (classType.methods.has(memberName)) {
            // Check for override from superclass
            if (superType && superType.methods.has(memberName)) {
              // Find which overload (if any) this matches
              const superMethod = superType.methods.get(memberName)!;
              const matchingSuper = findMatchingOverload(
                superMethod,
                methodType,
              );

              if (matchingSuper) {
                if (matchingSuper.isFinal) {
                  ctx.diagnostics.reportError(
                    `Cannot override final method '${memberName}'.`,
                    DiagnosticCode.TypeMismatch,
                  );
                }
                // TODO: Check signature compatibility (covariant return, contravariant params)

                // When overriding one overload, we need to preserve the other overloads from super
                // The overriding method becomes the main method, and other overloads are copied
                const newOverloads: FunctionType[] = [];

                // Check if super's main method is NOT the one being overridden
                if (!hasSameSignature(superMethod, methodType)) {
                  // Keep super's main method as an overload
                  newOverloads.push(superMethod);
                }

                // Copy any other overloads from super that aren't being overridden
                if (superMethod.overloads) {
                  for (const overload of superMethod.overloads) {
                    if (!hasSameSignature(overload, methodType)) {
                      newOverloads.push(overload);
                    }
                  }
                }

                // Set the overriding method as the main method with inherited overloads
                if (newOverloads.length > 0) {
                  methodType.overloads = newOverloads;
                }
              } else {
                // No matching overload in super - this is a new overload, add to inherited method
                const inheritedMethod = classType.methods.get(memberName)!;
                if (!inheritedMethod.overloads) {
                  inheritedMethod.overloads = [];
                }
                inheritedMethod.overloads.push(methodType);
                // Don't set the main method, it's already the inherited one
                continue;
              }
            }
          }
          classType.methods.set(memberName, methodType);
        }
      }
    }
  }

  // Check interface implementation
  if (decl.implements) {
    for (const impl of decl.implements) {
      const type = resolveTypeAnnotation(ctx, impl);
      if (type.kind !== TypeKind.Interface) {
        const name =
          impl.type === NodeType.TypeAnnotation ? impl.name : '<union>';
        ctx.diagnostics.reportError(
          `Type '${name}' is not an interface.`,
          DiagnosticCode.TypeMismatch,
        );
        continue;
      }
      const interfaceType = type as InterfaceType;
      classType.implements.push(interfaceType);

      // Create a type map to substitute `this` with the implementing class.
      // Use ctx.currentClass which has typeArguments set to typeParameters for generics.
      const thisTypeMap = new Map<string, Type>();
      thisTypeMap.set('$this', ctx.currentClass!);

      // Check methods
      for (const [name, type] of interfaceType.methods) {
        if (!classType.methods.has(name)) {
          let errorMsg = `Method '${name}' is missing.`;
          if (isGetterName(name)) {
            errorMsg = `Getter for '${getPropertyNameFromAccessor(name)}' is missing.`;
          } else if (isSetterName(name)) {
            errorMsg = `Setter for '${getPropertyNameFromAccessor(name)}' is missing.`;
          }

          ctx.diagnostics.reportError(
            `Class '${className}' incorrectly implements interface '${interfaceType.name}'. ${errorMsg}`,
            DiagnosticCode.PropertyNotFound,
          );
        } else {
          const methodType = classType.methods.get(name)!;
          // Substitute `this` type in the interface method with the implementing class
          const substitutedType = substituteType(type, thisTypeMap, ctx);
          if (!isAssignableTo(ctx, methodType, substitutedType)) {
            let memberName = `Method '${name}'`;
            if (isGetterName(name)) {
              memberName = `Getter for '${getPropertyNameFromAccessor(name)}'`;
            } else if (isSetterName(name)) {
              memberName = `Setter for '${getPropertyNameFromAccessor(name)}'`;
            }

            ctx.diagnostics.reportError(
              `Class '${className}' incorrectly implements interface '${interfaceType.name}'. ${memberName} is type '${typeToString(methodType)}' but expected '${typeToString(substitutedType)}'.`,
              DiagnosticCode.TypeMismatch,
            );
          }
        }
      }
    }
  }

  // Check abstract methods implementation
  if (!decl.isAbstract) {
    for (const [name, method] of classType.methods) {
      if (method.isAbstract) {
        ctx.diagnostics.reportError(
          `Non-abstract class '${className}' does not implement abstract method '${name}'.`,
          DiagnosticCode.AbstractMethodNotImplemented,
        );
      }
    }
  }

  // 2. Second pass: Check bodies
  // Initialize tracking for field initialization order
  const previousInitializedFields = new Set(ctx.initializedFields);
  ctx.initializedFields.clear();
  if (superType) {
    for (const [name] of superType.fields) {
      ctx.initializedFields.add(name);
    }
  }

  for (const member of decl.body) {
    if (member.type === NodeType.MethodDefinition) {
      checkMethodDefinition(ctx, member);
    } else if (member.type === NodeType.FieldDefinition) {
      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (memberNameInfo.isSymbol) {
        // TODO: Check symbol field initializer
        continue;
      }
      const memberName = memberNameInfo.name;

      if (member.value) {
        ctx.isCheckingFieldInitializer = true;
        const valueType = checkExpression(ctx, member.value);
        ctx.isCheckingFieldInitializer = false;

        const fieldType = classType.fields.get(memberName)!;
        if (
          valueType.kind !== fieldType.kind &&
          valueType.kind !== Types.Unknown.kind
        ) {
          if (typeToString(valueType) !== typeToString(fieldType)) {
            ctx.diagnostics.reportError(
              `Type mismatch for field '${memberName}': expected ${typeToString(fieldType)}, got ${typeToString(valueType)}`,
              DiagnosticCode.TypeMismatch,
            );
          }
        }
      }
      ctx.initializedFields.add(memberName);
    } else if (member.type === NodeType.AccessorDeclaration) {
      checkAccessorDeclaration(ctx, member);
      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (!memberNameInfo.isSymbol) {
        ctx.initializedFields.add(memberNameInfo.name);
      }
    }
  }

  // Restore previous state
  ctx.initializedFields = previousInitializedFields;

  ctx.exitClass();
  ctx.exitScope();
}

function checkInterfaceDeclaration(
  ctx: CheckerContext,
  decl: InterfaceDeclaration,
) {
  const interfaceName = decl.name.name;

  const typeParameters: TypeParameterType[] = [];
  if (decl.typeParameters) {
    for (const param of decl.typeParameters) {
      typeParameters.push({
        kind: TypeKind.TypeParameter,
        name: param.name,
      });
    }
  }

  // Get the pre-declared interface type (from the first pass), or create it if not present
  let interfaceType = decl.inferredType as InterfaceType | undefined;
  if (!interfaceType) {
    // Fallback: create a new interface type if predeclaration was skipped (e.g., shadowing)
    interfaceType = {
      kind: TypeKind.Interface,
      name: interfaceName,
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      extends: [],
      fields: new Map(),
      methods: new Map(),
    };
    ctx.declare(interfaceName, interfaceType, 'type');
    decl.inferredType = interfaceType;
  } else {
    // Update the type parameters
    if (typeParameters.length > 0) {
      interfaceType.typeParameters = typeParameters;
    }
  }

  // Enter scope for type parameters
  ctx.enterScope();
  ctx.enterInterface(interfaceType);
  if (interfaceType.typeParameters) {
    for (const param of interfaceType.typeParameters) {
      ctx.declare(param.name, param, 'type');
    }
  }

  // Resolve constraints and defaults (after all type params are in scope)
  if (decl.typeParameters) {
    for (let i = 0; i < decl.typeParameters.length; i++) {
      const param = decl.typeParameters[i];
      if (param.constraint) {
        typeParameters[i].constraint = resolveTypeAnnotation(
          ctx,
          param.constraint,
        );
      }
      if (param.default) {
        typeParameters[i].defaultType = resolveTypeAnnotation(
          ctx,
          param.default,
        );
      }
    }
  }

  // Handle extends
  if (decl.extends) {
    for (const ext of decl.extends) {
      const type = resolveTypeAnnotation(ctx, ext);
      if (type.kind !== TypeKind.Interface) {
        ctx.diagnostics.reportError(
          `Interface '${interfaceName}' can only extend other interfaces.`,
          DiagnosticCode.TypeMismatch,
        );
      } else {
        const parentInterface = type as InterfaceType;
        interfaceType.extends!.push(parentInterface);

        // Copy members from parent
        for (const [name, fieldType] of parentInterface.fields) {
          interfaceType.fields.set(name, fieldType);
        }
        for (const [name, methodType] of parentInterface.methods) {
          interfaceType.methods.set(name, methodType);
        }
      }
    }
  }

  for (const member of decl.body) {
    if (member.type === NodeType.MethodSignature) {
      ctx.enterScope();
      const typeParameters = createTypeParameters(ctx, member.typeParameters);

      const paramTypes: Type[] = [];
      const parameterNames: string[] = [];
      const optionalParameters: boolean[] = [];
      const parameterInitializers: any[] = [];

      for (const param of member.params) {
        const type = resolveParameterType(ctx, param);
        paramTypes.push(type);
        parameterNames.push(param.name.name);
        optionalParameters.push(param.optional);
        parameterInitializers.push(param.initializer);
      }

      let returnType: Type = Types.Void;
      if (member.returnType) {
        returnType = resolveTypeAnnotation(ctx, member.returnType);
      }

      ctx.exitScope();

      const methodType: FunctionType = {
        kind: TypeKind.Function,
        typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
        parameters: paramTypes,
        parameterNames,
        returnType,
        optionalParameters,
        parameterInitializers,
      };

      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (memberNameInfo.isSymbol) {
        interfaceType.symbolMethods!.set(
          memberNameInfo.symbolType!,
          methodType,
        );
        continue;
      }
      const memberName = memberNameInfo.name;

      if (interfaceType.methods.has(memberName)) {
        ctx.diagnostics.reportError(
          `Duplicate method '${memberName}' in interface '${interfaceName}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
      } else {
        interfaceType.methods.set(memberName, methodType);
      }
    } else if (member.type === NodeType.FieldDefinition) {
      const type = resolveTypeAnnotation(ctx, member.typeAnnotation);

      // Unboxed tuples cannot appear in interface field types
      validateNoUnboxedTuple(type, ctx, 'field types');

      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (memberNameInfo.isSymbol) {
        interfaceType.symbolFields!.set(memberNameInfo.symbolType!, type);
        continue;
      }
      const memberName = memberNameInfo.name;

      if (interfaceType.fields.has(memberName)) {
        ctx.diagnostics.reportError(
          `Duplicate field '${memberName}' in interface '${interfaceName}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
      } else {
        interfaceType.fields.set(memberName, type);

        // Implicit accessors
        const getterName = getGetterName(memberName);
        const setterName = getSetterName(memberName);

        interfaceType.methods.set(getterName, {
          kind: TypeKind.Function,
          parameters: [],
          returnType: type,
          isFinal: false,
        });

        interfaceType.methods.set(setterName, {
          kind: TypeKind.Function,
          parameters: [type],
          returnType: Types.Void,
          isFinal: false,
        });
      }
    } else if (member.type === NodeType.AccessorSignature) {
      const type = resolveTypeAnnotation(ctx, member.typeAnnotation);

      // Unboxed tuples cannot appear in accessor types
      validateNoUnboxedTuple(type, ctx, 'accessor types');

      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (memberNameInfo.isSymbol) {
        interfaceType.symbolFields!.set(memberNameInfo.symbolType!, type);
        continue;
      }
      const memberName = memberNameInfo.name;

      if (interfaceType.fields.has(memberName)) {
        ctx.diagnostics.reportError(
          `Duplicate field '${memberName}' in interface '${interfaceName}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
      } else {
        interfaceType.fields.set(memberName, type);
      }

      if (member.hasGetter) {
        const getterName = getGetterName(memberName);
        interfaceType.methods.set(getterName, {
          kind: TypeKind.Function,
          parameters: [],
          returnType: type,
          isFinal: false,
        });
      }

      if (member.hasSetter) {
        const setterName = getSetterName(memberName);
        interfaceType.methods.set(setterName, {
          kind: TypeKind.Function,
          parameters: [type],
          returnType: Types.Void,
          isFinal: false,
        });
      }
    }
  }

  ctx.exitInterface();
  ctx.exitScope();
}

function checkMethodDefinition(ctx: CheckerContext, method: MethodDefinition) {
  if (method.decorators) {
    for (const decorator of method.decorators) {
      if (decorator.name === Decorators.Intrinsic) {
        if (ctx.module && !ctx.module.isStdlib) {
          ctx.diagnostics.reportError(
            '@intrinsic is only allowed in zena: modules.',
            DiagnosticCode.DecoratorNotAllowed,
          );
        }

        if (decorator.args.length !== 1) {
          ctx.diagnostics.reportError(
            '@intrinsic requires exactly one argument (the intrinsic name).',
            DiagnosticCode.ArgumentCountMismatch,
          );
        } else {
          const name = decorator.args[0].value;
          const validIntrinsics = new Set([
            // Array intrinsics
            'array.len',
            'array.get',
            'array.get_u',
            'array.set',
            'array.new',
            'array.new_default',
            'array.new_fixed',
            'array.new_data',
            'array.copy',
            'array.fill',
            'array.init_data',
            'array.init_elem',
            // Memory intrinsics
            'memory.size',
            'memory.grow',
            // Load/store intrinsics
            'i32.load',
            'i32.load8_u',
            'i32.load8_s',
            'i32.store',
            'i32.store8',
            'i64.load',
            'i64.store',
            'f32.load',
            'f32.store',
            'f64.load',
            'f64.store',
          ]);
          if (!validIntrinsics.has(name)) {
            ctx.diagnostics.reportError(
              `Unknown intrinsic '${name}'.`,
              DiagnosticCode.UnknownIntrinsic,
            );
          }
        }
      } else {
        ctx.diagnostics.reportError(
          `Unknown decorator '@${decorator.name}'.`,
          DiagnosticCode.DecoratorNotAllowed,
        );
      }
    }
  }

  const memberNameInfo = resolveMemberName(ctx, method.name);
  const methodName = memberNameInfo.isSymbol
    ? (memberNameInfo.symbolType!.debugName ?? '<symbol>')
    : memberNameInfo.name;

  const previousMethod = ctx.currentMethod;
  ctx.currentMethod = methodName;

  // Helper to check if the superType chain requires super() to be called.
  // If the superType is only mixin intermediate classes (no user-defined base), super() is not required.
  const requiresSuperCall = (): boolean => {
    if (!ctx.currentClass?.superType) return false;
    let current: ClassType | undefined = ctx.currentClass.superType;
    while (current) {
      // If we find a non-mixin-intermediate class, super() is required
      if (!current.isMixinIntermediate) return true;
      current = current.superType;
    }
    return false;
  };

  const previousIsThisInitialized = ctx.isThisInitialized;
  if (methodName === '#new' && requiresSuperCall()) {
    ctx.isThisInitialized = false;
  } else {
    ctx.isThisInitialized = true;
  }

  ctx.enterScope();

  if (method.typeParameters) {
    for (const param of method.typeParameters) {
      const tp: TypeParameterType = {
        kind: TypeKind.TypeParameter,
        name: param.name,
      };
      ctx.declare(param.name, tp, 'type');
    }
  }

  // Declare parameters
  for (const param of method.params) {
    const type = resolveParameterType(ctx, param);
    ctx.declare(param.name.name, type, 'let', param);

    if (param.initializer) {
      const initType = checkExpression(ctx, param.initializer);
      if (!isAssignableTo(ctx, initType, type)) {
        ctx.diagnostics.reportError(
          `Type mismatch: default value ${typeToString(initType)} is not assignable to ${typeToString(type)}`,
          DiagnosticCode.TypeMismatch,
        );
      }
    }
  }

  const returnType = method.returnType
    ? resolveTypeAnnotation(ctx, method.returnType)
    : Types.Void;
  const previousReturnType = ctx.currentFunctionReturnType;
  ctx.currentFunctionReturnType = returnType;

  // Check body
  if (method.body) {
    checkStatement(ctx, method.body);
  }

  if (
    methodName === '#new' &&
    (requiresSuperCall() || ctx.currentClass?.isExtension) &&
    !ctx.isThisInitialized
  ) {
    ctx.diagnostics.reportError(
      `Constructors in derived classes and extensions must call 'super()'.`,
      DiagnosticCode.UnknownError,
    );
  }

  ctx.currentFunctionReturnType = previousReturnType;
  ctx.exitScope();
  ctx.currentMethod = previousMethod;
  ctx.isThisInitialized = previousIsThisInitialized;
}

function checkAccessorDeclaration(
  ctx: CheckerContext,
  decl: AccessorDeclaration,
) {
  const propertyType = resolveTypeAnnotation(ctx, decl.typeAnnotation);

  // Check getter
  if (decl.getter) {
    ctx.enterScope();
    const previousReturnType = ctx.currentFunctionReturnType;
    ctx.currentFunctionReturnType = propertyType;

    for (const stmt of decl.getter.body) {
      checkStatement(ctx, stmt);
    }

    ctx.currentFunctionReturnType = previousReturnType;
    ctx.exitScope();
  }

  // Check setter
  if (decl.setter) {
    ctx.enterScope();
    const previousReturnType = ctx.currentFunctionReturnType;
    ctx.currentFunctionReturnType = Types.Void;

    // Declare parameter (pass the Identifier node as the declaration)
    ctx.declare(decl.setter.param.name, propertyType, 'let', decl.setter.param);

    for (const stmt of decl.setter.body.body) {
      checkStatement(ctx, stmt);
    }

    ctx.currentFunctionReturnType = previousReturnType;
    ctx.exitScope();
  }
}

function checkMixinDeclaration(ctx: CheckerContext, decl: MixinDeclaration) {
  const mixinName = decl.name.name;

  const typeParameters: TypeParameterType[] = [];
  if (decl.typeParameters) {
    for (const param of decl.typeParameters) {
      typeParameters.push({
        kind: TypeKind.TypeParameter,
        name: param.name,
      });
    }
  }

  let onType: ClassType | undefined;
  if (decl.on) {
    const type = ctx.resolveType(decl.on.name);
    if (!type) {
      ctx.diagnostics.reportError(
        `Unknown type '${decl.on.name}' in 'on' clause.`,
        DiagnosticCode.SymbolNotFound,
      );
    } else if (type.kind !== TypeKind.Class) {
      ctx.diagnostics.reportError(
        `Mixin 'on' type must be a class.`,
        DiagnosticCode.TypeMismatch,
      );
    } else {
      onType = type as ClassType;
    }
  }

  // Get the pre-declared mixin type (from the first pass), or create it if not present
  let mixinType = decl.inferredType as MixinType | undefined;
  if (!mixinType) {
    // Fallback: create a new mixin type if predeclaration was skipped (e.g., shadowing)
    mixinType = {
      kind: TypeKind.Mixin,
      name: mixinName,
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      onType,
      fields: new Map(),
      methods: new Map(),
    };
    ctx.declare(mixinName, mixinType, 'type');
    decl.inferredType = mixinType;
  } else {
    // Update the type parameters and onType
    if (typeParameters.length > 0) {
      mixinType.typeParameters = typeParameters;
    }
    mixinType.onType = onType;
  }

  ctx.enterScope();
  for (const tp of typeParameters) {
    ctx.declare(tp.name, tp, 'type');
  }

  // Resolve constraints and defaults (after all type params are in scope)
  if (decl.typeParameters) {
    for (let i = 0; i < decl.typeParameters.length; i++) {
      const param = decl.typeParameters[i];
      if (param.constraint) {
        typeParameters[i].constraint = resolveTypeAnnotation(
          ctx,
          param.constraint,
        );
      }
      if (param.default) {
        typeParameters[i].defaultType = resolveTypeAnnotation(
          ctx,
          param.default,
        );
      }
    }
  }

  // Apply composed mixins
  if (decl.mixins) {
    for (const mixinAnnotation of decl.mixins) {
      const composedMixinType = resolveTypeAnnotation(ctx, mixinAnnotation);
      if (composedMixinType.kind === TypeKind.Unknown) {
        continue;
      }
      if (composedMixinType.kind !== TypeKind.Mixin) {
        ctx.diagnostics.reportError(
          `'${typeToString(composedMixinType)}' is not a mixin.`,
          DiagnosticCode.TypeMismatch,
        );
        continue;
      }

      const composedMixin = composedMixinType as MixinType;

      // Check 'on' compatibility
      if (composedMixin.onType) {
        if (!onType) {
          ctx.diagnostics.reportError(
            `Mixin '${mixinName}' composes '${composedMixin.name}' which requires 'on ${composedMixin.onType.name}', but '${mixinName}' has no 'on' clause.`,
            DiagnosticCode.TypeMismatch,
          );
        } else if (!isAssignableTo(ctx, onType, composedMixin.onType)) {
          ctx.diagnostics.reportError(
            `Mixin '${mixinName}' on '${onType.name}' is not compatible with composed mixin '${composedMixin.name}' on '${composedMixin.onType.name}'.`,
            DiagnosticCode.TypeMismatch,
          );
        }
      }

      // Copy members
      for (const [name, type] of composedMixin.fields) {
        if (mixinType.fields.has(name)) {
          // Shadowing check?
        }
        mixinType.fields.set(name, type);
      }
      for (const [name, type] of composedMixin.methods) {
        mixinType.methods.set(name, type);
      }
    }
  }

  // If 'on' type is present, we should probably add its members to the scope so 'super' or 'this' works?
  // But 'this' in a mixin is polymorphic.
  // For checking purposes, we can treat 'this' as 'onType' (plus the mixin's own members).
  // However, we don't have a full class type for 'this' yet.
  // We can handle this by adding 'onType' members to the scope or handling 'this' resolution specially.
  // For now, let's just process members.

  // 1. Collect members
  for (const member of decl.body) {
    if (
      member.type === NodeType.MethodDefinition &&
      member.name.type === NodeType.Identifier &&
      member.name.name === '#new'
    ) {
      ctx.diagnostics.reportError(
        `Mixins cannot define constructors.`,
        DiagnosticCode.ConstructorInMixin,
      );
      continue;
    }

    if (member.type === NodeType.FieldDefinition) {
      const fieldType = resolveTypeAnnotation(ctx, member.typeAnnotation);

      // Unboxed tuples cannot appear in mixin field types
      validateNoUnboxedTuple(fieldType, ctx, 'field types');

      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (memberNameInfo.isSymbol) {
        mixinType.symbolFields!.set(memberNameInfo.symbolType!, fieldType);
        continue;
      }
      const memberName = memberNameInfo.name;

      if (mixinType.fields.has(memberName)) {
        ctx.diagnostics.reportError(
          `Duplicate field '${memberName}' in mixin '${mixinName}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
      }
      mixinType.fields.set(memberName, fieldType);

      // Implicit accessors
      if (!memberName.startsWith('#')) {
        const getterName = getGetterName(memberName);
        const setterName = getSetterName(memberName);

        mixinType.methods.set(getterName, {
          kind: TypeKind.Function,
          parameters: [],
          returnType: fieldType,
          isFinal: false,
        });

        if (!member.isFinal) {
          mixinType.methods.set(setterName, {
            kind: TypeKind.Function,
            parameters: [fieldType],
            parameterNames: ['value'],
            returnType: Types.Void,
            isFinal: false,
          });
        }
      }
    } else if (member.type === NodeType.MethodDefinition) {
      ctx.enterScope();
      const typeParameters = createTypeParameters(ctx, member.typeParameters);

      const paramTypes: Type[] = [];
      const parameterNames: string[] = [];
      const optionalParameters: boolean[] = [];
      const parameterInitializers: any[] = [];

      for (const param of member.params) {
        const type = resolveParameterType(ctx, param);
        paramTypes.push(type);
        parameterNames.push(param.name.name);
        optionalParameters.push(param.optional);
        parameterInitializers.push(param.initializer);
      }

      let returnType: Type = Types.Void;
      if (member.returnType) {
        returnType = resolveTypeAnnotation(ctx, member.returnType);
      }

      ctx.exitScope();

      const methodType: FunctionType = {
        kind: TypeKind.Function,
        typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
        parameters: paramTypes,
        parameterNames,
        returnType,
        isFinal: member.isFinal,
        isAbstract: member.isAbstract,
        optionalParameters,
        parameterInitializers,
      };

      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (memberNameInfo.isSymbol) {
        mixinType.symbolMethods!.set(memberNameInfo.symbolType!, methodType);
      } else {
        mixinType.methods.set(memberNameInfo.name, methodType);
      }
    } else if (member.type === NodeType.AccessorDeclaration) {
      const fieldType = resolveTypeAnnotation(ctx, member.typeAnnotation);

      // Unboxed tuples cannot appear in accessor types
      validateNoUnboxedTuple(fieldType, ctx, 'accessor types');

      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (memberNameInfo.isSymbol) {
        mixinType.symbolFields!.set(memberNameInfo.symbolType!, fieldType);
        if (member.getter) {
          mixinType.symbolMethods!.set(memberNameInfo.symbolType!, {
            kind: TypeKind.Function,
            parameters: [],
            returnType: fieldType,
            isFinal: member.isFinal,
          });
        }
        continue;
      }
      const memberName = memberNameInfo.name;

      mixinType.fields.set(memberName, fieldType);

      if (member.getter) {
        mixinType.methods.set(getGetterName(memberName), {
          kind: TypeKind.Function,
          parameters: [],
          returnType: fieldType,
          isFinal: member.isFinal,
        });
      }
      if (member.setter) {
        mixinType.methods.set(getSetterName(memberName), {
          kind: TypeKind.Function,
          parameters: [fieldType],
          returnType: Types.Void,
          isFinal: member.isFinal,
        });
      }
    }
  }

  // 2. Check bodies
  // We need to set up 'this' type.
  // 'this' should be (OnType & MixinType).
  // Since we don't have intersection types, we can approximate it by creating a synthetic ClassType
  // that extends OnType (if any) and has Mixin members.

  const thisType: ClassType = {
    kind: TypeKind.Class,
    name: `${mixinName}_This`,
    superType: onType,
    implements: [],
    fields: new Map(mixinType.fields),
    methods: new Map(mixinType.methods),
    statics: new Map(),
    symbolFields: new Map(mixinType.symbolFields),
    symbolMethods: new Map(mixinType.symbolMethods),
    vtable: onType ? [...onType.vtable] : [],
    isFinal: false,
    isSyntheticMixinThis: true,
  };

  if (onType) {
    for (const [name, type] of onType.fields) {
      if (!name.startsWith('#') && !thisType.fields.has(name)) {
        thisType.fields.set(name, type);
      }
    }
    for (const [name, type] of onType.methods) {
      if (!thisType.methods.has(name)) {
        thisType.methods.set(name, type);
      }
    }
  }

  ctx.enterClass(thisType);

  for (const member of decl.body) {
    if (member.type === NodeType.MethodDefinition) {
      const memberNameInfo = resolveMemberName(ctx, member.name);
      const methodName = memberNameInfo.name; // For error messages

      if (methodName === '#new') continue; // Skip constructor check as it's already reported

      let methodType: FunctionType | undefined;
      if (memberNameInfo.isSymbol) {
        methodType = mixinType.symbolMethods!.get(memberNameInfo.symbolType!);
      } else {
        methodType = mixinType.methods.get(methodName);
      }

      if (!methodType) continue; // Should not happen unless error occurred

      const previousReturnType = ctx.currentFunctionReturnType;
      ctx.currentFunctionReturnType = methodType.returnType;
      ctx.enterScope();
      member.params.forEach((param, index) => {
        const type = methodType!.parameters[index];
        ctx.declare(param.name.name, type, 'let', param);
      });
      if (member.body) {
        checkStatement(ctx, member.body);
      }
      ctx.exitScope();
      ctx.currentFunctionReturnType = previousReturnType;
    } else if (member.type === NodeType.FieldDefinition && member.value) {
      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (memberNameInfo.isSymbol) continue; // TODO: Check symbol field initializer

      const fieldType = mixinType.fields.get(memberNameInfo.name)!;
      const valueType = checkExpression(ctx, member.value);
      if (!isAssignableTo(ctx, valueType, fieldType)) {
        ctx.diagnostics.reportError(
          `Type mismatch in field initializer: expected ${typeToString(fieldType)}, got ${typeToString(valueType)}`,
          DiagnosticCode.TypeMismatch,
        );
      }
    } else if (member.type === NodeType.AccessorDeclaration) {
      const memberNameInfo = resolveMemberName(ctx, member.name);
      if (memberNameInfo.isSymbol) continue; // TODO: Check symbol accessor body

      const fieldType = mixinType.fields.get(memberNameInfo.name)!;
      const previousReturnType = ctx.currentFunctionReturnType;
      if (member.getter) {
        ctx.currentFunctionReturnType = fieldType;
        ctx.enterScope();
        checkStatement(ctx, member.getter);
        ctx.exitScope();
      }
      if (member.setter) {
        ctx.currentFunctionReturnType = Types.Void;
        ctx.enterScope();
        ctx.declare(
          member.setter.param.name,
          fieldType,
          'let',
          member.setter.param,
        );
        checkStatement(ctx, member.setter.body);
        ctx.exitScope();
      }
      ctx.currentFunctionReturnType = previousReturnType;
    }
  }

  ctx.exitClass();
  ctx.exitScope();
}

/**
 * Helper to create type parameters from AST nodes and resolve constraints.
 * This function:
 * 1. Creates TypeParameterType objects without constraints
 * 2. Declares them in the current scope
 * 3. Resolves constraints (after all params are in scope)
 * 4. Resolves default types (after all params are in scope)
 */
function createTypeParameters(
  ctx: CheckerContext,
  astTypeParameters: TypeParameter[] | undefined,
): TypeParameterType[] {
  const typeParameters: TypeParameterType[] = [];

  if (!astTypeParameters) {
    return typeParameters;
  }

  // First pass: create type parameters without constraints
  for (const param of astTypeParameters) {
    typeParameters.push({
      kind: TypeKind.TypeParameter,
      name: param.name,
    });
  }

  // Declare all type parameters in scope so they can reference each other
  for (const param of typeParameters) {
    ctx.declare(param.name, param, 'type');
  }

  // Second pass: resolve constraints and defaults
  for (let i = 0; i < astTypeParameters.length; i++) {
    const astParam = astTypeParameters[i];
    const param = typeParameters[i];

    if (astParam.constraint) {
      param.constraint = resolveTypeAnnotation(ctx, astParam.constraint);
    }

    if (astParam.default) {
      param.defaultType = resolveTypeAnnotation(ctx, astParam.default);
    }
  }

  return typeParameters;
}

function checkEnumDeclaration(ctx: CheckerContext, decl: EnumDeclaration) {
  const name = decl.name.name;

  // If the AST node already has an inferred type (from a previous type-check pass),
  // reuse it to preserve type identity across bundling.
  if (decl.inferredType && decl.inferredType.kind === TypeKind.TypeAlias) {
    const existingType = decl.inferredType as TypeAliasType;
    // Update the name to match the (possibly renamed) declaration
    existingType.name = name;
    ctx.declare(name, existingType, 'type');

    // Recreate the value type with the existing enum type
    const fields = new Map<string, Type>();
    for (const member of decl.members) {
      fields.set(member.name.name, existingType);
    }
    const enumValueType: RecordType = {
      kind: TypeKind.Record,
      properties: fields,
    };
    // Pass the enum declaration for value binding resolution
    ctx.declare(name, enumValueType, 'let', decl);

    if (decl.exported && ctx.module) {
      ctx.module!.exports!.set(`type:${name}`, {
        type: existingType,
        kind: 'type',
      });
      ctx.module!.exports!.set(`value:${name}`, {
        type: enumValueType,
        kind: 'let',
        declaration: decl,
      });
    }
    return;
  }

  // 1. Determine backing type
  let isStringEnum = false;
  let isIntegerEnum = true;

  for (const member of decl.members) {
    if (member.initializer) {
      if (member.initializer.type === NodeType.StringLiteral) {
        isStringEnum = true;
        isIntegerEnum = false;
        break;
      } else if (member.initializer.type === NodeType.NumberLiteral) {
        isIntegerEnum = true;
        isStringEnum = false;
        break;
      }
    }
  }

  let nextValue = 0;
  const memberValues = new Map<string, number | string>();

  for (const member of decl.members) {
    if (member.initializer) {
      const initType = checkExpression(ctx, member.initializer);

      if (isIntegerEnum) {
        if (!isAssignableTo(ctx, initType, Types.I32)) {
          ctx.diagnostics.reportError(
            `Enum member initializer must be assignable to '${Types.I32.name}'.`,
            DiagnosticCode.TypeMismatch,
            ctx.getLocation(member.initializer.loc),
          );
        }

        if (member.initializer.type === NodeType.NumberLiteral) {
          const val = Number((member.initializer as any).value);
          member.resolvedValue = val;
          nextValue = val + 1;
        } else {
          ctx.diagnostics.reportError(
            `Enum member initializer must be a number literal.`,
            DiagnosticCode.TypeMismatch,
            ctx.getLocation(member.initializer.loc),
          );
        }
      } else {
        if (!isAssignableTo(ctx, initType, Types.String)) {
          ctx.diagnostics.reportError(
            `Enum member initializer must be assignable to '${Types.String.name}'.`,
            DiagnosticCode.TypeMismatch,
            ctx.getLocation(member.initializer.loc),
          );
        }

        if (member.initializer.type === NodeType.StringLiteral) {
          member.resolvedValue = (member.initializer as any).value;
        } else {
          ctx.diagnostics.reportError(
            `Enum member initializer must be a string literal.`,
            DiagnosticCode.TypeMismatch,
            ctx.getLocation(member.initializer.loc),
          );
        }
      }
    } else {
      if (isStringEnum) {
        ctx.diagnostics.reportError(
          `String enum member '${member.name.name}' must have an initializer.`,
          DiagnosticCode.TypeMismatch,
          ctx.getLocation(member.name.loc),
        );
      } else {
        member.resolvedValue = nextValue++;
      }
    }

    if (member.resolvedValue !== undefined) {
      memberValues.set(member.name.name, member.resolvedValue);
    }
  }

  const backingType = isStringEnum ? Types.String : Types.I32;

  const literalTypes: LiteralType[] = [];
  for (const val of memberValues.values()) {
    literalTypes.push({
      kind: TypeKind.Literal,
      value: val,
    });
  }

  let targetType: Type;
  if (literalTypes.length === 0) {
    targetType = backingType;
  } else if (literalTypes.length === 1) {
    targetType = literalTypes[0];
  } else {
    targetType = {
      kind: TypeKind.Union,
      types: literalTypes,
    } as UnionType;
  }

  const enumType: TypeAliasType = {
    kind: TypeKind.TypeAlias,
    name,
    target: targetType,
    isDistinct: true,
  };

  ctx.declare(name, enumType, 'type');
  decl.inferredType = enumType;

  // Store reference so the bundler can update the type name
  decl.inferredType = enumType;

  const fields = new Map<string, Type>();
  for (const member of decl.members) {
    fields.set(member.name.name, enumType);
  }

  const enumValueType: RecordType = {
    kind: TypeKind.Record,
    properties: fields,
  };

  // Pass the enum declaration as the value declaration so codegen can resolve enum references
  ctx.declare(name, enumValueType, 'let', decl);

  if (decl.exported && ctx.module) {
    ctx.module!.exports!.set(`type:${name}`, {type: enumType, kind: 'type'});
    ctx.module!.exports!.set(`value:${name}`, {
      type: enumValueType,
      kind: 'let',
      declaration: decl,
    });
  }
}
