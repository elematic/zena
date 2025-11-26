import type {Program} from '../ast.js';
import {type Diagnostic, DiagnosticBag} from '../diagnostics.js';
import {CheckerContext} from './context.js';
import {checkStatement} from './statements.js';

export class TypeChecker {
  #program: Program;

  constructor(program: Program) {
    this.#program = program;
  }

  check(): Diagnostic[] {
    const ctx = new CheckerContext(this.#program);
    ctx.enterScope();

    for (const stmt of this.#program.body) {
      checkStatement(ctx, stmt);
    }

    ctx.exitScope();

    return [...ctx.diagnostics.diagnostics];
  }
}
