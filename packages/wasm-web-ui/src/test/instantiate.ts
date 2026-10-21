/**
 * Instantiates a compiled js-target Zena module the way a page does: a
 * plain `WebAssembly.instantiate`, with the Zena runtime's imports and
 * the protocol's merged into one import object. Imported after `./dom.js`,
 * because lit-html reads `document` when it loads.
 */
import {createImports, compileOptions} from '@zena-lang/runtime';
import {webUiImports, type WebUiImportOptions} from '../index.js';

export const instantiateModule = async (
  bytes: Uint8Array,
  options: WebUiImportOptions = {},
): Promise<{module: WebAssembly.Module; instance: WebAssembly.Instance}> => {
  const zena = createImports();
  const module = await WebAssembly.compile(
    bytes as Uint8Array<ArrayBuffer>,
    compileOptions,
  );
  const instance = await WebAssembly.instantiate(module, {
    ...zena.imports,
    ...webUiImports(options),
  });
  zena.attach(instance.exports);
  return {module, instance};
};
