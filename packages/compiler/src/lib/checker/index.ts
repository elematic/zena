import {NodeType, type Program} from '../ast.js';
import {type Diagnostic} from '../diagnostics.js';
import {CheckerContext} from './context.js';
import {checkStatement} from './statements.js';
import type {Compiler, Module} from '../compiler.js';

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
