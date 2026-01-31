import {test} from 'node:test';
import {compileToWasm} from './utils.js';
import fs from 'fs';

test('dump WAT for minimal and string programs', async () => {
  // Minimal program
  const minimal = 'export let main = () => 42;';
  const minimalWasm = compileToWasm(minimal, '/main.zena', {dce: true});
  fs.writeFileSync('/tmp/minimal.wasm', minimalWasm);
  console.log('\n=== Minimal program (', minimalWasm.length, 'bytes) ===');
  console.log('Written to /tmp/minimal.wasm');
  console.log('Run: wasm-tools print /tmp/minimal.wasm\n');

  // String program
  const withString = 'export let main = () => "hello";';
  const stringWasm = compileToWasm(withString, '/main.zena', {dce: true});
  fs.writeFileSync('/tmp/string.wasm', stringWasm);
  console.log('\n=== String program (', stringWasm.length, 'bytes) ===');
  console.log('Written to /tmp/string.wasm');
  console.log('Run: wasm-tools print /tmp/string.wasm\n');
});
