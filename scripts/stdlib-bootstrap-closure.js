#!/usr/bin/env node
/**
 * Print which standard library modules the checked-in bootstrap must resolve.
 *
 * Moving a module's file is only free if the bootstrap never resolves that
 * module. The bootstrap resolves `zena:x` through the manifest baked into it,
 * not the one in the working tree, so if the file moves and the bootstrap's
 * manifest still names the old path, `build:cli` fails before anything else
 * runs.
 *
 * A module is bootstrap-critical if it is reached from either of:
 *
 * - the import closure of `packages/zena-compiler/zena/cli/main.zena`, the one
 *   file `build:cli` compiles, plus the wit-parser and formatter packages it
 *   pulls in;
 * - the prelude, which the bootstrap applies to every file it compiles,
 *   including the compiler's own sources.
 *
 * `getTargetRuntimeModules` is deliberately not seeded. It names
 * `zena:component-abi`, but only for a component target, and `build:cli`
 * builds no component — which is why the component libraries could move in one
 * step. Anything reached only under a target the bootstrap never builds is
 * free in the same way.
 *
 * The prelude half is easy to forget and is what makes most of `core`
 * bootstrap-critical: `immutable-array` and `ownership` are named by nobody in
 * the compiler and are still loaded by every compilation.
 *
 * Run from the repository root:  node scripts/stdlib-bootstrap-closure.js
 */

import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join, dirname, normalize} from 'node:path';

const STDLIB = 'packages/stdlib/zena';
const MANIFEST = 'packages/stdlib/stdlib-manifest.json';
const PRELUDE = 'packages/zena-compiler/zena/lib/prelude.zena';
const ENTRY = 'packages/zena-compiler/zena/cli/main.zena';
const ALSO_COMPILED = ['packages/wit-parser/zena', 'packages/zena-formatter/zena'];

/** `build:cli` builds no component, so a virtual module's component entry is
 * never resolved by the bootstrap — nor is anything only that entry imports.
 * This is why the component libraries moved in one step, and why `console`
 * being prelude-bound does not drag them in. */
const UNBUILT_TARGETS = new Set(['component']);

const FROM_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*'([^']+)'/g;
const PRELUDE_MODULE = /prelude\["zena:([a-z0-9-]+)"\]/g;
const RUNTIME_MODULE = /return \["zena:([a-z0-9-]+)"\]/g;

const uncommented = (path) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const matchAll = (re, src) => {
  re.lastIndex = 0;
  const out = new Set();
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
};

const entryFiles = (name, cfg) => {
  if (cfg.path) return [cfg.path];
  if (cfg.virtual) {
    return [
      ...new Set(
        Object.entries(cfg.virtual)
          .filter(([target]) => !UNBUILT_TARGETS.has(target))
          .map(([, path]) => path),
      ),
    ];
  }
  return [`${name}.zena`];
};

const walkZena = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkZena(full, out);
    else if (name.endsWith('.zena')) out.push(full);
  }
  return out;
};

const modules = JSON.parse(readFileSync(MANIFEST, 'utf8')).modules;

// Seed: every module the prelude names.
const preludeSrc = uncommented(PRELUDE);
const seed = matchAll(PRELUDE_MODULE, preludeSrc);
const targetGated = matchAll(RUNTIME_MODULE, preludeSrc);

// Seed: the import closure of the one file build:cli compiles.
const files = [ENTRY];
const walked = new Set();
while (files.length > 0) {
  const path = files.pop();
  if (walked.has(path) || !existsSync(path)) continue;
  walked.add(path);
  for (const spec of matchAll(FROM_IMPORT, uncommented(path))) {
    if (spec.startsWith('zena:')) seed.add(spec.slice('zena:'.length));
    else if (spec.startsWith('.')) files.push(normalize(join(dirname(path), spec)));
  }
}

for (const root of ALSO_COMPILED) {
  for (const path of walkZena(root)) {
    for (const spec of matchAll(FROM_IMPORT, uncommented(path))) {
      if (spec.startsWith('zena:')) seed.add(spec.slice('zena:'.length));
    }
  }
}

// Close over the stdlib's own imports.
const critical = new Set();
const queue = [...seed];
while (queue.length > 0) {
  const name = queue.pop();
  if (critical.has(name) || !(name in modules)) continue;
  critical.add(name);
  const stack = entryFiles(name, modules[name]);
  const local = new Set();
  while (stack.length > 0) {
    const path = stack.pop();
    if (local.has(path)) continue;
    local.add(path);
    const full = join(STDLIB, path);
    if (!existsSync(full)) continue;
    for (const spec of matchAll(FROM_IMPORT, uncommented(full))) {
      if (spec.startsWith('zena:')) queue.push(spec.slice('zena:'.length));
      else stack.push(normalize(join(dirname(path), spec)));
    }
  }
}

const free = Object.keys(modules)
  .filter((m) => !critical.has(m))
  .sort();

console.log(`Bootstrap-critical (${critical.size}) — a file move needs the`);
console.log('shim-then-reseed sequence in docs/design/stdlib-organization.md:');
console.log(`  ${[...critical].sort().join(', ')}`);
console.log();
console.log(`Freely movable (${free.length}) — repoint the manifest and move:`);
console.log(`  ${free.join(', ')}`);
if (targetGated.size > 0) {
  console.log();
  console.log('Target-gated, free for the bootstrap but resolved by a component');
  console.log(`build: ${[...targetGated].sort().join(', ')}`);
}
