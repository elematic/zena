import {compileToWasm} from './utils.js';
import {writeFileSync} from 'node:fs';

// Test minimal program
const source = `export let main = () => 42;`;
try {
  const wasm = compileToWasm(source, '/main.zena', {dce: false});
  writeFileSync('/tmp/test.wasm', wasm);
  console.log('WASM compiled successfully, wrote to /tmp/test.wasm');
  console.log('WASM size:', wasm.length);
} catch (e) {
  console.error('Error:', e);
}
