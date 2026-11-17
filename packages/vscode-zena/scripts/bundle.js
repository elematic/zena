// Bundles `packages/vscode-zena` into a self-contained `dist/` directory:
// - `dist/extension.cjs`: CommonJS bundle with `@zena-lang/compiler`,
//   `@zena-lang/compiler/stdlib`, and `@zena-lang/runtime` inlined, targeting
//   both Desktop Node and Web Worker (`vscode.dev`) hosts.
// - `dist/compiler.wasm`: Copy of `packages/compiler/compiler.wasm`.

import * as esbuild from 'esbuild';
import {copyFileSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const wasmSrc = resolve(pkgRoot, '../compiler/compiler.wasm');
const distDir = resolve(pkgRoot, 'dist');

mkdirSync(distDir, {recursive: true});
copyFileSync(wasmSrc, join(distDir, 'compiler.wasm'));

await esbuild.build({
  entryPoints: [resolve(pkgRoot, 'src/extension.ts')],
  outfile: join(distDir, 'extension.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['browser', 'import', 'default'],
  target: 'es2022',
  sourcemap: true,
  external: ['vscode'],
  logOverride: {
    'empty-import-meta': 'silent',
  },
});
