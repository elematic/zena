/**
 * Generic AST visitor infrastructure for traversing Zena AST nodes.
 *
 * This module provides a flexible visitor pattern implementation that can be
 * used for various AST analyses and transformations:
 * - Dead code elimination (usage analysis)
 * - Capture analysis for closures
 * - Linting passes
 * - Code transformations
 *
 * @example
 * ```typescript
 * // Simple visitor that collects all identifiers
 * const identifiers: string[] = [];
 * visit(ast, {
 *   visitIdentifier(node) {
 *     identifiers.push(node.name);
 *   }
 * });
 * ```
 *
 * @module
 */

import {
  NodeType,
  type Node,
  type Module,
  type TypeAnnotation,
  type VariableDeclaration,
  type ExpressionStatement,
  type BlockStatement,
  type ReturnStatement,
  type BreakStatement,
  type ContinueStatement,
  type IfStatement,
  type WhileStatement,
  type ForStatement,
  type ForInStatement,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type MixinDeclaration,
  type DeclareFunction,
  type ImportDeclaration,
  type ExportAllDeclaration,
  type TypeAliasDeclaration,
  type EnumDeclaration,
  type BinaryExpression,
  type AssignmentExpression,
  type NumberLiteral,
  type StringLiteral,
  type BooleanLiteral,
  type NullLiteral,
  type Identifier,
  type FunctionExpression,
  type CallExpression,
  type NewExpression,
  type MemberExpression,
  type ThisExpression,
  type ArrayLiteral,
  type RecordLiteral,
  type TupleLiteral,
  type IndexExpression,
  type SuperExpression,
  type TemplateLiteral,
  type TaggedTemplateExpression,
  type AsExpression,
  type IsExpression,
  type UnaryExpression,
  type ThrowExpression,
  type TryExpression,
  type MatchExpression,
  type IfExpression,
  type RangeExpression,
  type PipelineExpression,
  type PipePlaceholder,
  type RecordPattern,
  type TuplePattern,
  type AssignmentPattern,
  type ClassPattern,
  type AsPattern,
  type LogicalPattern,
  type FieldDefinition,
  type MethodDefinition,
  type AccessorDeclaration,
  type MethodSignature,
  type AccessorSignature,
  type Parameter,
  type TypeParameter,
  type MatchCase,
  type CatchClause,
  type PropertyAssignment,
  type SpreadElement,
  type BindingProperty,
  type ImportSpecifier,
  type EnumMember,
  type NamedTypeAnnotation,
  type UnionTypeAnnotation,
  type RecordTypeAnnotation,
  type TupleTypeAnnotation,
  type FunctionTypeAnnotation,
  type LiteralTypeAnnotation,
  type SymbolPropertyName,
  type SymbolDeclaration,
} from './ast.js';

/**
 * Visitor interface with optional callbacks for each node type.
 * Implement only the callbacks you need.
 *
 * Each callback receives:
 * - The AST node being visited
 * - A context value (can be any type, passed through the traversal)
 *
 * Return values are ignored by default. For transforming visitors,
 * use {@link TransformVisitor} instead.
 *
 * @typeParam T - The type of the context passed through the traversal
 */
export interface Visitor<T = void> {
  // ===== Module =====
  visitModule?(node: Module, context: T): void;

  // ===== Statements =====
  visitVariableDeclaration?(node: VariableDeclaration, context: T): void;
  visitExpressionStatement?(node: ExpressionStatement, context: T): void;
  visitBlockStatement?(node: BlockStatement, context: T): void;
  visitReturnStatement?(node: ReturnStatement, context: T): void;
  visitBreakStatement?(node: BreakStatement, context: T): void;
  visitContinueStatement?(node: ContinueStatement, context: T): void;
  visitIfStatement?(node: IfStatement, context: T): void;
  visitWhileStatement?(node: WhileStatement, context: T): void;
  visitForStatement?(node: ForStatement, context: T): void;
  visitForInStatement?(node: ForInStatement, context: T): void;
  visitClassDeclaration?(node: ClassDeclaration, context: T): void;
  visitInterfaceDeclaration?(node: InterfaceDeclaration, context: T): void;
  visitMixinDeclaration?(node: MixinDeclaration, context: T): void;
  visitDeclareFunction?(node: DeclareFunction, context: T): void;
  visitImportDeclaration?(node: ImportDeclaration, context: T): void;
  visitExportAllDeclaration?(node: ExportAllDeclaration, context: T): void;
  visitTypeAliasDeclaration?(node: TypeAliasDeclaration, context: T): void;
  visitEnumDeclaration?(node: EnumDeclaration, context: T): void;
  visitEnumMember?(node: EnumMember, context: T): void;
  visitSymbolDeclaration?(node: SymbolDeclaration, context: T): void;

  // ===== Expressions =====
  visitBinaryExpression?(node: BinaryExpression, context: T): void;
  visitAssignmentExpression?(node: AssignmentExpression, context: T): void;
  visitNumberLiteral?(node: NumberLiteral, context: T): void;
  visitStringLiteral?(node: StringLiteral, context: T): void;
  visitBooleanLiteral?(node: BooleanLiteral, context: T): void;
  visitNullLiteral?(node: NullLiteral, context: T): void;
  visitIdentifier?(node: Identifier, context: T): void;
  visitFunctionExpression?(node: FunctionExpression, context: T): void;
  visitCallExpression?(node: CallExpression, context: T): void;
  visitNewExpression?(node: NewExpression, context: T): void;
  visitMemberExpression?(node: MemberExpression, context: T): void;
  visitThisExpression?(node: ThisExpression, context: T): void;
  visitArrayLiteral?(node: ArrayLiteral, context: T): void;
  visitRecordLiteral?(node: RecordLiteral, context: T): void;
  visitTupleLiteral?(node: TupleLiteral, context: T): void;
  visitIndexExpression?(node: IndexExpression, context: T): void;
  visitSuperExpression?(node: SuperExpression, context: T): void;
  visitTemplateLiteral?(node: TemplateLiteral, context: T): void;
  visitTaggedTemplateExpression?(
    node: TaggedTemplateExpression,
    context: T,
  ): void;
  visitAsExpression?(node: AsExpression, context: T): void;
  visitIsExpression?(node: IsExpression, context: T): void;
  visitUnaryExpression?(node: UnaryExpression, context: T): void;
  visitThrowExpression?(node: ThrowExpression, context: T): void;
  visitTryExpression?(node: TryExpression, context: T): void;
  visitMatchExpression?(node: MatchExpression, context: T): void;
  visitIfExpression?(node: IfExpression, context: T): void;
  visitRangeExpression?(node: RangeExpression, context: T): void;
  visitPipelineExpression?(node: PipelineExpression, context: T): void;
  visitPipePlaceholder?(node: PipePlaceholder, context: T): void;

  // ===== Patterns =====
  visitRecordPattern?(node: RecordPattern, context: T): void;
  visitTuplePattern?(node: TuplePattern, context: T): void;
  visitAssignmentPattern?(node: AssignmentPattern, context: T): void;
  visitClassPattern?(node: ClassPattern, context: T): void;
  visitAsPattern?(node: AsPattern, context: T): void;
  visitLogicalPattern?(node: LogicalPattern, context: T): void;

  // ===== Class Members =====
  visitFieldDefinition?(node: FieldDefinition, context: T): void;
  visitMethodDefinition?(node: MethodDefinition, context: T): void;
  visitAccessorDeclaration?(node: AccessorDeclaration, context: T): void;

  // ===== Interface Members =====
  visitMethodSignature?(node: MethodSignature, context: T): void;
  visitAccessorSignature?(node: AccessorSignature, context: T): void;

  // ===== Type Annotations =====
  visitTypeAnnotation?(node: NamedTypeAnnotation, context: T): void;
  visitUnionTypeAnnotation?(node: UnionTypeAnnotation, context: T): void;
  visitRecordTypeAnnotation?(node: RecordTypeAnnotation, context: T): void;
  visitTupleTypeAnnotation?(node: TupleTypeAnnotation, context: T): void;
  visitFunctionTypeAnnotation?(node: FunctionTypeAnnotation, context: T): void;
  visitLiteralTypeAnnotation?(node: LiteralTypeAnnotation, context: T): void;

  // ===== Other =====
  visitParameter?(node: Parameter, context: T): void;
  visitTypeParameter?(node: TypeParameter, context: T): void;
  visitMatchCase?(node: MatchCase, context: T): void;
  visitCatchClause?(node: CatchClause, context: T): void;
  visitPropertyAssignment?(node: PropertyAssignment, context: T): void;
  visitSpreadElement?(node: SpreadElement, context: T): void;
  visitBindingProperty?(node: BindingProperty, context: T): void;
  visitImportSpecifier?(node: ImportSpecifier, context: T): void;
  visitEnumMember?(node: EnumMember, context: T): void;
  visitSymbolPropertyName?(node: SymbolPropertyName, context: T): void;

  // ===== Generic Hooks =====
  /**
   * Called before visiting any node. Return false to skip visiting this node
   * and its children.
   */
  beforeVisit?(node: Node, context: T): boolean | void;

  /**
   * Called after visiting a node and all its children.
   */
  afterVisit?(node: Node, context: T): void;
}

/**
 * Visit an AST node and all its children using the provided visitor.
 *
 * The visitor callbacks are called in pre-order (parent before children).
 * Use {@link visitChildren} if you need post-order or custom traversal.
 *
 * @param node - The AST node to visit
 * @param visitor - The visitor with callbacks
 * @param context - Context value passed to all callbacks
 */
export function visit<T>(
  node: Node | null | undefined,
  visitor: Visitor<T>,
  context: T,
): void {
  if (!node) return;

  // Call beforeVisit hook if present
  if (visitor.beforeVisit) {
    const shouldContinue = visitor.beforeVisit(node, context);
    if (shouldContinue === false) return;
  }

  // Call the specific visitor method based on node type
  switch (node.type) {
    // Module
    case NodeType.Module:
      visitor.visitModule?.(node as Module, context);
      visitModuleChildren(node as Module, visitor, context);
      break;

    // Statements
    case NodeType.VariableDeclaration:
      visitor.visitVariableDeclaration?.(node as VariableDeclaration, context);
      visitVariableDeclarationChildren(
        node as VariableDeclaration,
        visitor,
        context,
      );
      break;
    case NodeType.ExpressionStatement:
      visitor.visitExpressionStatement?.(node as ExpressionStatement, context);
      visit((node as ExpressionStatement).expression, visitor, context);
      break;
    case NodeType.BlockStatement:
      visitor.visitBlockStatement?.(node as BlockStatement, context);
      for (const stmt of (node as BlockStatement).body) {
        visit(stmt, visitor, context);
      }
      break;
    case NodeType.ReturnStatement:
      visitor.visitReturnStatement?.(node as ReturnStatement, context);
      visit((node as ReturnStatement).argument, visitor, context);
      break;
    case NodeType.BreakStatement:
      visitor.visitBreakStatement?.(node as BreakStatement, context);
      break;
    case NodeType.ContinueStatement:
      visitor.visitContinueStatement?.(node as ContinueStatement, context);
      break;
    case NodeType.IfStatement:
      visitor.visitIfStatement?.(node as IfStatement, context);
      visitIfStatementChildren(node as IfStatement, visitor, context);
      break;
    case NodeType.WhileStatement:
      visitor.visitWhileStatement?.(node as WhileStatement, context);
      visit((node as WhileStatement).test, visitor, context);
      visit((node as WhileStatement).body, visitor, context);
      break;
    case NodeType.ForStatement:
      visitor.visitForStatement?.(node as ForStatement, context);
      visitForStatementChildren(node as ForStatement, visitor, context);
      break;
    case NodeType.ForInStatement:
      visitor.visitForInStatement?.(node as ForInStatement, context);
      visit((node as ForInStatement).pattern, visitor, context);
      visit((node as ForInStatement).iterable, visitor, context);
      visit((node as ForInStatement).body, visitor, context);
      break;
    case NodeType.ClassDeclaration:
      visitor.visitClassDeclaration?.(node as ClassDeclaration, context);
      visitClassDeclarationChildren(node as ClassDeclaration, visitor, context);
      break;
    case NodeType.InterfaceDeclaration:
      visitor.visitInterfaceDeclaration?.(
        node as InterfaceDeclaration,
        context,
      );
      visitInterfaceDeclarationChildren(
        node as InterfaceDeclaration,
        visitor,
        context,
      );
      break;
    case NodeType.MixinDeclaration:
      visitor.visitMixinDeclaration?.(node as MixinDeclaration, context);
      visitMixinDeclarationChildren(node as MixinDeclaration, visitor, context);
      break;
    case NodeType.DeclareFunction:
      visitor.visitDeclareFunction?.(node as DeclareFunction, context);
      visitDeclareFunctionChildren(node as DeclareFunction, visitor, context);
      break;
    case NodeType.ImportDeclaration:
      visitor.visitImportDeclaration?.(node as ImportDeclaration, context);
      visitImportDeclarationChildren(
        node as ImportDeclaration,
        visitor,
        context,
      );
      break;
    case NodeType.ExportAllDeclaration:
      visitor.visitExportAllDeclaration?.(
        node as ExportAllDeclaration,
        context,
      );
      break;
    case NodeType.TypeAliasDeclaration:
      visitor.visitTypeAliasDeclaration?.(
        node as TypeAliasDeclaration,
        context,
      );
      visitTypeAliasDeclarationChildren(
        node as TypeAliasDeclaration,
        visitor,
        context,
      );
      break;
    case NodeType.EnumDeclaration:
      visitor.visitEnumDeclaration?.(node as EnumDeclaration, context);
      visitEnumDeclarationChildren(node as EnumDeclaration, visitor, context);
      break;
    case NodeType.EnumMember:
      visitor.visitEnumMember?.(node as EnumMember, context);
      visitEnumMemberChildren(node as EnumMember, visitor, context);
      break;
    case NodeType.SymbolDeclaration:
      visitor.visitSymbolDeclaration?.(node as SymbolDeclaration, context);
      // No children to visit - symbols only have a name identifier
      break;

    // Expressions
    case NodeType.BinaryExpression:
      visitor.visitBinaryExpression?.(node as BinaryExpression, context);
      visit((node as BinaryExpression).left, visitor, context);
      visit((node as BinaryExpression).right, visitor, context);
      break;
    case NodeType.AssignmentExpression:
      visitor.visitAssignmentExpression?.(
        node as AssignmentExpression,
        context,
      );
      visit((node as AssignmentExpression).left, visitor, context);
      visit((node as AssignmentExpression).value, visitor, context);
      break;
    case NodeType.NumberLiteral:
      visitor.visitNumberLiteral?.(node as NumberLiteral, context);
      break;
    case NodeType.StringLiteral:
      visitor.visitStringLiteral?.(node as StringLiteral, context);
      break;
    case NodeType.BooleanLiteral:
      visitor.visitBooleanLiteral?.(node as BooleanLiteral, context);
      break;
    case NodeType.NullLiteral:
      visitor.visitNullLiteral?.(node as NullLiteral, context);
      break;
    case NodeType.Identifier:
      visitor.visitIdentifier?.(node as Identifier, context);
      break;
    case NodeType.FunctionExpression:
      visitor.visitFunctionExpression?.(node as FunctionExpression, context);
      visitFunctionExpressionChildren(
        node as FunctionExpression,
        visitor,
        context,
      );
      break;
    case NodeType.CallExpression:
      visitor.visitCallExpression?.(node as CallExpression, context);
      visitCallExpressionChildren(node as CallExpression, visitor, context);
      break;
    case NodeType.NewExpression:
      visitor.visitNewExpression?.(node as NewExpression, context);
      visitNewExpressionChildren(node as NewExpression, visitor, context);
      break;
    case NodeType.MemberExpression:
      visitor.visitMemberExpression?.(node as MemberExpression, context);
      visit((node as MemberExpression).object, visitor, context);
      // Note: property is just an identifier, don't visit as it's not a reference
      break;
    case NodeType.ThisExpression:
      visitor.visitThisExpression?.(node as ThisExpression, context);
      break;
    case NodeType.ArrayLiteral:
      visitor.visitArrayLiteral?.(node as ArrayLiteral, context);
      for (const elem of (node as ArrayLiteral).elements) {
        visit(elem, visitor, context);
      }
      break;
    case NodeType.RecordLiteral:
      visitor.visitRecordLiteral?.(node as RecordLiteral, context);
      for (const prop of (node as RecordLiteral).properties) {
        visit(prop, visitor, context);
      }
      break;
    case NodeType.TupleLiteral:
      visitor.visitTupleLiteral?.(node as TupleLiteral, context);
      for (const elem of (node as TupleLiteral).elements) {
        visit(elem, visitor, context);
      }
      break;
    case NodeType.IndexExpression:
      visitor.visitIndexExpression?.(node as IndexExpression, context);
      visit((node as IndexExpression).object, visitor, context);
      visit((node as IndexExpression).index, visitor, context);
      break;
    case NodeType.SuperExpression:
      visitor.visitSuperExpression?.(node as SuperExpression, context);
      break;
    case NodeType.TemplateLiteral:
      visitor.visitTemplateLiteral?.(node as TemplateLiteral, context);
      visitTemplateLiteralChildren(node as TemplateLiteral, visitor, context);
      break;
    case NodeType.TaggedTemplateExpression:
      visitor.visitTaggedTemplateExpression?.(
        node as TaggedTemplateExpression,
        context,
      );
      visit((node as TaggedTemplateExpression).tag, visitor, context);
      visit((node as TaggedTemplateExpression).quasi, visitor, context);
      break;
    case NodeType.AsExpression:
      visitor.visitAsExpression?.(node as AsExpression, context);
      visit((node as AsExpression).expression, visitor, context);
      visitTypeAnnotation(
        (node as AsExpression).typeAnnotation,
        visitor,
        context,
      );
      break;
    case NodeType.IsExpression:
      visitor.visitIsExpression?.(node as IsExpression, context);
      visit((node as IsExpression).expression, visitor, context);
      visitTypeAnnotation(
        (node as IsExpression).typeAnnotation,
        visitor,
        context,
      );
      break;
    case NodeType.UnaryExpression:
      visitor.visitUnaryExpression?.(node as UnaryExpression, context);
      visit((node as UnaryExpression).argument, visitor, context);
      break;
    case NodeType.ThrowExpression:
      visitor.visitThrowExpression?.(node as ThrowExpression, context);
      visit((node as ThrowExpression).argument, visitor, context);
      break;
    case NodeType.TryExpression:
      visitor.visitTryExpression?.(node as TryExpression, context);
      visitTryExpressionChildren(node as TryExpression, visitor, context);
      break;
    case NodeType.MatchExpression:
      visitor.visitMatchExpression?.(node as MatchExpression, context);
      visitMatchExpressionChildren(node as MatchExpression, visitor, context);
      break;
    case NodeType.IfExpression:
      visitor.visitIfExpression?.(node as IfExpression, context);
      visit((node as IfExpression).test, visitor, context);
      visit((node as IfExpression).consequent, visitor, context);
      visit((node as IfExpression).alternate, visitor, context);
      break;
    case NodeType.RangeExpression:
      visitor.visitRangeExpression?.(node as RangeExpression, context);
      visit((node as RangeExpression).start, visitor, context);
      visit((node as RangeExpression).end, visitor, context);
      break;
    case NodeType.PipelineExpression:
      visitor.visitPipelineExpression?.(node as PipelineExpression, context);
      visit((node as PipelineExpression).left, visitor, context);
      visit((node as PipelineExpression).right, visitor, context);
      break;
    case NodeType.PipePlaceholder:
      visitor.visitPipePlaceholder?.(node as PipePlaceholder, context);
      break;

    // Patterns
    case NodeType.RecordPattern:
      visitor.visitRecordPattern?.(node as RecordPattern, context);
      for (const prop of (node as RecordPattern).properties) {
        visit(prop, visitor, context);
      }
      break;
    case NodeType.TuplePattern:
      visitor.visitTuplePattern?.(node as TuplePattern, context);
      for (const elem of (node as TuplePattern).elements) {
        visit(elem, visitor, context);
      }
      break;
    case NodeType.AssignmentPattern:
      visitor.visitAssignmentPattern?.(node as AssignmentPattern, context);
      visit((node as AssignmentPattern).left, visitor, context);
      visit((node as AssignmentPattern).right, visitor, context);
      break;
    case NodeType.ClassPattern:
      visitor.visitClassPattern?.(node as ClassPattern, context);
      // name is a type reference, not a variable
      for (const prop of (node as ClassPattern).properties) {
        visit(prop, visitor, context);
      }
      break;
    case NodeType.AsPattern:
      visitor.visitAsPattern?.(node as AsPattern, context);
      visit((node as AsPattern).pattern, visitor, context);
      // name introduces a binding, don't visit as reference
      break;
    case NodeType.LogicalPattern:
      visitor.visitLogicalPattern?.(node as LogicalPattern, context);
      visit((node as LogicalPattern).left, visitor, context);
      visit((node as LogicalPattern).right, visitor, context);
      break;

    // Class Members
    case NodeType.FieldDefinition:
      visitor.visitFieldDefinition?.(node as FieldDefinition, context);
      visitFieldDefinitionChildren(node as FieldDefinition, visitor, context);
      break;
    case NodeType.MethodDefinition:
      visitor.visitMethodDefinition?.(node as MethodDefinition, context);
      visitMethodDefinitionChildren(node as MethodDefinition, visitor, context);
      break;
    case NodeType.AccessorDeclaration:
      visitor.visitAccessorDeclaration?.(node as AccessorDeclaration, context);
      visitAccessorDeclarationChildren(
        node as AccessorDeclaration,
        visitor,
        context,
      );
      break;

    // Interface Members
    case NodeType.MethodSignature:
      visitor.visitMethodSignature?.(node as MethodSignature, context);
      visitMethodSignatureChildren(node as MethodSignature, visitor, context);
      break;
    case NodeType.AccessorSignature:
      visitor.visitAccessorSignature?.(node as AccessorSignature, context);
      visitTypeAnnotation(
        (node as AccessorSignature).typeAnnotation,
        visitor,
        context,
      );
      break;

    // Type Annotations - handled by visitTypeAnnotation helper
    case NodeType.TypeAnnotation:
      visitor.visitTypeAnnotation?.(node as NamedTypeAnnotation, context);
      visitNamedTypeAnnotationChildren(
        node as NamedTypeAnnotation,
        visitor,
        context,
      );
      break;
    case NodeType.UnionTypeAnnotation:
      visitor.visitUnionTypeAnnotation?.(node as UnionTypeAnnotation, context);
      for (const type of (node as UnionTypeAnnotation).types) {
        visitTypeAnnotation(type, visitor, context);
      }
      break;
    case NodeType.RecordTypeAnnotation:
      visitor.visitRecordTypeAnnotation?.(
        node as RecordTypeAnnotation,
        context,
      );
      for (const prop of (node as RecordTypeAnnotation).properties) {
        visitTypeAnnotation(prop.typeAnnotation, visitor, context);
      }
      break;
    case NodeType.TupleTypeAnnotation:
      visitor.visitTupleTypeAnnotation?.(node as TupleTypeAnnotation, context);
      for (const elemType of (node as TupleTypeAnnotation).elementTypes) {
        visitTypeAnnotation(elemType, visitor, context);
      }
      break;
    case NodeType.FunctionTypeAnnotation:
      visitor.visitFunctionTypeAnnotation?.(
        node as FunctionTypeAnnotation,
        context,
      );
      for (const paramType of (node as FunctionTypeAnnotation).params) {
        visitTypeAnnotation(paramType, visitor, context);
      }
      visitTypeAnnotation(
        (node as FunctionTypeAnnotation).returnType,
        visitor,
        context,
      );
      break;
    case NodeType.LiteralTypeAnnotation:
      visitor.visitLiteralTypeAnnotation?.(
        node as LiteralTypeAnnotation,
        context,
      );
      break;

    // Other
    case NodeType.Parameter:
      visitor.visitParameter?.(node as Parameter, context);
      visitParameterChildren(node as Parameter, visitor, context);
      break;
    case NodeType.TypeParameter:
      visitor.visitTypeParameter?.(node as TypeParameter, context);
      visitTypeParameterChildren(node as TypeParameter, visitor, context);
      break;
    case NodeType.MatchCase:
      visitor.visitMatchCase?.(node as MatchCase, context);
      visit((node as MatchCase).pattern, visitor, context);
      visit((node as MatchCase).guard, visitor, context);
      visit((node as MatchCase).body, visitor, context);
      break;
    case NodeType.CatchClause:
      visitor.visitCatchClause?.(node as CatchClause, context);
      // param introduces a binding
      visit((node as CatchClause).body, visitor, context);
      break;
    case NodeType.PropertyAssignment:
      visitor.visitPropertyAssignment?.(node as PropertyAssignment, context);
      visit((node as PropertyAssignment).value, visitor, context);
      break;
    case NodeType.SpreadElement:
      visitor.visitSpreadElement?.(node as SpreadElement, context);
      visit((node as SpreadElement).argument, visitor, context);
      break;
    case NodeType.BindingProperty:
      visitor.visitBindingProperty?.(node as BindingProperty, context);
      visit((node as BindingProperty).value, visitor, context);
      break;
    case NodeType.ImportSpecifier:
      visitor.visitImportSpecifier?.(node as ImportSpecifier, context);
      // imported and local are identifiers but not references to visit
      break;
    case NodeType.EnumMember:
      visitor.visitEnumMember?.(node as EnumMember, context);
      break;
    case NodeType.SymbolPropertyName:
      visitor.visitSymbolPropertyName?.(node as SymbolPropertyName, context);
      // symbol is an identifier reference to the symbol variable
      visit((node as SymbolPropertyName).symbol, visitor, context);
      break;

    // Nodes we skip (template elements, etc.)
    case NodeType.TemplateElement:
      // No children to visit
      break;
    case NodeType.ThisTypeAnnotation:
      // No children to visit
      break;
    case NodeType.Decorator:
      // Decorators are handled specially
      break;

    default:
      // Unknown node type - skip silently
      // This allows the visitor to handle future node types gracefully
      break;
  }

  // Call afterVisit hook if present
  if (visitor.afterVisit) {
    visitor.afterVisit(node, context);
  }
}

/**
 * Visit only the children of a node, not the node itself.
 * Useful when you want custom pre/post processing around children.
 */
export function visitChildren<T>(
  node: Node,
  visitor: Visitor<T>,
  context: T,
): void {
  // Create a wrapper visitor that skips the beforeVisit/afterVisit for the root
  const childVisitor: Visitor<T> = {
    ...visitor,
    beforeVisit: undefined,
    afterVisit: undefined,
  };

  // Re-dispatch to visit but with the wrapper
  // This is a bit redundant but ensures consistent behavior
  switch (node.type) {
    case NodeType.Module:
      visitModuleChildren(node as Module, visitor, context);
      break;
    // ... We'd need to enumerate all types, so let's just use visit
    // The beforeVisit/afterVisit hooks handle this case
    default:
      // Use the default children iteration
      const nodeAny = node as any;
      for (const key in nodeAny) {
        if (key === 'type' || key === 'loc' || key === 'inferredType') continue;
        const value = nodeAny[key];
        if (Array.isArray(value)) {
          for (const child of value) {
            if (child && typeof child === 'object' && 'type' in child) {
              visit(child, childVisitor, context);
            }
          }
        } else if (value && typeof value === 'object' && 'type' in value) {
          visit(value, childVisitor, context);
        }
      }
      break;
  }
}

// ===== Helper functions for visiting children of specific node types =====

function visitTypeAnnotation<T>(
  annotation: TypeAnnotation | undefined,
  visitor: Visitor<T>,
  context: T,
): void {
  if (!annotation) return;
  visit(annotation as Node, visitor, context);
}

function visitModuleChildren<T>(
  node: Module,
  visitor: Visitor<T>,
  context: T,
): void {
  for (const stmt of node.body) {
    visit(stmt, visitor, context);
  }
}

function visitVariableDeclarationChildren<T>(
  node: VariableDeclaration,
  visitor: Visitor<T>,
  context: T,
): void {
  visit(node.pattern, visitor, context);
  visitTypeAnnotation(node.typeAnnotation, visitor, context);
  visit(node.init, visitor, context);
}

function visitIfStatementChildren<T>(
  node: IfStatement,
  visitor: Visitor<T>,
  context: T,
): void {
  visit(node.test, visitor, context);
  visit(node.consequent, visitor, context);
  visit(node.alternate, visitor, context);
}

function visitForStatementChildren<T>(
  node: ForStatement,
  visitor: Visitor<T>,
  context: T,
): void {
  visit(node.init, visitor, context);
  visit(node.test, visitor, context);
  visit(node.update, visitor, context);
  visit(node.body, visitor, context);
}

function visitClassDeclarationChildren<T>(
  node: ClassDeclaration,
  visitor: Visitor<T>,
  context: T,
): void {
  for (const tp of node.typeParameters ?? []) {
    visit(tp, visitor, context);
  }
  visitTypeAnnotation(node.superClass, visitor, context);
  for (const mixin of node.mixins ?? []) {
    visitTypeAnnotation(mixin, visitor, context);
  }
  for (const impl of node.implements ?? []) {
    visitTypeAnnotation(impl, visitor, context);
  }
  visitTypeAnnotation(node.onType, visitor, context);
  for (const member of node.body) {
    visit(member, visitor, context);
  }
}

function visitInterfaceDeclarationChildren<T>(
  node: InterfaceDeclaration,
  visitor: Visitor<T>,
  context: T,
): void {
  for (const tp of node.typeParameters ?? []) {
    visit(tp, visitor, context);
  }
  for (const ext of node.extends ?? []) {
    visitTypeAnnotation(ext, visitor, context);
  }
  for (const member of node.body) {
    visit(member, visitor, context);
  }
}

function visitMixinDeclarationChildren<T>(
  node: MixinDeclaration,
  visitor: Visitor<T>,
  context: T,
): void {
  for (const tp of node.typeParameters ?? []) {
    visit(tp, visitor, context);
  }
  for (const mixin of node.mixins ?? []) {
    visitTypeAnnotation(mixin, visitor, context);
  }
  for (const member of node.body) {
    visit(member, visitor, context);
  }
}

function visitDeclareFunctionChildren<T>(
  node: DeclareFunction,
  visitor: Visitor<T>,
  context: T,
): void {
  for (const tp of node.typeParameters ?? []) {
    visit(tp, visitor, context);
  }
  for (const param of node.params) {
    visit(param, visitor, context);
  }
  visitTypeAnnotation(node.returnType, visitor, context);
}

function visitImportDeclarationChildren<T>(
  node: ImportDeclaration,
  visitor: Visitor<T>,
  context: T,
): void {
  for (const spec of node.imports) {
    visit(spec, visitor, context);
  }
}

function visitTypeAliasDeclarationChildren<T>(
  node: TypeAliasDeclaration,
  visitor: Visitor<T>,
  context: T,
): void {
  for (const tp of node.typeParameters ?? []) {
    visit(tp, visitor, context);
  }
  visitTypeAnnotation(node.typeAnnotation, visitor, context);
}

function visitEnumDeclarationChildren<T>(
  node: EnumDeclaration,
  visitor: Visitor<T>,
  context: T,
): void {
  visit(node.name, visitor, context);
  for (const member of node.members) {
    visit(member, visitor, context);
  }
}

function visitEnumMemberChildren<T>(
  node: EnumMember,
  visitor: Visitor<T>,
  context: T,
): void {
  visit(node.name, visitor, context);
  if (node.initializer) {
    visit(node.initializer, visitor, context);
  }
}

function visitFunctionExpressionChildren<T>(
  node: FunctionExpression,
  visitor: Visitor<T>,
  context: T,
): void {
  for (const tp of node.typeParameters ?? []) {
    visit(tp, visitor, context);
  }
  for (const param of node.params) {
    visit(param, visitor, context);
  }
  visitTypeAnnotation(node.returnType, visitor, context);
  visit(node.body, visitor, context);
}

function visitCallExpressionChildren<T>(
  node: CallExpression,
  visitor: Visitor<T>,
  context: T,
): void {
  visit(node.callee, visitor, context);
  for (const typeArg of node.typeArguments ?? []) {
    visitTypeAnnotation(typeArg, visitor, context);
  }
  for (const arg of node.arguments) {
    visit(arg, visitor, context);
  }
}

function visitNewExpressionChildren<T>(
  node: NewExpression,
  visitor: Visitor<T>,
  context: T,
): void {
  // callee is an identifier referring to a class
  visit(node.callee, visitor, context);
  for (const typeArg of node.typeArguments ?? []) {
    visitTypeAnnotation(typeArg, visitor, context);
  }
  for (const arg of node.arguments) {
    visit(arg, visitor, context);
  }
}

function visitTemplateLiteralChildren<T>(
  node: TemplateLiteral,
  visitor: Visitor<T>,
  context: T,
): void {
  for (const expr of (node as any).expressions ?? []) {
    visit(expr, visitor, context);
  }
}

function visitTryExpressionChildren<T>(
  node: TryExpression,
  visitor: Visitor<T>,
  context: T,
): void {
  visit(node.body, visitor, context);
  visit(node.handler, visitor, context);
  visit(node.finalizer, visitor, context);
}

function visitMatchExpressionChildren<T>(
  node: MatchExpression,
  visitor: Visitor<T>,
  context: T,
): void {
  visit(node.discriminant, visitor, context);
  for (const c of node.cases) {
    visit(c, visitor, context);
  }
}

function visitFieldDefinitionChildren<T>(
  node: FieldDefinition,
  visitor: Visitor<T>,
  context: T,
): void {
  if (node.name.type === NodeType.SymbolPropertyName) {
    visit(node.name, visitor, context);
  }
  visitTypeAnnotation(node.typeAnnotation, visitor, context);
  visit(node.value, visitor, context);
}

function visitMethodDefinitionChildren<T>(
  node: MethodDefinition,
  visitor: Visitor<T>,
  context: T,
): void {
  if (node.name.type === NodeType.SymbolPropertyName) {
    visit(node.name, visitor, context);
  }
  for (const tp of node.typeParameters ?? []) {
    visit(tp, visitor, context);
  }
  for (const param of node.params) {
    visit(param, visitor, context);
  }
  visitTypeAnnotation(node.returnType, visitor, context);
  visit(node.body, visitor, context);
}

function visitAccessorDeclarationChildren<T>(
  node: AccessorDeclaration,
  visitor: Visitor<T>,
  context: T,
): void {
  if (node.name.type === NodeType.SymbolPropertyName) {
    visit(node.name, visitor, context);
  }
  visitTypeAnnotation(node.typeAnnotation, visitor, context);
  visit(node.getter, visitor, context);
  if (node.setter) {
    visit(node.setter.body, visitor, context);
  }
}

function visitMethodSignatureChildren<T>(
  node: MethodSignature,
  visitor: Visitor<T>,
  context: T,
): void {
  if (node.name.type === NodeType.SymbolPropertyName) {
    visit(node.name, visitor, context);
  }
  for (const tp of node.typeParameters ?? []) {
    visit(tp, visitor, context);
  }
  for (const param of node.params) {
    visit(param, visitor, context);
  }
  visitTypeAnnotation(node.returnType, visitor, context);
}

function visitNamedTypeAnnotationChildren<T>(
  node: NamedTypeAnnotation,
  visitor: Visitor<T>,
  context: T,
): void {
  for (const typeArg of node.typeArguments ?? []) {
    visitTypeAnnotation(typeArg, visitor, context);
  }
}

function visitParameterChildren<T>(
  node: Parameter,
  visitor: Visitor<T>,
  context: T,
): void {
  visit(node.name, visitor, context);
  visitTypeAnnotation(node.typeAnnotation, visitor, context);
  visit(node.initializer, visitor, context);
}

function visitTypeParameterChildren<T>(
  node: TypeParameter,
  visitor: Visitor<T>,
  context: T,
): void {
  visitTypeAnnotation(node.constraint, visitor, context);
  visitTypeAnnotation(node.default, visitor, context);
}
