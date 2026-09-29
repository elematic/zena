import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import MarkdownIt from 'markdown-it';
import {createZenaHighlighter} from '../lib/highlight.js';
import {configureMarkdown} from '../lib/markdown.js';

describe('markdown custom element parsing', async () => {
  const highlighter = await createZenaHighlighter();
  const md = configureMarkdown(new MarkdownIt(), highlighter);

  it('parses code blocks inside <zena-example-playground>', () => {
    const input = [
      '<zena-example-playground fullpage>',
      '<figure id="example-functions" category="Basics">',
      '<figcaption>Functions</figcaption>',
      '',
      '```zena',
      'export function main() {',
      '  console.log("Hello");',
      '}',
      '```',
      '',
      '</figure>',
      '</zena-example-playground>',
    ].join('\n');

    const html = md.render(input);

    // Code block inside figure should be parsed into a pre/code block, not left as raw ```zena
    assert.doesNotMatch(html, /```zena/);
    assert.match(html, /<figure id="example-functions"/);
    assert.match(html, /<figcaption>Functions<\/figcaption>/);
    assert.match(html, /<pre[^>]*><code[^>]*>/);
  });

  it('keeps <zena-playground> as a raw block for script tags', () => {
    const input = [
      '<zena-playground vertical>',
      '  <script type="sample/zena" filename="main.zena">',
      '',
      '    let x = 1;',
      '',
      '  </script>',
      '</zena-playground>',
    ].join('\n');

    const html = md.render(input);

    // <zena-playground> should not have paragraphs injected into its script tag
    assert.doesNotMatch(html, /<p>/);
    assert.match(html, /<script type="sample\/zena"/);
  });

  it('parses all figures in playground-examples.njk with zero unrendered fences', async () => {
    const {readFile} = await import('node:fs/promises');
    const examplesPath = new URL(
      '../src/_includes/playground-examples.njk',
      import.meta.url,
    );
    const content = await readFile(examplesPath, 'utf8');
    const html = md.render(
      `<zena-example-playground fullpage>\n${content}\n</zena-example-playground>`,
    );

    // Guard rail: No markdown fences should remain unparsed
    assert.doesNotMatch(
      html,
      /```zena/,
      'Found unrendered ```zena code fences inside <zena-example-playground>',
    );
    // Every figure should contain a code block or script
    const figureMatches = html.match(/<figure[^>]*>/g) || [];
    const codeBlockMatches =
      html.match(/<pre[^>]*><code[^>]*>|<script type="sample\//g) || [];
    assert.ok(
      figureMatches.length > 0,
      'Expected figures in playground-examples.njk',
    );
    assert.ok(
      codeBlockMatches.length >= figureMatches.length,
      `Expected at least ${figureMatches.length} code blocks or sample scripts, but found ${codeBlockMatches.length}`,
    );
  });
});
