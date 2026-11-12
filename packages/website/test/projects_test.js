import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {writeSearchIndex} from '../lib/search-index.js';
import {
  containsActive,
  flattenSidebar,
  prevNext,
  sidebarFor,
} from '../lib/sidebar.js';
import nav from '../src/_data/nav.js';
import projects from '../src/_data/projects.js';
import sidebar from '../src/_data/sidebar.js';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

describe('projects section navigation, sidebars, and content', () => {
  it('exposes Projects in the top navigation bar', () => {
    const entry = nav.find((item) => item.link === '/projects/');
    assert.ok(entry, 'Expected /projects/ in nav.js');
    assert.equal(entry.text, 'Projects');
    assert.equal(entry.match, '/projects/');
  });

  it('keeps /projects/ full-width without a sidebar', () => {
    assert.equal(sidebarFor(sidebar, '/projects/'), null);
  });

  it('wires an isolated micro-site sidebar and matching page for every project', async () => {
    assert.equal(projects.length, 8);

    for (const project of projects) {
      const prefix = `/projects/${project.slug}/`;
      assert.equal(project.link, prefix);

      const tree = sidebarFor(sidebar, prefix);
      assert.ok(tree, `Expected sidebar tree for ${prefix}`);
      assert.equal(
        sidebarFor(sidebar, `${prefix}architecture/`),
        tree,
        `Expected subpages under ${prefix} to inherit its micro-site sidebar`,
      );

      // Back link to /projects/ sits at the top of each micro-site sidebar,
      // but stays out of flattenSidebar / prevNext reading order.
      assert.equal(tree[0]?.link, '/projects/');
      assert.equal(tree[0]?.back, true);

      const flat = flattenSidebar(tree);
      assert.ok(
        flat.every((item) => !item.back && item.link.startsWith(prefix)),
        `Expected flattened reading order for ${prefix} to exclude back links`,
      );
      assert.deepEqual(prevNext(sidebar, prefix), {
        prev: undefined,
        next: flat[1],
      });

      assert.equal(containsActive(tree[1], prefix), true);
      assert.equal(containsActive(tree[1], '/projects/'), false);

      // Verify the markdown overview page exists, is written, and matches outline.
      const mdPath = join(SRC_DIR, 'projects', project.slug, 'index.md');
      const source = await readFile(mdPath, 'utf8');
      assert.doesNotMatch(
        source,
        /^status:\s*['"]?Draft['"]?/m,
        `Expected ${mdPath} not to be a Draft placeholder`,
      );
      assert.equal(
        source.match(/^status:\s*'([^']+)'/m)?.[1],
        project.status,
        `Expected ${project.slug}/index.md status to match projects.js`,
      );
      assert.equal(
        source.match(/^statusType:\s*'([^']+)'/m)?.[1],
        project.statusType,
        `Expected ${project.slug}/index.md statusType to match projects.js`,
      );
      if (project.status === 'In progress') {
        assert.equal(
          project.statusType,
          'success',
          `Expected "In progress" project ${project.slug} to use green success badge`,
        );
      }

      const headings = [...source.matchAll(/^## (.+)$/gm)].map((m) =>
        m[1].trim(),
      );
      assert.deepEqual(
        headings,
        flat[0].outline,
        `Expected ## headings in ${project.slug}/index.md to match sidebar outline`,
      );
    }
  });

  it('embeds and deep-links the Wasm Web UI playground example', async () => {
    const mdSource = await readFile(
      join(SRC_DIR, 'projects', 'wasm-web-ui', 'index.md'),
      'utf8',
    );
    assert.match(mdSource, /\/playground\/#example-web-components/);
    assert.match(
      mdSource,
      /<zena-playground\s+vertical\s+preview\s+allow-unused-variables>/,
    );
    assert.match(
      mdSource,
      /\{%\s*include "wasm-web-ui-example-files\.njk"\s*%\}/,
    );

    const sampleFiles = await readFile(
      join(SRC_DIR, '_includes', 'wasm-web-ui-example-files.njk'),
      'utf8',
    );
    assert.match(sampleFiles, /filename="elements\.zena"/);
    assert.match(sampleFiles, /filename="demo\.js"/);
    assert.match(sampleFiles, /filename="index\.html"/);
  });

  it('indexes /projects/ and micro-site pages without status badge text in titles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zena-search-test-'));
    try {
      await writeSearchIndex(dir, [
        {
          url: '/projects/',
          content: `
            <main class="main">
              <h1 class="projects-title">Projects</h1>
              <p>WebAssembly tools built alongside Zena.</p>
              <h2 class="project-card-title">Zebra</h2>
            </main>
          `,
        },
        {
          url: '/projects/zebra/',
          content: `
            <main class="main">
              <div class="prose">
                <h1>Zebra<span class="badge success">In progress</span></h1>
                <p class="lead">Zebra is the Zena Build and Run tool.</p>
                <h2 id="build-and-run-model">Build and run model</h2>
                <p>Targets run incrementally.</p>
              </div>
            </main>
          `,
        },
      ]);

      const entries = JSON.parse(
        await readFile(join(dir, 'search-index.json'), 'utf8'),
      );

      assert.deepEqual(entries, [
        {
          title: 'Projects',
          section: 'Projects',
          url: '/projects/',
          text: 'Projects WebAssembly tools built alongside Zena.',
        },
        {
          title: 'Zebra',
          section: 'Projects',
          url: '/projects/zebra/',
          text: 'Zebra In progress Zebra is the Zena Build and Run tool.',
        },
        {
          title: 'Build and run model',
          section: 'Projects › Zebra',
          url: '/projects/zebra/#build-and-run-model',
          text: 'Targets run incrementally.',
        },
      ]);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
