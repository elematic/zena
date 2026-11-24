/**
 * Minimal runtime parser for WebAssembly Component Model binaries.
 *
 * Extracts embedded core Wasm modules (component section id 1) from an
 * unmodified `.wasm` component produced by `zena build --target component`
 * (or any other Component Model toolchain), and classifies the runtime memory
 * module (`zena:runtime`) and the application core module.
 */

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const COMPONENT_LAYER = 0x01;
const SECTION_CORE_MODULE = 1;

/**
 * Read an unsigned LEB128 integer from `bytes` starting at `offset`.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {{value: number, offset: number}}
 */
const readUleb128 = (bytes, offset) => {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return {value: value >>> 0, offset};
    }
    shift += 7;
    if (shift > 35) {
      throw new Error('Malformed LEB128 in WebAssembly component');
    }
  }
  throw new Error('Unexpected EOF reading LEB128 in WebAssembly component');
};

/**
 * Check whether `bytes` is a WebAssembly Component Model binary (as opposed to
 * a core Wasm module).
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export const isWasmComponent = (bytes) =>
  bytes.length >= 8 &&
  bytes[0] === WASM_MAGIC[0] &&
  bytes[1] === WASM_MAGIC[1] &&
  bytes[2] === WASM_MAGIC[2] &&
  bytes[3] === WASM_MAGIC[3] &&
  bytes[6] === COMPONENT_LAYER &&
  bytes[7] === 0x00;

/**
 * Extract all embedded core Wasm modules (section id 1) in order from a
 * Component Model binary.
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {Uint8Array[]}
 */
export const extractCoreModules = (input) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isWasmComponent(bytes)) {
    throw new Error(
      'Expected a WebAssembly Component binary (layer 0x01), not a core module',
    );
  }
  /** @type {Uint8Array[]} */
  const modules = [];
  let offset = 8;
  while (offset < bytes.length) {
    const sectionId = bytes[offset++];
    const sizeRead = readUleb128(bytes, offset);
    offset = sizeRead.offset;
    const end = offset + sizeRead.value;
    if (end > bytes.length) {
      throw new Error(
        `Component section ${sectionId} extends past EOF (${end} > ${bytes.length})`,
      );
    }
    if (sectionId === SECTION_CORE_MODULE) {
      modules.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  return modules;
};

/**
 * Compile the embedded core modules of a ZenaFX component and identify:
 * - `runtimeModule`: optional `zena:runtime` core module exporting `memory` and `realloc`
 * - `appModule`: the main component core module
 * - `entryExport`: the async/sync entry export name on `appModule`
 * - `callbackExport`: the Component Model Async callback export name (if async)
 *
 * @param {Uint8Array | ArrayBuffer} componentBytes
 */
export const parseZenaFxComponent = async (componentBytes) => {
  const rawModules = extractCoreModules(componentBytes);
  if (rawModules.length === 0) {
    throw new Error('Component contains no embedded core Wasm modules');
  }

  const compiled = await Promise.all(
    rawModules.map((m) => WebAssembly.compile(m)),
  );

  /** @type {WebAssembly.Module | null} */
  let runtimeModule = null;
  /** @type {WebAssembly.Module | null} */
  let appModule = null;

  for (const mod of compiled) {
    const exports = WebAssembly.Module.exports(mod);
    const exportNames = new Set(exports.map((e) => e.name));
    const hasMemoryAndRealloc =
      exportNames.has('memory') && exportNames.has('realloc');
    const imports = WebAssembly.Module.imports(mod);
    if (hasMemoryAndRealloc && imports.length === 0 && runtimeModule === null) {
      runtimeModule = mod;
    } else {
      appModule = mod;
    }
  }

  if (appModule === null) {
    appModule = compiled[compiled.length - 1];
  }

  const appExports = WebAssembly.Module.exports(appModule);
  const exportNames = appExports.map((e) => e.name);

  // Locate the component entry point and async callback export.
  const entryExport =
    exportNames.find((n) => n === 'main_export$componentRun') ??
    exportNames.find((n) => n === '__zena_component_run') ??
    exportNames.find((n) => n.endsWith('$componentRun')) ??
    exportNames.find((n) => n === 'main' || n === 'start' || n === 'run') ??
    null;

  const callbackExport =
    exportNames.find((n) => n === '__zena_component_callback') ?? null;

  if (entryExport === null) {
    throw new Error(
      `Could not find component entry export. Exports: ${exportNames.join(', ')}`,
    );
  }

  return {
    runtimeModule,
    appModule,
    appImports: WebAssembly.Module.imports(appModule),
    entryExport,
    callbackExport,
  };
};
