import {suite, test} from 'node:test';
import assert from 'node:assert';
import {
  generateCodeSvg,
  getAvailableThemes,
  getAvailableBackgrounds,
  getDefaultWatermarkText,
  type ExportCodeImageOptions,
} from '../lib/zena-code-export.js';

suite('zena-code-export', () => {
  test('returns available themes and backgrounds', () => {
    const themes = getAvailableThemes();
    assert.ok(themes.some((t) => t.id === 'one-dark'));
    assert.ok(themes.some((t) => t.id === 'dracula'));
    assert.ok(themes.some((t) => t.id === 'nord'));

    const backgrounds = getAvailableBackgrounds();
    assert.ok(backgrounds.some((b) => b.id === 'sunset'));
    assert.ok(backgrounds.some((b) => b.id === 'ocean'));
    assert.ok(backgrounds.some((b) => b.id === 'midnight'));
    assert.ok(backgrounds.some((b) => b.id === 'transparent'));
  });

  test('generates valid SVG for basic Zena code', () => {
    const code = `export function add(a: i32, b: i32): i32 {
  return a + b;
}`;
    const svg = generateCodeSvg({
      code,
      filename: 'math.zena',
      theme: 'one-dark',
      background: 'sunset',
    });

    assert.ok(svg.startsWith('<svg'), 'SVG starts with <svg tag');
    assert.ok(svg.endsWith('</svg>'), 'SVG ends with </svg> tag');
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'Has xmlns');
    assert.ok(svg.includes('math.zena'), 'Includes filename in window title');
    assert.ok(
      svg.includes('linearGradient id="bg-sunset"'),
      'Includes background gradient',
    );
    assert.ok(svg.includes('export'), 'Contains code text');
    assert.ok(svg.includes('function'), 'Contains code text');
    assert.ok(svg.includes('add'), 'Contains code text');
  });

  test('escapes HTML/XML entities correctly in SVG output', () => {
    const code = `let check = (x: i32) => x < 10 && x > 0;
let msg = "Hello <world> & 'friends' \\"quote\\"";`;
    const svg = generateCodeSvg({
      code,
      filename: 'escape.zena',
    });

    // Code characters <, >, &, ", ' should be XML escaped in tspans
    assert.ok(svg.includes('&lt;'), 'Escapes <');
    assert.ok(svg.includes('&amp;&amp;'), 'Escapes &&');
    assert.ok(svg.includes('&gt;'), 'Escapes >');
    assert.ok(!svg.includes('<world>'), 'Does not contain raw unescaped tag');
  });

  test('handles empty lines and whitespace indentation', () => {
    const code = `class Point {
  x: i32;

  y: i32;
}`;
    const svg = generateCodeSvg({
      code,
      filename: 'point.zena',
      showLineNumbers: true,
    });

    assert.ok(svg.includes('class'), 'Contains class token');
    assert.ok(svg.includes('xml:space="preserve"'), 'Preserves whitespace');
  });

  test('toggles line numbers and window controls', () => {
    const code = `let x = 42;`;

    const svgWithLineNums = generateCodeSvg({
      code,
      showLineNumbers: true,
      showWindowControls: true,
    });
    // macOS circles
    assert.ok(svgWithLineNums.includes('fill="#ff5f56"'), 'Has close circle');
    assert.ok(
      svgWithLineNums.includes('fill="#ffbd2e"'),
      'Has minimize circle',
    );
    assert.ok(
      svgWithLineNums.includes('fill="#27c93f"'),
      'Has maximize circle',
    );

    const svgWithoutControls = generateCodeSvg({
      code,
      showLineNumbers: false,
      showWindowControls: false,
    });
    assert.ok(
      !svgWithoutControls.includes('fill="#ff5f56"'),
      'Omits window controls',
    );
  });

  test('supports transparent background', () => {
    const code = `let greeting = 'hello';`;
    const svg = generateCodeSvg({
      code,
      background: 'transparent',
    });

    assert.ok(
      svg.includes('fill="none"') || svg.includes('fill="transparent"'),
      'Has transparent background fill',
    );
  });

  test('configures and escapes watermark text', () => {
    assert.strictEqual(typeof getDefaultWatermarkText(), 'string');

    const svgWithSiteWatermark = generateCodeSvg({
      code: 'let x = 1;',
      showWatermark: true,
      watermarkText: '⚡ Zena • zena-lang.dev',
    });
    assert.ok(
      svgWithSiteWatermark.includes('⚡ Zena • zena-lang.dev'),
      'Includes site watermark text',
    );

    const svgWithoutWatermark = generateCodeSvg({
      code: 'let x = 1;',
      showWatermark: false,
    });
    assert.ok(
      !svgWithoutWatermark.includes('⚡ Zena'),
      'Omits watermark when showWatermark is false',
    );

    const svgEscaped = generateCodeSvg({
      code: 'let x = 1;',
      watermarkText: 'Brand <Corp> & Co',
    });
    assert.ok(
      svgEscaped.includes('Brand &lt;Corp&gt; &amp; Co'),
      'Escapes XML in watermark text',
    );
  });
});
