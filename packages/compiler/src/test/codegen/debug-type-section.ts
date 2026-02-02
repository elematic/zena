import {compileToWasm} from './utils.js';
import {writeFileSync} from 'node:fs';

// Simple test
const source = `export let main = () => 42;`;
const wasm = compileToWasm(source, '/main.zena', {dce: false});

writeFileSync('/tmp/test-order.wasm', wasm);

// Parse type section
let pos = 8; // Skip magic and version
while (pos < wasm.length) {
  const sectionId = wasm[pos++];
  const sectionSize = wasm[pos++]; // Assuming small size
  
  if (sectionId === 1) {
    console.log('Type section found at offset', pos - 2);
    console.log('Section size:', sectionSize);
    
    const typeCount = wasm[pos++];
    console.log('Type count:', typeCount);
    
    let typeIdx = 0;
    for (let i = 0; i < typeCount; i++) {
      const byte = wasm[pos];
      console.log(`Entry ${i} at offset ${pos}: 0x${byte.toString(16)}`);
      
      if (byte === 0x4e) {
        // rec
        pos++;
        const recCount = wasm[pos++];
        console.log(`  rec block with ${recCount} types (type indices ${typeIdx} to ${typeIdx + recCount - 1})`);
        typeIdx += recCount;
        // Skip the types
        for (let j = 0; j < recCount; j++) {
          while (pos < wasm.length && wasm[pos] !== 0x60 && wasm[pos] !== 0x5f && wasm[pos] !== 0x5e) {
            pos++;
          }
          if (wasm[pos] === 0x60) {
            // func type
            pos++;
            const paramCount = wasm[pos++];
            pos += paramCount;
            const resultCount = wasm[pos++];
            pos += resultCount;
          }
        }
      } else {
        // Plain type
        console.log(`  plain type (index ${typeIdx})`);
        typeIdx++;
      }
    }
    break;
  } else {
    pos += sectionSize;
  }
}

console.log('\nTotal WASM size:', wasm.length);
