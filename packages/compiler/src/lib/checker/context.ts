import {DiagnosticBag, DiagnosticCode} from '../diagnostics.js';
import {
  type Type,
  type ClassType,
  type FunctionType,
  Types,
  TypeNames,
} from '../types.js';
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
    const key = kind === 'type' ? `type:${name}` : `value:${name}`;

    if (scope.has(key)) {
      const existing = scope.get(key)!;
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
    scope.set(key, {type, kind});
  }

  resolveValue(name: string): Type | undefined {
    const key = `value:${name}`;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(key)) {
        return this.scopes[i].get(key)!.type;
      }
    }

    // Check prelude
    if (this.preludeExports.has(key)) {
      const exportInfo = this.preludeExports.get(key)!;
      this.usedPreludeSymbols.set(key, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info.type;
    }

    // Fallback for legacy/unmangled prelude exports
    if (this.preludeExports.has(name)) {
      const exportInfo = this.preludeExports.get(name)!;
      if (exportInfo.info.kind !== 'type') {
        this.usedPreludeSymbols.set(name, {
          modulePath: exportInfo.modulePath,
          exportName: exportInfo.exportName,
        });
        return exportInfo.info.type;
      }
    }

    return undefined;
  }

  resolveType(name: string): Type | undefined {
    const key = `type:${name}`;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(key)) {
        return this.scopes[i].get(key)!.type;
      }
    }

    // Check prelude
    if (this.preludeExports.has(key)) {
      const exportInfo = this.preludeExports.get(key)!;
      this.usedPreludeSymbols.set(key, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info.type;
    }

    // Fallback for legacy/unmangled prelude exports
    if (this.preludeExports.has(name)) {
      const exportInfo = this.preludeExports.get(name)!;
      if (exportInfo.info.kind === 'type') {
        this.usedPreludeSymbols.set(name, {
          modulePath: exportInfo.modulePath,
          exportName: exportInfo.exportName,
        });
        return exportInfo.info.type;
      }
    }

    return undefined;
  }

  resolveInfo(name: string): SymbolInfo | undefined {
    // Try value first, then type? Or return both?
    // This method is used for finding symbol info, usually for values.
    // Let's check usage.
    const valueKey = `value:${name}`;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(valueKey)) {
        return this.scopes[i].get(valueKey)!;
      }
    }

    const typeKey = `type:${name}`;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(typeKey)) {
        return this.scopes[i].get(typeKey)!;
      }
    }

    // Check prelude
    if (this.preludeExports.has(valueKey)) {
      const exportInfo = this.preludeExports.get(valueKey)!;
      this.usedPreludeSymbols.set(valueKey, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info;
    }

    if (this.preludeExports.has(typeKey)) {
      const exportInfo = this.preludeExports.get(typeKey)!;
      this.usedPreludeSymbols.set(typeKey, {
        modulePath: exportInfo.modulePath,
        exportName: exportInfo.exportName,
      });
      return exportInfo.info;
    }

    // Check prelude (legacy)
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

  getWellKnownType(name: string): Type | undefined {
    // Check bundled well-known types first
    if (
      name === Types.String.name &&
      this.program.wellKnownTypes?.String?.inferredType
    ) {
      return this.program.wellKnownTypes.String.inferredType;
    }
    if (
      name === TypeNames.FixedArray &&
      this.program.wellKnownTypes?.FixedArray?.inferredType
    ) {
      return this.program.wellKnownTypes.FixedArray.inferredType;
    }

    if (!this.compiler) return undefined;

    let modulePath = '';
    let exportName = '';

    if (name === Types.String.name) {
      modulePath = 'zena:string';
      exportName = Types.String.name;
    } else if (name === TypeNames.FixedArray) {
      modulePath = 'zena:array';
      exportName = TypeNames.FixedArray;
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
