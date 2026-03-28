import assert from 'node:assert';
import {suite, test} from 'node:test';
import {NodeCompilerHost} from '../lib/host.js';

suite('NodeCompilerHost package map', () => {
  const packageMap = {
    packages: {
      'zena-compiler': '/workspace/packages/zena-compiler/zena/lib',
      'zena-formatter': '/workspace/packages/zena-formatter/zena/lib',
    },
  };

  const host = new NodeCompilerHost('host', packageMap);

  test('resolves package:path specifier', () => {
    const resolved = host.resolve(
      'zena-compiler:parser',
      '/workspace/main.zena',
    );
    assert.strictEqual(
      resolved,
      '/workspace/packages/zena-compiler/zena/lib/parser.zena',
    );
  });

  test('resolves package with no subpath to index.zena', () => {
    const resolved = host.resolve('zena-formatter:', '/workspace/main.zena');
    assert.strictEqual(
      resolved,
      '/workspace/packages/zena-formatter/zena/lib/index.zena',
    );
  });

  test('resolves nested subpath', () => {
    const resolved = host.resolve(
      'zena-compiler:ast/nodes',
      '/workspace/main.zena',
    );
    assert.strictEqual(
      resolved,
      '/workspace/packages/zena-compiler/zena/lib/ast/nodes.zena',
    );
  });

  test('throws for unknown package', () => {
    assert.throws(
      () => host.resolve('unknown-pkg:foo', '/workspace/main.zena'),
      /unknown package/,
    );
  });

  test('throws for specifier without colon or relative prefix', () => {
    assert.throws(
      () => host.resolve('no-colon', '/workspace/main.zena'),
      /expected package:path format/,
    );
  });

  test('relative imports still work with package map', () => {
    const resolved = host.resolve('./utils.zena', '/workspace/src/main.zena');
    assert.strictEqual(resolved, '/workspace/src/utils.zena');
  });

  test('stdlib imports still work with package map', () => {
    const resolved = host.resolve('zena:string', '/workspace/main.zena');
    assert.ok(resolved.startsWith('zena:'));
  });

  test('loadPackageMap returns undefined for missing file', () => {
    const result = NodeCompilerHost.loadPackageMap(
      '/nonexistent/zena-packages.json',
    );
    assert.strictEqual(result, undefined);
  });
});
