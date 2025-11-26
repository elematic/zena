import assert from 'node:assert';
import {suite, test} from 'node:test';
import {main} from '../lib/index.js';

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
