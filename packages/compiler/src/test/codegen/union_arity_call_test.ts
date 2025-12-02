import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {compileAndRun} from './utils.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

suite('Union Arity Call', () => {
  test('should succeed when calling a union with arguments supported by all members (via adaptation)', async () => {
    const filePath = join(process.cwd(), 'test-files/union-arity-call.zena');
    const code = await readFile(filePath, 'utf-8');

    const ret = await compileAndRun(code, 'main');
    assert.strictEqual(ret, 10);
  });
});
