/**
 * Zena language support for CodeMirror 6.
 *
 * Importing this module registers the `<cm-lang-zena>` and `<cm-hover-zena>`
 * custom elements, which plug into `<cm-editor>` from `codemirror-elements`,
 * and loads the themes re-exported below.
 */

export {
  CodeMirrorLangZena,
  CodeMirrorHoverZena,
  zenaLanguage,
  zena,
  type ZenaState,
  type ZenaHoverInfo,
  type ZenaHoverProvider,
} from './cm-lang-zena.js';
export * from './cm-themes.js';
