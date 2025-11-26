import assert from 'node:assert';
import {suite, test} from 'node:test';
import {main} from '../lib/index.js';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// From test/ go up to cli/ then into test-files/
const testFilesDir = join(__dirname, '..', 'test-files');

suite('CLI', () => {
  test('should return 0 for help command', async () => {
    const exitCode = await main(['help']);
    assert.strictEqual(exitCode, 0);
  });

  test('should return 0 for --help flag', async () => {
    const exitCode = await main(['--help']);
    assert.strictEqual(exitCode, 0);
  });

  test('should return 0 for -h flag', async () => {
    const exitCode = await main(['-h']);
    assert.strictEqual(exitCode, 0);
  });

  test('should return 1 for build without files', async () => {
    const exitCode = await main(['build']);
    assert.strictEqual(exitCode, 1);
  });

  test('should return 1 for check without files', async () => {
    const exitCode = await main(['check']);
    assert.strictEqual(exitCode, 1);
  });

  test('should return 1 for run without files', async () => {
    const exitCode = await main(['run']);
    assert.strictEqual(exitCode, 1);
  });

  test('should return 0 for unknown command (shows help)', async () => {
    const exitCode = await main([]);
    assert.strictEqual(exitCode, 0);
  });
});

suite('CLI with test files', () => {
  test('should check valid.zena successfully', async () => {
    const exitCode = await main(['check', join(testFilesDir, 'valid.zena')]);
    assert.strictEqual(exitCode, 0);
  });

  test('should fail to check type-error.zena', async () => {
    const exitCode = await main([
      'check',
      join(testFilesDir, 'type-error.zena'),
    ]);
    assert.strictEqual(exitCode, 1);
  });

  test('should build valid.zena successfully', async () => {
    const exitCode = await main([
      'build',
      join(testFilesDir, 'valid.zena'),
      '-o',
      '/tmp/valid-test.wasm',
    ]);
    assert.strictEqual(exitCode, 0);
  });

  test('should fail to build type-error.zena', async () => {
    const exitCode = await main([
      'build',
      join(testFilesDir, 'type-error.zena'),
    ]);
    assert.strictEqual(exitCode, 1);
  });

  test('should fail to run type-error.zena', async () => {
    const exitCode = await main(['run', join(testFilesDir, 'type-error.zena')]);
    assert.strictEqual(exitCode, 1);
  });
});
