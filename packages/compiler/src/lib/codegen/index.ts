import {
  NodeType,
  type ClassDeclaration,
  type Declaration,
  type DeclareFunction,
  type EnumDeclaration,
  type FunctionExpression,
  type InterfaceDeclaration,
  type MixinDeclaration,
  type Module,
  type VariableDeclaration,
} from '../ast.js';
import {analyzeUsage, type UsageAnalysisResult} from '../analysis/usage.js';
import type {CheckerContext} from '../checker/context.js';
import {SemanticContext} from '../checker/semantic-context.js';
import {TypeKind, type MixinType, type Target} from '../types.js';
import {
  preRegisterClassStruct,
  defineClassStruct,
  registerClassMethods,
  preRegisterInterface,
  defineInterfaceMethods,
  getMemberName,
  mapCheckerTypeToWasmType,
} from './classes.js';
import {CodegenContext} from './context.js';
import {registerDeclaredFunction, registerFunction} from './functions.js';
import {
  generateExpression,
  generateStringGetByteFunction,
  generateStringGetLengthFunction,
  inferType,
} from './expressions.js';
import {HeapType, Opcode, ValType, ExportDesc, GcOpcode} from '../wasm.js';
import {WasmModule} from '../emitter.js';

/**
 * The CodeGenerator class is responsible for traversing the AST and generating
 * WebAssembly (WASM) binary code.
 *
 * It manages:
 * - The WASM module structure (types, functions, exports, etc.)
 * - Symbol tables for variables and functions.
 * - Class and Interface layouts (structs and vtables).
 * - String and Array memory management.
 *
 * The generation process is typically:
 * 1. Register all classes and interfaces (to handle forward references).
 * 2. Generate method bodies and function bodies.
 * 3. Emit the final WASM binary.
 */

/**
 * Options for code generation.
 */
export interface CodegenOptions {
  /**
   * Enable dead code elimination.
   * When true, unused declarations are not included in the output.
   * Default: false
   */
  dce?: boolean;

  /**
   * Compilation target.
   * - 'host': Custom console imports for @zena-lang/runtime (default)
   * - 'wasi': WASI Preview 1 imports for wasmtime
   */
  target?: Target;
}

export class CodeGenerator {
  #ctx: CodegenContext;
  #options: CodegenOptions;
  #usageResult: UsageAnalysisResult | null = null;

  /**
   * Create a new CodeGenerator.
   * @param modules - All compiled modules to generate code for
   * @param entryPointPath - Path of the entry point module (its exports become WASM exports)
   * @param semanticContext - Semantic context for type lookups (required)
   * @param checkerContext - Checker context for type instantiation (required)
   * @param options - Code generation options
   */
  constructor(
    modules: Module[],
    entryPointPath: string | undefined,
    semanticContext: SemanticContext,
    checkerContext: CheckerContext,
    options: CodegenOptions = {},
  ) {
    this.#ctx = new CodegenContext(
      modules,
      entryPointPath,
      semanticContext,
      checkerContext,
      options.target ?? 'host',
    );
    this.#options = options;
  }

  /**
   * Check if a declaration should be included in code generation.
   * Returns true if DCE is disabled or if the declaration is used.
   */
  #isUsed(decl: Declaration): boolean {
    if (!this.#options.dce || !this.#usageResult) {
      return true; // DCE disabled, include everything
    }
    return this.#usageResult.isUsed(decl);
  }

  /**
   * Get the semantic context used by this code generator.
   * Useful for tests that need to inspect type mappings.
   */
  public get semanticContext(): SemanticContext {
    return this.#ctx.semanticContext;
  }

  /**
   * Get the codegen context for testing purposes.
   * This exposes internal state and should only be used in tests.
   * @internal
   */
  public get context(): CodegenContext {
    return this.#ctx;
  }

  /**
   * Set the file name used for diagnostic locations.
   */
  public setFileName(fileName: string) {
    this.#ctx.fileName = fileName;
  }

  /**
   * Get the diagnostics reported during code generation.
   */
  public get diagnostics() {
    return this.#ctx.diagnostics;
  }

  /**
   * Main entry point for code generation.
   * @returns The generated WASM binary as a Uint8Array.
   */
  public generate(): Uint8Array {
    // Run usage analysis if DCE is enabled
    if (this.#options.dce) {
      const program = {
        modules: new Map(this.#ctx.modules.map((m) => [m.path!, m])),
        entryPoint: this.#ctx.entryPointModule.path!,
        preludeModules: [], // Prelude modules are already in the modules list
      };
      this.#usageResult = analyzeUsage(program, {
        semanticContext: this.#ctx.semanticContext,
      });
      // Share the usage result with the context for method-level DCE
      this.#ctx.setUsageResult(this.#usageResult);
    }

    const statements = this.#ctx.statements;

    // NOTE: Exception tag, payload global, and memory are now created lazily
    // via ctx.ensureExceptionInfra() and ctx.ensureMemory() to minimize binary size.
    // They are only created when actually needed (throw/try or data segments).

    // WASI infrastructure must be initialized early (before class methods are registered)
    // because fd_write import must be added before any defined functions.
    // Imports always come before defined functions in WASM's function index space.
    if (this.#ctx.target === 'wasi') {
      this.#ctx.ensureWasiInfra();
    }

    const globalInitializers: {index: number; init: any}[] = [];

    // 1. Pre-register Interfaces and register Mixins/Type Aliases/Enums (First pass)
    // This reserves type indices for interfaces so they can be referenced by classes.
    // Interface method types are NOT defined yet since they may reference classes.
    for (const statement of statements) {
      if (statement.type === NodeType.InterfaceDeclaration) {
        if (!this.#isUsed(statement as InterfaceDeclaration)) continue;
        preRegisterInterface(this.#ctx, statement as InterfaceDeclaration);
      } else if (statement.type === NodeType.MixinDeclaration) {
        if (!this.#isUsed(statement as MixinDeclaration)) continue;
        const mixinDecl = statement as MixinDeclaration;
        // Identity-based registration for O(1) lookup via checker types
        if (mixinDecl.inferredType?.kind === TypeKind.Mixin) {
          this.#ctx.setMixinDeclaration(
            mixinDecl.inferredType as MixinType,
            mixinDecl,
          );
        }
      }
    }

    // 2. Pre-register Class Structs (Second pass)
    // This reserves type indices so self-referential types can work
    for (const statement of statements) {
      if (statement.type === NodeType.ClassDeclaration) {
        if (!this.#isUsed(statement as ClassDeclaration)) continue;
        preRegisterClassStruct(this.#ctx, statement as ClassDeclaration);
      }
    }

    // 3. Define Interface Methods (Third pass)
    // Now that all classes have reserved indices, class types can be resolved correctly.
    for (const statement of statements) {
      if (statement.type === NodeType.InterfaceDeclaration) {
        if (!this.#isUsed(statement as InterfaceDeclaration)) continue;
        defineInterfaceMethods(this.#ctx, statement as InterfaceDeclaration);
      }
    }

    // 4. Define Class Structs (Fourth pass)
    // Now that all classes have reserved indices, define the actual struct types
    for (const statement of statements) {
      if (statement.type === NodeType.ClassDeclaration) {
        if (!this.#isUsed(statement as ClassDeclaration)) continue;
        defineClassStruct(this.#ctx, statement as ClassDeclaration);
      }
    }

    // 5. Register Imports (DeclareFunction)
    // Imports must be registered before defined functions to ensure correct index space.
    for (const statement of statements) {
      if (statement.type === NodeType.DeclareFunction) {
        const decl = statement as DeclareFunction;
        if (!this.#isUsed(decl)) continue;
        registerDeclaredFunction(this.#ctx, decl, this.#ctx.shouldExport(decl));
      }
    }

    // 6. Register Class Methods (Sixth pass)
    // Execute pending method registrations (e.g. from mixins created in Pass 2)
    let pendingIndex = 0;
    while (pendingIndex < this.#ctx.pendingMethodGenerations.length) {
      const generator = this.#ctx.pendingMethodGenerations[pendingIndex++];
      generator();
    }

    // Register methods for synthetic classes (mixins)
    for (const decl of this.#ctx.syntheticClasses) {
      registerClassMethods(this.#ctx, decl);
    }

    for (const statement of statements) {
      if (statement.type === NodeType.ClassDeclaration) {
        if (!this.#isUsed(statement as ClassDeclaration)) continue;
        registerClassMethods(this.#ctx, statement as ClassDeclaration);
      }
    }

    // 6. Register Functions and Variables (Sixth pass)
    // Use statementsWithModule to track current module for qualified names
    for (const statement of this.#ctx.statementsWithModule()) {
      if (statement.type === NodeType.ClassDeclaration) {
        if (!this.#isUsed(statement as ClassDeclaration)) continue;
        const classDecl = statement as ClassDeclaration;
        for (const member of classDecl.body) {
          if (
            member.type === NodeType.FieldDefinition &&
            member.isStatic &&
            member.value
          ) {
            const name = `${classDecl.name.name}_${getMemberName(member.name)}`;
            const type = inferType(this.#ctx, member.value);
            let initBytes: number[] = [];

            // Default initialization
            if (type[0] === ValType.i32)
              initBytes = [0x41, 0x00]; // i32.const 0
            else if (type[0] === ValType.f32)
              initBytes = [0x43, 0x00, 0x00, 0x00, 0x00]; // f32.const 0
            else if (type[0] === ValType.ref_null || type[0] === ValType.ref) {
              initBytes = [Opcode.ref_null, HeapType.none];
            } else {
              initBytes = [0x41, 0x00];
            }

            const globalIndex = this.#ctx.module.addGlobal(
              type,
              true, // Static fields are mutable
              initBytes,
            );
            this.#ctx.defineGlobal(name, globalIndex, type);
            globalInitializers.push({index: globalIndex, init: member.value});
          }
        }
      } else if (statement.type === NodeType.EnumDeclaration) {
        if (!this.#isUsed(statement as EnumDeclaration)) continue;
        this.#generateEnum(statement as EnumDeclaration);
      } else if (statement.type === NodeType.VariableDeclaration) {
        const varDecl = statement as VariableDeclaration;
        if (!this.#isUsed(varDecl)) continue;
        if (varDecl.pattern.type === NodeType.Identifier) {
          const name = varDecl.pattern.name;
          if (varDecl.init.type === NodeType.FunctionExpression) {
            registerFunction(
              this.#ctx,
              name,
              varDecl.init as FunctionExpression,
              this.#ctx.shouldExport(varDecl),
              (varDecl as any).exportName,
            );
          } else {
            // Global variable - use checker's inferredType
            const type = varDecl.inferredType
              ? mapCheckerTypeToWasmType(this.#ctx, varDecl.inferredType)
              : varDecl.typeAnnotation
                ? mapCheckerTypeToWasmType(
                    this.#ctx,
                    varDecl.typeAnnotation.inferredType!,
                  )
                : inferType(this.#ctx, varDecl.init);
            let initBytes: number[] = [];

            // Default initialization
            // Note: Do NOT include the 0x0b end opcode here - addGlobal adds it
            if (type[0] === ValType.i32)
              initBytes = [0x41, 0x00]; // i32.const 0
            else if (type[0] === ValType.f32)
              initBytes = [0x43, 0x00, 0x00, 0x00, 0x00]; // f32.const 0
            else if (type[0] === ValType.ref_null || type[0] === ValType.ref) {
              initBytes = [Opcode.ref_null, HeapType.none];
            } else {
              // Default to i32 0 if unknown (e.g. boolean)
              initBytes = [0x41, 0x00];
            }

            const globalIndex = this.#ctx.module.addGlobal(
              type,
              true,
              initBytes,
            );
            this.#ctx.defineGlobal(name, globalIndex, type);
            // Register by declaration for identity-based lookup (new name resolution)
            this.#ctx.registerGlobalByDecl(varDecl, globalIndex);
            globalInitializers.push({index: globalIndex, init: varDecl.init});

            if (this.#ctx.shouldExport(varDecl)) {
              const exportName = (varDecl as any).exportName || name;
              this.#ctx.module.addExport(
                exportName,
                ExportDesc.Global,
                globalIndex,
              );
            }
          }
        }
      }
    }

    // Execute any pending method registrations added during Pass 5 (e.g. from type inference)
    while (pendingIndex < this.#ctx.pendingMethodGenerations.length) {
      const generator = this.#ctx.pendingMethodGenerations[pendingIndex++];
      generator();
    }

    // Pass 2: Generate bodies
    this.#ctx.isGeneratingBodies = true;

    // Execute deferred body generators and pending helper functions
    // Use a single loop to handle mutual dependencies (e.g. helpers adding bodies or vice versa)
    let bodyIndex = 0;
    while (
      bodyIndex < this.#ctx.bodyGenerators.length ||
      this.#ctx.pendingHelperFunctions.length > 0
    ) {
      // Prioritize body generators to keep order somewhat predictable
      if (bodyIndex < this.#ctx.bodyGenerators.length) {
        const generator = this.#ctx.bodyGenerators[bodyIndex++];
        generator();
      } else {
        // Process pending helpers
        const gen = this.#ctx.pendingHelperFunctions.shift()!;
        gen();
      }
    }

    // Generate the $stringGetByte export for JS interop
    // This allows JavaScript to read bytes from Zena strings via the exported getter
    // Required for the V8-recommended pattern of reading WASM GC arrays from JS
    if (this.#ctx.stringTypeIndex >= 0) {
      generateStringGetByteFunction(this.#ctx);
      generateStringGetLengthFunction(this.#ctx);
      // Execute any newly added pending helper functions
      while (this.#ctx.pendingHelperFunctions.length > 0) {
        const gen = this.#ctx.pendingHelperFunctions.shift()!;
        gen();
      }
    }

    // Generate start function
    if (globalInitializers.length > 0) {
      const typeIndex = this.#ctx.module.addType([], []);
      const funcIndex = this.#ctx.module.addFunction(typeIndex);

      const body: number[] = [];
      this.#ctx.pushFunctionScope();

      for (const {index, init} of globalInitializers) {
        generateExpression(this.#ctx, init, body);
        body.push(Opcode.global_set);
        body.push(...WasmModule.encodeSignedLEB128(index));
      }
      body.push(Opcode.end);

      this.#ctx.module.addCode(funcIndex, this.#ctx.extraLocals, body);
      this.#ctx.module.setStart(funcIndex);
    }

    // Execute any body generators added during start function generation (e.g. generic instantiation)
    while (
      bodyIndex < this.#ctx.bodyGenerators.length ||
      this.#ctx.pendingHelperFunctions.length > 0
    ) {
      if (bodyIndex < this.#ctx.bodyGenerators.length) {
        const generator = this.#ctx.bodyGenerators[bodyIndex++];
        generator();
      }

      if (this.#ctx.pendingHelperFunctions.length > 0) {
        const gen = this.#ctx.pendingHelperFunctions.shift()!;
        gen();
      }
    }

    // Check for codegen errors before returning
    if (this.#ctx.diagnostics.hasErrors()) {
      throw new Error(
        `Code generation failed with errors:\n${this.#ctx.diagnostics.diagnostics.map((d) => d.message).join('\n')}`,
      );
    }

    return this.#ctx.module.toBytes();
  }

  #generateEnum(decl: EnumDeclaration) {
    // Determine backing type (assume i32 for now)
    const backingType = ValType.i32;

    const fieldTypes: number[] = [];
    for (const _ of decl.members) {
      fieldTypes.push(backingType);
    }

    // Create struct type
    // (field (mut i32)) ... actually they should be immutable (const).
    // (field i32)
    const structTypeIndex = this.#ctx.module.addStructType(
      fieldTypes.map((t) => ({type: [t], mutable: false})),
    );

    // Register enum info
    const members = new Map<string, number>();
    decl.members.forEach((m, i) => members.set(m.name.name, i));
    this.#ctx.enums.set(structTypeIndex, {members});

    // Create Global
    // (global $EnumName (ref $StructType) (struct.new $StructType (i32.const val)...))

    const initOps: number[] = [];
    for (const member of decl.members) {
      const val = member.resolvedValue;
      if (typeof val === 'number') {
        initOps.push(Opcode.i32_const, ...encodeSignedLEB128(val));
      } else {
        // Fallback for non-numbers (should be caught by checker)
        initOps.push(Opcode.i32_const, 0);
      }
    }

    initOps.push(
      Opcode.gc_prefix,
      GcOpcode.struct_new,
      ...encodeUnsignedLEB128(structTypeIndex),
    );

    const globalType = [ValType.ref, ...encodeSignedLEB128(structTypeIndex)]; // (ref $StructType)
    const globalIndex = this.#ctx.module.addGlobal(
      globalType,
      false, // immutable
      initOps,
    );

    this.#ctx.defineGlobal(decl.name.name, globalIndex, globalType);

    // Register the enum declaration for binding-based lookup
    this.#ctx.registerGlobalByDecl(decl, globalIndex);

    if (decl.exported) {
      this.#ctx.module.addExport(
        decl.name.name,
        ExportDesc.Global,
        globalIndex,
      );
    }
  }
}

function encodeSignedLEB128(value: number): number[] {
  const bytes: number[] = [];
  let more = true;
  while (more) {
    let byte = value & 0x7f;
    value >>= 7;
    if (
      (value === 0 && (byte & 0x40) === 0) ||
      (value === -1 && (byte & 0x40) !== 0)
    ) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}

function encodeUnsignedLEB128(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}
