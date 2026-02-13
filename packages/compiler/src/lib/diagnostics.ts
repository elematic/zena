export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
} as const;

export type DiagnosticSeverity =
  (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export const DiagnosticCode = {
  // Parser Errors (1000-1999)
  UnexpectedToken: 1001,
  ExpectedToken: 1002,

  // Checker Errors (2000-2999)
  TypeMismatch: 2001,
  SymbolNotFound: 2002,
  DuplicateDeclaration: 2003,
  InvalidAssignment: 2004,
  ReturnOutsideFunction: 2005,
  BreakOutsideLoop: 2024,
  ContinueOutsideLoop: 2025,
  ArgumentCountMismatch: 2006,
  PropertyNotFound: 2007,
  NotCallable: 2008,
  NotIndexable: 2009,
  GenericTypeArgumentMismatch: 2010,
  ConstructorInMixin: 2011,
  AbstractMethodInConcreteClass: 2012,
  AbstractMethodNotImplemented: 2013,
  CannotInstantiateAbstractClass: 2014,
  ModuleNotFound: 2015,
  IndexOutOfBounds: 2016,
  ImportError: 2016,
  ExtensionClassField: 2017,
  DecoratorNotAllowed: 2018,
  UnknownIntrinsic: 2019,
  MissingDecorator: 2020,
  UnexpectedBody: 2021,
  UnreachableCode: 2022,
  TypeNotFound: 2023,

  // Codegen Errors (3000-3999)
  UnknownType: 3001,
  UnknownClass: 3002,
  UnknownFunction: 3003,
  UnknownVariable: 3004,
  UnknownMethod: 3005,
  UnknownField: 3006,
  UnsupportedFeature: 3007,
  InvalidExpression: 3008,
  CodegenError: 3009,

  // Internal Compiler Errors (9000-9998)
  InternalCompilerError: 9000,

  // General
  UnknownError: 9999,
} as const;

export type DiagnosticCode =
  (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

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

export class CompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompilerError';
  }
}

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

  public clear() {
    this.#diagnostics = [];
  }
}

/**
 * Format a single diagnostic for display.
 * Includes filename, line:column, severity, message, and source context with caret.
 *
 * @param diagnostic The diagnostic to format
 * @param source The source code (required to show context)
 * @returns Formatted multi-line string
 */
export const formatDiagnostic = (
  diagnostic: Diagnostic,
  source?: string,
): string => {
  const parts: string[] = [];

  // Severity label and color codes
  const severityLabel =
    diagnostic.severity === DiagnosticSeverity.Error
      ? '\x1b[31merror\x1b[0m'
      : diagnostic.severity === DiagnosticSeverity.Warning
        ? '\x1b[33mwarning\x1b[0m'
        : '\x1b[34minfo\x1b[0m';

  // Location string (file:line:column)
  const loc = diagnostic.location;
  const locationStr = loc
    ? `\x1b[1m${loc.file}:${loc.line}:${loc.column}\x1b[0m`
    : '\x1b[1m<unknown>\x1b[0m';

  // First line: location: severity[code]: message
  parts.push(
    `${locationStr}: ${severityLabel}[Z${diagnostic.code}]: ${diagnostic.message}`,
  );

  // If we have source and location info, show the relevant line with a caret
  if (source && loc) {
    const lines = source.split('\n');
    const lineIndex = loc.line - 1; // Convert to 0-based

    if (lineIndex >= 0 && lineIndex < lines.length) {
      const sourceLine = lines[lineIndex];
      const lineNumWidth = String(loc.line).length;
      const gutter = ' '.repeat(lineNumWidth);

      // Line number and source
      parts.push(`${gutter} |`);
      parts.push(`\x1b[34m${loc.line}\x1b[0m | ${sourceLine}`);

      // Caret line pointing to the error
      const caretCol = Math.max(0, loc.column - 1);
      const caretLength = Math.max(1, loc.length || 1);
      const caret =
        ' '.repeat(caretCol) + '\x1b[31m' + '^'.repeat(caretLength) + '\x1b[0m';
      parts.push(`${gutter} | ${caret}`);
    }
  }

  return parts.join('\n');
};

/**
 * Format multiple diagnostics for a single file.
 *
 * @param diagnostics Array of diagnostics to format
 * @param source The source code for the file
 * @returns Formatted multi-line string
 */
export const formatDiagnostics = (
  diagnostics: ReadonlyArray<Diagnostic>,
  source?: string,
): string => {
  return diagnostics.map((d) => formatDiagnostic(d, source)).join('\n\n');
};
