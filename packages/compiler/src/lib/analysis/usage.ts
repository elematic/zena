/**
 * Usage analysis for dead code elimination.
 *
 * This module determines which declarations are "live" (reachable from entry
 * point exports) and marks them accordingly. Unused declarations can then be
 * eliminated during code generation.
 *
 * The analysis is sound but conservative - if we're unsure whether something
 * is used, we assume it is used. This ensures correctness at the cost of
 * potentially keeping some dead code.
 *
 * @module
 */

import {
  NodeType,
  type Declaration,
  type Module,
  type Program,
  type Node,
  type Statement,
  type VariableDeclaration,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type MixinDeclaration,
  type DeclareFunction,
  type TypeAliasDeclaration,
  type EnumDeclaration,
  type FunctionExpression,
  type Identifier,
  type NewExpression,
  type ArrayLiteral,
  type RangeExpression,
  type CallExpression,
} from '../ast.js';
import {visit, type Visitor} from '../visitor.js';
import type {SemanticContext} from '../checker/semantic-context.js';
import {
  TypeKind,
  type ClassType,
  type InterfaceType,
  type MixinType,
  type Type,
} from '../types.js';

/**
 * Information about a declaration's usage status.
 */
export interface UsageInfo {
  /** Whether this declaration is reachable from entry point exports */
  isUsed: boolean;

  /**
   * Why this declaration is marked as used.
   * Useful for debugging and "why is this included?" queries.
   */
  reason?: string;
}

/**
 * Result of usage analysis for a program.
 */
export interface UsageAnalysisResult {
  /**
   * Get usage info for a declaration.
   * Returns undefined for declarations not in the analyzed program.
   */
  getUsage(decl: Declaration): UsageInfo | undefined;

  /**
   * Check if a declaration is used (convenience method).
   * Returns true if the declaration is used or unknown (conservative).
   */
  isUsed(decl: Declaration): boolean;

  /**
   * Check if a module has any used declarations.
   * A module with no used declarations can be entirely skipped.
   */
  isModuleUsed(module: Module): boolean;

  /** Get all used declarations */
  readonly usedDeclarations: Set<Declaration>;

  /** Get all used modules */
  readonly usedModules: Set<Module>;
}

/**
 * Configuration for usage analysis.
 */
export interface UsageAnalysisOptions {
  /**
   * Semantic context from the checker, used to resolve identifier bindings.
   * If not provided, the analysis falls back to name-based resolution (less accurate).
   */
  semanticContext?: SemanticContext;

  /**
   * Whether to include debug information about why declarations are marked as used.
   * Defaults to false for better performance.
   */
  includeReasons?: boolean;

  /**
   * Module paths that should be treated as "pure" (no side effects in initializers).
   * Declarations from pure modules can be safely eliminated if unreferenced.
   * Standard library modules are pure by default.
   */
  pureModules?: Set<string>;
}

/**
 * Analyze usage in a program and determine which declarations are live.
 *
 * @param program - The compiled program to analyze
 * @param options - Configuration options
 * @returns Analysis result with usage information
 */
export function analyzeUsage(
  program: Program,
  options: UsageAnalysisOptions = {},
): UsageAnalysisResult {
  const analyzer = new UsageAnalyzer(program, options);
  return analyzer.analyze();
}

/**
 * Internal class that performs the usage analysis.
 */
class UsageAnalyzer {
  readonly #program: Program;
  readonly #options: UsageAnalysisOptions;
  readonly #semanticContext: SemanticContext | undefined;

  // Maps declarations to their usage info
  readonly #usageMap = new WeakMap<Declaration, UsageInfo>();

  // Set of all used declarations (for fast iteration)
  readonly #usedDeclarations = new Set<Declaration>();

  // Set of all used modules
  readonly #usedModules = new Set<Module>();

  // Worklist of declarations to process
  readonly #worklist: Declaration[] = [];

  // Set of declarations already added to worklist (to avoid duplicates)
  readonly #inWorklist = new Set<Declaration>();

  // Map from module-local names to declarations for fallback resolution
  readonly #declarationsByName = new Map<string, Declaration[]>();

  // Map from type to its declaration (for type-based lookups)
  readonly #declarationsByType = new WeakMap<Type, Declaration>();

  // Map from FunctionExpression to parent VariableDeclaration
  // (for marking the VariableDeclaration when a function binding is used)
  readonly #funcToVarDecl = new WeakMap<
    FunctionExpression,
    VariableDeclaration
  >();

  constructor(program: Program, options: UsageAnalysisOptions) {
    this.#program = program;
    this.#options = options;
    this.#semanticContext = options.semanticContext;
  }

  analyze(): UsageAnalysisResult {
    // Phase 1: Index all declarations
    this.#indexDeclarations();

    // Phase 2: Find and mark roots (entry point exports)
    this.#markRoots();

    // Phase 3: Process worklist until empty
    this.#processWorklist();

    // Phase 4: Determine which modules are used
    this.#computeUsedModules();

    return this.#createResult();
  }

  /**
   * Index all declarations in the program for later lookup.
   */
  #indexDeclarations(): void {
    for (const module of this.#program.modules.values()) {
      for (const stmt of module.body) {
        this.#indexDeclaration(stmt, module);
      }
    }
  }

  #indexDeclaration(stmt: Statement, module: Module): void {
    switch (stmt.type) {
      case NodeType.VariableDeclaration: {
        const decl = stmt as VariableDeclaration;
        if (decl.pattern.type === NodeType.Identifier) {
          this.#addDeclarationByName(decl.pattern.name, decl);
        }
        // Also index the function expression if it's a function declaration
        if (decl.init?.type === NodeType.FunctionExpression) {
          const funcExpr = decl.init as FunctionExpression;
          this.#addDeclarationByName(
            decl.pattern.type === NodeType.Identifier
              ? decl.pattern.name
              : '<anon>',
            funcExpr,
          );
          // Map function expression back to its variable declaration
          this.#funcToVarDecl.set(funcExpr, decl);
        }
        break;
      }
      case NodeType.ClassDeclaration: {
        const decl = stmt as ClassDeclaration;
        this.#addDeclarationByName(decl.name.name, decl);
        if (decl.inferredType) {
          this.#declarationsByType.set(decl.inferredType, decl);
        }
        break;
      }
      case NodeType.InterfaceDeclaration: {
        const decl = stmt as InterfaceDeclaration;
        this.#addDeclarationByName(decl.name.name, decl);
        if (decl.inferredType) {
          this.#declarationsByType.set(decl.inferredType, decl);
        }
        break;
      }
      case NodeType.MixinDeclaration: {
        const decl = stmt as MixinDeclaration;
        this.#addDeclarationByName(decl.name.name, decl);
        if (decl.inferredType) {
          this.#declarationsByType.set(decl.inferredType, decl);
        }
        break;
      }
      case NodeType.DeclareFunction: {
        const decl = stmt as DeclareFunction;
        this.#addDeclarationByName(decl.name.name, decl);
        break;
      }
      case NodeType.TypeAliasDeclaration: {
        const decl = stmt as TypeAliasDeclaration;
        this.#addDeclarationByName(decl.name.name, decl);
        if (decl.inferredType) {
          this.#declarationsByType.set(decl.inferredType, decl);
        }
        break;
      }
      case NodeType.EnumDeclaration: {
        const decl = stmt as EnumDeclaration;
        this.#addDeclarationByName(decl.name.name, decl);
        break;
      }
    }
  }

  #addDeclarationByName(name: string, decl: Declaration): void {
    const existing = this.#declarationsByName.get(name);
    if (existing) {
      existing.push(decl);
    } else {
      this.#declarationsByName.set(name, [decl]);
    }
    // Pre-mark all declarations as unused initially.
    // The worklist will mark used ones as used.
    if (!this.#usageMap.has(decl)) {
      this.#usageMap.set(decl, {isUsed: false});
    }
  }

  /**
   * Mark entry point exports as roots.
   */
  #markRoots(): void {
    const entryModule = this.#program.modules.get(this.#program.entryPoint);
    if (!entryModule) return;

    for (const stmt of entryModule.body) {
      // Mark all exported declarations as roots
      if (this.#isExported(stmt)) {
        const decl = this.#getDeclarationFromStatement(stmt);
        if (decl) {
          this.#markUsed(decl, 'entry point export');
        }
      }
    }
  }

  #isExported(stmt: Statement): boolean {
    switch (stmt.type) {
      case NodeType.VariableDeclaration:
        return (stmt as VariableDeclaration).exported;
      case NodeType.ClassDeclaration:
        return (stmt as ClassDeclaration).exported;
      case NodeType.InterfaceDeclaration:
        return (stmt as InterfaceDeclaration).exported;
      case NodeType.MixinDeclaration:
        return (stmt as MixinDeclaration).exported;
      case NodeType.DeclareFunction:
        return (stmt as DeclareFunction).exported ?? false;
      case NodeType.TypeAliasDeclaration:
        return (stmt as TypeAliasDeclaration).exported;
      case NodeType.EnumDeclaration:
        return (stmt as EnumDeclaration).exported;
      default:
        return false;
    }
  }

  #getDeclarationFromStatement(stmt: Statement): Declaration | null {
    switch (stmt.type) {
      case NodeType.VariableDeclaration: {
        const decl = stmt as VariableDeclaration;
        // For function declarations (let f = () => ...), return the variable decl
        return decl.pattern.type === NodeType.Identifier ? decl : null;
      }
      case NodeType.ClassDeclaration:
      case NodeType.InterfaceDeclaration:
      case NodeType.MixinDeclaration:
      case NodeType.DeclareFunction:
      case NodeType.TypeAliasDeclaration:
      case NodeType.EnumDeclaration:
        return stmt as Declaration;
      default:
        return null;
    }
  }

  /**
   * Mark a declaration as used and add it to the worklist.
   */
  #markUsed(decl: Declaration, reason?: string): void {
    if (this.#usedDeclarations.has(decl)) return;

    const info: UsageInfo = {isUsed: true};
    if (this.#options.includeReasons && reason) {
      info.reason = reason;
    }

    this.#usageMap.set(decl, info);
    this.#usedDeclarations.add(decl);

    if (!this.#inWorklist.has(decl)) {
      this.#worklist.push(decl);
      this.#inWorklist.add(decl);
    }

    // If this is a FunctionExpression, also mark its parent VariableDeclaration
    if (decl.type === NodeType.FunctionExpression) {
      const parentDecl = this.#funcToVarDecl.get(decl as FunctionExpression);
      if (parentDecl && !this.#usedDeclarations.has(parentDecl)) {
        this.#markUsed(parentDecl, reason);
      }
    }
  }

  /**
   * Process the worklist until empty.
   */
  #processWorklist(): void {
    while (this.#worklist.length > 0) {
      const decl = this.#worklist.pop()!;
      this.#processDeclaration(decl);
    }
  }

  /**
   * Process a declaration to find what it references.
   */
  #processDeclaration(decl: Declaration): void {
    // Create a visitor that finds references
    const visitor = this.#createReferenceVisitor();

    // Visit the declaration based on its type
    switch (decl.type) {
      case NodeType.VariableDeclaration: {
        const varDecl = decl as VariableDeclaration;
        visit(varDecl.init, visitor, null);
        visit(varDecl.typeAnnotation, visitor, null);
        break;
      }
      case NodeType.ClassDeclaration: {
        const classDecl = decl as ClassDeclaration;
        // Visit superclass, mixins, implements, and body
        visit(classDecl.superClass, visitor, null);
        for (const mixin of classDecl.mixins ?? []) {
          visit(mixin, visitor, null);
        }
        for (const impl of classDecl.implements ?? []) {
          visit(impl, visitor, null);
        }
        visit(classDecl.onType, visitor, null);
        for (const member of classDecl.body) {
          visit(member, visitor, null);
        }
        break;
      }
      case NodeType.InterfaceDeclaration: {
        const ifaceDecl = decl as InterfaceDeclaration;
        for (const ext of ifaceDecl.extends ?? []) {
          visit(ext, visitor, null);
        }
        for (const member of ifaceDecl.body) {
          visit(member, visitor, null);
        }
        break;
      }
      case NodeType.MixinDeclaration: {
        const mixinDecl = decl as MixinDeclaration;
        for (const mixin of mixinDecl.mixins ?? []) {
          visit(mixin, visitor, null);
        }
        for (const member of mixinDecl.body) {
          visit(member, visitor, null);
        }
        break;
      }
      case NodeType.DeclareFunction: {
        const funcDecl = decl as DeclareFunction;
        for (const param of funcDecl.params) {
          visit(param.typeAnnotation, visitor, null);
        }
        visit(funcDecl.returnType, visitor, null);
        break;
      }
      case NodeType.TypeAliasDeclaration: {
        const typeDecl = decl as TypeAliasDeclaration;
        visit(typeDecl.typeAnnotation, visitor, null);
        break;
      }
      case NodeType.FunctionExpression: {
        const funcExpr = decl as FunctionExpression;
        for (const param of funcExpr.params) {
          visit(param.typeAnnotation, visitor, null);
        }
        visit(funcExpr.returnType, visitor, null);
        visit(funcExpr.body, visitor, null);
        break;
      }
      case NodeType.Identifier:
        // An identifier declaration doesn't reference anything itself
        break;
      case NodeType.Parameter:
        // A parameter doesn't reference anything besides its type annotation
        visit((decl as any).typeAnnotation, visitor, null);
        break;
      case NodeType.TypeParameter:
        // Type parameters may have constraints
        visit((decl as any).constraint, visitor, null);
        visit((decl as any).default, visitor, null);
        break;
      case NodeType.EnumDeclaration:
        // Enum members don't reference external declarations
        break;
    }
  }

  /**
   * Create a visitor that finds and marks references.
   */
  #createReferenceVisitor(): Visitor<null> {
    return {
      // Handle identifier references
      visitIdentifier: (node: Identifier) => {
        this.#handleIdentifierReference(node);
      },

      // Handle new expressions (class instantiation)
      visitNewExpression: (node: NewExpression) => {
        // The callee is a class reference
        this.#handleTypeReference(node.callee.name);

        // Also handle the inferred type if available
        if (node.inferredType?.kind === TypeKind.Class) {
          this.#handleTypeUsage(node.inferredType);
        }
      },

      // Handle type annotations (type references)
      visitTypeAnnotation: (node) => {
        this.#handleTypeReference(node.name);
      },

      // Handle syntax-implied usages
      visitStringLiteral: () => {
        this.#handleTypeReference('String');
      },

      visitTemplateLiteral: () => {
        this.#handleTypeReference('String');
        this.#handleTypeReference('TemplateStringsArray');
      },

      visitTaggedTemplateExpression: () => {
        this.#handleTypeReference('TemplateStringsArray');
      },

      visitArrayLiteral: (node: ArrayLiteral) => {
        // #[1, 2, 3] creates a FixedArray
        // We can check inferredType to be sure
        if (node.inferredType?.kind === TypeKind.Array) {
          this.#handleTypeReference('FixedArray');
        }
      },

      visitRangeExpression: (node: RangeExpression) => {
        // Determine which range class to use based on bounds
        if (node.start && node.end) {
          this.#handleTypeReference('BoundedRange');
        } else if (node.start) {
          this.#handleTypeReference('FromRange');
        } else if (node.end) {
          this.#handleTypeReference('ToRange');
        } else {
          this.#handleTypeReference('FullRange');
        }
      },

      visitThrowExpression: () => {
        this.#handleTypeReference('Error');
      },

      // Handle member expressions for method calls
      visitCallExpression: (node: CallExpression) => {
        // If calling a method, mark the method as used
        // This is handled by the callee expression visitor
      },

      // Don't recurse into nested function bodies by default
      // (they will be processed when the function is marked used)
      beforeVisit: (node: Node) => {
        // Skip nested function declarations - they will be processed separately
        if (node.type === NodeType.FunctionExpression) {
          // But we still want to visit if it's the top-level thing
          // The parent processDeclaration handles this
          return true;
        }
        return true;
      },
    };
  }

  /**
   * Handle an identifier that may reference a declaration.
   */
  #handleIdentifierReference(node: Identifier): void {
    // Try to resolve using semantic context first (most accurate)
    // Try to resolve using semantic context first (most accurate)
    if (this.#semanticContext) {
      const binding = this.#semanticContext.getResolvedBinding(node);
      if (binding) {
        const decl = this.#getDeclarationFromBinding(binding);
        if (decl) {
          this.#markUsed(decl, `referenced by identifier '${node.name}'`);
          return;
        }
      }
    }

    // Fallback: look up by name
    const decls = this.#declarationsByName.get(node.name);
    if (decls) {
      for (const decl of decls) {
        this.#markUsed(decl, `referenced by name '${node.name}'`);
      }
    }
  }

  /**
   * Extract the declaration from a resolved binding.
   */
  #getDeclarationFromBinding(
    binding: import('../bindings.js').ResolvedBinding,
  ): Declaration | null {
    switch (binding.kind) {
      case 'local':
        // Parameter or VariableDeclaration or Identifier
        return binding.declaration as Declaration;
      case 'global':
        return binding.declaration;
      case 'function':
        return binding.declaration;
      case 'class':
        return binding.declaration;
      case 'interface':
        return binding.declaration;
      case 'mixin':
        return binding.declaration;
      case 'type-alias':
        return binding.declaration;
      case 'type-parameter':
        return binding.declaration;
      case 'import':
        // Recursively resolve import targets
        return this.#getDeclarationFromBinding(binding.target);
      case 'field':
      case 'getter':
      case 'method':
      case 'record-field':
        // Member bindings don't have a direct declaration
        return null;
      default:
        return null;
    }
  }

  /**
   * Handle a type reference by name (e.g., in type annotations).
   */
  #handleTypeReference(name: string): void {
    const decls = this.#declarationsByName.get(name);
    if (decls) {
      for (const decl of decls) {
        this.#markUsed(decl, `type reference '${name}'`);
      }
    }
  }

  /**
   * Handle usage of a type (from inferredType).
   */
  #handleTypeUsage(type: Type): void {
    // Find the declaration for this type
    const decl = this.#declarationsByType.get(type);
    if (decl) {
      this.#markUsed(decl, 'type usage');
      return;
    }

    // For generic instantiations, also mark the generic source
    switch (type.kind) {
      case TypeKind.Class: {
        const classType = type as ClassType;
        if (classType.genericSource) {
          this.#handleTypeUsage(classType.genericSource);
        }
        // Mark superclass and implemented interfaces
        if (classType.superType) {
          this.#handleTypeUsage(classType.superType);
        }
        for (const iface of classType.implements) {
          this.#handleTypeUsage(iface);
        }
        break;
      }
      case TypeKind.Interface: {
        const ifaceType = type as InterfaceType;
        if (ifaceType.genericSource) {
          this.#handleTypeUsage(ifaceType.genericSource);
        }
        for (const ext of ifaceType.extends ?? []) {
          this.#handleTypeUsage(ext);
        }
        break;
      }
      case TypeKind.Mixin: {
        const mixinType = type as MixinType;
        if (mixinType.genericSource) {
          this.#handleTypeUsage(mixinType.genericSource);
        }
        break;
      }
    }
  }

  /**
   * Compute which modules have used declarations.
   */
  #computeUsedModules(): void {
    for (const module of this.#program.modules.values()) {
      for (const stmt of module.body) {
        const decl = this.#getDeclarationFromStatement(stmt);
        if (decl && this.#usedDeclarations.has(decl)) {
          this.#usedModules.add(module);
          break;
        }
      }
    }
  }

  /**
   * Create the final result object.
   */
  #createResult(): UsageAnalysisResult {
    const usageMap = this.#usageMap;
    const usedDeclarations = this.#usedDeclarations;
    const usedModules = this.#usedModules;

    return {
      getUsage(decl: Declaration): UsageInfo | undefined {
        return usageMap.get(decl);
      },

      isUsed(decl: Declaration): boolean {
        const info = usageMap.get(decl);
        // Conservative: if we don't have info, assume it's used
        return info?.isUsed ?? true;
      },

      isModuleUsed(module: Module): boolean {
        return usedModules.has(module);
      },

      get usedDeclarations() {
        return usedDeclarations;
      },

      get usedModules() {
        return usedModules;
      },
    };
  }
}

/**
 * Check if a module is considered "pure" (no side effects).
 * Pure modules can have their unused declarations safely eliminated.
 */
export function isPureModule(
  module: Module,
  pureModules?: Set<string>,
): boolean {
  // Standard library modules are pure by default
  if (module.isStdlib || module.path?.startsWith('zena:')) {
    return true;
  }

  // Check explicit pure modules set
  if (pureModules && module.path && pureModules.has(module.path)) {
    return true;
  }

  return false;
}

/**
 * Get the declaration node for a statement, if it's a declaration.
 */
export function getStatementDeclaration(stmt: Statement): Declaration | null {
  switch (stmt.type) {
    case NodeType.VariableDeclaration: {
      const decl = stmt as VariableDeclaration;
      return decl.pattern.type === NodeType.Identifier ? decl : null;
    }
    case NodeType.ClassDeclaration:
    case NodeType.InterfaceDeclaration:
    case NodeType.MixinDeclaration:
    case NodeType.DeclareFunction:
    case NodeType.TypeAliasDeclaration:
    case NodeType.EnumDeclaration:
      return stmt as Declaration;
    default:
      return null;
  }
}
