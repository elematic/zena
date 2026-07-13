import {test} from 'node:test';
import {compileToWasm} from './utils.js';
import fs from 'fs';

test('dump WAT for minimal and string programs', async () => {
  // Minimal program
  const minimal = 'export let main = () => 42;';
  const minimalWasm = compileToWasm(minimal, '/main.zena', {dce: true});
  const minimalUrl = new URL('./minimal.wasm', import.meta.url);
  fs.writeFileSync(minimalUrl, minimalWasm);
  console.log('\n=== Minimal program (', minimalWasm.length, 'bytes) ===');
  console.log(`Written to ${minimalUrl.pathname}`);
  console.log(`Run: wasm-tools print ${minimalUrl.pathname}\n`);

  // String program
  const withString = 'export let main = () => "hello";';
  const stringWasm = compileToWasm(withString, '/main.zena', {dce: true});
  const stringUrl = new URL('./string.wasm', import.meta.url);
  fs.writeFileSync(stringUrl, stringWasm);
  console.log('\n=== String program (', stringWasm.length, 'bytes) ===');
  console.log(`Written to ${stringUrl.pathname}`);
  console.log(`Run: wasm-tools print ${stringUrl.pathname}\n`);
});
