import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';
import {wrapAsModule} from './utils.js';

suite('CodeGenerator: Diagnostics', () => {
  test('should report diagnostic for unknown variable in expression', () => {
    const source = `
      let main = () => {
        unknownVar;
      };
    `;
    const parser = new Parser(source);
    const ast = parser.parse();
    // Run type checker to get semantic context (even though code has errors)
    const checker = TypeChecker.forProgram(ast);
    checker.check();
    const codegen = new CodeGenerator(
      wrapAsModule(ast, source),
      undefined,
      checker.semanticContext,
      checker.checkerContext,
    );
    codegen.setFileName('test.zena');

    try {
      codegen.generate();
      assert.fail('Expected an error to be thrown');
    } catch {
      // Expected
    }

    // Check that a diagnostic was reported
    assert.ok(codegen.diagnostics.hasErrors(), 'Should have reported errors');
    const errors = codegen.diagnostics.diagnostics;
    assert.ok(errors.length > 0, 'Should have at least one diagnostic');

    const diagnostic = errors.find(
      (d) => d.code === DiagnosticCode.UnknownVariable,
    );
    assert.ok(diagnostic, 'Should have reported UnknownVariable diagnostic');
    assert.ok(diagnostic!.message.includes('unknownVar'));
  });

  test('should include file name in diagnostic location', () => {
    const source = `
      let main = () => {
        unknownVar;
      };
    `;
    const parser = new Parser(source);
    const ast = parser.parse();
    // Run type checker to get semantic context (even though code has errors)
    const checker = TypeChecker.forProgram(ast);
    checker.check();
    const codegen = new CodeGenerator(
      wrapAsModule(ast, source),
      undefined,
      checker.semanticContext,
      checker.checkerContext,
    );
    codegen.setFileName('myfile.zena');

    try {
      codegen.generate();
    } catch {
      // Expected
    }

    const errors = codegen.diagnostics.diagnostics;
    const diagnostic = errors.find(
      (d) => d.code === DiagnosticCode.UnknownVariable,
    );
    assert.ok(diagnostic);
    assert.ok(diagnostic!.location);
    assert.strictEqual(diagnostic!.location!.file, 'myfile.zena');
  });

  test('diagnostics should have location info when AST has loc', () => {
    const source = `
      let main = () => {
        unknownVar;
      };
    `;
    const parser = new Parser(source);
    const ast = parser.parse();
    // Run type checker to get semantic context (even though code has errors)
    const checker = TypeChecker.forProgram(ast);
    checker.check();
    const codegen = new CodeGenerator(
      wrapAsModule(ast, source),
      undefined,
      checker.semanticContext,
      checker.checkerContext,
    );
    codegen.setFileName('test.zena');

    try {
      codegen.generate();
    } catch {
      // Expected
    }

    const errors = codegen.diagnostics.diagnostics;
    const diagnostic = errors.find(
      (d) => d.code === DiagnosticCode.UnknownVariable,
    );
    assert.ok(diagnostic, 'Should have reported UnknownVariable diagnostic');
    assert.ok(diagnostic!.location, 'Diagnostic should have location');
    assert.ok(diagnostic!.location!.line > 0, 'Location should have line');
    assert.ok(diagnostic!.location!.column > 0, 'Location should have column');
    assert.ok(diagnostic!.location!.start >= 0, 'Location should have start');
    assert.ok(
      diagnostic!.location!.length > 0,
      'Location should have non-zero length',
    );
  });
});
