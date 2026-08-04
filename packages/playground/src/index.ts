/**
 * An embeddable Zena playground.
 *
 * Importing this module registers `<zena-playground>`, along with the
 * CodeMirror elements it renders.
 */

export {ZenaPlayground} from './zena-playground.js';
export {default as STDLIB_FILES} from './stdlib-data.json' with {type: 'json'};
export type {
  CompletionItem,
  ConsoleEntry,
  ConsoleLevel,
  Diagnostic,
  HoverInfo,
  WorkerRequest,
  WorkerResponse,
} from './types.js';
