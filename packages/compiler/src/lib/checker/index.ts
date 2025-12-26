import {type Program} from '../ast.js';
import {type Diagnostic} from '../diagnostics.js';
import {CheckerContext} from './context.js';
import {checkStatement} from './statements.js';
import type {Compiler, Module} from '../compiler.js';
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
  #program: Program;
  #compiler?: Compiler;
  #module?: Module;
  preludeModules: Module[] = [];
  usedPreludeSymbols = new Map<
    string,
    {modulePath: string; exportName: string}
  >();

  constructor(program: Program, compiler?: Compiler, module?: Module) {
    this.#program = program;
    this.#compiler = compiler;
    this.#module = module;
  }

  check(): Diagnostic[] {
    const ctx = new CheckerContext(this.#program, this.#compiler, this.#module);

    // Populate prelude exports
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
    if (
      this.#module &&
      (this.#module.path.startsWith('zena:') || this.#module.isStdlib)
    ) {
      this.#registerIntrinsics(ctx);
    }

    for (const stmt of this.#program.body) {
      checkStatement(ctx, stmt);
    }

    ctx.exitScope();

    this.usedPreludeSymbols = ctx.usedPreludeSymbols;

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
