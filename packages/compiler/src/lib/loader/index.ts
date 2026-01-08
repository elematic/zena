/**
 * Library loading and resolution for the Zena compiler.
 *
 * In Zena, individual .zena files are called "libraries" (not "modules") to avoid
 * confusion with WASM modules.
 *
 * @module
 */
export {
  type LibraryRecord,
  type LibraryGraph,
  type LibraryLoaderOptions,
  LibraryLoader,
} from './library-loader.js';
