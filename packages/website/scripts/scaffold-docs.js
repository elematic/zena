#!/usr/bin/env node
/**
 * Creates a placeholder page for every sidebar entry that doesn't have one yet.
 *
 * The sidebar in `src/_data/sidebar.js` is the site's content plan: each leaf
 * carries the `outline` of sections that page is meant to cover. This turns
 * that plan into real files with the headings already stubbed out, so writing a
 * page means filling in prose rather than deciding structure.
 *
 * Existing files are never modified. Run it again after editing the sidebar.
 *
 *   node scripts/scaffold-docs.js [--dry-run]
 */

import {mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import sidebar from '../src/_data/sidebar.js';
import {flattenSidebar} from '../lib/sidebar.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const dryRun = process.argv.includes('--dry-run');

/**
 * Maps a URL to its source file. A link that is a prefix of another link owns a
 * directory, so it becomes that directory's `index.md`.
 */
const sourcePathFor = (link, allLinks) => {
  const isDirectory = allLinks.some((l) => l !== link && l.startsWith(link));
  const segments = link.split('/').filter(Boolean);
  return join(
    SRC,
    ...(isDirectory
      ? [...segments, 'index.md']
      : [...segments.slice(0, -1), `${segments.at(-1)}.md`]),
  );
};

const yamlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

const placeholder = (item) => {
  const sections = (item.outline ?? [])
    .map(
      (heading) => `## ${heading}\n\n<!-- TODO: ${heading.toLowerCase()} -->\n`,
    )
    .join('\n');

  return `---
title: ${yamlString(item.text)}
description: ${yamlString(`${item.text} — Zena documentation.`)}
status: Draft
statusType: warning
---

::: warning Placeholder
This page hasn't been written yet. The headings below are the planned outline —
see \`src/_data/sidebar.js\` for the full content plan.
:::

${sections || '<!-- TODO: outline this page -->\n'}`;
};

const created = [];
const skipped = [];

for (const [prefix, tree] of Object.entries(sidebar)) {
  const items = flattenSidebar(tree);
  const links = items.map((item) => item.link);

  for (const item of items) {
    if (!item.link.startsWith(prefix)) continue;
    // A generated page already exists at this URL, produced from data
    // rather than from a source file. Writing a placeholder for it would
    // claim the same permalink.
    if (item.generated) continue;
    const path = sourcePathFor(item.link, links);

    // A page may be a template rather than markdown — the stdlib overview
    // renders the extracted module list — and that still counts as
    // existing.
    if (existsSync(path) || existsSync(path.replace(/\.md$/, '.njk'))) {
      skipped.push(path);
      continue;
    }

    created.push(path);
    if (dryRun) continue;

    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, placeholder(item));
  }
}

const relative = (p) => p.slice(SRC.length);
for (const path of created) {
  console.log(`${dryRun ? 'would create' : 'created'} ${relative(path)}`);
}
console.log(
  `\n${created.length} created, ${skipped.length} already present${dryRun ? ' (dry run)' : ''}`,
);
