import {DiagnosticBag, DiagnosticCode} from '../diagnostics.js';
import type {Type, ClassType, FunctionType} from '../types.js';
import type {Program} from '../ast.js';
import type {Compiler, Module} from '../compiler.js';

export interface SymbolInfo {
  type: Type;
  kind: 'let' | 'var' | 'type';
}

export class CheckerContext {
  scopes: Map<string, SymbolInfo>[] = [];
  diagnostics = new DiagnosticBag();
  currentFunctionReturnType: Type | null = null;
  currentClass: ClassType | null = null;
  currentMethod: string | null = null;
  isThisInitialized = true;
  program: Program;
  module?: Module;
  compiler?: Compiler;
  #classStack: (ClassType | null)[] = [];

  // Field initialization tracking
  isCheckingFieldInitializer = false;
  initializedFields = new Set<string>();
  inferredReturnTypes: Type[] = [];

  // Prelude support
  preludeExports = new Map<
    string,
    {modulePath: string; exportName: string; info: SymbolInfo}
  >();
  usedPreludeSymbols = new Map<
    string,
    {modulePath: string; exportName: string}
  >();

  constructor(program: Program, compiler?: Compiler, module?: Module) {
    this.program = program;
    this.compiler = compiler;
    this.module = module;
  }

  enterClass(classType: ClassType) {
    this.#classStack.push(this.currentClass);
    this.currentClass = classType;
  }

  exitClass() {
    this.currentClass = this.#classStack.pop() || null;
  }

  enterScope() {
    this.scopes.push(new Map());
  }

  exitScope() {
    this.scopes.pop();
  }

  declare(name: string, type: Type, kind: 'let' | 'var' | 'type' = 'let') {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) {
      const existing = scope.get(name)!;
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
    scope.set(name, {type, kind});
  }

  resolve(name: string): Type | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) {
        return this.scopes[i].get(name)!.type;
      }
    }

    // Check prelude
    if (this.preludeExports.has(name)) {
      const exportInfo = this.preludeExports.get(name)!;
      this.usedPreludeSymbols.set(name, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info.type;
    }

    return undefined;
  }

  resolveInfo(name: string): SymbolInfo | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) {
        return this.scopes[i].get(name)!;
      }
    }

    // Check prelude
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

  getWellKnownType(
    name: 'String' | 'FixedArray' | 'TemplateStringsArray',
  ): Type | undefined {
    // Check bundled well-known types first
    if (
      name === 'String' &&
      this.program.wellKnownTypes?.String?.inferredType
    ) {
      return this.program.wellKnownTypes.String.inferredType;
    }
    if (
      name === 'FixedArray' &&
      this.program.wellKnownTypes?.FixedArray?.inferredType
    ) {
      return this.program.wellKnownTypes.FixedArray.inferredType;
    }
    if (
      name === 'TemplateStringsArray' &&
      this.program.wellKnownTypes?.TemplateStringsArray?.inferredType
    ) {
      return this.program.wellKnownTypes.TemplateStringsArray.inferredType;
    }

    if (!this.compiler) return undefined;

    let modulePath = '';
    let exportName = '';

    if (name === 'String') {
      modulePath = 'zena:string';
      exportName = 'String';
    } else if (name === 'FixedArray') {
      modulePath = 'zena:array';
      exportName = 'FixedArray';
    } else if (name === 'TemplateStringsArray') {
      modulePath = 'zena:template-strings-array';
      exportName = 'TemplateStringsArray';
    }

    const module = this.compiler.getModule(modulePath);
    if (!module) return undefined;

    const symbol = module.exports.get(exportName);
    if (symbol) {
      // Record usage so it gets injected/bundled
      this.usedPreludeSymbols.set(exportName, {
        modulePath,
        exportName,
      });
      return symbol.type;
    }
    return undefined;
  }
}
