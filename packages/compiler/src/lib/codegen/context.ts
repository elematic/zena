import {
  NodeType,
  type ClassDeclaration,
  type FunctionExpression,
  type InterfaceDeclaration,
  type MethodDefinition,
  type MixinDeclaration,
  type Module,
  type Node,
  type Statement,
  type TaggedTemplateExpression,
  type TypeAnnotation,
} from '../ast.js';
import type {UsageAnalysisResult} from '../analysis/usage.js';
import type {CheckerContext} from '../checker/context.js';
import {SemanticContext} from '../checker/semantic-context.js';
import {
  DiagnosticBag,
  DiagnosticCode,
  type DiagnosticLocation,
} from '../diagnostics.js';
import {WasmModule} from '../emitter.js';
import {
  TypeKind,
  type ClassType,
  type FunctionType,
  type InterfaceType,
  type MixinType,
  type Target,
  type Type,
} from '../types.js';
import {ExportDesc, HeapType, Opcode, ValType} from '../wasm.js';
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
  /**
   * Ordered list of modules to generate code for.
   * Modules are in topological order (dependencies before dependents).
   */
  public modules: Module[];
  /**
   * The entry point module (last in topological order).
   * Only exports from this module become WASM exports.
   */
  public entryPointModule: Module;
  /**
   * The module currently being processed during iteration.
   * Used to track which module declarations belong to.
   */
  public currentModule: Module | null = null;
  public diagnostics = new DiagnosticBag();

  /**
   * Semantic context for type → struct index lookups.
   * Populated during codegen and used to resolve types by object identity.
   */
  public semanticContext: SemanticContext;

  /**
   * Checker context for type operations.
   * Provides access to type interning and instantiation utilities
   * (e.g., getInstantiatedFieldType) for identity-based type lookups.
   *
   * This ensures codegen uses the same interned types as the checker,
   * avoiding duplicate WASM type indices for logically identical types.
   */
  public checkerContext: CheckerContext;

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
  /**
   * Maps function names to their WASM function indices.
   *
   * Keys are qualified names (e.g., "/path/to/module.zena:funcName") to avoid
   * collisions between modules. Generic function specializations use keys like
   * "funcName<i32>" for deduplication.
   *
   * Identity-based lookup via `getFunctionIndexByDecl()` is preferred when a
   * declaration is available. This map serves as fallback for generic function
   * specializations which don't have a declaration node.
   *
   * @see getFunctionIndexByDecl for identity-based lookup
   * @see registerFunctionByDecl for identity-based registration
   */
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

  // Exception handling
  public exceptionTagIndex = -1;
  public exceptionPayloadGlobalIndex = -1;

  // Current state
  public currentClass: ClassInfo | null = null;
  public currentCheckerType: ClassType | undefined; // For resolving type parameters in instantiated generics
  public currentReturnType: number[] | undefined;
  public currentCheckerReturnType: Type | undefined; // For generating _ hole literals in unboxed tuples

  /**
   * Stack of loop targets for break/continue statements.
   * Each entry represents a loop's block nesting depth.
   * - breakDepth: depth from current position to break target (outer block)
   * - continueDepth: depth from current position to continue target (loop)
   *
   * When generating loop body, these start at {break: 1, continue: 0}.
   * When entering nested blocks (like if), depths increase by 1.
   */
  readonly #loopStack: {breakDepth: number; continueDepth: number}[] = [];

  /**
   * Type parameter substitution map for checker-based type resolution.
   *
   * Maps type parameter names (e.g., "T", "U") to their concrete Type values.
   * This is used by checkerContext.substituteTypeParams() to resolve types
   * in nested generic contexts (e.g., generic method inside generic class).
   *
   * The map is merged when entering nested contexts:
   * - Entering generic class: add class type params (T → i32)
   * - Entering generic method: add method type params (U → string)
   * - Result: both T and U are resolvable
   *
   * Use pushTypeParamContext() / popTypeParamContext() to manage this.
   */
  public currentTypeArguments: Map<string, Type> = new Map();

  /**
   * Stack of saved type param maps for nested contexts.
   * Each entry saves the previous map when entering a new context.
   */
  readonly #typeArgumentsStack: Map<string, Type>[] = [];

  // Type management
  public arrayTypes = new Map<string, number>(); // elementTypeString -> typeIndex
  public stringTypeIndex = -1;
  public byteArrayTypeIndex = -1;
  public stringLiterals = new Map<string, number>(); // content -> dataIndex

  // Deferred generation
  public pendingHelperFunctions: (() => void)[] = [];
  public stringEqFunctionIndex = -1; // Cached index for String.operator==
  public stringFromPartsFunctionIndex = -1; // Cached index for String.fromParts
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
    Error?: ClassDeclaration;
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

  /**
   * Tracks types currently being processed by ensureTypeInstantiated() to prevent
   * infinite recursion. This set persists across nested instantiateClass() calls.
   *
   * For recursive types (e.g., class Node<T> { child: Node<T>; }), without this
   * set, instantiating Node<i32> would try to instantiate Node<i32> again when
   * processing the child field, causing infinite recursion.
   */
  public typeInstantiationVisited = new Set<Type>();

  // Struct index to ClassInfo mapping - the primary registry for all classes
  // This replaces the old name-based `classes` Map and avoids issues with
  // name collisions when multiple modules define same-named classes.
  readonly #structIndexToClassInfo = new Map<number, ClassInfo>();
  // Struct index to InterfaceInfo mapping for fast lookup
  readonly #structIndexToInterfaceInfo = new Map<number, InterfaceInfo>();
  // Counter for generating unique brand IDs for classes
  // This must be incremented whenever a class is registered, including partial
  // registrations where structTypeIndex is not yet valid
  #brandIdCounter = 0;
  // Maps generic class declarations to their ClassType
  readonly #genericTemplates = new Map<string, ClassType>();
  // Reverse mapping: checker ClassType → ClassDeclaration for generic classes
  readonly #genericDeclarations = new WeakMap<ClassType, ClassDeclaration>();
  // Identity-based specialization lookup: ClassType -> ClassInfo
  // With type interning in the checker, identical instantiations share the
  // same ClassType object, so we can use a WeakMap for O(1) lookup.
  readonly #classInfo = new WeakMap<ClassType, ClassInfo>();

  // Extension class lookup: onType (checker Type) -> ClassInfo[]
  // Maps the type being extended to all extension classes that extend it.
  // Multiple extension classes can extend the same type.
  readonly #extensionsByOnType = new WeakMap<Type, ClassInfo[]>();

  // Extension class lookup by WASM type index: typeIndex -> ClassInfo[]
  // Used when the checker Type is not available (e.g., raw array<T> types).
  // The key is the heap type index from the WASM type encoding.
  readonly #extensionsByWasmTypeIndex = new Map<number, ClassInfo[]>();

  // Extension class lookup by WASM valtype (for primitives like i32): valtype -> ClassInfo[]
  // The key is the WASM valtype byte (e.g., 0x7f for i32).
  readonly #extensionsByWasmValType = new Map<number, ClassInfo[]>();

  // Identity-based interface lookup: InterfaceType -> InterfaceInfo
  readonly #interfaceInfo = new WeakMap<InterfaceType, InterfaceInfo>();

  // Identity-based mixin lookup: MixinType -> MixinDeclaration
  readonly #mixinDeclarations = new WeakMap<MixinType, MixinDeclaration>();

  // ===== Declaration → WASM Index Mappings =====
  // These enable identity-based lookup from resolved bindings to WASM indices.
  // Used by the new name resolution architecture (see docs/design/name-resolution.md).

  // Map local variable declarations to their WASM local indices.
  // This includes function parameters and block-scoped variables.
  // Note: Indices are function-scoped, so the same declaration may have
  // different indices in different function contexts (e.g., closures).
  readonly #localIndices = new WeakMap<Node, number>();

  // Map global variable declarations to their WASM global indices.
  readonly #globalIndices = new WeakMap<Node, number>();

  // Map function declarations to their WASM function indices.
  readonly #functionIndices = new WeakMap<Node, number>();

  // Map class declarations to their WASM struct type indices.
  readonly #classTypeIndices = new WeakMap<ClassDeclaration, number>();

  // Template Literals
  public templateLiteralGlobals = new Map<TaggedTemplateExpression, number>();

  /**
   * Compilation target.
   * - 'host': Custom console imports for @zena-lang/runtime
   * - 'wasi': WASI Preview 1 imports for wasmtime
   */
  public target: Target = 'host';

  /**
   * Usage analysis result for DCE.
   * Set by CodeGenerator when DCE is enabled.
   */
  #usageResult: UsageAnalysisResult | null = null;

  /**
   * Set the usage analysis result for method-level DCE.
   */
  setUsageResult(result: UsageAnalysisResult): void {
    this.#usageResult = result;
  }

  /**
   * Check if a method is used according to DCE analysis.
   * Returns true if DCE is disabled or if the method is used.
   */
  isMethodUsed(
    classType: ClassType | InterfaceType,
    methodName: string,
  ): boolean {
    if (!this.#usageResult) {
      return true; // DCE disabled, include everything
    }
    return this.#usageResult.isMethodUsed(classType, methodName);
  }

  /**
   * Check if a field is eliminable (unobservable - never read).
   * A field is eliminable if DCE is enabled and the field is never read.
   * This allows eliminating the field from the struct, eliminating assignments,
   * and eliminating both getter and setter.
   *
   * @param classType - The class type
   * @param fieldName - The field name (without class prefix)
   * @returns true if the field can be eliminated, false if it must be kept
   */
  isFieldEliminable(
    classType: ClassType | InterfaceType,
    fieldName: string,
  ): boolean {
    if (!this.#usageResult) {
      return false; // DCE disabled, keep everything
    }
    const fieldUsage = this.#usageResult.getFieldUsage(classType, fieldName);
    // Field is eliminable if it's never read (writes are unobservable)
    // If fieldUsage is undefined (field not tracked), conservatively keep it
    return fieldUsage !== undefined && !fieldUsage.isRead;
  }

  /**
   * Get the usage analysis result.
   * Returns the current usage analysis result or null if DCE is disabled.
   */
  get usageResult(): UsageAnalysisResult | null {
    return this.#usageResult;
  }

  /**
   * Whether debug information (name section) should be emitted.
   */
  public debug: boolean;

  constructor(
    modules: Module[],
    entryPointPath: string | undefined,
    semanticContext: SemanticContext,
    checkerContext: CheckerContext,
    target: Target = 'host',
    debug: boolean = false,
  ) {
    this.modules = modules;
    // Find entry point by path, or default to last module (for backward compatibility)
    this.entryPointModule = entryPointPath
      ? (modules.find((m) => m.path === entryPointPath) ??
        modules[modules.length - 1])
      : modules[modules.length - 1];
    this.semanticContext = semanticContext;
    this.checkerContext = checkerContext;
    this.target = target;
    this.debug = debug;
    this.#extractWellKnownTypes();
    this.module = new WasmModule();
    // Note: byteArrayTypeIndex and stringTypeIndex are now created lazily
    // via ensureStringType() to avoid including them when not needed.
  }

  // ============================================
  // Lazy Infrastructure Initialization
  // ============================================
  // These methods create WASM infrastructure on-demand to minimize binary size.
  // Only call them when the feature is actually needed.

  /**
   * Ensure the ByteArray type is created.
   * Call this before using byteArrayTypeIndex.
   * Returns the type index.
   */
  ensureByteArrayType(): number {
    if (this.byteArrayTypeIndex === -1) {
      // Define backing array type: array<i8> (mutable for construction)
      this.byteArrayTypeIndex = this.module.addArrayType([ValType.i8], true);
    }
    return this.byteArrayTypeIndex;
  }

  /**
   * Ensure the String struct type is created.
   * String is a view-based struct with fields:
   *   - #data: ref $ByteArray
   *   - #start: i32
   *   - #end: i32
   *   - #encoding: i32
   * Call this before using stringTypeIndex.
   * Returns the type index.
   */
  ensureStringType(): number {
    // Note: This method no longer creates its own String struct type.
    // The String class from stdlib defines the actual struct type with:
    //   0: __vtable (eqref)
    //   1: __brand_String (ref null $brandType)
    //   2: String#data (ref $ByteArray)
    //   3: String#start (i32)
    //   4: String#end (i32)
    //   5: String#encoding (i32)
    // The stringTypeIndex is set when the String class is processed.
    // If called before the String class is defined, returns -1.
    if (this.stringTypeIndex === -1) {
      // Ensure ByteArray type exists (needed by String class)
      this.ensureByteArrayType();
    }
    return this.stringTypeIndex;
  }

  /**
   * Ensure exception handling infrastructure is created.
   * Call this before using exceptionTagIndex or exceptionPayloadGlobalIndex.
   * Creates the exception tag and payload global.
   */
  ensureExceptionInfra(): void {
    if (this.exceptionTagIndex === -1) {
      // Tag type: () -> void (no parameters)
      const tagTypeIndex = this.module.addType([], []);
      this.exceptionTagIndex = this.module.addTag(tagTypeIndex);
      this.module.addExport(
        'zena_exception',
        ExportDesc.Tag,
        this.exceptionTagIndex,
      );

      // Add global for exception payload (mutable eqref, initially null)
      this.exceptionPayloadGlobalIndex = this.module.addGlobal(
        [ValType.eqref],
        true, // mutable
        [Opcode.ref_null, HeapType.eq], // init: ref.null eq
      );
    }
  }

  #memoryIndex = -1;

  /**
   * Ensure memory is created.
   * Call this before using memory (e.g., for data segments).
   * Returns the memory index.
   */
  ensureMemory(): number {
    if (this.#memoryIndex === -1) {
      this.#memoryIndex = this.module.addMemory(1);
      this.module.addExport('memory', ExportDesc.Mem, this.#memoryIndex);
    }
    return this.#memoryIndex;
  }

  /**
   * Check if string type has been initialized.
   * Use this to conditionally generate string helpers.
   */
  hasStringType(): boolean {
    return this.stringTypeIndex !== -1;
  }

  /**
   * Check if exception infrastructure has been initialized.
   */
  hasExceptionInfra(): boolean {
    return this.exceptionTagIndex !== -1;
  }

  /**
   * Check if memory has been initialized.
   */
  hasMemory(): boolean {
    return this.#memoryIndex !== -1;
  }

  // ============================================
  // WASI Support
  // ============================================
  // These fields and methods support WASI target compilation.

  /** WASI fd_write import function index (-1 if not initialized) */
  wasiFdWriteIndex = -1;

  /** WASI string write helper function index (-1 if not initialized) */
  wasiWriteStringIndex = -1;

  /**
   * Ensure WASI infrastructure is created.
   * Creates memory, imports fd_write, and generates helper functions.
   * Only call this when target === 'wasi'.
   */
  ensureWasiInfra(): void {
    if (this.wasiFdWriteIndex !== -1) return;

    // WASI requires linear memory
    this.ensureMemory();

    // Import fd_write from wasi_snapshot_preview1
    // fd_write(fd: i32, iovs: i32, iovs_len: i32, nwritten: i32) -> i32
    // Use preRec: true to emit this type outside the rec block for WASI compatibility
    const fdWriteTypeIndex = this.module.addType(
      [[ValType.i32], [ValType.i32], [ValType.i32], [ValType.i32]],
      [[ValType.i32]],
      {preRec: true},
    );
    this.wasiFdWriteIndex = this.module.addImport(
      'wasi_snapshot_preview1',
      'fd_write',
      ExportDesc.Func,
      fdWriteTypeIndex,
    );
  }

  /**
   * Extract well-known types (FixedArray, String, Box, TemplateStringsArray)
   * from the module list based on their canonical module paths.
   */
  #extractWellKnownTypes() {
    for (const mod of this.modules) {
      for (const stmt of mod.body) {
        if (stmt.type !== NodeType.ClassDeclaration) continue;
        const decl = stmt as ClassDeclaration;
        const name = decl.name.name;

        if (mod.path === 'zena:fixed-array' && name === 'FixedArray') {
          this.wellKnownTypes.FixedArray = decl;
        } else if (mod.path === 'zena:string' && name === 'String') {
          this.wellKnownTypes.String = decl;
        } else if (mod.path === 'zena:box' && name === 'Box') {
          this.wellKnownTypes.Box = decl;
        } else if (
          mod.path === 'zena:template-strings-array' &&
          name === 'TemplateStringsArray'
        ) {
          this.wellKnownTypes.TemplateStringsArray = decl;
        } else if (mod.path === 'zena:error' && name === 'Error') {
          this.wellKnownTypes.Error = decl;
        }
      }
    }
  }

  /**
   * Get all statements from all modules in topological order.
   * Use this for iterating over the entire program.
   */
  get statements(): Statement[] {
    const result: Statement[] = [];
    for (const mod of this.modules) {
      result.push(...mod.body);
    }
    return result;
  }

  /**
   * Iterate over all statements while tracking the current module.
   * This is useful when you need to know which module a statement belongs to.
   * Sets `currentModule` before processing each module's statements.
   */
  *statementsWithModule(): Generator<Statement, void, undefined> {
    for (const mod of this.modules) {
      this.currentModule = mod;
      for (const stmt of mod.body) {
        yield stmt;
      }
    }
    this.currentModule = null;
  }

  /**
   * Set the debug name for a function (only if debug mode is enabled).
   * This populates the WASM name section for better stack traces.
   * @param funcIndex - The WASM function index
   * @param name - The human-readable function name
   */
  setFunctionDebugName(funcIndex: number, name: string): void {
    if (this.debug) {
      this.module.setFunctionName(funcIndex, name);
    }
  }

  /**
   * Execute a callback for each module, setting currentModule during the call.
   * Use this when you need to process each module separately.
   */
  forEachModule(callback: (mod: Module) => void): void {
    for (const mod of this.modules) {
      this.currentModule = mod;
      callback(mod);
    }
    this.currentModule = null;
  }

  /**
   * Find a class declaration by name across all modules.
   */
  findClassDeclaration(name: string): ClassDeclaration | undefined {
    for (const mod of this.modules) {
      for (const stmt of mod.body) {
        if (
          stmt.type === NodeType.ClassDeclaration &&
          (stmt as ClassDeclaration).name.name === name
        ) {
          return stmt as ClassDeclaration;
        }
      }
    }
    return undefined;
  }

  /**
   * Find an interface declaration by checker InterfaceType using identity.
   * This is the preferred lookup method when you have an InterfaceType from the checker.
   */
  findInterfaceDeclaration(
    interfaceType: InterfaceType,
  ): InterfaceDeclaration | undefined {
    for (const mod of this.modules) {
      for (const stmt of mod.body) {
        if (stmt.type === NodeType.InterfaceDeclaration) {
          const decl = stmt as InterfaceDeclaration;
          if (
            decl.inferredType &&
            decl.inferredType.kind === TypeKind.Interface &&
            decl.inferredType === interfaceType
          ) {
            return decl;
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Check if a statement is from the entry point module.
   * Only exports from the entry point module should become WASM exports.
   */
  isFromEntryPoint(stmt: Statement): boolean {
    return this.entryPointModule.body.includes(stmt);
  }

  /**
   * Check if a statement should produce a WASM export.
   * Returns true if the statement is marked as exported AND is from the entry point module.
   */
  shouldExport(stmt: {exported?: boolean}): boolean {
    // Only entry point exports become WASM exports
    return !!(
      stmt.exported && this.entryPointModule.body.includes(stmt as any)
    );
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

  // ============================================================
  // Loop Context Management (for break/continue)
  // ============================================================

  /**
   * Enter a while loop context for break/continue targeting.
   * Call this when emitting the block/loop structure for while loops.
   *
   * While loop structure: block $break -> loop $continue -> body
   * From inside body: break=1 (to $break), continue=0 (to $continue/loop start)
   */
  public enterLoop() {
    this.#loopStack.push({breakDepth: 1, continueDepth: 0});
  }

  /**
   * Enter a for loop context for break/continue targeting.
   * For loops have an extra block for the continue target.
   *
   * For loop structure: block $break -> loop -> block $continue -> body
   * From inside body: break=2 (to $break), continue=0 (to $continue/update)
   */
  public enterForLoop() {
    this.#loopStack.push({breakDepth: 2, continueDepth: 0});
  }

  /**
   * Exit the current loop context.
   */
  public exitLoop() {
    this.#loopStack.pop();
  }

  /**
   * Notify that we're entering a WASM block structure (if, block, etc.)
   * that increments the br depth for any break/continue inside.
   */
  public enterBlockStructure() {
    for (const loop of this.#loopStack) {
      loop.breakDepth++;
      loop.continueDepth++;
    }
  }

  /**
   * Notify that we're exiting a WASM block structure.
   */
  public exitBlockStructure() {
    for (const loop of this.#loopStack) {
      loop.breakDepth--;
      loop.continueDepth--;
    }
  }

  /**
   * Get the br depth for a break statement.
   * Returns undefined if not inside a loop.
   */
  public getBreakDepth(): number | undefined {
    if (this.#loopStack.length === 0) return undefined;
    return this.#loopStack[this.#loopStack.length - 1].breakDepth;
  }

  /**
   * Get the br depth for a continue statement.
   * Returns undefined if not inside a loop.
   */
  public getContinueDepth(): number | undefined {
    if (this.#loopStack.length === 0) return undefined;
    return this.#loopStack[this.#loopStack.length - 1].continueDepth;
  }

  // ============================================================
  // Type Parameter Context Management
  // ============================================================

  /**
   * Enter a new type parameter context, merging new bindings into the map.
   *
   * Call this when entering a generic class or method context. The new bindings
   * are merged with existing ones (for nested contexts like generic method in
   * generic class).
   *
   * @param bindings Map of type parameter names to their concrete types
   */
  public pushTypeArgumentsContext(bindings: Map<string, Type>): void {
    // Save current map
    this.#typeArgumentsStack.push(new Map(this.currentTypeArguments));

    // Merge new bindings
    for (const [name, type] of bindings) {
      this.currentTypeArguments.set(name, type);
    }
  }

  /**
   * Exit the current type parameter context, restoring the previous map.
   */
  public popTypeParamContext(): void {
    const previous = this.#typeArgumentsStack.pop();
    if (previous) {
      this.currentTypeArguments = previous;
    } else {
      this.currentTypeArguments = new Map();
    }
  }

  /**
   * Clear all type parameter bindings. Use this when starting a fresh
   * context that shouldn't inherit any type parameters.
   */
  public clearTypeParamContext(): void {
    this.#typeArgumentsStack.length = 0;
    this.currentTypeArguments = new Map();
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
   * @param name The parameter name
   * @param type The WASM type
   * @param declaration Optional AST node for identity-based lookup
   */
  public defineParam(name: string, type: number[], declaration?: Node): number {
    const index = this.#nextLocalIndex++;
    this.scopes[this.scopes.length - 1].set(name, {index, type});
    // Register by declaration for identity-based lookup (new name resolution)
    if (declaration) {
      this.registerLocalByDecl(declaration, index);
    }
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
   * @param name The variable name
   * @param type The WASM type
   * @param declaration Optional AST node for identity-based lookup
   */
  public declareLocal(
    name: string,
    type: number[] = [ValType.i32],
    declaration?: Node,
    isBoxed?: boolean,
    unboxedType?: number[],
  ): number {
    const index = this.#nextLocalIndex++;
    this.scopes[this.scopes.length - 1].set(name, {
      index,
      type,
      isBoxed,
      unboxedType,
    });
    this.#extraLocals.push(type);
    // Register by declaration for identity-based lookup (new name resolution)
    if (declaration) {
      this.registerLocalByDecl(declaration, index);
    }
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
    // Also register with qualified name for multi-module support
    if (this.currentModule) {
      const qualifiedName = this.qualifyName(name);
      this.globals.set(qualifiedName, {index, type});
    }
  }

  public getGlobal(name: string): {index: number; type: number[]} | undefined {
    return this.globals.get(name);
  }

  // ===== Qualified Name and Import Resolution =====

  /**
   * Create a qualified name for a declaration.
   * Format: `{modulePath}:{name}`
   * @param name - The unqualified name of the declaration
   * @param modulePath - Optional module path (defaults to current module)
   */
  public qualifyName(name: string, modulePath?: string): string {
    const path = modulePath ?? this.currentModule?.path ?? '';
    return `${path}:${name}`;
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

  /**
   * Register a ClassInfo by its struct index for fast lookup.
   * This is called during class registration and enables looking up
   * ClassInfo without name collisions across modules.
   */
  public setClassInfoByStructIndex(
    structIndex: number,
    classInfo: ClassInfo,
  ): void {
    this.#structIndexToClassInfo.set(structIndex, classInfo);
  }

  /**
   * Get a ClassInfo directly by its WASM struct index.
   * This is the primary way to look up classes by struct index
   * and avoids issues with name collisions across modules.
   *
   * Unlike getClassInfoByStructIndex (which uses identity-based lookup via
   * ClassType), this uses a direct struct index to ClassInfo mapping.
   */
  public getClassInfoByStructIndexDirect(
    structIndex: number,
  ): ClassInfo | undefined {
    return this.#structIndexToClassInfo.get(structIndex);
  }

  /**
   * Get all registered ClassInfo objects.
   * Used for iterating over all classes (e.g., to generate method bodies).
   */
  public getAllClassInfos(): IterableIterator<ClassInfo> {
    return this.#structIndexToClassInfo.values();
  }

  /**
   * Get the total number of registered classes.
   */
  public getClassCount(): number {
    return this.#structIndexToClassInfo.size;
  }

  /**
   * Get the next brand ID for a class.
   * This must be called for every class registration (including partial ones)
   * to maintain consistent brand IDs with the old ctx.classes.size behavior.
   */
  public getNextBrandId(): number {
    return ++this.#brandIdCounter;
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
   * Register a generic class declaration by its checker type for identity-based
   * lookup. This enables looking up the AST declaration from an interned
   * ClassType.
   */
  public setGenericDeclaration(
    classType: ClassType,
    decl: ClassDeclaration,
  ): void {
    this.#genericDeclarations.set(classType, decl);
  }

  /**
   * Get the ClassDeclaration for a generic class by its checker type.
   * Follows genericSource chain to find the template.
   */
  public getGenericDeclaration(
    classType: ClassType,
  ): ClassDeclaration | undefined {
    // Try direct lookup first
    let decl = this.#genericDeclarations.get(classType);
    if (decl) return decl;

    // Follow genericSource chain
    let source = classType.genericSource;
    while (source) {
      decl = this.#genericDeclarations.get(source);
      if (decl) return decl;
      source = source.genericSource;
    }

    return undefined;
  }

  /**
   * Register a mixin declaration by its checker MixinType for identity-based lookup.
   * This enables looking up the AST declaration from an interned MixinType.
   */
  public setMixinDeclaration(
    mixinType: MixinType,
    decl: MixinDeclaration,
  ): void {
    this.#mixinDeclarations.set(mixinType, decl);
  }

  /**
   * Get the MixinDeclaration for a mixin by its checker MixinType.
   * Follows genericSource chain to find the template.
   */
  public getMixinDeclaration(
    mixinType: MixinType,
  ): MixinDeclaration | undefined {
    // Try direct lookup first
    let decl = this.#mixinDeclarations.get(mixinType);
    if (decl) return decl;

    // Follow genericSource chain for generic mixins
    let source = mixinType.genericSource;
    while (source) {
      decl = this.#mixinDeclarations.get(source);
      if (decl) return decl;
      source = source.genericSource;
    }

    return undefined;
  }

  /**
   * Register a ClassInfo by its checker ClassType for identity-based lookup.
   * With type interning, identical instantiations share the same ClassType
   * object, so this provides O(1) lookup without string key computation.
   */
  public registerClassInfo(classType: ClassType, classInfo: ClassInfo): void {
    this.#classInfo.set(classType, classInfo);
  }

  /**
   * Look up a ClassInfo by its checker ClassType using identity.
   * This is the preferred lookup method when you have a ClassType from the checker.
   *
   * Returns undefined if not found - caller should fall back to other lookups
   * or the type hasn't been registered yet.
   */
  public getClassInfo(classType: ClassType): ClassInfo | undefined {
    const result = this.#classInfo.get(classType);
    if (result) return result;
    // For specialized generic classes, look up via genericSource.
    // This handles cases where the same logical class (e.g., FixedArray<Entry<K,V>>)
    // is accessed via different expressions (field vs local variable), which may
    // have different ClassType object identities due to substituteType creating
    // new ClassType objects without interning.
    if (classType.genericSource) {
      return this.#classInfo.get(classType.genericSource);
    }
    return undefined;
  }

  /**
   * Look up a ClassInfo by struct type index using identity-based lookups.
   * This is O(1) via the structIndex -> ClassType -> ClassInfo chain.
   *
   * Returns undefined if not found - caller should fall back to iteration.
   */
  public getClassInfoByStructIndex(structIndex: number): ClassInfo | undefined {
    const classType = this.#structIndexToClass.get(structIndex);
    if (!classType) return undefined;
    return this.#classInfo.get(classType);
  }

  /**
   * Register an extension class by its onType for O(1) lookup.
   * Multiple extension classes can extend the same type.
   */
  public registerExtensionClass(onType: Type, classInfo: ClassInfo): void {
    const existing = this.#extensionsByOnType.get(onType);
    if (existing) {
      existing.push(classInfo);
    } else {
      this.#extensionsByOnType.set(onType, [classInfo]);
    }
  }

  /**
   * Register an extension class by its WASM type for O(1) lookup.
   * Handles both reference types (by heap type index) and primitive types (by valtype).
   * Call this after setting classInfo.onType with the WASM type bytes.
   */
  public registerExtensionClassByWasmTypeIndex(classInfo: ClassInfo): void {
    if (!classInfo.onType || classInfo.onType.length === 0) {
      return;
    }

    // Single byte = primitive valtype (e.g., 0x7f for i32)
    if (classInfo.onType.length === 1) {
      const valtype = classInfo.onType[0];
      const existing = this.#extensionsByWasmValType.get(valtype);
      if (existing) {
        if (!existing.includes(classInfo)) {
          existing.push(classInfo);
        }
      } else {
        this.#extensionsByWasmValType.set(valtype, [classInfo]);
      }
      return;
    }

    // Multi-byte = reference type, decode the heap type index (skip the ref type byte)
    let typeIndex = 0;
    let shift = 0;
    for (let i = 1; i < classInfo.onType.length; i++) {
      const byte = classInfo.onType[i];
      typeIndex |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    const existing = this.#extensionsByWasmTypeIndex.get(typeIndex);
    if (existing) {
      // Avoid duplicate registration
      if (!existing.includes(classInfo)) {
        existing.push(classInfo);
      }
    } else {
      this.#extensionsByWasmTypeIndex.set(typeIndex, [classInfo]);
    }
  }

  /**
   * Look up extension classes by the type they extend.
   * Returns an array of ClassInfo (multiple extensions can extend the same type).
   */
  public getExtensionClassesByOnType(onType: Type): ClassInfo[] | undefined {
    return this.#extensionsByOnType.get(onType);
  }

  /**
   * Look up extension classes by WASM heap type index.
   * Returns an array of ClassInfo (multiple extensions can extend the same type).
   */
  public getExtensionClassesByWasmTypeIndex(
    typeIndex: number,
  ): ClassInfo[] | undefined {
    return this.#extensionsByWasmTypeIndex.get(typeIndex);
  }

  /**
   * Look up extension classes by WASM valtype byte (for primitives).
   * Returns an array of ClassInfo (multiple extensions can extend the same type).
   */
  public getExtensionClassesByWasmValType(
    valtype: number,
  ): ClassInfo[] | undefined {
    return this.#extensionsByWasmValType.get(valtype);
  }

  /**
   * Register an InterfaceInfo by its checker InterfaceType for identity-based lookup.
   */
  public registerInterface(
    interfaceType: InterfaceType,
    interfaceInfo: InterfaceInfo,
  ): void {
    this.#interfaceInfo.set(interfaceType, interfaceInfo);
    // Also register by struct index for O(1) lookup
    this.#structIndexToInterfaceInfo.set(
      interfaceInfo.structTypeIndex,
      interfaceInfo,
    );
  }

  /**
   * Register an InterfaceInfo by struct type index directly.
   * Use this when no checker InterfaceType is available.
   */
  public setInterfaceInfoByStructIndex(
    structIndex: number,
    interfaceInfo: InterfaceInfo,
  ): void {
    this.#structIndexToInterfaceInfo.set(structIndex, interfaceInfo);
  }

  /**
   * Look up an InterfaceInfo by struct type index directly.
   * This is O(1) and preferred when you only have the struct index.
   */
  public getInterfaceInfoByStructIndex(
    structIndex: number,
  ): InterfaceInfo | undefined {
    return this.#structIndexToInterfaceInfo.get(structIndex);
  }

  /**
   * Look up an InterfaceInfo by its checker InterfaceType using identity.
   * This is the preferred lookup method when you have an InterfaceType from the checker.
   *
   * For generic interfaces like `Sequence<T>`, all specializations (e.g., `Sequence<i32>`)
   * share the same WASM struct. We only register the template InterfaceType, so lookups
   * for specialized types follow the genericSource chain to find the template.
   */
  public getInterfaceInfo(
    interfaceType: InterfaceType,
  ): InterfaceInfo | undefined {
    const result = this.#interfaceInfo.get(interfaceType);
    if (result) return result;
    // For specialized generic interfaces, look up via genericSource chain
    let source = interfaceType.genericSource;
    while (source) {
      const sourceResult = this.#interfaceInfo.get(source);
      if (sourceResult) return sourceResult;
      source = source.genericSource;
    }
    return undefined;
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

  // ===== Declaration-Based Index Management =====
  // These methods support the new name resolution architecture where
  // the checker resolves names to declarations, and codegen maps
  // declarations to WASM indices.

  /**
   * Register a local variable's WASM index by its declaration.
   * Call this when allocating a local for a parameter or variable declaration.
   */
  public registerLocalByDecl(decl: Node, index: number): void {
    this.#localIndices.set(decl, index);
  }

  /**
   * Get a local variable's WASM index by its declaration.
   * Returns undefined if the declaration is not registered (e.g., for globals).
   */
  public getLocalIndexByDecl(decl: Node): number | undefined {
    return this.#localIndices.get(decl);
  }

  /**
   * Register a global variable's WASM index by its declaration.
   */
  public registerGlobalByDecl(decl: Node, index: number): void {
    this.#globalIndices.set(decl, index);
  }

  /**
   * Get a global variable's WASM index by its declaration.
   */
  public getGlobalIndexByDecl(decl: Node): number | undefined {
    return this.#globalIndices.get(decl);
  }

  /**
   * Register a function's WASM index by its declaration.
   * The declaration can be a FunctionExpression or DeclareFunction.
   */
  public registerFunctionByDecl(decl: Node, index: number): void {
    this.#functionIndices.set(decl, index);
  }

  /**
   * Get a function's WASM index by its declaration.
   */
  public getFunctionIndexByDecl(decl: Node): number | undefined {
    return this.#functionIndices.get(decl);
  }

  /**
   * Register a class's WASM struct type index by its declaration.
   */
  public registerClassByDecl(decl: ClassDeclaration, index: number): void {
    this.#classTypeIndices.set(decl, index);
  }

  /**
   * Get a class's WASM struct type index by its declaration.
   */
  public getClassIndexByDecl(decl: ClassDeclaration): number | undefined {
    return this.#classTypeIndices.get(decl);
  }
}
