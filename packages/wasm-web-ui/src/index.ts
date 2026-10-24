/**
 * The Wasm Web UI host. The protocol is in docs/design/wasm-web-ui.md.
 *
 * A page instantiates a module itself, with `webUiImports()` spread into
 * the import object beside the imports of the module's own runtime, and
 * then reads the module through its exports: `TemplateHost` renders the
 * template results it returns, and `ElementModule` reads the element
 * definitions it exports and derives an `HTMLElement` class from each
 * one the page registers.
 */
export * from './templates.js';
export * from './elements.js';
export * from './linear.js';
