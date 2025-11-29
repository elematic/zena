# Diagnostics System Design

## Overview

The diagnostics system provides a standardized way to report errors, warnings, and information messages during compilation. It replaces ad-hoc error throwing with structured `Diagnostic` objects that include source location information.

## Diagnostic Structure

A `Diagnostic` object contains the following information:

```typescript
export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
} as const;

export interface DiagnosticLocation {
  file: string;
  start: number;
  length: number;
  line: number;
  column: number;
}

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  severity: DiagnosticSeverity;
  location?: DiagnosticLocation;
}
```

## Source Locations

### Token Position Tracking

The lexer tracks position information for each token:

```typescript
export interface Token {
  type: TokenType;
  value: string;
  rawValue?: string; // For template literals
  line: number;      // 1-based line number
  column: number;    // 1-based column number
  start: number;     // 0-based start index (inclusive)
  end: number;       // 0-based end index (exclusive)
}
```

### AST Node Locations

AST nodes can have source location information attached:

```typescript
export interface SourceLocation {
  line: number;    // 1-based line number
  column: number;  // 1-based column number
  start: number;   // 0-based start index (inclusive)
  end: number;     // 0-based end index (exclusive)
}

export interface Node {
  type: NodeType;
  loc?: SourceLocation;
}
```

The parser attaches location information to key AST nodes including:
- Literals (number, string, boolean, null)
- Identifiers
- This/Super expressions
- Variable declarations
- Array literals

## Error Codes

Error codes are grouped by compiler phase:

- **1000-1999**: Parser Errors
- **2000-2999**: Type Checker Errors
- **3000-3999**: Code Generation Errors
- **9000-9998**: Internal Compiler Errors
- **9999**: Unknown Error

### Parser Codes (1000-1999)

| Code | Name            | Description          |
| ---- | --------------- | -------------------- |
| 1001 | UnexpectedToken | Unexpected token     |
| 1002 | ExpectedToken   | Expected token       |

### Checker Codes (2000-2999)

| Code | Name                       | Description                         |
| ---- | -------------------------- | ----------------------------------- |
| 2001 | TypeMismatch               | Type mismatch                       |
| 2002 | SymbolNotFound             | Symbol not found                    |
| 2003 | DuplicateDeclaration       | Duplicate declaration               |
| 2004 | InvalidAssignment          | Invalid assignment target           |
| 2005 | ReturnOutsideFunction      | Return outside of function          |
| 2006 | ArgumentCountMismatch      | Wrong number of arguments           |
| 2007 | PropertyNotFound           | Property not found                  |
| 2008 | NotCallable                | Expression is not callable          |
| 2009 | NotIndexable               | Expression is not indexable         |
| 2010 | GenericTypeArgumentMismatch| Generic type argument mismatch      |
| 2011 | ConstructorInMixin         | Constructor not allowed in mixin    |
| 2012 | AbstractMethodInConcreteClass | Abstract method in concrete class |
| 2013 | AbstractMethodNotImplemented | Abstract method not implemented   |
| 2014 | CannotInstantiateAbstractClass | Cannot instantiate abstract class |
| 2015 | ModuleNotFound             | Module not found                    |
| 2016 | IndexOutOfBounds           | Index out of bounds                 |
| 2017 | ExtensionClassField        | Extension class field error         |
| 2018 | DecoratorNotAllowed        | Decorator not allowed               |
| 2019 | UnknownIntrinsic           | Unknown intrinsic                   |
| 2020 | MissingDecorator           | Missing required decorator          |
| 2021 | UnexpectedBody             | Unexpected function body            |

### Codegen Codes (3000-3999)

| Code | Name              | Description                    |
| ---- | ----------------- | ------------------------------ |
| 3001 | UnknownType       | Unknown type                   |
| 3002 | UnknownClass      | Unknown class                  |
| 3003 | UnknownFunction   | Unknown function               |
| 3004 | UnknownVariable   | Unknown variable               |
| 3005 | UnknownMethod     | Unknown method                 |
| 3006 | UnknownField      | Unknown field                  |
| 3007 | UnsupportedFeature| Unsupported feature            |
| 3008 | InvalidExpression | Invalid expression             |

### Internal Compiler Errors (9000-9999)

| Code | Name                  | Description                |
| ---- | --------------------- | -------------------------- |
| 9000 | InternalCompilerError | Internal compiler error    |
| 9999 | UnknownError          | Unknown error              |

## Implementation

### DiagnosticBag

The `DiagnosticBag` class collects diagnostics throughout compilation:

```typescript
export class DiagnosticBag {
  #diagnostics: Diagnostic[] = [];

  public get diagnostics(): ReadonlyArray<Diagnostic> {
    return this.#diagnostics;
  }

  public report(diagnostic: Diagnostic) {
    this.#diagnostics.push(diagnostic);
  }

  public reportError(
    message: string,
    code: DiagnosticCode,
    location?: DiagnosticLocation,
  ) {
    this.report({
      code,
      message,
      severity: DiagnosticSeverity.Error,
      location,
    });
  }

  public hasErrors(): boolean {
    return this.#diagnostics.some(
      (d) => d.severity === DiagnosticSeverity.Error,
    );
  }
}
```

### Integration

1. **Type Checker**: The `CheckerContext` has a `DiagnosticBag` that collects type errors during checking.

2. **Code Generator**: The `CodegenContext` has a `DiagnosticBag` for reporting code generation errors. The `CodeGenerator` class exposes:
   - `setFileName(name: string)` - Set the file name for diagnostic locations
   - `diagnostics` getter - Access the collected diagnostics

### Error Reporting with Location

The codegen context provides helper methods for reporting errors with location information:

```typescript
// In CodegenContext
public reportError(message: string, code: DiagnosticCode, node?: Node): void {
  this.diagnostics.reportError(
    message,
    code,
    node ? this.locationFromNode(node) : undefined,
  );
}

public reportInternalError(message: string, node?: Node): void {
  this.reportError(
    `Internal Compiler Error: ${message}`,
    DiagnosticCode.InternalCompilerError,
    node,
  );
}
```

## Testing

Tests assert on specific error codes and locations, making them robust against message text changes:

```typescript
test('should report diagnostic for unknown variable', () => {
  const source = 'let x = unknownVar;';
  const parser = new Parser(source);
  const ast = parser.parse();
  const codegen = new CodeGenerator(ast);
  codegen.setFileName('test.zena');

  try {
    codegen.generate();
  } catch {
    // Expected
  }

  const diagnostic = codegen.diagnostics.diagnostics.find(
    (d) => d.code === DiagnosticCode.UnknownVariable,
  );
  assert.ok(diagnostic);
  assert.ok(diagnostic.location);
  assert.ok(diagnostic.location.line > 0);
});
```
