#!/usr/bin/env node
/**
 * Print the standard library's inter-module dependency graph and its layering.
 *
 * Each published module is read as its entry file plus the private siblings it
 * reaches by relative import. Imports of other `zena:` modules become edges.
 * Layer N holds the modules whose dependencies all sit in layers below N, so a
 * module can only be grouped with another without creating a cycle if the
 * grouping respects this order. Modules left over after the peel are part of a
 * cycle and are reported separately.
 *
 * Run from the repository root:  node scripts/stdlib-deps.js
 */

import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join, dirname, normalize, relative} from 'node:path';

const ROOT = 'packages/stdlib/zena';
const MANIFEST = 'packages/stdlib/stdlib-manifest.json';

const FROM_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*'([^']+)'/g;
const SIDE_IMPORT = /(?:^|\n)\s*import\s*'([^']+)'/g;

/** Source with comments removed, so examples in doc blocks are not edges. */
const uncommented = (path) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const specifiers = (path) => {
  const src = uncommented(path);
  const out = new Set();
  for (const re of [FROM_IMPORT, SIDE_IMPORT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
  }
  return out;
};

const entryFiles = (name, cfg) => {
  if (cfg.path) return [cfg.path];
  if (cfg.virtual) return [...new Set(Object.values(cfg.virtual))];
  return [`${name}.zena`];
};

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.zena')) out.push(relative(ROOT, full));
  }
  return out;
};

const modules = JSON.parse(readFileSync(MANIFEST, 'utf8')).modules;
const present = new Set(walk(ROOT));

const deps = new Map();
const missing = [];
for (const [name, cfg] of Object.entries(modules)) {
  const seen = new Set();
  const stack = entryFiles(name, cfg);
  const edges = new Set();
  while (stack.length > 0) {
    const path = stack.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    if (!present.has(path)) {
      missing.push([name, path]);
      continue;
    }
    for (const spec of specifiers(join(ROOT, path))) {
      if (spec.startsWith('zena:')) edges.add(spec.slice('zena:'.length));
      else stack.push(normalize(join(dirname(path), spec)));
    }
  }
  edges.delete(name);
  deps.set(name, edges);
}

// Peel modules whose dependencies are all already placed.
const placed = new Map();
let remaining = new Set(Object.keys(modules));
let layer = 0;
for (;;) {
  const ready = [...remaining].filter((m) =>
    [...deps.get(m)].every((d) => placed.has(d) || !(d in modules)),
  );
  if (ready.length === 0) break;
  for (const m of ready) {
    placed.set(m, layer);
    remaining.delete(m);
  }
  layer += 1;
}

for (let n = 0; n < layer; n += 1) {
  const members = [...placed.keys()].filter((m) => placed.get(m) === n).sort();
  console.log(`L${n}: ${members.join(', ')}`);
}

if (missing.length > 0) {
  console.log('\nManifest entries with no file:');
  for (const [name, path] of missing.sort()) console.log(`  ${name} -> ${path}`);
}

if (remaining.size > 0) {
  console.log('\nCyclic:');
  for (const m of [...remaining].sort()) {
    const inCycle = [...deps.get(m)].filter((d) => remaining.has(d)).sort();
    console.log(`  ${m} -> ${inCycle.join(', ')}`);
  }
}

console.log('\nDependencies:');
for (const m of Object.keys(modules).sort()) {
  console.log(`  ${m}: ${[...deps.get(m)].sort().join(', ') || '-'}`);
}

process.exit(remaining.size > 0 ? 1 : 0);
