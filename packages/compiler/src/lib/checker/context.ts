import {DiagnosticBag, DiagnosticCode} from '../diagnostics.js';
import {
  type Type,
  type ClassType,
  type InterfaceType,
  type MixinType,
  type FunctionType,
  Types,
  TypeNames,
  TypeKind,
} from '../types.js';
import type {
  ClassDeclaration,
  DeclareFunction,
  FunctionExpression,
  InterfaceDeclaration,
  MixinDeclaration,
  Parameter,
  Program,
  TypeAliasDeclaration,
  TypeParameter,
  VariableDeclaration,
} from '../ast.js';
import type {Compiler, Module} from '../compiler.js';

/**
 * Declaration types that can be associated with a symbol.
 * This enables tracking what AST node a name refers to.
 */
export type Declaration =
  | Parameter
  | VariableDeclaration
  | FunctionExpression
  | DeclareFunction
  | ClassDeclaration
  | InterfaceDeclaration
  | MixinDeclaration
  | TypeAliasDeclaration
  | TypeParameter;

export interface SymbolInfo {
  type: Type;
  kind: 'let' | 'var' | 'type';
  /**
   * The AST node that declares this symbol.
   * Optional for backward compatibility with existing code.
   */
  declaration?: Declaration;
  /**
   * The module path where this symbol is declared.
   * Set for top-level declarations to enable cross-module resolution.
   */
  modulePath?: string;
}

/**
 * Per-library state that gets reset when switching modules.
 * This is separate from the global type interning state.
 */
interface LibraryState {
  scopes: Map<string, SymbolInfo>[];
  diagnostics: DiagnosticBag;
  narrowedTypes: Map<string, Type>[];
  classStack: (ClassType | null)[];
  interfaceStack: (InterfaceType | null)[];
  currentFunctionReturnType: Type | null;
  currentClass: ClassType | null;
  currentInterface: InterfaceType | null;
  currentMethod: string | null;
  isThisInitialized: boolean;
  isCheckingFieldInitializer: boolean;
  initializedFields: Set<string>;
  inferredReturnTypes: Type[];
  usedPreludeSymbols: Map<string, {modulePath: string; exportName: string}>;
}

/**
 * Create fresh per-library state.
 */
const createLibraryState = (): LibraryState => ({
  scopes: [],
  diagnostics: new DiagnosticBag(),
  narrowedTypes: [],
  classStack: [],
  interfaceStack: [],
  currentFunctionReturnType: null,
  currentClass: null,
  currentInterface: null,
  currentMethod: null,
  isThisInitialized: true,
  isCheckingFieldInitializer: false,
  initializedFields: new Set(),
  inferredReturnTypes: [],
  usedPreludeSymbols: new Map(),
});

export class CheckerContext {
  // ============================================================
  // Per-library state (reset when switching modules)
  // ============================================================
  #lib: LibraryState = createLibraryState();

  // Convenience accessors for per-library state
  get scopes() {
    return this.#lib.scopes;
  }
  get diagnostics() {
    return this.#lib.diagnostics;
  }
  get currentFunctionReturnType() {
    return this.#lib.currentFunctionReturnType;
  }
  set currentFunctionReturnType(v: Type | null) {
    this.#lib.currentFunctionReturnType = v;
  }
  get currentClass() {
    return this.#lib.currentClass;
  }
  set currentClass(v: ClassType | null) {
    this.#lib.currentClass = v;
  }
  get currentInterface() {
    return this.#lib.currentInterface;
  }
  set currentInterface(v: InterfaceType | null) {
    this.#lib.currentInterface = v;
  }
  get currentMethod() {
    return this.#lib.currentMethod;
  }
  set currentMethod(v: string | null) {
    this.#lib.currentMethod = v;
  }
  get isThisInitialized() {
    return this.#lib.isThisInitialized;
  }
  set isThisInitialized(v: boolean) {
    this.#lib.isThisInitialized = v;
  }
  get isCheckingFieldInitializer() {
    return this.#lib.isCheckingFieldInitializer;
  }
  set isCheckingFieldInitializer(v: boolean) {
    this.#lib.isCheckingFieldInitializer = v;
  }
  get initializedFields() {
    return this.#lib.initializedFields;
  }
  set initializedFields(v: Set<string>) {
    this.#lib.initializedFields = v;
  }
  get inferredReturnTypes() {
    return this.#lib.inferredReturnTypes;
  }
  set inferredReturnTypes(v: Type[]) {
    this.#lib.inferredReturnTypes = v;
  }
  get usedPreludeSymbols() {
    return this.#lib.usedPreludeSymbols;
  }

  // ============================================================
  // Global state (shared across all modules)
  // ============================================================
  program!: Program;
  module?: Module;
  compiler?: Compiler;

  // Prelude support (global, populated once)
  preludeExports = new Map<
    string,
    {modulePath: string; exportName: string; info: SymbolInfo}
  >();

  /**
   * Type interning cache for generic instantiations.
   * Key format: "kind:genericSourceId|arg1Key,arg2Key,..."
   * This ensures that identical generic instantiations share the same object,
   * enabling identity-based type comparisons.
   *
   * GLOBAL: Shared across all modules for consistent type identity.
   */
  #internedTypes = new Map<string, Type>();

  /** Counter for assigning unique IDs to generic source types (GLOBAL) */
  #typeIdCounter = 0;

  /** Map from generic source types to their unique IDs (GLOBAL) */
  #typeIds = new WeakMap<Type, number>();

  constructor(compiler?: Compiler) {
    this.compiler = compiler;
  }

  /**
   * Switch to a new library/module for type checking.
   * Resets per-library state while preserving global type interning.
   */
  setCurrentLibrary(module: Module): void {
    this.module = module;
    this.program = module.ast;
    this.#lib = createLibraryState();
  }

  enterClass(classType: ClassType) {
    this.#lib.classStack.push(this.currentClass);
    // For generic classes, set typeArguments = typeParameters so that
    // ctx.currentClass and 'this' type are consistent (both represent Foo<T>).
    // This avoids special-case handling in isAssignableTo for self-referential types.
    // We also set genericSource to preserve type identity when comparing.
    if (
      classType.typeParameters &&
      classType.typeParameters.length > 0 &&
      !classType.typeArguments
    ) {
      this.currentClass = {
        ...classType,
        typeArguments: classType.typeParameters,
        genericSource: classType,
      };
    } else {
      this.currentClass = classType;
    }
  }

  exitClass() {
    this.currentClass = this.#lib.classStack.pop() || null;
  }

  enterInterface(interfaceType: InterfaceType) {
    this.#lib.interfaceStack.push(this.currentInterface);
    // For generic interfaces, set typeArguments = typeParameters so that
    // `this` type is consistent (represents Interface<T>).
    // We also set genericSource to preserve type identity when comparing.
    if (
      interfaceType.typeParameters &&
      interfaceType.typeParameters.length > 0 &&
      !interfaceType.typeArguments
    ) {
      this.currentInterface = {
        ...interfaceType,
        typeArguments: interfaceType.typeParameters,
        genericSource: interfaceType,
      };
    } else {
      this.currentInterface = interfaceType;
    }
  }

  exitInterface() {
    this.currentInterface = this.#lib.interfaceStack.pop() || null;
  }

  enterScope() {
    this.scopes.push(new Map());
    this.#lib.narrowedTypes.push(new Map());
  }

  exitScope() {
    this.scopes.pop();
    this.#lib.narrowedTypes.pop();
  }

  /**
   * Narrow a variable's type in the current scope.
   * This is used for control flow-based type narrowing (e.g., after null checks).
   */
  narrowType(name: string, type: Type) {
    const narrowings =
      this.#lib.narrowedTypes[this.#lib.narrowedTypes.length - 1];
    if (narrowings) {
      narrowings.set(name, type);
    }
  }

  /**
   * Get the narrowed type for a variable, if any.
   */
  getNarrowedType(name: string): Type | undefined {
    // Check from innermost scope outward
    for (let i = this.#lib.narrowedTypes.length - 1; i >= 0; i--) {
      const narrowings = this.#lib.narrowedTypes[i];
      if (narrowings.has(name)) {
        return narrowings.get(name);
      }
    }
    return undefined;
  }

  /**
   * Declare a symbol in the current scope.
   *
   * @param name The symbol name
   * @param type The semantic type
   * @param kind 'let' for immutable values, 'var' for mutable, 'type' for type declarations
   * @param declaration Optional AST node that declares this symbol
   */
  declare(
    name: string,
    type: Type,
    kind: 'let' | 'var' | 'type' = 'let',
    declaration?: Declaration,
  ) {
    const scope = this.scopes[this.scopes.length - 1];
    const key = kind === 'type' ? `type:${name}` : `value:${name}`;

    if (scope.has(key)) {
      const existing = scope.get(key)!;
      // Allow overloading for functions
      if (
        existing.kind === 'let' &&
        kind === 'let' &&
        existing.type.kind === 'Function' &&
        type.kind === 'Function'
      ) {
        const existingFunc = existing.type as FunctionType;
        const newFunc = type as FunctionType;
        if (!existingFunc.overloads) {
          existingFunc.overloads = [];
        }
        existingFunc.overloads.push(newFunc);
        return;
      }

      this.diagnostics.reportError(
        `Variable '${name}' is already declared in this scope.`,
        DiagnosticCode.DuplicateDeclaration,
      );
      return;
    }

    const info: SymbolInfo = {type, kind};
    if (declaration) {
      info.declaration = declaration;
    }
    // Track module path for top-level declarations
    if (this.module && this.scopes.length === 1) {
      info.modulePath = this.module.path;
    }
    scope.set(key, info);
  }

  /**
   * Resolve a value name and return the full SymbolInfo.
   * Unlike resolveValue() which returns only the Type, this returns
   * the full symbol info including the declaration (if tracked).
   */
  resolveValueInfo(name: string): SymbolInfo | undefined {
    const key = `value:${name}`;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(key)) {
        return this.scopes[i].get(key);
      }
    }

    // Check prelude
    if (this.preludeExports.has(key)) {
      const exportInfo = this.preludeExports.get(key)!;
      this.usedPreludeSymbols.set(key, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info;
    }

    // Fallback for legacy/unmangled prelude exports
    if (this.preludeExports.has(name)) {
      const exportInfo = this.preludeExports.get(name)!;
      if (exportInfo.info.kind !== 'type') {
        this.usedPreludeSymbols.set(name, {
          modulePath: exportInfo.modulePath,
          exportName: exportInfo.exportName,
        });
        return exportInfo.info;
      }
    }

    return undefined;
  }

  resolveValue(name: string): Type | undefined {
    // Check for narrowed type first (control-flow narrowing)
    const narrowedType = this.getNarrowedType(name);
    if (narrowedType !== undefined) {
      return narrowedType;
    }

    const key = `value:${name}`;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(key)) {
        return this.scopes[i].get(key)!.type;
      }
    }

    // Check prelude
    if (this.preludeExports.has(key)) {
      const exportInfo = this.preludeExports.get(key)!;
      this.usedPreludeSymbols.set(key, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info.type;
    }

    // Fallback for legacy/unmangled prelude exports
    if (this.preludeExports.has(name)) {
      const exportInfo = this.preludeExports.get(name)!;
      if (exportInfo.info.kind !== 'type') {
        this.usedPreludeSymbols.set(name, {
          modulePath: exportInfo.modulePath,
          exportName: exportInfo.exportName,
        });
        return exportInfo.info.type;
      }
    }

    return undefined;
  }

  /**
   * Resolve a type name, checking only local scopes (not prelude).
   * Use this when you need to check if a type is already declared locally.
   */
  resolveTypeLocal(name: string): Type | undefined {
    const key = `type:${name}`;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(key)) {
        return this.scopes[i].get(key)!.type;
      }
    }
    return undefined;
  }

  resolveType(name: string): Type | undefined {
    const key = `type:${name}`;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(key)) {
        return this.scopes[i].get(key)!.type;
      }
    }

    // Check prelude
    if (this.preludeExports.has(key)) {
      const exportInfo = this.preludeExports.get(key)!;
      this.usedPreludeSymbols.set(key, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info.type;
    }

    // Fallback for legacy/unmangled prelude exports
    if (this.preludeExports.has(name)) {
      const exportInfo = this.preludeExports.get(name)!;
      if (exportInfo.info.kind === 'type') {
        this.usedPreludeSymbols.set(name, {
          modulePath: exportInfo.modulePath,
          exportName: exportInfo.exportName,
        });
        return exportInfo.info.type;
      }
    }

    // Built-in types (implicitly global)
    switch (name) {
      case Types.I32.name:
        return Types.I32;
      case Types.U32.name:
        return Types.U32;
      case Types.I64.name:
        return Types.I64;
      case Types.F32.name:
        return Types.F32;
      case Types.F64.name:
        return Types.F64;
      case TypeNames.Boolean:
        return Types.Boolean;
      case 'symbol':
        return Types.Symbol;
      case TypeNames.AnyRef:
        return Types.AnyRef;
      case TypeNames.Any:
        return Types.Any;
      case TypeNames.String: {
        // 'string' is an alias for the 'String' class if it exists in scope
        const stringType = this.resolveType(Types.String.name);
        if (stringType) return stringType;

        const wellKnown = this.getWellKnownType(Types.String.name);
        return wellKnown || Types.String;
      }
      case TypeKind.ByteArray:
        return Types.ByteArray;
      case TypeNames.Void:
        return Types.Void;
      case TypeNames.Never:
        return Types.Never;
      case TypeNames.Null:
        return Types.Null;
      case TypeNames.Array:
        // Return the base array type. Generic instantiation happens in
        // resolveTypeAnnotation.
        return Types.Array;
    }

    return undefined;
  }

  resolveInfo(name: string): SymbolInfo | undefined {
    // Try value first, then type? Or return both?
    // This method is used for finding symbol info, usually for values.
    // Let's check usage.
    const valueKey = `value:${name}`;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(valueKey)) {
        return this.scopes[i].get(valueKey)!;
      }
    }

    const typeKey = `type:${name}`;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(typeKey)) {
        return this.scopes[i].get(typeKey)!;
      }
    }

    // Check prelude
    if (this.preludeExports.has(valueKey)) {
      const exportInfo = this.preludeExports.get(valueKey)!;
      this.usedPreludeSymbols.set(valueKey, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info;
    }

    if (this.preludeExports.has(typeKey)) {
      const exportInfo = this.preludeExports.get(typeKey)!;
      this.usedPreludeSymbols.set(typeKey, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info;
    }

    // Check prelude (legacy)
    if (this.preludeExports.has(name)) {
      const exportInfo = this.preludeExports.get(name)!;
      this.usedPreludeSymbols.set(name, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info;
    }

    return undefined;
  }

  /**
   * Canonical locations for well-known types.
   * These types have special semantics in the language and must come from specific modules.
   */
  static readonly WELL_KNOWN_TYPE_MODULES: ReadonlyMap<string, string> =
    new Map([
      [Types.String.name, 'zena:string'],
      [TypeNames.FixedArray, 'zena:fixed-array'],
    ]);

  getWellKnownType(name: string): Type | undefined {
    // Check bundled well-known types first (already resolved during bundling)
    if (
      name === Types.String.name &&
      this.program.wellKnownTypes?.String?.inferredType
    ) {
      return this.program.wellKnownTypes.String.inferredType;
    }
    if (
      name === TypeNames.FixedArray &&
      this.program.wellKnownTypes?.FixedArray?.inferredType
    ) {
      return this.program.wellKnownTypes.FixedArray.inferredType;
    }

    // Look up from canonical module location
    if (!this.compiler) return undefined;

    const modulePath = CheckerContext.WELL_KNOWN_TYPE_MODULES.get(name);
    if (!modulePath) return undefined;

    const module = this.compiler.getModule(modulePath);
    if (!module) return undefined;

    const symbol = module.exports.get(`type:${name}`);
    if (symbol) {
      // Record usage so it gets injected/bundled
      this.usedPreludeSymbols.set(`type:${name}`, {
        modulePath,
        exportName: name,
      });
      return symbol.type;
    }
    return undefined;
  }

  // ============================================================
  // Type Interning
  // ============================================================

  /**
   * Get a unique ID for a type, assigning one if necessary.
   * Used as part of the interning key to avoid name-based lookups.
   */
  getTypeId(type: Type): number {
    let id = this.#typeIds.get(type);
    if (id === undefined) {
      id = this.#typeIdCounter++;
      this.#typeIds.set(type, id);
    }
    return id;
  }

  /**
   * Compute a canonical string key for a type, used for interning.
   * This key must be stable and unique for structurally identical types.
   */
  computeTypeKey(type: Type): string {
    switch (type.kind) {
      case TypeKind.Number:
        // Number types differ by name (i32, f32, i64, f64, etc.)
        return `N:${(type as import('../types.js').NumberType).name}`;
      case TypeKind.Boolean:
      case TypeKind.Void:
      case TypeKind.Null:
      case TypeKind.Never:
      case TypeKind.Any:
      case TypeKind.AnyRef:
      case TypeKind.ByteArray:
      case TypeKind.Symbol:
      case TypeKind.This:
        // Primitive/singleton types use their kind as key
        return type.kind;
      case TypeKind.TypeParameter:
        // Type parameters are identified by name within their scope
        return `TP:${(type as import('../types.js').TypeParameterType).name}`;
      case TypeKind.Class: {
        const ct = type as ClassType;
        // Use the canonical (root) type's ID to handle genericSource chains
        const sourceType = ct.genericSource ?? ct;
        const sourceId = this.getTypeId(sourceType);
        if (ct.typeArguments && ct.typeArguments.length > 0) {
          const argKeys = ct.typeArguments
            .map((a) => this.computeTypeKey(a))
            .join(',');
          return `C:${sourceId}<${argKeys}>`;
        }
        return `C:${sourceId}`;
      }
      case TypeKind.Interface: {
        const it = type as InterfaceType;
        const sourceType = it.genericSource ?? it;
        const sourceId = this.getTypeId(sourceType);
        if (it.typeArguments && it.typeArguments.length > 0) {
          const argKeys = it.typeArguments
            .map((a) => this.computeTypeKey(a))
            .join(',');
          return `I:${sourceId}<${argKeys}>`;
        }
        return `I:${sourceId}`;
      }
      case TypeKind.Mixin: {
        const mt = type as MixinType;
        const sourceType = mt.genericSource ?? mt;
        const sourceId = this.getTypeId(sourceType);
        if (mt.typeArguments && mt.typeArguments.length > 0) {
          const argKeys = mt.typeArguments
            .map((a) => this.computeTypeKey(a))
            .join(',');
          return `M:${sourceId}<${argKeys}>`;
        }
        return `M:${sourceId}`;
      }
      case TypeKind.Array: {
        const at = type as import('../types.js').ArrayType;
        return `A:${this.computeTypeKey(at.elementType)}`;
      }
      case TypeKind.Tuple: {
        const tt = type as import('../types.js').TupleType;
        const elemKeys = tt.elementTypes
          .map((e) => this.computeTypeKey(e))
          .join(',');
        return `T:[${elemKeys}]`;
      }
      case TypeKind.Record: {
        const rt = type as import('../types.js').RecordType;
        const propKeys = Array.from(rt.properties.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}:${this.computeTypeKey(v)}`)
          .join(',');
        return `R:{${propKeys}}`;
      }
      case TypeKind.Function: {
        const ft = type as FunctionType;
        const paramKeys = ft.parameters
          .map((p) => this.computeTypeKey(p))
          .join(',');
        const retKey = this.computeTypeKey(ft.returnType);
        return `F:(${paramKeys})=>${retKey}`;
      }
      case TypeKind.Union: {
        const ut = type as import('../types.js').UnionType;
        // Sort union members for canonical representation
        const memberKeys = ut.types
          .map((t) => this.computeTypeKey(t))
          .sort()
          .join('|');
        return `U:(${memberKeys})`;
      }
      case TypeKind.Literal: {
        const lt = type as import('../types.js').LiteralType;
        return `L:${JSON.stringify(lt.value)}`;
      }
      case TypeKind.TypeAlias: {
        const ta = type as import('../types.js').TypeAliasType;
        // For distinct type aliases, preserve the alias identity in the key
        // This ensures Box<Meters> and Box<Seconds> are different types
        // even if both resolve to i32 structurally
        if (ta.isDistinct) {
          // Use the alias's own ID to distinguish it from other distinct types
          const aliasId = this.getTypeId(ta);
          return `TA:${aliasId}`;
        }
        // Regular type aliases resolve to their target for structural comparison
        return this.computeTypeKey(ta.target);
      }
      default:
        // Fallback to type kind
        return type.kind;
    }
  }

  /**
   * Get an interned generic class instantiation, or undefined if not cached.
   */
  getInternedClass(
    genericSource: ClassType,
    typeArguments: Type[],
  ): ClassType | undefined {
    const key = this.computeInstantiationKey('C', genericSource, typeArguments);
    return this.#internedTypes.get(key) as ClassType | undefined;
  }

  /**
   * Store an interned generic class instantiation.
   */
  internClass(
    genericSource: ClassType,
    typeArguments: Type[],
    instance: ClassType,
  ): void {
    const key = this.computeInstantiationKey('C', genericSource, typeArguments);
    this.#internedTypes.set(key, instance);
  }

  /**
   * Get an interned generic interface instantiation, or undefined if not cached.
   */
  getInternedInterface(
    genericSource: InterfaceType,
    typeArguments: Type[],
  ): InterfaceType | undefined {
    const key = this.computeInstantiationKey('I', genericSource, typeArguments);
    return this.#internedTypes.get(key) as InterfaceType | undefined;
  }

  /**
   * Store an interned generic interface instantiation.
   */
  internInterface(
    genericSource: InterfaceType,
    typeArguments: Type[],
    instance: InterfaceType,
  ): void {
    const key = this.computeInstantiationKey('I', genericSource, typeArguments);
    this.#internedTypes.set(key, instance);
  }

  /**
   * Get an interned generic mixin instantiation, or undefined if not cached.
   */
  getInternedMixin(
    genericSource: MixinType,
    typeArguments: Type[],
  ): MixinType | undefined {
    const key = this.computeInstantiationKey('M', genericSource, typeArguments);
    return this.#internedTypes.get(key) as MixinType | undefined;
  }

  /**
   * Store an interned generic mixin instantiation.
   */
  internMixin(
    genericSource: MixinType,
    typeArguments: Type[],
    instance: MixinType,
  ): void {
    const key = this.computeInstantiationKey('M', genericSource, typeArguments);
    this.#internedTypes.set(key, instance);
  }

  /**
   * Compute interning key for a generic instantiation.
   */
  private computeInstantiationKey(
    prefix: string,
    genericSource: Type,
    typeArguments: Type[],
  ): string {
    const sourceId = this.getTypeId(genericSource);
    const argKeys = typeArguments.map((a) => this.computeTypeKey(a)).join(',');
    return `${prefix}:${sourceId}<${argKeys}>`;
  }
}
