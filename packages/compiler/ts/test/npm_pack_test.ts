/**
 * Verifies that only the intended `@zena-lang/*` workspaces are public (non-private)
 * and that `npm pack --dry-run --json` produces clean, complete tarballs for
 * every public package.
 */

import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const packagesDir = join(repoRoot, 'packages');

const EXPECTED_PUBLIC_PACKAGES = new Map<string, string[]>([
  [
    '@zena-lang/runtime',
    ['package.json', 'LICENSE', 'README.md', 'index.js', 'index.d.ts'],
  ],
  [
    '@zena-lang/compiler',
    [
      'package.json',
      'LICENSE',
      'README.md',
      'index.js',
      'index.d.ts',
      'stdlib.js',
      'stdlib.d.ts',
      'compiler.wasm',
    ],
  ],
  [
    '@zena-lang/codemirror',
    ['package.json', 'LICENSE', 'README.md', 'lib/index.js', 'lib/index.d.ts'],
  ],
  [
    '@zena-lang/playground',
    [
      'package.json',
      'LICENSE',
      'README.md',
      'lib/index.js',
      'lib/index.d.ts',
      'lib/worker/compiler-worker.js',
    ],
  ],
  [
    '@zena-lang/wasm-web-ui',
    ['package.json', 'LICENSE', 'README.md', 'index.js', 'index.d.ts'],
  ],
]);

suite('public @zena-lang/* npm packages', () => {
  test('only the intended packages omit "private": true', () => {
    const actualPublic: string[] = [];
    for (const entry of readdirSync(packagesDir, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const pkgJsonPath = join(packagesDir, entry.name, 'package.json');
      let pkg: any;
      try {
        pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      } catch {
        continue;
      }
      if (!pkg.private) {
        actualPublic.push(pkg.name);
      }
    }
    assert.deepStrictEqual(
      actualPublic.sort(),
      [...EXPECTED_PUBLIC_PACKAGES.keys()].sort(),
    );
  });

  for (const [pkgName, requiredFiles] of EXPECTED_PUBLIC_PACKAGES) {
    test(`${pkgName} packs a clean npm tarball with required files`, () => {
      const stdout = execFileSync(
        'npm',
        ['pack', '--dry-run', '--json', '-w', pkgName],
        {cwd: repoRoot, encoding: 'utf8'},
      );
      const [info] = JSON.parse(stdout) as Array<{
        name: string;
        version: string;
        files: Array<{path: string}>;
      }>;
      assert.strictEqual(info.name, pkgName);
      assert.match(info.version, /^\d+\.\d+\.\d+(-preview\.\d+)?$/);

      const packedPaths = new Set(info.files.map((f) => f.path));
      for (const req of requiredFiles) {
        assert.ok(
          packedPaths.has(req),
          `${pkgName} tarball missing '${req}' (packed: ${[...packedPaths].join(', ')})`,
        );
      }
      for (const packed of packedPaths) {
        assert.ok(
          !packed.endsWith('.tsbuildinfo') &&
            !packed.startsWith('test/') &&
            !packed.startsWith('src/'),
          `${pkgName} tarball leaked build/test artifact: ${packed}`,
        );
      }
    });
  }
});
