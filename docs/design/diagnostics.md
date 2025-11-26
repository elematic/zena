# Diagnostics System Design

## Overview

The diagnostics system provides a standardized way to report errors, warnings, and information messages during compilation. It replaces ad-hoc error throwing and string arrays with structured `Diagnostic` objects.

## Diagnostic Structure

A `Diagnostic` object contains the following information:

```typescript
export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
}

export interface Diagnostic {
  code: number;
  message: string;
  severity: DiagnosticSeverity;
  location?: {
    file: string;
    start: number;
    length: number;
    line: number;
    column: number;
  };
}
```

## Error Codes

Error codes are grouped by compiler phase:

- **1000-1999**: Lexer & Parser Errors
- **2000-2999**: Type Checker Errors
- **3000-3999**: Code Generation Errors

### Common Codes

| Code | Message               |
| ---- | --------------------- |
| 1001 | Unexpected token      |
| 2001 | Type mismatch         |
| 2002 | Symbol not found      |
| 2003 | Duplicate declaration |

## Implementation

### DiagnosticBag

A `DiagnosticBag` class will be used to collect diagnostics throughout the compilation process.

```typescript
class DiagnosticBag {
  private diagnostics: Diagnostic[] = [];

  public report(diagnostic: Diagnostic) {
    this.diagnostics.push(diagnostic);
  }

  public getDiagnostics(): Diagnostic[] {
    return this.diagnostics;
  }

  public hasErrors(): boolean {
    return this.diagnostics.some(
      (d) => d.severity === DiagnosticSeverity.Error,
    );
  }
}
```

### Integration

1.  **Parser**: Instead of throwing `Error`, the parser will report diagnostics. For fatal syntax errors where recovery is impossible, it may still throw a `CompilerError` containing the diagnostic to abort parsing of the current construct.
2.  **Type Checker**: The checker will push `Diagnostic` objects to the bag instead of strings.

## Testing

Tests will be updated to assert on specific error codes and locations, making them more robust against message text changes.
