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

  // Codegen Errors (3000-3999)
  UnknownType: 3001,
  UnknownClass: 3002,
  UnknownFunction: 3003,
  UnknownVariable: 3004,
  UnknownMethod: 3005,
  UnknownField: 3006,
  UnsupportedFeature: 3007,
  InvalidExpression: 3008,

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
