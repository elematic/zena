import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import * as assert from 'node:assert';

suite('Tuple Array Bug', () => {
  test('Array<[i32, i32]> should not create duplicate WASM types', async () => {
    const source = `
import { Array } from 'zena:growable-array';

export let main = (): i32 => {
  let chunks = new Array<[i32, i32]>();
  chunks.push([100, 50]);
  chunks.push([200, 75]);
  
  var totalLen = 0;
  for (var c = 0; c < chunks.length; c = c + 1) {
    let [ptr, len] = chunks[c];
    totalLen = totalLen + len;
  }
  
  return totalLen;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 125); // 50 + 75
  });

  test('Array<[Class, string]> should not create duplicate WASM types', async () => {
    const source = `
import { Array } from 'zena:growable-array';

class Descriptor {
  handle: i32;
  #new(h: i32) { this.handle = h; }
}

let makePreopens = (): Array<[Descriptor, string]> => {
  let result = new Array<[Descriptor, string]>();
  result.push([new Descriptor(1), '/tmp']);
  result.push([new Descriptor(2), '/data']);
  return result;
};

export let main = (): i32 => {
  let preopens = makePreopens();
  
  var sum = 0;
  for (var i = 0; i < preopens.length; i = i + 1) {
    let [desc, path] = preopens[i];
    sum = sum + desc.handle + path.length;
  }
  
  return sum;  // 1 + 4 + 2 + 5 = 12
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 12);
  });

  test('Array<RecordType> with enum field should not create duplicate WASM types', async () => {
    const source = `
import { Array } from 'zena:growable-array';

enum FileType {
  File,
  Directory,
}

type DirEntry = {
  name: string,
  fileType: FileType,
};

let readDir = (): Array<DirEntry> => {
  let entries = new Array<DirEntry>();
  entries.push({ name: 'file.txt', fileType: FileType.File });
  entries.push({ name: 'subdir', fileType: FileType.Directory });
  return entries;
};

export let main = (): i32 => {
  let entries = readDir();
  
  var dirCount = 0;
  for (var i = 0; i < entries.length; i = i + 1) {
    let entry = entries[i];
    if (entry.fileType == FileType.Directory) {
      dirCount = dirCount + 1;
    }
  }
  
  return dirCount;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('global variable with interface type should be boxed correctly', async () => {
    const source = `
interface Allocator {
  allocate(size: i32): i32;
}

class BumpAllocator implements Allocator {
  offset: i32;
  #new() { this.offset = 0; }
  allocate(size: i32): i32 {
    let result = this.offset;
    this.offset = this.offset + size;
    return result;
  }
}

let defaultAllocator = new BumpAllocator();

// Global variable with interface type initialized by class instance
let alloc: Allocator = defaultAllocator;

export let main = (): i32 => {
  let a = alloc.allocate(10);
  let b = alloc.allocate(20);
  let c = alloc.allocate(5);
  return a + b + c;  // 0 + 10 + 30 = 40
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 40);
  });
});
