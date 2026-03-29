/**
 * Regression test for: checkDeclareFunction not including `declaration`
 * in module export records.
 *
 * When a `declare function` with @intrinsic('eq') is exported, imported
 * by another module, and called with a type parameter, DCE usage analysis
 * must detect the intrinsic via its ResolvedBinding and conservatively
 * keep String.operator==. Without the declaration in the export, no
 * binding is created, the intrinsic is invisible to DCE, and String.==
 * is eliminated — producing an invalid function index in the WASM binary.
 */
import {suite, test} from 'node:test';
import {compileToWasm} from './utils.js';

suite('DeclareFunction export DCE', () => {
  test('imported @intrinsic eq preserves String.== under DCE', async () => {
    // This calls equals() from zena:hashable (a declare function with
    // @intrinsic('eq')) on string keys inside HashMap. Without the fix,
    // DCE eliminates String.== and the binary has an out-of-bounds call.
    const source = `
      import {HashMap} from 'zena:map';

      export let main = (): i32 => {
        let m = new HashMap<string, i32>();
        m['hello'] = 1;
        m['world'] = 2;
        return 0;
      };
    `;

    const bytes = compileToWasm(source, '/main.zena', {dce: true});
    // The critical assertion: WebAssembly.compile rejects binaries with
    // out-of-bounds function indices.
    await WebAssembly.compile(bytes.buffer as ArrayBuffer);
  });
});
