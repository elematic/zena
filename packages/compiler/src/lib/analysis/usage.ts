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
  type MemberExpression,
  type BinaryExpression,
  type IndexExpression,
  type AssignmentExpression,
} from '../ast.js';
import {visit, type Visitor} from '../visitor.js';
import type {SemanticContext} from '../checker/semantic-context.js';
import {getSignatureKey} from '../names.js';
import {
  TypeKind,
  type ClassType,
  type InterfaceType,
  type MixinType,
  type Type,
} from '../types.js';

/**
 * Key for identifying a method: combines class type and method name.
 * We use the class type's identity for proper tracking across modules.
 */
export interface MethodKey {
  /** The class type (by identity) */
  classType: ClassType | InterfaceType;
  /** The method name */
  methodName: string;
}

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

  /**
   * Check if a method is used on a class or interface.
   * Returns true if the method is called directly or via polymorphic dispatch.
   *
   * @param classType - The class or interface type
   * @param methodName - The method name (including signature key for overloads)
   * @returns true if the method is used, false if it can be eliminated
   */
  isMethodUsed(
    classType: ClassType | InterfaceType,
    methodName: string,
  ): boolean;

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

  // Track used methods by class/interface type
  // Maps ClassType/InterfaceType -> Set of method names that are used
  readonly #usedMethods = new WeakMap<ClassType | InterfaceType, Set<string>>();

  // Track classes that have polymorphic method calls (calls through base class/interface)
  // For these, all overrides in subclasses must be kept
  readonly #polymorphicMethods = new WeakMap<
    ClassType | InterfaceType,
    Set<string>
  >();

  // Map from ClassType to all known subclasses (for propagating polymorphic calls)
  readonly #subclasses = new WeakMap<ClassType, Set<ClassType>>();

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
          // Build subclass map for polymorphic call propagation
          const classType = decl.inferredType as ClassType;
          if (classType.superType) {
            let subclasses = this.#subclasses.get(classType.superType);
            if (!subclasses) {
              subclasses = new Set();
              this.#subclasses.set(classType.superType, subclasses);
            }
            subclasses.add(classType);
          }
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

      // Handle member expressions for method/getter access
      visitMemberExpression: (node: MemberExpression) => {
        // Try to get the resolved binding for this member access
        if (this.#semanticContext) {
          const binding = this.#semanticContext.getResolvedBinding(node);
          if (binding) {
            if (binding.kind === 'method') {
              // Mark this method as used on the specific class type
              this.#markMethodUsed(
                binding.classType,
                binding.methodName,
                !binding.isStaticDispatch,
              );
            } else if (binding.kind === 'getter') {
              // Getters are also methods
              this.#markMethodUsed(
                binding.classType,
                binding.methodName,
                !binding.isStaticDispatch,
              );
            } else if (binding.kind === 'setter') {
              // Setters are also methods
              this.#markMethodUsed(
                binding.classType,
                binding.methodName,
                !binding.isStaticDispatch,
              );
            } else if (binding.kind === 'field') {
              // Public field access - mark the implicit getter as used
              // because codegen uses implicit getters for virtual dispatch
              const getterName = `get#${binding.fieldName}`;
              const isFinal =
                binding.classType.kind === TypeKind.Class &&
                (binding.classType as ClassType).isFinal === true;
              this.#markMethodUsed(binding.classType, getterName, !isFinal);
            }
          }
        }
      },

      // Handle call expressions - mark methods and constructors
      visitCallExpression: (node: CallExpression) => {
        // Check if this is a method call via resolved binding on callee
        if (
          node.callee.type === NodeType.MemberExpression &&
          this.#semanticContext
        ) {
          const binding = this.#semanticContext.getResolvedBinding(
            node.callee as MemberExpression,
          );
          if (binding && binding.kind === 'method') {
            this.#markMethodUsed(
              binding.classType,
              binding.methodName,
              !binding.isStaticDispatch,
            );
          }
        }
      },

      // Handle binary expressions for operator methods (operator ==, operator !=, etc.)
      visitBinaryExpression: (node: BinaryExpression) => {
        // Map binary operators to their operator method names
        // Currently only == is implemented, but this is designed to support
        // future operators like +, -, *, etc.
        const operatorMap: Record<string, string | undefined> = {
          '==': '==',
          '!=': '==', // != uses the same operator == method (result is negated)
          // Future: uncomment when these operators are implemented
          // '+': '+',
          // '-': '-',
          // '*': '*',
          // '/': '/',
        };

        const operatorMethodName = operatorMap[node.operator];
        if (operatorMethodName) {
          // Check if the left operand has a class type with this operator
          const leftType = node.left.inferredType;
          if (leftType && leftType.kind === TypeKind.Class) {
            const classType = leftType as ClassType;
            // Check if this class has the operator method
            if (classType.methods.has(operatorMethodName)) {
              // Mark operator method as used
              const isFinal = classType.isFinal === true;
              this.#markMethodUsed(classType, operatorMethodName, !isFinal);
            }
          }
        }
      },

      // Handle index expressions for operator []
      visitIndexExpression: (node: IndexExpression) => {
        // Check if resolvedOperatorMethod was set by the checker
        if (node.resolvedOperatorMethod) {
          // Get the class type from the object expression
          const objectType = node.object.inferredType;
          if (objectType && objectType.kind === TypeKind.Class) {
            const classType = objectType as ClassType;
            // The operator [] method name needs to include signature for overloads
            // Use the same mangling approach as codegen
            const methodName = '[]' + getSignatureKey(node.resolvedOperatorMethod);
            const isFinal = classType.isFinal === true;
            this.#markMethodUsed(classType, methodName, !isFinal);
          }
        }
        // Also handle extension class operators
        if (node.extensionClassType) {
          const classType = node.extensionClassType;
          if (node.resolvedOperatorMethod) {
            const methodName = '[]' + getSignatureKey(node.resolvedOperatorMethod);
            const isFinal = classType.isFinal === true;
            this.#markMethodUsed(classType, methodName, !isFinal);
          }
        }
      },

      // Handle assignment expressions for operator []=
      visitAssignmentExpression: (node: AssignmentExpression) => {
        // Check if the left side is an index expression (for operator []=)
        if (node.left.type === NodeType.IndexExpression) {
          const indexExpr = node.left as IndexExpression;
          const objectType = indexExpr.object.inferredType;
          
          // Check if the object type is a class or interface with operator []=
          if (
            objectType &&
            (objectType.kind === TypeKind.Class ||
              objectType.kind === TypeKind.Interface)
          ) {
            const classType = objectType as ClassType | InterfaceType;
            // Check if this class/interface has operator []=
            if (classType.methods.has('[]=')) {
              // Mark operator []= as used
              const isFinal =
                objectType.kind === TypeKind.Class &&
                (classType as ClassType).isFinal === true;
              this.#markMethodUsed(classType, '[]=', !isFinal);
            }
          }
        }
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
   * Mark a method as used on a class or interface.
   *
   * @param classType - The class or interface type
   * @param methodName - The method name
   * @param isPolymorphic - Whether the call could dispatch to subclass overrides
   */
  #markMethodUsed(
    classType: ClassType | InterfaceType,
    methodName: string,
    isPolymorphic: boolean,
  ): void {
    // Get or create the used methods set for this type
    let usedSet = this.#usedMethods.get(classType);
    if (!usedSet) {
      usedSet = new Set();
      this.#usedMethods.set(classType, usedSet);
    }
    usedSet.add(methodName);

    // If polymorphic, we need to mark all overrides in subclasses as used too
    if (isPolymorphic) {
      let polySet = this.#polymorphicMethods.get(classType);
      if (!polySet) {
        polySet = new Set();
        this.#polymorphicMethods.set(classType, polySet);
      }
      polySet.add(methodName);

      // For class types, propagate to all known subclasses
      if (classType.kind === TypeKind.Class) {
        this.#propagateMethodToSubclasses(classType as ClassType, methodName);
      }

      // For interface types, we'll handle this conservatively in isMethodUsed
      // by checking if any base interface has the method marked as polymorphic
    }
  }

  /**
   * Propagate a polymorphic method call to all known subclasses.
   */
  #propagateMethodToSubclasses(classType: ClassType, methodName: string): void {
    const subclasses = this.#subclasses.get(classType);
    if (!subclasses) return;

    for (const subclass of subclasses) {
      // Mark the method as used in the subclass
      let usedSet = this.#usedMethods.get(subclass);
      if (!usedSet) {
        usedSet = new Set();
        this.#usedMethods.set(subclass, usedSet);
      }
      usedSet.add(methodName);

      // Recursively propagate to subclass's subclasses
      this.#propagateMethodToSubclasses(subclass, methodName);
    }
  }

  /**
   * Check if a method is used on a class or interface.
   * Accounts for polymorphic dispatch from base classes/interfaces.
   */
  #isMethodUsedInternal(
    classType: ClassType | InterfaceType,
    methodName: string,
  ): boolean {
    // Check if directly marked as used
    const usedSet = this.#usedMethods.get(classType);
    if (usedSet?.has(methodName)) {
      return true;
    }

    // For classes, check if any base class has polymorphic call to this method
    if (classType.kind === TypeKind.Class) {
      const ct = classType as ClassType;
      let current: ClassType | undefined = ct.superType;
      while (current) {
        const polySet = this.#polymorphicMethods.get(current);
        if (polySet?.has(methodName)) {
          return true;
        }
        current = current.superType;
      }

      // Also check implemented interfaces for polymorphic calls
      for (const iface of ct.implements) {
        if (this.#isMethodUsedViaInterface(iface, methodName)) {
          return true;
        }
      }
    }

    // For interfaces, check parent interfaces
    if (classType.kind === TypeKind.Interface) {
      const it = classType as InterfaceType;
      for (const parent of it.extends ?? []) {
        const polySet = this.#polymorphicMethods.get(parent);
        if (polySet?.has(methodName)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a method is used via an interface (polymorphic).
   */
  #isMethodUsedViaInterface(iface: InterfaceType, methodName: string): boolean {
    const polySet = this.#polymorphicMethods.get(iface);
    if (polySet?.has(methodName)) {
      return true;
    }
    // Check parent interfaces
    for (const parent of iface.extends ?? []) {
      if (this.#isMethodUsedViaInterface(parent, methodName)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Create the final result object.
   */
  #createResult(): UsageAnalysisResult {
    const usageMap = this.#usageMap;
    const usedDeclarations = this.#usedDeclarations;
    const usedModules = this.#usedModules;
    // Capture 'this' for the closure
    const analyzer = this;

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

      isMethodUsed(
        classType: ClassType | InterfaceType,
        methodName: string,
      ): boolean {
        return analyzer.#isMethodUsedInternal(classType, methodName);
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
