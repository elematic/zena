import {type Program} from '../ast.js';
import {type Diagnostic} from '../diagnostics.js';
import {CheckerContext} from './context.js';
import {checkStatement, predeclareType} from './statements.js';
import type {Module} from '../compiler.js';
import {
  TypeKind,
  type TypeParameterType,
  Types,
  type FunctionType,
  type ArrayType,
} from '../types.js';

/**
 * The TypeChecker analyzes the AST to validate types, resolve symbols,
 * and infer types for expressions. It populates the AST with type information
 * (e.g., `inferredType`) that is used by the CodeGenerator.
 */
export class TypeChecker {
  #ctx: CheckerContext;
  #module: Module;
  preludeModules: Module[] = [];

  constructor(ctx: CheckerContext, module: Module) {
    this.#ctx = ctx;
    this.#module = module;
  }

  /**
   * Create a TypeChecker for a standalone Program (no Compiler context).
   * Useful for simple tests that don't need multi-module support.
   *
   * @param program The AST to check
   * @param options Optional module configuration
   */
  static forProgram(
    program: Program,
    options?: {path?: string; isStdlib?: boolean},
  ): TypeChecker {
    const module: Module = {
      path: options?.path ?? '<standalone>',
      isStdlib: options?.isStdlib ?? false,
      source: '',
      ast: program,
      imports: new Map(),
      exports: new Map(),
      diagnostics: [],
    };
    const ctx = new CheckerContext();
    ctx.setCurrentLibrary(module);
    return new TypeChecker(ctx, module);
  }

  /**
   * Get the symbols used from the prelude after checking.
   * Must be called after check().
   */
  get usedPreludeSymbols(): Map<
    string,
    {modulePath: string; exportName: string}
  > {
    return this.#ctx.usedPreludeSymbols;
  }

  check(): Diagnostic[] {
    const ctx = this.#ctx;

    // Switch context to current module (resets per-library state)
    ctx.setCurrentLibrary(this.#module);

    // Populate prelude exports (only if not already populated - they're global)
    // This is done once per compilation, but we check here to be safe.
    // Note: preludeExports is global, so modules checked later will see exports
    // from modules checked earlier.
    for (const mod of this.preludeModules) {
      for (const [name, info] of mod.exports) {
        // Don't overwrite if multiple prelude modules export the same name (first wins)
        if (!ctx.preludeExports.has(name)) {
          ctx.preludeExports.set(name, {
            modulePath: mod.path,
            exportName: name,
            info,
          });
        }
      }
    }

    ctx.enterScope();

    // Only register intrinsics for system modules
    if (this.#module.path.startsWith('zena:') || this.#module.isStdlib) {
      this.#registerIntrinsics(ctx);
    }

    // First pass: pre-declare all type names (classes, mixins, interfaces)
    // This enables forward references (e.g., a mixin field referencing a class that uses the mixin)
    for (const stmt of ctx.program.body) {
      predeclareType(ctx, stmt);
    }

    // Second pass: fully check all statements
    for (const stmt of ctx.program.body) {
      checkStatement(ctx, stmt);
    }

    ctx.exitScope();

    return [...ctx.diagnostics.diagnostics];
  }

  #registerIntrinsics(ctx: CheckerContext) {
    const T: TypeParameterType = {
      kind: TypeKind.TypeParameter,
      name: 'T',
    };

    // __array_len<T>(array: array<T>): i32
    ctx.declare(
      '__array_len',
      {
        kind: TypeKind.Function,
        typeParameters: [T],
        parameters: [{kind: TypeKind.Array, elementType: T} as ArrayType],
        returnType: Types.I32,
      } as FunctionType,
      'let',
    );

    // __array_get<T>(array: array<T>, index: i32): T
    ctx.declare(
      '__array_get',
      {
        kind: TypeKind.Function,
        typeParameters: [T],
        parameters: [
          {kind: TypeKind.Array, elementType: T} as ArrayType,
          Types.I32,
        ],
        returnType: T,
      } as FunctionType,
      'let',
    );

    // __array_set<T>(array: array<T>, index: i32, value: T): void
    ctx.declare(
      '__array_set',
      {
        kind: TypeKind.Function,
        typeParameters: [T],
        parameters: [
          {kind: TypeKind.Array, elementType: T} as ArrayType,
          Types.I32,
          T,
        ],
        returnType: Types.Void,
      } as FunctionType,
      'let',
    );

    // __array_new<T>(size: i32, value: T): array<T>
    ctx.declare(
      '__array_new',
      {
        kind: TypeKind.Function,
        typeParameters: [T],
        parameters: [Types.I32, T],
        returnType: {
          kind: TypeKind.Array,
          elementType: T,
        } as ArrayType,
      } as FunctionType,
      'let',
    );

    // __array_new_empty<T>(size: i32): array<T>
    ctx.declare(
      '__array_new_empty',
      {
        kind: TypeKind.Function,
        typeParameters: [T],
        parameters: [Types.I32],
        returnType: {
          kind: TypeKind.Array,
          elementType: T,
        } as ArrayType,
      } as FunctionType,
      'let',
    );

    // unreachable(): never
    ctx.declare(
      'unreachable',
      {
        kind: TypeKind.Function,
        typeParameters: [],
        parameters: [],
        returnType: Types.Never,
      } as FunctionType,
      'let',
    );
  }
}
