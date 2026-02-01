/**
 * Resolved bindings represent what a name resolves to at a usage site.
 *
 * During type checking, when an Identifier is encountered, the checker
 * resolves it to a binding and stores it in SemanticContext. Code generation
 * then uses these bindings to look up WASM indices without re-doing name
 * resolution.
 *
 * This enables correct scoping semantics and removes duplicated resolution
 * logic between the checker and codegen.
 */

import type {
  ClassDeclaration,
  DeclareFunction,
  EnumDeclaration,
  FunctionExpression,
  Identifier,
  ImportDeclaration,
  InterfaceDeclaration,
  MixinDeclaration,
  Parameter,
  TypeAliasDeclaration,
  TypeParameter,
  VariableDeclaration,
} from './ast.js';
import type {
  ClassType,
  FunctionType,
  InterfaceType,
  MixinType,
  RecordType,
  Type,
  TypeParameterType,
} from './types.js';

// ============================================================
// Binding Kinds
// ============================================================

/**
 * A local variable or function parameter.
 */
export interface LocalBinding {
  readonly kind: 'local';
  /**
   * The parameter or variable declaration AST node.
   * For accessor setter parameters, this may be an Identifier.
   */
  readonly declaration: Parameter | VariableDeclaration | Identifier;
  /** The semantic type of the binding */
  readonly type: Type;
}

/**
 * A module-level variable (const/let/var at top level) or enum.
 */
export interface GlobalBinding {
  readonly kind: 'global';
  /** The variable or enum declaration AST node */
  readonly declaration: VariableDeclaration | EnumDeclaration;
  /** The module path where this is declared */
  readonly modulePath: string;
  /** The semantic type of the binding */
  readonly type: Type;
}

/**
 * A named function (top-level or class method, not a closure).
 * For closures, the variable holding the closure uses LocalBinding.
 */
export interface FunctionBinding {
  readonly kind: 'function';
  /** The function declaration/expression AST node */
  readonly declaration: FunctionExpression | DeclareFunction;
  /** The module path where this is declared */
  readonly modulePath: string;
  /** The semantic function type */
  readonly type: FunctionType;
  /** For overloaded functions, the specific overload resolved for this call */
  readonly overloadIndex?: number;
}

/**
 * A class in value position (i.e., used as a constructor).
 * Example: `new Point(...)` - `Point` resolves to ClassBinding.
 */
export interface ClassBinding {
  readonly kind: 'class';
  /** The class declaration AST node */
  readonly declaration: ClassDeclaration;
  /** The module path where this is declared */
  readonly modulePath: string;
  /** The semantic class type */
  readonly type: ClassType;
}

/**
 * An interface binding (rarely used in value position, mainly for type checking).
 */
export interface InterfaceBinding {
  readonly kind: 'interface';
  /** The interface declaration AST node */
  readonly declaration: InterfaceDeclaration;
  /** The module path where this is declared */
  readonly modulePath: string;
  /** The semantic interface type */
  readonly type: InterfaceType;
}

/**
 * A mixin binding.
 */
export interface MixinBinding {
  readonly kind: 'mixin';
  /** The mixin declaration AST node */
  readonly declaration: MixinDeclaration;
  /** The module path where this is declared */
  readonly modulePath: string;
  /** The semantic mixin type */
  readonly type: MixinType;
}

/**
 * A type alias in value position (not common, mainly for `typeof` patterns).
 */
export interface TypeAliasBinding {
  readonly kind: 'type-alias';
  /** The type alias declaration AST node */
  readonly declaration: TypeAliasDeclaration;
  /** The module path where this is declared */
  readonly modulePath: string;
  /** The semantic type this alias refers to */
  readonly type: Type;
}

/**
 * A type parameter (e.g., `T` in `function foo<T>(x: T)`).
 * Only valid within the generic scope.
 */
export interface TypeParameterBinding {
  readonly kind: 'type-parameter';
  /** The type parameter declaration node */
  readonly declaration: TypeParameter;
  /** The semantic type parameter type */
  readonly type: TypeParameterType;
}

/**
 * An import that re-exports to another binding.
 * The `target` is the resolved binding from the source module.
 */
export interface ImportBinding {
  readonly kind: 'import';
  /** The local name used in this module */
  readonly localName: string;
  /** The import declaration AST node */
  readonly importDeclaration: ImportDeclaration;
  /** The resolved binding from the source module */
  readonly target: ResolvedBinding;
}

// ============================================================
// Member Bindings (for MemberExpression resolution)
// ============================================================

/**
 * A field access on a class or interface.
 * Example: `point.x` where `x` is a field on `Point`.
 */
export interface FieldBinding {
  readonly kind: 'field';
  /** The class or interface type containing the field */
  readonly classType: ClassType | InterfaceType;
  /** The field name (may include private prefix like `ClassName::#field`) */
  readonly fieldName: string;
  /** The semantic type of the field */
  readonly type: Type;
  /** If this field is an intrinsic (e.g., 'array.len'), the intrinsic name */
  readonly intrinsic?: string;
}

/**
 * A getter access on a class or interface.
 * Example: `array.length` where `length` is implemented via `get length()`.
 */
export interface GetterBinding {
  readonly kind: 'getter';
  /** The class or interface type containing the getter */
  readonly classType: ClassType | InterfaceType;
  /** The getter method name (e.g., `get:length`) */
  readonly methodName: string;
  /** Whether static dispatch can be used (final class/method or extension) */
  readonly isStaticDispatch: boolean;
  /** The return type of the getter */
  readonly type: Type;
}

/**
 * A setter access on a class or interface (used when assigning to a property).
 * Example: `obj.value = 5` where `value` is implemented via `set value(v)`.
 */
export interface SetterBinding {
  readonly kind: 'setter';
  /** The class or interface type containing the setter */
  readonly classType: ClassType | InterfaceType;
  /** The setter method name (e.g., `set:value`) */
  readonly methodName: string;
  /** Whether static dispatch can be used (final class/method or extension) */
  readonly isStaticDispatch: boolean;
}

/**
 * A method access on a class or interface (not a call, just the method reference).
 * Example: `obj.toString` (without call parens).
 */
export interface MethodBinding {
  readonly kind: 'method';
  /** The class or interface type containing the method */
  readonly classType: ClassType | InterfaceType;
  /** The method name */
  readonly methodName: string;
  /** Whether static dispatch can be used (final class/method or extension) */
  readonly isStaticDispatch: boolean;
  /** The semantic function type of the method */
  readonly type: FunctionType;
}

/**
 * A record field access.
 * Example: `record.name` where record is `{ name: string }`.
 */
export interface RecordFieldBinding {
  readonly kind: 'record-field';
  /** The record type */
  readonly recordType: RecordType;
  /** The field name */
  readonly fieldName: string;
  /** The semantic type of the field */
  readonly type: Type;
}

// ============================================================
// Union Type
// ============================================================

/**
 * A resolved binding describes what a name reference resolves to.
 * This is the result of name resolution during type checking.
 */
export type ResolvedBinding =
  | LocalBinding
  | GlobalBinding
  | FunctionBinding
  | ClassBinding
  | InterfaceBinding
  | MixinBinding
  | TypeAliasBinding
  | TypeParameterBinding
  | ImportBinding
  | FieldBinding
  | GetterBinding
  | SetterBinding
  | MethodBinding
  | RecordFieldBinding;

/**
 * Member bindings are the subset of bindings that resolve MemberExpressions.
 */
export type MemberBinding =
  | FieldBinding
  | GetterBinding
  | SetterBinding
  | MethodBinding
  | RecordFieldBinding;

// ============================================================
// Helper Functions
// ============================================================

/**
 * Check if a binding is a value binding (can be used in expressions).
 */
export const isValueBinding = (binding: ResolvedBinding): boolean => {
  switch (binding.kind) {
    case 'local':
    case 'global':
    case 'function':
    case 'class':
    case 'import':
    case 'field':
    case 'getter':
    case 'setter':
    case 'method':
    case 'record-field':
      return true;
    case 'interface':
    case 'mixin':
    case 'type-alias':
    case 'type-parameter':
      return false;
  }
};

/**
 * Check if a binding is a type binding (can be used in type annotations).
 */
export const isTypeBinding = (binding: ResolvedBinding): boolean => {
  switch (binding.kind) {
    case 'class':
    case 'interface':
    case 'mixin':
    case 'type-alias':
    case 'type-parameter':
    case 'import':
      return true;
    case 'local':
    case 'global':
    case 'function':
    case 'field':
    case 'getter':
    case 'setter':
    case 'method':
    case 'record-field':
      return false;
  }
};

/**
 * Follow import bindings to their ultimate target.
 */
export const resolveImport = (binding: ResolvedBinding): ResolvedBinding => {
  while (binding.kind === 'import') {
    binding = binding.target;
  }
  return binding;
};

/**
 * Get the declaration node from any binding.
 * Returns undefined for member bindings that don't have a declaration node.
 */
export const getDeclaration = (
  binding: ResolvedBinding,
):
  | Parameter
  | VariableDeclaration
  | EnumDeclaration
  | Identifier
  | FunctionExpression
  | DeclareFunction
  | ClassDeclaration
  | InterfaceDeclaration
  | MixinDeclaration
  | TypeAliasDeclaration
  | TypeParameter
  | ImportDeclaration
  | undefined => {
  switch (binding.kind) {
    case 'local':
      return binding.declaration;
    case 'global':
      return binding.declaration;
    case 'function':
      return binding.declaration;
    case 'class':
      return binding.declaration;
    case 'interface':
      return binding.declaration;
    case 'mixin':
      return binding.declaration;
    case 'type-alias':
      return binding.declaration;
    case 'type-parameter':
      return binding.declaration;
    case 'import':
      return binding.importDeclaration;
    case 'getter':
    case 'setter':
    case 'method':
    case 'field':
    case 'record-field':
      // Member bindings don't have a direct declaration node
      return undefined;
  }
};

// ============================================================
// Binding Creation
// ============================================================

/**
 * Information needed to create a binding from a resolved symbol.
 * This is the input to createBinding().
 */
export interface SymbolInfoForBinding {
  type: Type;
  kind: 'let' | 'var' | 'type';
  declaration?: Declaration;
  modulePath?: string;
}

/**
 * Options for binding creation.
 */
export interface CreateBindingOptions {
  /**
   * Whether this is a local variable (inside a function, block, etc.)
   * If not set, determined by whether modulePath is present.
   */
  isLocal?: boolean;
}

/**
 * Declaration types that can be associated with a symbol.
 */
type Declaration =
  | Parameter
  | VariableDeclaration
  | Identifier
  | FunctionExpression
  | DeclareFunction
  | ClassDeclaration
  | InterfaceDeclaration
  | MixinDeclaration
  | TypeAliasDeclaration
  | TypeParameter
  | EnumDeclaration;

/**
 * Create a ResolvedBinding from symbol information.
 *
 * This is used by the checker when resolving identifiers to create
 * the appropriate binding type based on what the name resolves to.
 *
 * @param info The symbol information from the checker's scope lookup
 * @param options Additional options for binding creation
 * @returns A ResolvedBinding, or undefined if the info is insufficient
 */
export const createBinding = (
  info: SymbolInfoForBinding,
  options: CreateBindingOptions = {},
): ResolvedBinding | undefined => {
  const {type, kind, declaration, modulePath} = info;
  const isLocal = options.isLocal ?? !modulePath;

  // Type declarations
  if (kind === 'type') {
    return createTypeBinding(type, declaration, modulePath);
  }

  // Value declarations
  return createValueBinding(type, declaration, modulePath, isLocal);
};

/**
 * Create a binding for a type declaration (class, interface, mixin, type alias).
 */
const createTypeBinding = (
  type: Type,
  declaration: Declaration | undefined,
  modulePath: string | undefined,
): ResolvedBinding | undefined => {
  switch (type.kind) {
    case 'Class': {
      if (!declaration) return undefined;
      return {
        kind: 'class',
        declaration: declaration as ClassDeclaration,
        modulePath: modulePath ?? '',
        type: type as ClassType,
      };
    }
    case 'Interface': {
      if (!declaration) return undefined;
      return {
        kind: 'interface',
        declaration: declaration as InterfaceDeclaration,
        modulePath: modulePath ?? '',
        type: type as InterfaceType,
      };
    }
    case 'Mixin': {
      if (!declaration) return undefined;
      return {
        kind: 'mixin',
        declaration: declaration as MixinDeclaration,
        modulePath: modulePath ?? '',
        type: type as MixinType,
      };
    }
    case 'TypeAlias': {
      if (!declaration) return undefined;
      return {
        kind: 'type-alias',
        declaration: declaration as TypeAliasDeclaration,
        modulePath: modulePath ?? '',
        type,
      };
    }
    case 'TypeParameter': {
      if (!declaration) return undefined;
      return {
        kind: 'type-parameter',
        declaration: declaration as TypeParameter,
        type: type as TypeParameterType,
      };
    }
    default:
      return undefined;
  }
};

/**
 * Create a binding for a value declaration (variable, function, class constructor).
 */
const createValueBinding = (
  type: Type,
  declaration: Declaration | undefined,
  modulePath: string | undefined,
  isLocal: boolean,
): ResolvedBinding | undefined => {
  // Functions (top-level or declared)
  if (type.kind === 'Function') {
    // Check if declaration is a function (not a variable holding a closure)
    if (
      declaration &&
      (declaration.type === 'FunctionExpression' ||
        declaration.type === 'DeclareFunction')
    ) {
      return {
        kind: 'function',
        declaration: declaration as FunctionExpression | DeclareFunction,
        modulePath: modulePath ?? '',
        type: type as FunctionType,
      };
    }
    // Check if it's a top-level variable with a function value (e.g., let foo = () => ...)
    // Only create function binding for module-level (non-local) functions
    if (
      !isLocal &&
      declaration &&
      declaration.type === 'VariableDeclaration' &&
      (declaration as VariableDeclaration).init?.type === 'FunctionExpression'
    ) {
      return {
        kind: 'function',
        declaration: (declaration as VariableDeclaration)
          .init as FunctionExpression,
        modulePath: modulePath ?? '',
        type: type as FunctionType,
      };
    }
    // Variable holding a function value - treat as local/global based on scope
  }

  // Classes in value position (used as constructors)
  if (type.kind === 'Class') {
    if (declaration && declaration.type === 'ClassDeclaration') {
      return {
        kind: 'class',
        declaration: declaration as ClassDeclaration,
        modulePath: modulePath ?? '',
        type: type as ClassType,
      };
    }
  }

  // Local variables and parameters
  if (isLocal) {
    if (!declaration) return undefined;
    if (
      declaration.type !== 'Parameter' &&
      declaration.type !== 'VariableDeclaration' &&
      declaration.type !== 'Identifier'
    ) {
      return undefined;
    }
    return {
      kind: 'local',
      declaration: declaration as Parameter | VariableDeclaration | Identifier,
      type,
    };
  }

  // Global variables and enums
  if (!declaration) return undefined;
  if (
    declaration.type !== 'VariableDeclaration' &&
    declaration.type !== 'EnumDeclaration'
  ) {
    return undefined;
  }
  return {
    kind: 'global',
    declaration: declaration as VariableDeclaration | EnumDeclaration,
    modulePath: modulePath ?? '',
    type,
  };
};
