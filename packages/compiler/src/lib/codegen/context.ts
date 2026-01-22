import {
  NodeType,
  type ClassDeclaration,
  type FunctionExpression,
  type MethodDefinition,
  type MixinDeclaration,
  type Node,
  type Program,
  type TaggedTemplateExpression,
  type TypeAnnotation,
} from '../ast.js';
import {SemanticContext} from '../checker/semantic-context.js';
import {
  DiagnosticBag,
  DiagnosticCode,
  type DiagnosticLocation,
} from '../diagnostics.js';
import {WasmModule} from '../emitter.js';
import {
  type ClassType,
  type FunctionType,
  type InterfaceType,
} from '../types.js';
import {ValType} from '../wasm.js';
import type {ClassInfo, InterfaceInfo, LocalInfo} from './types.js';

/**
 * Saved function context state for nested function generation.
 * Used by trampolines and other nested code generation scenarios.
 */
export interface FunctionContextState {
  scopes: Map<string, LocalInfo>[];
  extraLocals: number[][];
  nextLocalIndex: number;
  thisLocalIndex: number;
}

/**
 * CodegenContext manages state during WASM code generation.
 *
 * ## Scope Model
 *
 * This class manages two distinct but related concepts:
 *
 * ### Lexical Scopes (`pushScope()` / `popScope()`)
 * Zena has block-level lexical scoping for variable name resolution. When you
 * write `{ let x = 1; }`, the `x` binding is only visible within that block.
 * Nested blocks can shadow outer bindings.
 *
 * ### WASM Function Contexts (`pushFunctionScope()` / `saveFunctionContext()`)
 * WASM has function-level local allocation. All locals for a function must be
 * declared upfront in the function header—there's no concept of "block-local"
 * variables in WASM itself.
 *
 * For example:
 * ```zena
 * const foo = () => {
 *   let x = 1;        // WASM local 0
 *   {
 *     let y = 2;      // WASM local 1
 *     let x = 3;      // WASM local 2 (shadows outer x in Zena)
 *   }
 *   // x refers to WASM local 0 again
 * };
 * ```
 *
 * All three variables become WASM locals (0, 1, 2). The lexical scope only
 * affects which local index a name resolves to, not local allocation.
 *
 * ### Why Block Scopes Don't Reset Local Indices
 *
 * When entering a block, we push a new lexical scope but continue allocating
 * locals from the current `nextLocalIndex`. This is simpler than local slot
 * reuse (where exiting a block would free its locals for reuse) and ensures
 * outer scope variables remain valid.
 *
 * Local slot reuse is a potential future optimization—see optimization-strategy.md.
 *
 * ### When to Use Each
 *
 * - `pushScope()`: Entering a Zena lexical block (if, while, match arm, etc.)
 *   within the same WASM function.
 * - `pushFunctionScope()`: Starting code generation for a new WASM function.
 *   Each WASM function has its own local index space starting at 0.
 * - `saveFunctionContext()` / `restoreFunctionContext()`: Temporarily generating
 *   a nested WASM function (trampolines, closures) while preserving outer state.
 */
export class CodegenContext {
  public module: WasmModule;
  public program: Program;
  public diagnostics = new DiagnosticBag();

  /**
   * Semantic context for type → struct index lookups.
   * Populated during codegen and used to resolve types by object identity.
   */
  public semanticContext: SemanticContext;

  /** File name used for diagnostic locations */
  public fileName = '<anonymous>';

  /**
   * Stack of lexical scopes for variable name resolution.
   * Each scope maps variable names to their local info (index + type).
   * Pushed/popped for blocks; replaced entirely for new functions.
   */
  public scopes: Map<string, LocalInfo>[] = [];
  #extraLocals: number[][] = [];
  #nextLocalIndex = 0;
  #thisLocalIndex = 0;
  public functions = new Map<string, number>();
  public functionOverloads = new Map<
    string,
    {
      index: number;
      params: number[][];
      intrinsic?: string;
      type?: FunctionType;
    }[]
  >();
  public classes = new Map<string, ClassInfo>();
  public mixins = new Map<string, MixinDeclaration>();
  public interfaces = new Map<string, InterfaceInfo>();
  public typeAliases = new Map<string, TypeAnnotation>();

  // Exception handling
  public exceptionTagIndex = -1;
  public exceptionPayloadGlobalIndex = -1;

  // Current state
  public currentClass: ClassInfo | null = null;
  public currentTypeContext: Map<string, TypeAnnotation> | undefined;
  public currentReturnType: number[] | undefined;

  // Type management
  public arrayTypes = new Map<string, number>(); // elementTypeString -> typeIndex
  public stringTypeIndex = -1;
  public byteArrayTypeIndex = -1;
  public stringLiterals = new Map<string, number>(); // content -> dataIndex

  // Deferred generation
  public pendingHelperFunctions: (() => void)[] = [];
  public concatFunctionIndex = -1;
  public strEqFunctionIndex = -1;
  public stringHashFunctionIndex = -1;
  public byteArrayGetFunctionIndex = -1; // Exported helper for JS to read ByteArray
  public stringGetByteFunctionIndex = -1; // Exported helper for JS to read String bytes
  public genericClasses = new Map<string, ClassDeclaration>();
  public genericFunctions = new Map<string, FunctionExpression>();
  public genericMethods = new Map<string, MethodDefinition>();
  public functionReturnTypes = new Map<string, number[]>();
  public pendingMethodGenerations: (() => void)[] = [];
  public bodyGenerators: (() => void)[] = [];
  public syntheticClasses: ClassDeclaration[] = [];
  public isGeneratingBodies = false;

  // Global variables
  public globals = new Map<string, {index: number; type: number[]}>();
  public globalIntrinsics = new Map<string, string>();

  // Well-known types (renamed)
  public wellKnownTypes: {
    FixedArray?: ClassDeclaration;
    String?: ClassDeclaration;
    Box?: ClassDeclaration;
    TemplateStringsArray?: ClassDeclaration;
  } = {};

  // Records and Tuples
  public recordTypes = new Map<string, number>(); // canonicalKey -> typeIndex
  public tupleTypes = new Map<string, number>(); // canonicalKey -> typeIndex
  public closureTypes = new Map<string, number>(); // signature -> structTypeIndex
  public closureStructs = new Map<number, {funcTypeIndex: number}>(); // structTypeIndex -> info
  public enums = new Map<number, {members: Map<string, number>}>(); // structTypeIndex -> info

  // Type → WASM struct index mappings (emitter-specific, keyed by checker types)
  readonly #classStructIndices = new Map<ClassType, number>();
  readonly #interfaceStructIndices = new Map<InterfaceType, number>();
  readonly #structIndexToClass = new Map<number, ClassType>();
  readonly #structIndexToInterface = new Map<number, InterfaceType>();

  // Identity-based lookup infrastructure (Round 2.5 refactoring)
  // Maps checker types to their bundled names for lookup
  readonly #classBundledNames = new Map<ClassType, string>();
  readonly #interfaceBundledNames = new Map<InterfaceType, string>();
  // Maps generic class declarations to their ClassType
  readonly #genericTemplates = new Map<string, ClassType>();
  // Maps generic specializations: "TemplateName|arg1,arg2" -> ClassInfo
  // @deprecated Use #classInfoByType for identity-based lookups
  readonly #genericSpecializations = new Map<string, ClassInfo>();
  // Identity-based specialization lookup: ClassType -> ClassInfo
  // With type interning in the checker, identical instantiations share the
  // same ClassType object, so we can use a WeakMap for O(1) lookup.
  readonly #classInfoByType = new WeakMap<ClassType, ClassInfo>();

  // Template Literals
  public templateLiteralGlobals = new Map<TaggedTemplateExpression, number>();

  constructor(program: Program, semanticContext?: SemanticContext) {
    this.program = program;
    this.semanticContext = semanticContext ?? new SemanticContext();
    if (program.wellKnownTypes) {
      this.wellKnownTypes = program.wellKnownTypes;
    }
    this.module = new WasmModule();
    // Define backing array type: array<i8> (mutable for construction)
    this.byteArrayTypeIndex = this.module.addArrayType([ValType.i8], true);

    // Pre-initialize String struct type so that declared functions can use string params.
    // The String class definition in the prelude will reuse this type index.
    // String is now an extension class on ByteArray, so it shares the same type index.
    this.stringTypeIndex = this.byteArrayTypeIndex;
  }

  // ===== Local Index Management =====
  // These fields track state for the current WASM function being generated.
  // They are reset by pushFunctionScope() when starting a new function.

  /**
   * Get the extra locals declared during function body generation.
   * These are locals beyond the function parameters, accumulated as
   * variables are declared in the function body.
   */
  get extraLocals(): number[][] {
    return this.#extraLocals;
  }

  /**
   * Get the next available local index for the current WASM function.
   * Starts at 0 (or paramCount) after pushFunctionScope() and increments
   * monotonically as locals are declared.
   */
  get nextLocalIndex(): number {
    return this.#nextLocalIndex;
  }

  /**
   * Get the local index where 'this' is stored for the current method.
   * Usually 0 (first parameter), but may change when downcasting 'this'
   * to a more specific type.
   */
  get thisLocalIndex(): number {
    return this.#thisLocalIndex;
  }

  /**
   * Set the local index for 'this'. Used when downcasting 'this' to a subtype.
   */
  set thisLocalIndex(index: number) {
    this.#thisLocalIndex = index;
  }

  // ===== Scope Management =====

  /**
   * Push a new lexical scope for variable name resolution.
   *
   * Use this when entering a Zena block that can introduce new bindings
   * (blocks, loops, if/else, match arms, try/catch, etc.).
   *
   * This does NOT reset local indices—locals continue to accumulate within
   * the same WASM function. The scope only affects which local a name resolves to.
   */
  public pushScope() {
    this.scopes.push(new Map());
  }

  /**
   * Start generating a new WASM function.
   *
   * This resets all function-local state:
   * - Scopes: Replaced with a single fresh scope
   * - extraLocals: Cleared (new function has no body locals yet)
   * - nextLocalIndex: Reset to paramCount (locals 0..paramCount-1 are params)
   * - thisLocalIndex: Reset to 0 (default for methods)
   *
   * Unlike pushScope(), this starts fresh—it doesn't nest within the current
   * function's scope stack. Each WASM function has its own local index space.
   *
   * @param paramCount - Number of parameters. Sets nextLocalIndex so body
   *   locals start after parameters. Default 0 for functions with no params.
   */
  public pushFunctionScope(paramCount = 0) {
    this.scopes = [new Map()];
    this.#extraLocals = [];
    this.#nextLocalIndex = paramCount;
    this.#thisLocalIndex = 0;
  }

  /**
   * Save the current function context state. Use this when generating
   * nested functions (like trampolines) that need to restore the outer
   * function's state after completion.
   */
  public saveFunctionContext(): FunctionContextState {
    return {
      scopes: this.scopes,
      extraLocals: this.#extraLocals,
      nextLocalIndex: this.#nextLocalIndex,
      thisLocalIndex: this.#thisLocalIndex,
    };
  }

  /**
   * Restore a previously saved function context state.
   */
  public restoreFunctionContext(state: FunctionContextState) {
    this.scopes = state.scopes;
    this.#extraLocals = state.extraLocals;
    this.#nextLocalIndex = state.nextLocalIndex;
    this.#thisLocalIndex = state.thisLocalIndex;
  }

  public popScope() {
    this.scopes.pop();
  }

  /**
   * Define a local variable that was already allocated (e.g., function parameters).
   * Use this when the local index is already known.
   * @deprecated Use defineParam() for parameters or declareLocal() for new locals.
   */
  public defineLocal(name: string, index: number, type: number[]) {
    this.scopes[this.scopes.length - 1].set(name, {index, type});
  }

  /**
   * Define a function parameter. This allocates the next local index and
   * registers the parameter in the current scope.
   */
  public defineParam(name: string, type: number[]): number {
    const index = this.#nextLocalIndex++;
    this.scopes[this.scopes.length - 1].set(name, {index, type});
    return index;
  }

  public getLocal(name: string): LocalInfo | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) {
        return this.scopes[i].get(name);
      }
    }
    return undefined;
  }

  /**
   * Declare a new local variable within the current function body.
   * This allocates a new local index and registers it in the extra locals.
   */
  public declareLocal(name: string, type: number[] = [ValType.i32]): number {
    const index = this.#nextLocalIndex++;
    this.scopes[this.scopes.length - 1].set(name, {index, type});
    this.#extraLocals.push(type);
    return index;
  }

  public getArrayTypeIndex(elementType: number[]): number {
    const key = elementType.join(',');
    if (this.arrayTypes.has(key)) {
      return this.arrayTypes.get(key)!;
    }
    const index = this.module.addArrayType(elementType, true);
    this.arrayTypes.set(key, index);
    return index;
  }

  public defineGlobal(name: string, index: number, type: number[]) {
    this.globals.set(name, {index, type});
  }

  public getGlobal(name: string): {index: number; type: number[]} | undefined {
    return this.globals.get(name);
  }

  // ===== Type → Struct Index Management (WASM-specific) =====
  // These maps store WASM binary emitter state, keyed by checker types.
  // Using object identity ensures stable lookups regardless of name changes.

  /**
   * Register a class type's WASM struct index.
   * Called during code generation when a class struct is created.
   */
  public setClassStructIndex(classType: ClassType, structIndex: number): void {
    this.#classStructIndices.set(classType, structIndex);
    this.#structIndexToClass.set(structIndex, classType);
  }

  /**
   * Get the WASM struct index for a class type.
   */
  public getClassStructIndex(classType: ClassType): number | undefined {
    return this.#classStructIndices.get(classType);
  }

  /**
   * Get the ClassType for a struct index.
   */
  public getClassByStructIndex(structIndex: number): ClassType | undefined {
    return this.#structIndexToClass.get(structIndex);
  }

  /**
   * Register an interface type's WASM struct index.
   */
  public setInterfaceStructIndex(
    interfaceType: InterfaceType,
    structIndex: number,
  ): void {
    this.#interfaceStructIndices.set(interfaceType, structIndex);
    this.#structIndexToInterface.set(structIndex, interfaceType);
  }

  /**
   * Get the WASM struct index for an interface type.
   */
  public getInterfaceStructIndex(
    interfaceType: InterfaceType,
  ): number | undefined {
    return this.#interfaceStructIndices.get(interfaceType);
  }

  /**
   * Get the InterfaceType for a struct index.
   */
  public getInterfaceByStructIndex(
    structIndex: number,
  ): InterfaceType | undefined {
    return this.#structIndexToInterface.get(structIndex);
  }

  // ===== Identity-Based Lookup Methods (Round 2.5 refactoring) =====
  // These methods support looking up ClassInfo by checker type identity,
  // enabling us to remove bundler name mutation and suffix-based lookups.
  //
  // mapCheckerTypeToWasmType() uses these for:
  // - Non-generic classes/interfaces (via struct index maps)
  // - Generic class specializations (via specialization registry)
  // - Generic extension classes (via onTypeAnnotation recomputation)
  //
  // See docs/design/compiler-refactoring.md Step 2.5.6 for full details.

  /**
   * Register the bundled name for a checker ClassType.
   * Called during class registration to track the name mapping.
   */
  public setClassBundledName(classType: ClassType, bundledName: string): void {
    this.#classBundledNames.set(classType, bundledName);
  }

  /**
   * Get the bundled name for a checker ClassType.
   */
  public getClassBundledName(classType: ClassType): string | undefined {
    return this.#classBundledNames.get(classType);
  }

  /**
   * Register the bundled name for a checker InterfaceType.
   * Called during interface registration to track the name mapping.
   */
  public setInterfaceBundledName(
    interfaceType: InterfaceType,
    bundledName: string,
  ): void {
    this.#interfaceBundledNames.set(interfaceType, bundledName);
  }

  /**
   * Get the bundled name for a checker InterfaceType.
   */
  public getInterfaceBundledName(
    interfaceType: InterfaceType,
  ): string | undefined {
    return this.#interfaceBundledNames.get(interfaceType);
  }

  /**
   * Register a generic class template's checker type.
   * Called when a generic class declaration is first seen.
   */
  public setGenericTemplate(name: string, classType: ClassType): void {
    this.#genericTemplates.set(name, classType);
  }

  /**
   * Get the checker ClassType for a generic class template.
   */
  public getGenericTemplate(name: string): ClassType | undefined {
    return this.#genericTemplates.get(name);
  }

  /**
   * Register a generic specialization.
   * Key format: "TemplateName|TypeArg1,TypeArg2"
   *
   * @deprecated Use registerClassInfoByType for identity-based registration
   */
  public registerGenericSpecialization(
    key: string,
    classInfo: ClassInfo,
  ): void {
    this.#genericSpecializations.set(key, classInfo);
  }

  /**
   * Find a generic specialization by key.
   *
   * @deprecated Use getClassInfoByCheckerType for identity-based lookup
   */
  public findGenericSpecialization(key: string): ClassInfo | undefined {
    return this.#genericSpecializations.get(key);
  }

  /**
   * Register a ClassInfo by its checker ClassType for identity-based lookup.
   * With type interning, identical instantiations share the same ClassType
   * object, so this provides O(1) lookup without string key computation.
   */
  public registerClassInfoByType(
    classType: ClassType,
    classInfo: ClassInfo,
  ): void {
    this.#classInfoByType.set(classType, classInfo);
  }

  /**
   * Look up a ClassInfo by its checker ClassType using identity.
   * This is the preferred lookup method when you have a ClassType from the checker.
   *
   * Returns undefined if not found - caller should fall back to other lookups
   * or the type hasn't been registered yet.
   */
  public getClassInfoByCheckerType(
    classType: ClassType,
  ): ClassInfo | undefined {
    return this.#classInfoByType.get(classType);
  }

  public getRecordTypeIndex(fields: {name: string; type: number[]}[]): number {
    // Sort fields by name to canonicalize
    const sortedFields = [...fields].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const key = sortedFields
      .map((f) => `${f.name}:${f.type.join(',')}`)
      .join(';');

    if (this.recordTypes.has(key)) {
      return this.recordTypes.get(key)!;
    }

    // Create struct type
    // (struct (field $name type) ...)
    const structFields = sortedFields.map((f) => ({
      type: f.type,
      mutable: false, // Shallowly immutable
    }));

    const index = this.module.addStructType(structFields);
    this.recordTypes.set(key, index);
    return index;
  }

  public getTupleTypeIndex(types: number[][]): number {
    const key = types.map((t) => t.join(',')).join(';');

    if (this.tupleTypes.has(key)) {
      return this.tupleTypes.get(key)!;
    }

    // Create struct type
    // (struct (field type) ...)
    const structFields = types.map((t) => ({
      type: t,
      mutable: false, // Shallowly immutable
    }));

    const index = this.module.addStructType(structFields);
    this.tupleTypes.set(key, index);
    return index;
  }

  public getClosureTypeIndex(
    paramTypes: number[][],
    returnType: number[],
  ): number {
    const key = `(${paramTypes.map((t) => t.join(',')).join(',')})=>${returnType.join(',')}`;

    if (this.closureTypes.has(key)) {
      return this.closureTypes.get(key)!;
    }

    // 1. Define the implementation signature type: (ctx: eqref, ...params) -> returnType
    // We don't need to store this type index globally, just use it for the field.
    // Actually, we need to add it to the module types.
    const implParams = [[ValType.eqref], ...paramTypes];
    const implResults = returnType.length > 0 ? [returnType] : [];
    const implTypeIndex = this.module.addType(implParams, implResults);

    // 2. Define the closure struct type: (struct (field $func (ref $impl)) (field $ctx (ref eq)))
    const structFields = [
      {
        type: [ValType.ref, ...WasmModule.encodeSignedLEB128(implTypeIndex)],
        mutable: false,
      }, // func
      {type: [ValType.eqref], mutable: false}, // ctx
    ];

    const index = this.module.addStructType(structFields);
    this.closureTypes.set(key, index);
    this.closureStructs.set(index, {funcTypeIndex: implTypeIndex});
    return index;
  }

  public isFixedArrayType(type: TypeAnnotation): boolean {
    if (type.type !== NodeType.TypeAnnotation) return false;
    return (
      !!this.wellKnownTypes.FixedArray &&
      (type as any).name === this.wellKnownTypes.FixedArray.name.name
    );
  }

  public isStringType(type: TypeAnnotation): boolean {
    if (type.type !== NodeType.TypeAnnotation) return false;
    return (
      !!this.wellKnownTypes.String &&
      (type as any).name === this.wellKnownTypes.String.name.name
    );
  }

  /**
   * Create a DiagnosticLocation from an AST node's source location.
   */
  public locationFromNode(node: Node): DiagnosticLocation | undefined {
    if (!node.loc) return undefined;
    return {
      file: this.fileName,
      start: node.loc.start,
      length: node.loc.end - node.loc.start,
      line: node.loc.line,
      column: node.loc.column,
    };
  }

  /**
   * Report an error diagnostic, optionally with location from an AST node.
   */
  public reportError(message: string, code: DiagnosticCode, node?: Node): void {
    this.diagnostics.reportError(
      message,
      code,
      node ? this.locationFromNode(node) : undefined,
    );
  }

  /**
   * Report an internal compiler error. This should be used for unexpected
   * states that indicate a bug in the compiler.
   */
  public reportInternalError(message: string, node?: Node): void {
    this.reportError(
      `Internal Compiler Error: ${message}`,
      DiagnosticCode.InternalCompilerError,
      node,
    );
  }

  /**
   * Look up a ClassInfo by its checker ClassType.
   * Uses object identity to find the class, avoiding name-based lookups.
   *
   * @param classType The ClassType from the type checker
   * @returns The ClassInfo if found, undefined otherwise
   */
  public getClassInfoByType(
    classType: import('../types.js').ClassType,
  ): ClassInfo | undefined {
    const structIndex = this.getClassStructIndex(classType);
    if (structIndex === undefined) return undefined;

    // Find ClassInfo with matching structTypeIndex
    for (const info of this.classes.values()) {
      if (info.structTypeIndex === structIndex) {
        return info;
      }
    }
    return undefined;
  }

  /**
   * Look up an InterfaceInfo by its checker InterfaceType.
   * Uses object identity to find the interface, avoiding name-based lookups.
   *
   * @param interfaceType The InterfaceType from the type checker
   * @returns The InterfaceInfo if found, undefined otherwise
   */
  public getInterfaceInfoByType(
    interfaceType: import('../types.js').InterfaceType,
  ): InterfaceInfo | undefined {
    const structIndex = this.getInterfaceStructIndex(interfaceType);
    if (structIndex === undefined) return undefined;

    // Find InterfaceInfo with matching structTypeIndex
    for (const info of this.interfaces.values()) {
      if (info.structTypeIndex === structIndex) {
        return info;
      }
    }
    return undefined;
  }
}
