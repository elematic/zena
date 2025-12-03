import {
  NodeType,
  type AccessorDeclaration,
  type AssignmentPattern,
  type ClassDeclaration,
  type DeclareFunction,
  type ForStatement,
  type IfStatement,
  type ImportDeclaration,
  type InterfaceDeclaration,
  type MethodDefinition,
  type MixinDeclaration,
  type Parameter,
  type Pattern,
  type RecordPattern,
  type ReturnStatement,
  type Statement,
  type TuplePattern,
  type TypeAliasDeclaration,
  type VariableDeclaration,
  type WhileStatement,
} from '../ast.js';
import {DiagnosticCode} from '../diagnostics.js';
import {
  TypeKind,
  Types,
  type FixedArrayType,
  type ClassType,
  type FunctionType,
  type InterfaceType,
  type MixinType,
  type RecordType,
  type TupleType,
  type Type,
  type TypeAliasType,
  type TypeParameterType,
  type UnionType,
} from '../types.js';
import type {CheckerContext} from './context.js';
import {checkExpression} from './expressions.js';
import {isAssignableTo, resolveTypeAnnotation, typeToString} from './types.js';

export function checkStatement(ctx: CheckerContext, stmt: Statement) {
  switch (stmt.type) {
    case NodeType.ImportDeclaration:
      checkImportDeclaration(ctx, stmt as ImportDeclaration);
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
    case NodeType.IfStatement:
      checkIfStatement(ctx, stmt as IfStatement);
      break;
    case NodeType.WhileStatement:
      checkWhileStatement(ctx, stmt as WhileStatement);
      break;
    case NodeType.ForStatement:
      checkForStatement(ctx, stmt as ForStatement);
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
  }
}

function resolveParameterType(ctx: CheckerContext, param: Parameter): Type {
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
  }
  return type;
}

function checkTypeAliasDeclaration(
  ctx: CheckerContext,
  decl: TypeAliasDeclaration,
) {
  const name = decl.name.name;

  const typeParameters: TypeParameterType[] = [];
  if (decl.typeParameters) {
    for (const param of decl.typeParameters) {
      typeParameters.push({
        kind: TypeKind.TypeParameter,
        name: param.name,
      });
    }
  }

  ctx.enterScope();
  for (const param of typeParameters) {
    ctx.declare(param.name, param, 'type');
  }

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

  if (decl.exported && ctx.module) {
    ctx.module.exports.set(name, {type: typeAlias, kind: 'type'});
  }
}

function checkImportDeclaration(ctx: CheckerContext, decl: ImportDeclaration) {
  if (!ctx.module || !ctx.compiler) {
    // If we are not in a module context (e.g. simple test), we can't check imports.
    // Or maybe we should error? For now, let's ignore.
    return;
  }

  const specifier = decl.moduleSpecifier.value;
  const resolvedPath = ctx.module.imports.get(specifier);

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

    const symbolInfo = importedModule.exports.get(importedName);

    if (!symbolInfo) {
      ctx.diagnostics.reportError(
        `Module '${specifier}' does not export '${importedName}'`,
        DiagnosticCode.ImportError,
      );
      continue;
    }

    // Declare in current scope
    // Imports are read-only (const), so we force kind to 'let' (which is const in our internal model mostly, or we should add 'const' kind?)
    // Our VariableDeclaration uses 'let' for immutable and 'var' for mutable.
    // So 'let' is correct for immutable binding.
    // However, if the exported symbol was a 'var', should we allow it to be 'var' here?
    // No, imports are bindings. You can't reassign the binding.
    // But if it's a mutable object, you can mutate it.
    // If it's a 'var' export, it means the VALUE can change in the other module.
    // But locally, the binding is const.
    // So 'let' is correct.

    ctx.declare(localName, symbolInfo.type, 'let');
  }
}

function checkDeclareFunction(ctx: CheckerContext, decl: DeclareFunction) {
  const typeParameters: TypeParameterType[] = [];
  if (decl.typeParameters) {
    for (const param of decl.typeParameters) {
      typeParameters.push({
        kind: TypeKind.TypeParameter,
        name: param.name,
      });
    }
  }

  ctx.enterScope();
  for (const tp of typeParameters) {
    ctx.declare(tp.name, tp, 'type');
  }

  const paramTypes: Type[] = [];
  const optionalParameters: boolean[] = [];
  const parameterInitializers: any[] = [];

  for (const param of decl.params) {
    const type = resolveParameterType(ctx, param);
    paramTypes.push(type);
    optionalParameters.push(param.optional);
    parameterInitializers.push(param.initializer);
  }

  const returnType = resolveTypeAnnotation(ctx, decl.returnType);

  ctx.exitScope();

  const functionType: FunctionType = {
    kind: TypeKind.Function,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    parameters: paramTypes,
    returnType,
    optionalParameters,
    parameterInitializers,
  };

  ctx.declare(decl.name.name, functionType, 'let');
}

function checkIfStatement(ctx: CheckerContext, stmt: IfStatement) {
  const testType = checkExpression(ctx, stmt.test);
  if (
    testType.kind !== TypeKind.Boolean &&
    testType.kind !== TypeKind.Unknown
  ) {
    ctx.diagnostics.reportError(
      `Expected boolean condition in if statement, got ${typeToString(testType)}`,
      DiagnosticCode.TypeMismatch,
    );
  }

  checkStatement(ctx, stmt.consequent);
  if (stmt.alternate) {
    checkStatement(ctx, stmt.alternate);
  }
}

function checkWhileStatement(ctx: CheckerContext, stmt: WhileStatement) {
  const testType = checkExpression(ctx, stmt.test);
  if (
    testType.kind !== TypeKind.Boolean &&
    testType.kind !== TypeKind.Unknown
  ) {
    ctx.diagnostics.reportError(
      `Expected boolean condition in while statement, got ${typeToString(testType)}`,
      DiagnosticCode.TypeMismatch,
    );
  }

  checkStatement(ctx, stmt.body);
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
    if (
      testType.kind !== TypeKind.Boolean &&
      testType.kind !== TypeKind.Unknown
    ) {
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
  checkStatement(ctx, stmt.body);

  ctx.exitScope();
}

function checkReturnStatement(ctx: CheckerContext, stmt: ReturnStatement) {
  if (!ctx.currentFunctionReturnType) {
    ctx.diagnostics.reportError(
      'Return statement outside of function.',
      DiagnosticCode.ReturnOutsideFunction,
    );
    return;
  }

  const argType = stmt.argument
    ? checkExpression(ctx, stmt.argument)
    : Types.Void;

  if (ctx.currentFunctionReturnType.kind !== Types.Unknown.kind) {
    // If we know the expected return type, check against it
    if (!isAssignableTo(argType, ctx.currentFunctionReturnType)) {
      ctx.diagnostics.reportError(
        `Type mismatch: expected return type ${typeToString(ctx.currentFunctionReturnType)}, got ${typeToString(argType)}`,
        DiagnosticCode.TypeMismatch,
      );
    }
  } else {
    // Infer return type
    ctx.inferredReturnTypes.push(argType);
  }
}

function checkVariableDeclaration(
  ctx: CheckerContext,
  decl: VariableDeclaration,
) {
  let type = checkExpression(ctx, decl.init);

  if (decl.typeAnnotation) {
    const explicitType = resolveTypeAnnotation(ctx, decl.typeAnnotation);
    if (!isAssignableTo(type, explicitType)) {
      ctx.diagnostics.reportError(
        `Type mismatch: expected ${typeToString(explicitType)}, got ${typeToString(type)}`,
        DiagnosticCode.TypeMismatch,
      );
    }
    type = explicitType;
  }

  if (decl.pattern.type === NodeType.Identifier) {
    ctx.declare(decl.pattern.name, type, decl.kind);
  } else {
    checkPattern(ctx, decl.pattern, type, decl.kind);
  }
}

function checkPattern(
  ctx: CheckerContext,
  pattern: Pattern,
  type: Type,
  kind: 'let' | 'var',
) {
  switch (pattern.type) {
    case NodeType.Identifier:
      ctx.declare(pattern.name, type, kind);
      break;

    case NodeType.RecordPattern:
      checkRecordPattern(ctx, pattern, type, kind);
      break;

    case NodeType.TuplePattern:
      checkTuplePattern(ctx, pattern, type, kind);
      break;

    case NodeType.AssignmentPattern:
      checkAssignmentPattern(ctx, pattern, type, kind);
      break;
  }
}

function checkRecordPattern(
  ctx: CheckerContext,
  pattern: RecordPattern,
  type: Type,
  kind: 'let' | 'var',
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

    checkPattern(ctx, prop.value, propType, kind);
  }
}

function checkTuplePattern(
  ctx: CheckerContext,
  pattern: TuplePattern,
  type: Type,
  kind: 'let' | 'var',
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

      checkPattern(ctx, elemPattern, tupleType.elementTypes[i], kind);
    }
  } else if (type.kind === TypeKind.FixedArray) {
    const arrayType = type as FixedArrayType;
    for (const elemPattern of pattern.elements) {
      if (!elemPattern) continue;
      checkPattern(ctx, elemPattern, arrayType.elementType, kind);
    }
  } else {
    ctx.diagnostics.reportError(
      `Type '${typeToString(type)}' is not a tuple or array`,
      DiagnosticCode.TypeMismatch,
    );
  }
}

function checkAssignmentPattern(
  ctx: CheckerContext,
  pattern: AssignmentPattern,
  type: Type,
  kind: 'let' | 'var',
) {
  // pattern.right is default value
  const defaultType = checkExpression(ctx, pattern.right);

  // Ensure default value is assignable to the expected type
  if (!isAssignableTo(defaultType, type)) {
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

  checkPattern(ctx, pattern.left, type, kind);
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

function checkClassDeclaration(ctx: CheckerContext, decl: ClassDeclaration) {
  const className = decl.name.name;

  const typeParameters: TypeParameterType[] = [];
  if (decl.typeParameters) {
    for (const param of decl.typeParameters) {
      typeParameters.push({
        kind: TypeKind.TypeParameter,
        name: param.name,
      });
    }
  }

  let superType: ClassType | undefined;
  if (decl.superClass) {
    const type = ctx.resolve(decl.superClass.name);
    if (!type) {
      ctx.diagnostics.reportError(
        `Unknown superclass '${decl.superClass.name}'.`,
        DiagnosticCode.SymbolNotFound,
      );
    } else if (type.kind !== TypeKind.Class) {
      ctx.diagnostics.reportError(
        `Superclass '${decl.superClass.name}' must be a class.`,
        DiagnosticCode.TypeMismatch,
      );
    } else {
      superType = type as ClassType;
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
    for (const mixinId of decl.mixins) {
      const mixinType = ctx.resolve(mixinId.name);
      if (!mixinType) {
        ctx.diagnostics.reportError(
          `Unknown mixin '${mixinId.name}'.`,
          DiagnosticCode.SymbolNotFound,
        );
        continue;
      }
      if (mixinType.kind !== TypeKind.Mixin) {
        ctx.diagnostics.reportError(
          `'${mixinId.name}' is not a mixin.`,
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
        } else if (!isAssignableTo(superType, mixin.onType)) {
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
        vtable: superType ? [...superType.vtable] : [],
        isFinal: false, // Intermediate classes are not final
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
          if (!isAssignableTo(type, baseFieldType)) {
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
          if (!isAssignableTo(type.returnType, baseMethod.returnType)) {
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
                !isAssignableTo(baseMethod.parameters[i], type.parameters[i])
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

  const classType: ClassType = {
    kind: TypeKind.Class,
    _debugId: Math.floor(Math.random() * 1000000),
    name: className,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    superType,
    implements: [],
    fields: new Map(),
    methods: new Map(),
    constructorType: undefined,
    vtable: superType ? [...superType.vtable] : [],
    isFinal: decl.isFinal,
    isAbstract: decl.isAbstract,
    isExtension: decl.isExtension,
    onType: undefined,
  };

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

  ctx.declare(className, classType);
  decl.inferredType = classType;
  ctx.enterClass(classType);

  ctx.enterScope();
  for (const tp of typeParameters) {
    ctx.declare(tp.name, tp, 'type');
  }

  if (decl.isExtension && decl.onType) {
    classType.onType = resolveTypeAnnotation(ctx, decl.onType);
  }

  // Resolve default type parameters
  if (decl.typeParameters) {
    for (let i = 0; i < decl.typeParameters.length; i++) {
      const param = decl.typeParameters[i];
      if (param.default) {
        typeParameters[i].defaultType = resolveTypeAnnotation(
          ctx,
          param.default,
        );
      }
    }
  }

  // 1. First pass: Collect members to build the ClassType
  for (const member of decl.body) {
    if (member.type === NodeType.FieldDefinition) {
      if (decl.isExtension && !member.isStatic && !member.isDeclare) {
        ctx.diagnostics.reportError(
          `Extension classes cannot have instance fields.`,
          DiagnosticCode.ExtensionClassField,
        );
        continue;
      }
      const fieldType = resolveTypeAnnotation(ctx, member.typeAnnotation);
      if (classType.fields.has(member.name.name)) {
        // Check if it's a redeclaration of an inherited field
        if (superType && superType.fields.has(member.name.name)) {
          // Allow shadowing/overriding of fields
          // Check type compatibility
          const superFieldType = superType.fields.get(member.name.name)!;
          // If mutable, types should be invariant (identical). If immutable, covariant.
          // For now, we enforce covariance (fieldType extends superFieldType).
          if (!isAssignableTo(fieldType, superFieldType)) {
            ctx.diagnostics.reportError(
              `Field '${member.name.name}' in subclass '${className}' must be compatible with inherited field.`,
              DiagnosticCode.TypeMismatch,
            );
          }
        } else {
          ctx.diagnostics.reportError(
            `Duplicate field '${member.name.name}' in class '${className}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        }
      }
      classType.fields.set(member.name.name, fieldType);

      // Register implicit accessors for public fields
      if (!member.name.name.startsWith('#')) {
        const getterName = `get_${member.name.name}`;
        const setterName = `set_${member.name.name}`;

        // Getter
        if (!classType.methods.has(getterName)) {
          classType.vtable.push(getterName);
        }
        classType.methods.set(getterName, {
          kind: TypeKind.Function,
          parameters: [],
          returnType: fieldType,
          isFinal: false,
        });

        // Setter (if mutable)
        if (!member.isFinal) {
          if (!classType.methods.has(setterName)) {
            classType.vtable.push(setterName);
          }
          classType.methods.set(setterName, {
            kind: TypeKind.Function,
            parameters: [fieldType],
            returnType: Types.Void,
            isFinal: false,
          });
        }
      }
    } else if (member.type === NodeType.AccessorDeclaration) {
      const fieldType = resolveTypeAnnotation(ctx, member.typeAnnotation);
      if (classType.fields.has(member.name.name)) {
        if (superType && superType.fields.has(member.name.name)) {
          // Allow overriding field with accessor
          // Check type compatibility
          const superFieldType = superType.fields.get(member.name.name)!;
          if (!isAssignableTo(fieldType, superFieldType)) {
            ctx.diagnostics.reportError(
              `Accessor '${member.name.name}' in subclass '${className}' must be compatible with inherited field.`,
              DiagnosticCode.TypeMismatch,
            );
          }
        } else {
          ctx.diagnostics.reportError(
            `Duplicate field '${member.name.name}' in class '${className}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        }
      }
      classType.fields.set(member.name.name, fieldType);

      // Register getter/setter methods
      if (member.getter) {
        const getterName = `get_${member.name.name}`;
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
        const setterName = `set_${member.name.name}`;
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
      const typeParameters: TypeParameterType[] = [];
      if (member.typeParameters) {
        for (const param of member.typeParameters) {
          typeParameters.push({
            kind: TypeKind.TypeParameter,
            name: param.name,
          });
        }
      }

      ctx.enterScope();
      for (const tp of typeParameters) {
        ctx.declare(tp.name, tp, 'type');
      }

      const paramTypes = member.params.map((p) => resolveParameterType(ctx, p));
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
        returnType,
        isFinal: member.isFinal,
        isAbstract: member.isAbstract,
        optionalParameters,
        parameterInitializers,
      };

      if (member.isAbstract && !decl.isAbstract) {
        ctx.diagnostics.reportError(
          `Abstract method '${member.name.name}' can only appear within an abstract class.`,
          DiagnosticCode.AbstractMethodInConcreteClass,
        );
      }

      if (member.isDeclare) {
        const hasIntrinsic = member.decorators?.some(
          (d) => d.name === 'intrinsic',
        );
        if (!hasIntrinsic) {
          ctx.diagnostics.reportError(
            `Declared method '${member.name.name}' must be decorated with @intrinsic.`,
            DiagnosticCode.MissingDecorator,
          );
        }

        if (member.body) {
          ctx.diagnostics.reportError(
            `Declared method '${member.name.name}' cannot have a body.`,
            DiagnosticCode.UnexpectedBody,
          );
        }
      }

      if (member.name.name === '#new') {
        if (classType.constructorType) {
          ctx.diagnostics.reportError(
            `Duplicate constructor in class '${className}'.`,
            DiagnosticCode.DuplicateDeclaration,
          );
        }
        classType.constructorType = methodType;
      } else {
        if (!member.name.name.startsWith('#') && !classType.methods.has(member.name.name)) {
          classType.vtable.push(member.name.name);
        }

        if (classType.methods.has(member.name.name)) {
          // Check for override
          if (superType && superType.methods.has(member.name.name)) {
            // Validate override
            const superMethod = superType.methods.get(member.name.name)!;

            if (superMethod.isFinal) {
              ctx.diagnostics.reportError(
                `Cannot override final method '${member.name.name}'.`,
                DiagnosticCode.TypeMismatch,
              );
            }

            // TODO: Check signature compatibility (covariant return, contravariant params)
            // For now, require exact match
            if (typeToString(methodType) !== typeToString(superMethod)) {
              ctx.diagnostics.reportError(
                `Method '${member.name.name}' in '${className}' incorrectly overrides method in '${superType.name}'.`,
                DiagnosticCode.TypeMismatch,
              );
            }
          } else {
            ctx.diagnostics.reportError(
              `Duplicate method '${member.name.name}' in class '${className}'.`,
              DiagnosticCode.DuplicateDeclaration,
            );
          }
        }
        classType.methods.set(member.name.name, methodType);
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

      // Check fields
      for (const [name, type] of interfaceType.fields) {
        if (!classType.fields.has(name)) {
          ctx.diagnostics.reportError(
            `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Property '${name}' is missing.`,
            DiagnosticCode.PropertyNotFound,
          );
        } else {
          const fieldType = classType.fields.get(name)!;
          if (typeToString(fieldType) !== typeToString(type)) {
            ctx.diagnostics.reportError(
              `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Property '${name}' is type '${typeToString(fieldType)}' but expected '${typeToString(type)}'.`,
              DiagnosticCode.TypeMismatch,
            );
          }
        }
      }

      // Check methods
      for (const [name, type] of interfaceType.methods) {
        if (!classType.methods.has(name)) {
          ctx.diagnostics.reportError(
            `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Method '${name}' is missing.`,
            DiagnosticCode.PropertyNotFound,
          );
        } else {
          const methodType = classType.methods.get(name)!;
          if (typeToString(methodType) !== typeToString(type)) {
            ctx.diagnostics.reportError(
              `Class '${className}' incorrectly implements interface '${interfaceType.name}'. Method '${name}' is type '${typeToString(methodType)}' but expected '${typeToString(type)}'.`,
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
      if (member.value) {
        ctx.isCheckingFieldInitializer = true;
        const valueType = checkExpression(ctx, member.value);
        ctx.isCheckingFieldInitializer = false;

        const fieldType = classType.fields.get(member.name.name)!;
        if (
          valueType.kind !== fieldType.kind &&
          valueType.kind !== Types.Unknown.kind
        ) {
          if (typeToString(valueType) !== typeToString(fieldType)) {
            ctx.diagnostics.reportError(
              `Type mismatch for field '${member.name.name}': expected ${typeToString(fieldType)}, got ${typeToString(valueType)}`,
              DiagnosticCode.TypeMismatch,
            );
          }
        }
      }
      ctx.initializedFields.add(member.name.name);
    } else if (member.type === NodeType.AccessorDeclaration) {
      checkAccessorDeclaration(ctx, member);
      ctx.initializedFields.add(member.name.name);
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

  const interfaceType: InterfaceType = {
    kind: TypeKind.Interface,
    name: interfaceName,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    fields: new Map(),
    methods: new Map(),
    extends: [],
  };

  // Register interface in current scope
  ctx.declare(interfaceName, interfaceType);
  decl.inferredType = interfaceType;

  // Enter scope for type parameters
  ctx.enterScope();
  if (interfaceType.typeParameters) {
    for (const param of interfaceType.typeParameters) {
      ctx.declare(param.name, param);
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
      const typeParameters: TypeParameterType[] = [];
      if (member.typeParameters) {
        for (const param of member.typeParameters) {
          typeParameters.push({
            kind: TypeKind.TypeParameter,
            name: param.name,
          });
        }
      }

      ctx.enterScope();
      for (const tp of typeParameters) {
        ctx.declare(tp.name, tp, 'type');
      }

      const paramTypes: Type[] = [];
      const optionalParameters: boolean[] = [];
      const parameterInitializers: any[] = [];

      for (const param of member.params) {
        const type = resolveParameterType(ctx, param);
        paramTypes.push(type);
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
        returnType,
        optionalParameters,
        parameterInitializers,
      };

      if (interfaceType.methods.has(member.name.name)) {
        ctx.diagnostics.reportError(
          `Duplicate method '${member.name.name}' in interface '${interfaceName}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
      } else {
        interfaceType.methods.set(member.name.name, methodType);
      }
    } else if (member.type === NodeType.FieldDefinition) {
      const type = resolveTypeAnnotation(ctx, member.typeAnnotation);
      if (interfaceType.fields.has(member.name.name)) {
        ctx.diagnostics.reportError(
          `Duplicate field '${member.name.name}' in interface '${interfaceName}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
      } else {
        interfaceType.fields.set(member.name.name, type);
      }
    }
  }

  ctx.exitScope();
}

function checkMethodDefinition(ctx: CheckerContext, method: MethodDefinition) {
  if (method.decorators) {
    for (const decorator of method.decorators) {
      if (decorator.name === 'intrinsic') {
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

  const previousMethod = ctx.currentMethod;
  ctx.currentMethod = method.name.name;

  const previousIsThisInitialized = ctx.isThisInitialized;
  if (method.name.name === '#new' && ctx.currentClass?.superType) {
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
    ctx.declare(param.name.name, type, 'let');

    if (param.initializer) {
      const initType = checkExpression(ctx, param.initializer);
      if (!isAssignableTo(initType, type)) {
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
    method.name.name === '#new' &&
    (ctx.currentClass?.superType || ctx.currentClass?.isExtension) &&
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

    // Declare parameter
    ctx.declare(decl.setter.param.name, propertyType, 'let');

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
    const type = ctx.resolve(decl.on.name);
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

  const mixinType: MixinType = {
    kind: TypeKind.Mixin,
    name: mixinName,
    typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
    onType,
    fields: new Map(),
    methods: new Map(),
  };

  ctx.declare(mixinName, mixinType);
  decl.inferredType = mixinType;

  ctx.enterScope();
  for (const tp of typeParameters) {
    ctx.declare(tp.name, tp, 'let');
  }

  // Apply composed mixins
  if (decl.mixins) {
    for (const mixinId of decl.mixins) {
      const composedMixinType = ctx.resolve(mixinId.name);
      if (!composedMixinType) {
        ctx.diagnostics.reportError(
          `Unknown mixin '${mixinId.name}'.`,
          DiagnosticCode.SymbolNotFound,
        );
        continue;
      }
      if (composedMixinType.kind !== TypeKind.Mixin) {
        ctx.diagnostics.reportError(
          `'${mixinId.name}' is not a mixin.`,
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
        } else if (!isAssignableTo(onType, composedMixin.onType)) {
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
      if (mixinType.fields.has(member.name.name)) {
        ctx.diagnostics.reportError(
          `Duplicate field '${member.name.name}' in mixin '${mixinName}'.`,
          DiagnosticCode.DuplicateDeclaration,
        );
      }
      mixinType.fields.set(member.name.name, fieldType);

      // Implicit accessors
      if (!member.name.name.startsWith('#')) {
        const getterName = `get_${member.name.name}`;
        const setterName = `set_${member.name.name}`;

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
            returnType: Types.Void,
            isFinal: false,
          });
        }
      }
    } else if (member.type === NodeType.MethodDefinition) {
      const typeParameters: TypeParameterType[] = [];
      if (member.typeParameters) {
        for (const param of member.typeParameters) {
          typeParameters.push({
            kind: TypeKind.TypeParameter,
            name: param.name,
          });
        }
      }

      ctx.enterScope();
      for (const tp of typeParameters) {
        ctx.declare(tp.name, tp, 'type');
      }

      const paramTypes: Type[] = [];
      const optionalParameters: boolean[] = [];
      const parameterInitializers: any[] = [];

      for (const param of member.params) {
        const type = resolveParameterType(ctx, param);
        paramTypes.push(type);
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
        returnType,
        isFinal: member.isFinal,
        isAbstract: member.isAbstract,
        optionalParameters,
        parameterInitializers,
      };

      mixinType.methods.set(member.name.name, methodType);
    } else if (member.type === NodeType.AccessorDeclaration) {
      const fieldType = resolveTypeAnnotation(ctx, member.typeAnnotation);
      mixinType.fields.set(member.name.name, fieldType);

      if (member.getter) {
        mixinType.methods.set(`get_${member.name.name}`, {
          kind: TypeKind.Function,
          parameters: [],
          returnType: fieldType,
          isFinal: member.isFinal,
        });
      }
      if (member.setter) {
        mixinType.methods.set(`set_${member.name.name}`, {
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
    vtable: onType ? [...onType.vtable] : [],
    isFinal: false,
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
      if (member.name.name === '#new') continue; // Skip constructor check as it's already reported

      const methodType = mixinType.methods.get(member.name.name);
      if (!methodType) continue; // Should not happen unless error occurred

      ctx.currentFunctionReturnType = methodType.returnType;
      ctx.enterScope();
      member.params.forEach((param, index) => {
        const type = methodType.parameters[index];
        ctx.declare(param.name.name, type, 'let');
      });
      if (member.body) {
        checkStatement(ctx, member.body);
      }
      ctx.exitScope();
      ctx.currentFunctionReturnType = Types.Unknown;
    } else if (member.type === NodeType.FieldDefinition && member.value) {
      const fieldType = mixinType.fields.get(member.name.name)!;
      const valueType = checkExpression(ctx, member.value);
      if (!isAssignableTo(valueType, fieldType)) {
        ctx.diagnostics.reportError(
          `Type mismatch in field initializer: expected ${typeToString(fieldType)}, got ${typeToString(valueType)}`,
          DiagnosticCode.TypeMismatch,
        );
      }
    } else if (member.type === NodeType.AccessorDeclaration) {
      const fieldType = mixinType.fields.get(member.name.name)!;
      if (member.getter) {
        ctx.currentFunctionReturnType = fieldType;
        ctx.enterScope();
        checkStatement(ctx, member.getter);
        ctx.exitScope();
      }
      if (member.setter) {
        ctx.currentFunctionReturnType = Types.Void;
        ctx.enterScope();
        ctx.declare(member.setter.param.name, fieldType, 'let');
        checkStatement(ctx, member.setter.body);
        ctx.exitScope();
      }
      ctx.currentFunctionReturnType = Types.Unknown;
    }
  }

  ctx.exitClass();
  ctx.exitScope();
}
