import {
  NodeType,
  type FunctionExpression,
  type Identifier,
  type Node,
  type VariableDeclaration,
} from '../ast.js';

export function analyzeCaptures(func: FunctionExpression): Set<string> {
  const captures = new Set<string>();
  const locals = new Set<string>();

  // Add params to locals
  func.params.forEach((p) => locals.add(p.name.name));

  // We need a better visitor that handles scoping.
  // Since we don't have a full visitor infrastructure, I'll write a specific one.

  traverseWithScope(func.body, locals, captures);

  return captures;
}

function traverseWithScope(
  node: Node,
  locals: Set<string>,
  captures: Set<string>,
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
    case NodeType.VariableDeclaration: {
      const decl = node as VariableDeclaration;
      if (decl.pattern.type === NodeType.Identifier) {
        locals.add(decl.pattern.name);
      }
      if (decl.init) traverseWithScope(decl.init, locals, captures);
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
      // Recurse
      traverseWithScope(func.body, newLocals, nestedCaptures);

      for (const cap of nestedCaptures) {
        if (!locals.has(cap)) {
          captures.add(cap);
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
          traverseWithScope(child, locals, captures);
      });
    } else if (value && typeof value.type === 'string') {
      traverseWithScope(value, locals, captures);
    }
  }
}
