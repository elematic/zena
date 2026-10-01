/**
 * An embeddable Zena playground.
 *
 * Importing this module registers `<zena-playground>`, `<zena-project>`,
 * `<zena-file-editor>`, `<zena-console>`, and `<zena-tab-bar>`.
 */

export {ZenaProject} from './zena-project.js';
export {ZenaPlayground} from './zena-playground.js';
export {ZenaFileEditor} from './zena-file-editor.js';
export {ZenaConsole} from './zena-console.js';
export {ZenaOutput} from './zena-output.js';
export {ZenaTabBar} from './zena-tab-bar.js';
export {ZenaCodeExportDialog} from './zena-code-export-dialog.js';
export {ZenaThemeSelector, THEME_OPTIONS} from './zena-theme-selector.js';
export {PlaygroundConnectedElement} from './connected-element.js';
export {unindent} from './util.js';
export {
  generateCodeSvg,
  exportCodeToPngBlob,
  copyCodeImageToClipboard,
  downloadCodeImage,
  THEMES,
  BACKGROUNDS,
  getAvailableThemes,
  getAvailableBackgrounds,
  type ExportCodeImageOptions,
  type ThemeInfo,
  type BackgroundInfo,
} from './zena-code-export.js';

export {default as STDLIB_FILES} from './stdlib-data.json' with {type: 'json'};
export type {
  CompletionItem,
  ConsoleEntry,
  ConsoleLevel,
  Diagnostic,
  HoverInfo,
  PlaygroundStatus,
  ProjectManifest,
  SampleFile,
  WorkerRequest,
  WorkerResponse,
} from './types.js';
