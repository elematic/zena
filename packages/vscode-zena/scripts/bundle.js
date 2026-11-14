// Bundles `packages/vscode-zena` into a self-contained `dist/` directory:
// - `dist/extension.cjs`: CommonJS bundle with `@zena-lang/language-service`,
//   `@zena-lang/runtime`, and all `packages/stdlib/zena` sources inlined,
//   targeting both Desktop Node and Web Worker (`vscode.dev`) hosts.
// - `dist/lsp.wasm`: Copy of `packages/language-service/lsp.wasm`.

import * as esbuild from 'esbuild';
import {copyFileSync, mkdirSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const stdlibDir = resolve(pkgRoot, '../stdlib/zena');
const wasmSrc = resolve(pkgRoot, '../language-service/lsp.wasm');
const distDir = resolve(pkgRoot, 'dist');

function collectStdlibFiles(dir, base, out) {
  const entries = readdirSync(dir, {withFileTypes: true}).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectStdlibFiles(full, base, out);
    } else if (entry.name.endsWith('.zena')) {
      const rel = relative(base, full).replaceAll('\\', '/');
      out[`/stdlib/${rel}`] = readFileSync(full, 'utf8');
    }
  }
}

const stdlibPlugin = {
  name: 'zena-stdlib-data',
  setup(build) {
    build.onResolve({filter: /^virtual:stdlib-data$/}, () => ({
      path: 'virtual:stdlib-data',
      namespace: 'zena-stdlib-data',
    }));
    build.onLoad({filter: /.*/, namespace: 'zena-stdlib-data'}, () => {
      const files = {};
      collectStdlibFiles(stdlibDir, stdlibDir, files);
      return {
        contents: `export default ${JSON.stringify(files)};`,
        loader: 'js',
      };
    });
  },
};

mkdirSync(distDir, {recursive: true});
copyFileSync(wasmSrc, join(distDir, 'lsp.wasm'));

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
  plugins: [stdlibPlugin],
});
