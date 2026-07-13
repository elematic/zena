import {compileToWasm} from './utils.js';
import {writeFileSync} from 'node:fs';

// Test minimal program
const source = `export let main = () => 42;`;
try {
  const wasm = compileToWasm(source, '/main.zena', {dce: false});
  const outUrl = new URL('./test.wasm', import.meta.url);
  writeFileSync(outUrl, wasm);
  console.log(`WASM compiled successfully, wrote to ${outUrl.pathname}`);
  console.log('WASM size:', wasm.length);
} catch (e) {
  console.error('Error:', e);
}
