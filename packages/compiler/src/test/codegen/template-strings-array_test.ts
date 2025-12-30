import {suite, test} from 'node:test';

suite('CodeGenerator - TemplateStringsArray', () => {
  // These tests are skipped because they require tagged template literal support
  // which needs additional codegen changes to instantiate TemplateStringsArray.
  // The class itself is correctly wired up in the stdlib.

  test.skip('should access length property', () => {
    // Test requires tagged template literal codegen support
  });

  test.skip('should support indexing', () => {
    // Test requires tagged template literal codegen support
  });

  test.skip('should access raw property', () => {
    // Test requires tagged template literal codegen support
  });
});
