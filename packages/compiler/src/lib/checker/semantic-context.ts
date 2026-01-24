/**
 * SemanticContext stores semantic metadata separately from the AST.
 *
 * This enables:
 * 1. Immutable AST - syntax information stays immutable
 * 2. Type identity by object reference - stable lookups regardless of renaming
 * 3. Clear separation between parsing, type-checking, and code generation
 * 4. Foundation for incremental compilation
 *
 * The context provides mappings from AST nodes to their inferred types
 * and resolved bindings.
 *
 * Note: Emitter-specific information (like WASM struct indices) is stored
 * in the emitter layer (CodegenContext), not here. This keeps SemanticContext
 * output-format agnostic.
 */

import type {Identifier, MemberExpression, Node} from '../ast.js';
import type {ResolvedBinding} from '../bindings.js';
import type {Type} from '../types.js';

/**
 * SemanticContext manages semantic metadata for the compiler.
 *
 * This is the central store for information computed during type-checking.
 * Using object identity as keys ensures stable lookups regardless of how
 * declaration names might be transformed.
 */
export class SemanticContext {
  /**
   * Map AST nodes to their inferred types.
   * This replaces the `inferredType` field on Expression nodes.
   */
  readonly #nodeTypes = new Map<Node, Type>();

  /**
   * Map name references (Identifiers, MemberExpressions) to their resolved bindings.
   * This is the result of name resolution during type checking.
   *
   * Example: For `let x = foo()`, the Identifier `foo` is mapped to a
   * FunctionBinding pointing to the foo function declaration.
   */
  readonly #resolvedBindings = new Map<
    Identifier | MemberExpression,
    ResolvedBinding
  >();

  // ===== Node Type Management =====

  /**
   * Store the inferred type for an AST node.
   */
  setNodeType(node: Node, type: Type): void {
    this.#nodeTypes.set(node, type);
  }

  /**
   * Get the inferred type for an AST node, if any.
   */
  getNodeType(node: Node): Type | undefined {
    return this.#nodeTypes.get(node);
  }

  /**
   * Check if a node has an inferred type.
   */
  hasNodeType(node: Node): boolean {
    return this.#nodeTypes.has(node);
  }

  // ===== Resolved Binding Management =====

  /**
   * Store the resolved binding for a name reference.
   * Called during type checking when an identifier is resolved.
   *
   * @param node The identifier or member expression being resolved
   * @param binding The resolved binding (what the name refers to)
   */
  setResolvedBinding(
    node: Identifier | MemberExpression,
    binding: ResolvedBinding,
  ): void {
    this.#resolvedBindings.set(node, binding);
  }

  /**
   * Get the resolved binding for a name reference.
   * Returns undefined if the name hasn't been resolved (error case).
   *
   * @param node The identifier or member expression to look up
   */
  getResolvedBinding(
    node: Identifier | MemberExpression,
  ): ResolvedBinding | undefined {
    return this.#resolvedBindings.get(node);
  }

  /**
   * Check if a name reference has been resolved.
   */
  hasResolvedBinding(node: Identifier | MemberExpression): boolean {
    return this.#resolvedBindings.has(node);
  }

  // ===== Debugging =====

  /**
   * Get debug statistics about the context.
   */
  get stats(): {nodeTypes: number; resolvedBindings: number} {
    return {
      nodeTypes: this.#nodeTypes.size,
      resolvedBindings: this.#resolvedBindings.size,
    };
  }
}
