import {NodeType, type Program} from '../ast.js';
import {type Diagnostic} from '../diagnostics.js';
import {CheckerContext} from './context.js';
import {checkStatement} from './statements.js';
import type {Compiler, Module} from '../compiler.js';
import {
  TypeKind,
  type TypeParameterType,
  Types,
  type FunctionType,
  type FixedArrayType,
} from '../types.js';

export class TypeChecker {
  #program: Program;
  #compiler?: Compiler;
  #module?: Module;

  constructor(program: Program, compiler?: Compiler, module?: Module) {
    this.#program = program;
    this.#compiler = compiler;
    this.#module = module;
  }

  check(): Diagnostic[] {
    const ctx = new CheckerContext(this.#program, this.#compiler, this.#module);
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

    // If we are checking a module, we should populate its exports
    if (this.#module) {
      this.#collectExports(ctx, this.#module);
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
        parameters: [
          {kind: TypeKind.FixedArray, elementType: T} as FixedArrayType,
        ],
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
          {kind: TypeKind.FixedArray, elementType: T} as FixedArrayType,
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
          {kind: TypeKind.FixedArray, elementType: T} as FixedArrayType,
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
          kind: TypeKind.FixedArray,
          elementType: T,
        } as FixedArrayType,
      } as FunctionType,
      'let',
    );
  }

  #collectExports(ctx: CheckerContext, module: Module) {
    const scope = ctx.scopes[0]; // Global scope of the module

    for (const stmt of this.#program.body) {
      if ('exported' in stmt && (stmt as any).exported) {
        let name: string | undefined;

        switch (stmt.type) {
          case NodeType.VariableDeclaration:
            if (stmt.pattern.type === NodeType.Identifier) {
              name = stmt.pattern.name;
            }
            break;
          case NodeType.ClassDeclaration:
          case NodeType.InterfaceDeclaration:
          case NodeType.MixinDeclaration:
            name = stmt.name.name;
            break;
        }

        if (name) {
          const info = scope.get(name);
          if (info) {
            module.exports.set(name, info);
          }
        }
      }
    }
  }
}
