import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  escapeXml,
  getNewestDate,
  htmlToAbsoluteUrls,
  isoDateTime,
} from '../lib/feed.js';

describe('htmlToAbsoluteUrls', () => {
  const baseUrl = 'https://zena-lang.dev';

  it('converts root-relative href and src to absolute URLs', () => {
    const input = [
      '<p><a href="/guide/what-is-zena/">Guide</a></p>',
      '<img src="/images/blog/xena.jpg" alt="Xena" />',
    ].join('\n');

    const result = htmlToAbsoluteUrls(input, baseUrl);
    assert.equal(
      result,
      [
        '<p><a href="https://zena-lang.dev/guide/what-is-zena/">Guide</a></p>',
        '<img src="https://zena-lang.dev/images/blog/xena.jpg" alt="Xena" />',
      ].join('\n'),
    );
  });

  it('converts relative paths with leading dots', () => {
    const input = '<a href="./deep-dive/">Read more</a>';
    const result = htmlToAbsoluteUrls(input, baseUrl);
    assert.equal(
      result,
      '<a href="https://zena-lang.dev/deep-dive/">Read more</a>',
    );
  });

  it('preserves absolute URLs, protocol-relative URLs, hashes, and mailto links', () => {
    const input = [
      '<a href="https://github.com/elematic/zena">GitHub</a>',
      '<a href="http://example.com/spec">Spec</a>',
      '<a href="//cdn.example.com/asset.js">CDN</a>',
      '<a href="#heading-1">Anchor</a>',
      '<a href="mailto:contact@zena-lang.dev">Email</a>',
      '<a href="tel:+1234567890">Phone</a>',
      '<a href="javascript:void(0)">JS</a>',
    ].join('\n');

    const result = htmlToAbsoluteUrls(input, baseUrl);
    assert.equal(result, input);
  });

  it('handles case-insensitive attribute names', () => {
    const input = '<A HREF="/reference/">Ref</A><IMG SRC="/logo.svg">';
    const result = htmlToAbsoluteUrls(input, baseUrl);
    assert.equal(
      result,
      '<A HREF="https://zena-lang.dev/reference/">Ref</A><IMG SRC="https://zena-lang.dev/logo.svg">',
    );
  });

  it('handles empty or non-string inputs gracefully', () => {
    assert.equal(htmlToAbsoluteUrls('', baseUrl), '');
    assert.equal(htmlToAbsoluteUrls(null, baseUrl), '');
    assert.equal(htmlToAbsoluteUrls(undefined, baseUrl), '');
  });
});

describe('isoDateTime', () => {
  it('formats Date instances into RFC 3339 / ISO 8601 strings', () => {
    const date = new Date('2026-09-24T12:00:00Z');
    assert.equal(isoDateTime(date), '2026-09-24T12:00:00.000Z');
  });

  it('formats date strings into RFC 3339 / ISO 8601 strings', () => {
    assert.equal(
      isoDateTime('2026-09-24T09:30:00Z'),
      '2026-09-24T09:30:00.000Z',
    );
  });
});

describe('getNewestDate', () => {
  it('returns the newest date from a collection of posts', () => {
    const posts = [
      {date: new Date('2026-09-24T12:00:00Z')},
      {date: new Date('2026-09-24T09:00:00Z')},
    ];
    assert.equal(
      getNewestDate(posts).toISOString(),
      '2026-09-24T12:00:00.000Z',
    );
  });

  it('falls back to current date if collection is empty or null', () => {
    const now = new Date();
    const result = getNewestDate([]);
    assert.ok(result instanceof Date);
    assert.ok(Math.abs(result.getTime() - now.getTime()) < 1000);
  });
});

describe('escapeXml', () => {
  it('escapes XML special characters', () => {
    const input = '<div class="test">Fish & Chips \'n\' fun</div>';
    assert.equal(
      escapeXml(input),
      '&lt;div class=&quot;test&quot;&gt;Fish &amp; Chips &apos;n&apos; fun&lt;/div&gt;',
    );
  });

  it('handles null and undefined', () => {
    assert.equal(escapeXml(null), '');
    assert.equal(escapeXml(undefined), '');
  });
});
