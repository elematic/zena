import {readFile} from 'node:fs/promises';
import {createHighlighter} from 'shiki';

const GRAMMAR_PATH = new URL(
  '../../vscode-zena/syntaxes/zena.tmLanguage.json',
  import.meta.url,
);

/** Themes match VitePress's defaults so the ported CSS lines up. */
export const THEMES = {light: 'github-light', dark: 'github-dark'};

/** Languages used in the docs, beyond Zena itself. */
const LANGS = [
  'bash',
  'diff',
  'html',
  'javascript',
  'json',
  'markdown',
  'rust',
  'toml',
  'typescript',
  'wasm',
  'yaml',
];

/** `wat` is what everyone writes in fences; Shiki calls the grammar `wasm`. */
const LANG_ALIASES = {
  wat: 'wasm',
  ts: 'typescript',
  js: 'javascript',
  sh: 'bash',
};

/**
 * Loads the same TextMate grammar the VS Code extension ships, so code samples
 * on the site and in the editor highlight identically.
 */
const loadZenaGrammar = async () => {
  const grammar = JSON.parse(await readFile(GRAMMAR_PATH, 'utf8'));
  // Shiki keys grammars by `name`; the file's own name is the display name.
  return {...grammar, name: 'zena', displayName: 'Zena'};
};

export const createZenaHighlighter = async () =>
  createHighlighter({
    themes: Object.values(THEMES),
    langs: [...LANGS, await loadZenaGrammar()],
  });

/**
 * Renders one code block in VitePress's markup:
 *
 *     <div class="language-zena adaptive-theme">
 *       <button class="copy"></button>
 *       <span class="lang">zena</span>
 *       <pre class="shiki … code-block"><code>…</code></pre>
 *     </div>
 *
 * `defaultColor: false` makes Shiki emit `--shiki-light` / `--shiki-dark`
 * custom properties instead of concrete colours, which is what lets a single
 * render serve both themes (see css/vitepress/components/code-block.css).
 */
export const renderCodeBlock = (highlighter, code, lang, label) => {
  const aliased = LANG_ALIASES[lang] ?? lang;
  const known = highlighter.getLoadedLanguages().includes(aliased);
  const resolved = known ? aliased : 'text';

  const pre = highlighter.codeToHtml(code, {
    lang: resolved,
    themes: THEMES,
    defaultColor: false,
    transformers: [
      {
        pre(node) {
          node.properties['class'] = `${node.properties['class']} code-block`;
        },
      },
    ],
  });

  return (
    `<div class="language-${resolved} adaptive-theme">` +
    `<button title="Copy Code" class="copy"></button>` +
    `<span class="lang">${label ?? resolved}</span>` +
    pre +
    `</div>`
  );
};
