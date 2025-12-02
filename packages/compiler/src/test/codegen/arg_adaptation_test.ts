import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {compileAndRun} from './utils.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

suite('Argument Adaptation', () => {
  test('should adapt function arguments with fewer parameters', async () => {
    const filePath = join(process.cwd(), 'test-files/arg-adaptation.zena');
    const code = await readFile(filePath, 'utf-8');

    await compileAndRun(code, 'main');
  });

  test('should adapt function arguments when assigning to union type', async () => {
    const filePath = join(process.cwd(), 'test-files/union-adaptation.zena');
    const code = await readFile(filePath, 'utf-8');

    const ret = await compileAndRun(code, 'main');
    assert.strictEqual(ret, 10);
  });
});
