/**
 * SemanticContext stores semantic metadata separately from the AST.
 *
 * This enables:
 * 1. Immutable AST - syntax information stays immutable
 * 2. Type identity by object reference - stable lookups regardless of renaming
 * 3. Clear separation between parsing, type-checking, and code generation
 * 4. Foundation for incremental compilation
 *
 * The context provides mappings from AST nodes to their inferred types.
 * This replaces mutable `inferredType` fields on AST nodes.
 *
 * Note: Emitter-specific information (like WASM struct indices) is stored
 * in the emitter layer (CodegenContext), not here. This keeps SemanticContext
 * output-format agnostic.
 */

import type {Node} from '../ast.js';
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

  // ===== Debugging =====

  /**
   * Get debug statistics about the context.
   */
  get stats(): {nodeTypes: number} {
    return {
      nodeTypes: this.#nodeTypes.size,
    };
  }
}
