// Bundles `packages/vscode-zena` into a self-contained `dist/` directory:
// - `dist/extension.cjs`: CommonJS bundle with `@zena-lang/compiler` and
//   `@zena-lang/runtime`, targeting both Desktop Node and Web Worker hosts.
// - `dist/compiler-worker.cjs`: Node `worker_threads` bundle used on Desktop
//   hosts so WASM compilation and type checking never block the Extension Host.
// - `dist/compiler.wasm`: Copy of `packages/compiler/compiler.wasm`.
// - `dist/icon.png`: Copy of `assets/logo.png`.
// - `dist/stdlib/`: Individual `.zena` and `.wit` files from `packages/compiler/stdlib/`,
//   read asynchronously via `vscode.workspace.fs`.

import * as esbuild from 'esbuild';
import {copyFileSync, cpSync, mkdirSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const wasmSrc = resolve(pkgRoot, '../compiler/compiler.wasm');
const iconSrc = resolve(pkgRoot, '../../assets/logo.png');
const stdlibSrc = resolve(pkgRoot, '../compiler/stdlib');
const distDir = resolve(pkgRoot, 'dist');
const distStdlib = join(distDir, 'stdlib');

mkdirSync(distDir, {recursive: true});
copyFileSync(wasmSrc, join(distDir, 'compiler.wasm'));
copyFileSync(iconSrc, join(distDir, 'icon.png'));
rmSync(distStdlib, {recursive: true, force: true});
cpSync(stdlibSrc, distStdlib, {recursive: true});

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

await esbuild.build({
  entryPoints: [resolve(pkgRoot, 'src/compiler-worker.ts')],
  outfile: join(distDir, 'compiler-worker.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  logOverride: {
    'empty-import-meta': 'silent',
  },
});
