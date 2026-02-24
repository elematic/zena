import {WasmModule} from '../../lib/emitter.js';
import {writeFileSync} from 'node:fs';
import {ValType} from '../../lib/wasm.js';

// Create a minimal WASM module with a simple function
const module = new WasmModule();

// Add a function type: () -> i32
const funcType = module.addType([], [[ValType.i32]]);

// Add the function
const funcIndex = module.addFunction(funcType);

// Add code for the function: just return 42
module.addCode(
  funcIndex,
  [],
  [
    0x41,
    0x2a, // i32.const 42
    0x0b, // end
  ],
);

// Export the function
module.addExport('main', 0, funcIndex);

// Generate the WASM
const bytes = module.toBytes();
writeFileSync('/tmp/minimal.wasm', bytes);
console.log('Generated minimal WASM with', bytes.length, 'bytes');
console.log(
  'First 50 bytes:',
  Array.from(bytes.slice(0, 50))
    .map((b) => '0x' + b.toString(16).padStart(2, '0'))
    .join(' '),
);
