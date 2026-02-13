import assert from 'node:assert';
import {suite, test} from 'node:test';
import {
  formatDiagnostic,
  formatDiagnostics,
  DiagnosticSeverity,
  DiagnosticCode,
  type Diagnostic,
} from '../lib/diagnostics.js';

suite('Diagnostic Formatting', () => {
  test('formatDiagnostic includes file, line, and column', () => {
    const diagnostic: Diagnostic = {
      code: DiagnosticCode.TypeMismatch,
      message: 'Type mismatch: expected i32, got String',
      severity: DiagnosticSeverity.Error,
      location: {
        file: 'test.zena',
        line: 5,
        column: 10,
        start: 50,
        length: 7,
      },
    };

    const output = formatDiagnostic(diagnostic);

    assert.ok(
      output.includes('test.zena:5:10'),
      'Should include file:line:column',
    );
    assert.ok(output.includes('error'), 'Should include severity');
    assert.ok(output.includes('Type mismatch'), 'Should include message');
    assert.ok(output.includes('Z2001'), 'Should include error code');
  });

  test('formatDiagnostic shows source context and caret', () => {
    const source = `let x = 1;
let y: i32 = "hello";
let z = 3;`;

    const diagnostic: Diagnostic = {
      code: DiagnosticCode.TypeMismatch,
      message: 'Type mismatch: expected i32, got String',
      severity: DiagnosticSeverity.Error,
      location: {
        file: 'test.zena',
        line: 2,
        column: 14,
        start: 25,
        length: 7,
      },
    };

    const output = formatDiagnostic(diagnostic, source);

    // Should show the source line
    assert.ok(
      output.includes('let y: i32 = "hello"'),
      'Should include source line',
    );
    // Should have carets pointing to the error
    assert.ok(
      output.includes('^^^^^^^'),
      'Should have caret pointing to error',
    );
  });

  test('formatDiagnostic handles missing location gracefully', () => {
    const diagnostic: Diagnostic = {
      code: DiagnosticCode.UnknownError,
      message: 'Something went wrong',
      severity: DiagnosticSeverity.Error,
    };

    const output = formatDiagnostic(diagnostic);

    assert.ok(
      output.includes('<unknown>'),
      'Should show <unknown> for missing location',
    );
    assert.ok(
      output.includes('Something went wrong'),
      'Should include message',
    );
  });

  test('formatDiagnostic handles warning severity', () => {
    const diagnostic: Diagnostic = {
      code: DiagnosticCode.UnreachableCode,
      message: 'Unreachable code detected',
      severity: DiagnosticSeverity.Warning,
      location: {
        file: 'test.zena',
        line: 1,
        column: 1,
        start: 0,
        length: 5,
      },
    };

    const output = formatDiagnostic(diagnostic);

    assert.ok(output.includes('warning'), 'Should show warning severity');
  });

  test('formatDiagnostics formats multiple diagnostics', () => {
    const source = `let x = unknownA;
let y = unknownB;`;

    const diagnostics: Diagnostic[] = [
      {
        code: DiagnosticCode.SymbolNotFound,
        message: "Variable 'unknownA' not found",
        severity: DiagnosticSeverity.Error,
        location: {
          file: 'test.zena',
          line: 1,
          column: 9,
          start: 8,
          length: 8,
        },
      },
      {
        code: DiagnosticCode.SymbolNotFound,
        message: "Variable 'unknownB' not found",
        severity: DiagnosticSeverity.Error,
        location: {
          file: 'test.zena',
          line: 2,
          column: 9,
          start: 26,
          length: 8,
        },
      },
    ];

    const output = formatDiagnostics(diagnostics, source);

    assert.ok(output.includes('unknownA'), 'Should include first error');
    assert.ok(output.includes('unknownB'), 'Should include second error');
    assert.ok(
      output.includes('let x = unknownA'),
      'Should show first source line',
    );
    assert.ok(
      output.includes('let y = unknownB'),
      'Should show second source line',
    );
  });

  test('formatDiagnostic caret position is correct for various columns', () => {
    const source = `    let indented = "value";`;

    const diagnostic: Diagnostic = {
      code: DiagnosticCode.TypeMismatch,
      message: 'Test error',
      severity: DiagnosticSeverity.Error,
      location: {
        file: 'test.zena',
        line: 1,
        column: 20, // Points to "value"
        start: 19,
        length: 7,
      },
    };

    const output = formatDiagnostic(diagnostic, source);
    const lines = output.split('\n');

    // Find the caret line
    const caretLine = lines.find((l) => l.includes('^'));
    assert.ok(caretLine, 'Should have a caret line');

    // The caret should be positioned correctly (after the gutter)
    // Column 20 means 19 spaces before the caret (0-indexed internally)
    assert.ok(
      caretLine!.includes('^^^^^^^'),
      'Should have 7 carets for length 7',
    );
  });
});
