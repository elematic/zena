import {DiagnosticBag, DiagnosticCode} from '../diagnostics.js';
import type {Type, ClassType} from '../types.js';
import type {Program} from '../ast.js';

export interface SymbolInfo {
  type: Type;
  kind: 'let' | 'var';
}

export class CheckerContext {
  scopes: Map<string, SymbolInfo>[] = [];
  diagnostics = new DiagnosticBag();
  currentFunctionReturnType: Type | null = null;
  currentClass: ClassType | null = null;
  currentMethod: string | null = null;
  program: Program;

  constructor(program: Program) {
    this.program = program;
  }

  enterScope() {
    this.scopes.push(new Map());
  }

  exitScope() {
    this.scopes.pop();
  }

  declare(name: string, type: Type, kind: 'let' | 'var' = 'let') {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) {
      this.diagnostics.reportError(
        `Variable '${name}' is already declared in this scope.`,
        DiagnosticCode.DuplicateDeclaration,
      );
    }
    scope.set(name, {type, kind});
  }

  resolve(name: string): Type | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) {
        return this.scopes[i].get(name)!.type;
      }
    }
    return undefined;
  }

  resolveInfo(name: string): SymbolInfo | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) {
        return this.scopes[i].get(name)!;
      }
    }
    return undefined;
  }
}
