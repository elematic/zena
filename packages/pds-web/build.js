/**
 * Builds the web app's assets into out/, which the PDS serves at /assets/
 * as PDS_WEB_DIR: app.css, Radica's design tokens and the pages' own
 * styles; app.js, the Radica elements the pages use and their sign-in;
 * and chunks/, what app.js loads only when it needs it.
 */

import * as esbuild from 'esbuild';
import {copyFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
await mkdir(out, {recursive: true});
await copyFile(
  join(here, '../website/src/public/logo.svg'),
  join(out, 'logo.svg'),
);

/**
 * Radica's components import their styles as CSS module scripts
 * (`with {type: 'css'}`), which esbuild does not bundle itself: each
 * becomes a module exporting a constructed CSSStyleSheet, as in
 * packages/website's build.
 */
const cssModuleScripts = {
  name: 'css-module-scripts',
  setup(build) {
    build.onLoad({filter: /\.css$/}, async (args) => {
      if (args.with?.type !== 'css') {
        return null;
      }
      const cssText = await readFile(args.path, 'utf8');
      return {
        contents: `const sheet = new CSSStyleSheet();
sheet.replaceSync(${JSON.stringify(cssText)});
export default sheet;`,
        loader: 'js',
      };
    });
  },
};

await esbuild.build({
  entryPoints: {app: join(here, 'src/main.ts')},
  outdir: out,
  bundle: true,
  // The OAuth library is most of the script, and only signing in or out
  // needs it: main.ts imports ./auth.js dynamically, into a chunk of its own.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  legalComments: 'linked',
  plugins: [cssModuleScripts],
  logLevel: 'warning',
});
await esbuild.build({
  entryPoints: {app: join(here, 'src/app.css')},
  outdir: out,
  bundle: true,
  minify: true,
  logLevel: 'warning',
});
