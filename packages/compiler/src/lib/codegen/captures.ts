import {
  NodeType,
  type AssignmentExpression,
  type FunctionExpression,
  type Identifier,
  type Node,
  type VariableDeclaration,
} from '../ast.js';

export interface CaptureInfo {
  captures: Set<string>;
  mutableCaptures: Set<string>;
}

export function analyzeCaptures(func: FunctionExpression): CaptureInfo {
  const captures = new Set<string>();
  const mutableCaptures = new Set<string>();
  const locals = new Set<string>();

  // Add params to locals
  func.params.forEach((p) => locals.add(p.name.name));

  // We need a better visitor that handles scoping.
  // Since we don't have a full visitor infrastructure, I'll write a specific one.

  traverseWithScope(func.body, locals, captures, mutableCaptures);

  return {captures, mutableCaptures};
}

function traverseWithScope(
  node: Node,
  locals: Set<string>,
  captures: Set<string>,
  mutableCaptures: Set<string>,
) {
  if (!node) return;

  switch (node.type) {
    case NodeType.Identifier: {
      const name = (node as Identifier).name;
      if (!locals.has(name)) {
        captures.add(name);
      }
      break;
    }
    case NodeType.ThisExpression: {
      // 'this' is captured like a variable if it's used inside a closure
      // that was defined in a method context
      if (!locals.has('this')) {
        captures.add('this');
      }
      break;
    }
    case NodeType.AssignmentExpression: {
      const assign = node as AssignmentExpression;
      // Check if the assignment target is a captured variable
      if (assign.left.type === NodeType.Identifier) {
        const name = (assign.left as Identifier).name;
        if (!locals.has(name)) {
          captures.add(name);
          mutableCaptures.add(name);
        }
      } else {
        // For non-identifier targets (e.g., arr[0] = x), traverse to capture
        // any identifiers used (e.g., arr)
        traverseWithScope(assign.left, locals, captures, mutableCaptures);
      }
      // Traverse the assignment value
      traverseWithScope(assign.value, locals, captures, mutableCaptures);
      return;
    }
    case NodeType.VariableDeclaration: {
      const decl = node as VariableDeclaration;
      if (decl.pattern.type === NodeType.Identifier) {
        locals.add(decl.pattern.name);
      }
      if (decl.init)
        traverseWithScope(decl.init, locals, captures, mutableCaptures);
      break;
    }
    case NodeType.FunctionExpression: {
      const func = node as FunctionExpression;
      const newLocals = new Set(locals);
      func.params.forEach((p) => newLocals.add(p.name.name));

      // We don't traverse body with *our* locals, because nested function has its own scope.
      // But if nested function uses a variable that is NOT in newLocals, it captures it.
      // If that variable is in *our* locals, it's a capture from us (which is fine, we don't need to do anything).
      // If it's NOT in *our* locals, it's a capture from *outside* us, so we must capture it too.

      const nestedCaptures = new Set<string>();
      const nestedMutableCaptures = new Set<string>();
      // Recurse
      traverseWithScope(
        func.body,
        newLocals,
        nestedCaptures,
        nestedMutableCaptures,
      );

      for (const cap of nestedCaptures) {
        if (!locals.has(cap)) {
          captures.add(cap);
        }
      }
      for (const cap of nestedMutableCaptures) {
        if (!locals.has(cap)) {
          mutableCaptures.add(cap);
        }
      }
      return; // Don't traverse children again
    }
    case NodeType.BlockStatement: {
      // Blocks share function scope for 'var', but 'let' is block scoped.
      // Zena uses 'let' mostly.
      // For simplicity, let's treat block scope as function scope for now,
      // or properly handle block scoping.
      // Let's just traverse children.
      break;
    }
  }

  for (const key in node) {
    if (key === 'type') continue;
    const value = (node as any)[key];
    if (Array.isArray(value)) {
      value.forEach((child) => {
        if (child && typeof child.type === 'string')
          traverseWithScope(child, locals, captures, mutableCaptures);
      });
    } else if (value && typeof value.type === 'string') {
      traverseWithScope(value, locals, captures, mutableCaptures);
    }
  }
}
