import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';
import {createWasiFsImports, mockDir, mockFile} from '../wasi_fs_test_utils.js';

suite('CodeGenerator - WASI Filesystem', () => {
  test('should read a file using low-level WASI bindings', async () => {
    // This test demonstrates reading a file using raw WASI bindings.
    // Since Zena doesn't have String.fromCharCode, we return the raw bytes
    // to linear memory and verify them in the TypeScript harness.
    const input = `
      // Memory intrinsics
      @intrinsic("i32.store8")
      declare function store8(ptr: i32, value: i32): void;

      @intrinsic("i32.load8_u")
      declare function load8(ptr: i32): i32;

      @intrinsic("i32.store")
      declare function store32(ptr: i32, value: i32): void;

      @intrinsic("i32.load")
      declare function load32(ptr: i32): i32;

      // WASI filesystem bindings
      @external("wasi:filesystem/preopens", "get-directories")
      declare function wasiGetDirectories(retPtr: i32): void;

      @external("wasi:filesystem/types", "[method]descriptor.open-at")
      declare function wasiOpenAt(
        handle: i32,
        pathFlags: i32,
        pathPtr: i32,
        pathLen: i32,
        openFlags: i32,
        descFlags: i32
      ): i32;

      @external("wasi:filesystem/types", "[method]descriptor.read")
      declare function wasiRead(
        handle: i32,
        length: i64,
        offset: i64,
        retPtr: i32
      ): void;

      // Simple allocator - heap starts at offset 256
      var heapPtr: i32 = 256;

      let alloc = (size: i32): i32 => {
        let ptr = heapPtr;
        heapPtr = heapPtr + size;
        return ptr;
      };

      // Copy string to linear memory
      let stringToMem = (s: string): [i32, i32] => {
        let len = s.length;
        let ptr = alloc(len);
        for (var i = 0; i < len; i = i + 1) {
          store8(ptr + i, s.getByteAt(i));
        }
        return [ptr, len];
      };

      // Read a file and return [dataPtr, dataLen] for inspection
      // Returns [-1, errorCode] on error
      export let readFileToMemory = (path: string): inline (i32, i32) => {
        // Get preopened directories
        let preopensPtr = alloc(16);
        wasiGetDirectories(preopensPtr);
        
        // Get first preopen (root directory)
        let listPtr = load32(preopensPtr);
        let rootHandle = load32(listPtr);  // First entry's handle
        
        // Open the file
        let [pathPtr, pathLen] = stringToMem(path);
        let fileHandle = wasiOpenAt(
          rootHandle,
          1,        // path flags: follow symlinks
          pathPtr,
          pathLen,
          0,        // open flags: none
          1         // desc flags: read
        );
        
        if (fileHandle < 0) {
          return (-1, fileHandle);  // Error: could not open
        }
        
        // Read file contents
        let readRetPtr = alloc(32);
        wasiRead(fileHandle, 4096 as i64, 0 as i64, readRetPtr);
        
        let dataLen = load32(readRetPtr);
        let errorCode = load32(readRetPtr + 8);
        
        if (errorCode != 0) {
          return (-1, errorCode);  // Error: read failed
        }
        
        // Data is written to buffer after retPtr
        let dataPtr = readRetPtr + 16;
        return (dataPtr, dataLen);
      };

      // Test function that reads hello.txt
      export let main = (): inline (i32, i32) => {
        return readFileToMemory("hello.txt");
      };
    `;

    // Create mock filesystem with a test file
    const mockFs = mockDir({
      'hello.txt': mockFile('Hello from WASI filesystem!'),
      subdir: mockDir({
        'nested.txt': mockFile('Nested file content'),
      }),
    });

    const {imports: fsImports, setMemory} = createWasiFsImports(mockFs);

    const exports = await compileAndInstantiate(input, {
      imports: fsImports,
    });

    setMemory(exports.memory);

    // Run main() which reads hello.txt and returns [ptr, len]
    // WASM multi-value returns come back as an array
    const [ptr, len] = exports.main() as [number, number];

    assert.ok(ptr >= 0, `Expected valid pointer, got error code: ${len}`);

    // Read the content from linear memory
    const memory = new Uint8Array(exports.memory.buffer);
    const content = new TextDecoder().decode(memory.slice(ptr, ptr + len));

    assert.strictEqual(content, 'Hello from WASI filesystem!');
  });

  test('should write to a file using low-level WASI bindings', async () => {
    const input = `
      // Memory intrinsics
      @intrinsic("i32.store8")
      declare function store8(ptr: i32, value: i32): void;

      @intrinsic("i32.load")
      declare function load32(ptr: i32): i32;

      // WASI filesystem bindings
      @external("wasi:filesystem/preopens", "get-directories")
      declare function wasiGetDirectories(retPtr: i32): void;

      @external("wasi:filesystem/types", "[method]descriptor.open-at")
      declare function wasiOpenAt(
        handle: i32,
        pathFlags: i32,
        pathPtr: i32,
        pathLen: i32,
        openFlags: i32,
        descFlags: i32
      ): i32;

      @external("wasi:filesystem/types", "[method]descriptor.write")
      declare function wasiWrite(
        handle: i32,
        bufferPtr: i32,
        bufferLen: i32,
        offset: i64
      ): i64;

      // Simple allocator
      var heapPtr: i32 = 256;

      let alloc = (size: i32): i32 => {
        let ptr = heapPtr;
        heapPtr = heapPtr + size;
        return ptr;
      };

      // Copy string to linear memory
      let stringToMem = (s: string): [i32, i32] => {
        let len = s.length;
        let ptr = alloc(len);
        for (var i = 0; i < len; i = i + 1) {
          store8(ptr + i, s.getByteAt(i));
        }
        return [ptr, len];
      };

      // Write content to a file
      export let writeFile = (path: string, content: string): i32 => {
        // Get preopened directories
        let preopensPtr = alloc(16);
        wasiGetDirectories(preopensPtr);
        
        let listPtr = load32(preopensPtr);
        let rootHandle = load32(listPtr);
        
        // Open/create the file with CREATE | TRUNCATE flags
        let [pathPtr, pathLen] = stringToMem(path);
        let fileHandle = wasiOpenAt(
          rootHandle,
          1,        // path flags: follow symlinks
          pathPtr,
          pathLen,
          5,        // open flags: create (1) | truncate (4)
          2         // desc flags: write
        );
        
        if (fileHandle < 0) {
          return fileHandle;  // Return error code
        }
        
        // Write content
        let [dataPtr, dataLen] = stringToMem(content);
        let written = wasiWrite(fileHandle, dataPtr, dataLen, 0 as i64);
        
        return written as i32;
      };

      export let main = (): i32 => {
        return writeFile("output.txt", "Written by Zena!");
      };
    `;

    const mockFs = mockDir({});
    const {
      imports: fsImports,
      setMemory,
      getFileContent,
    } = createWasiFsImports(mockFs);

    const exports = await compileAndInstantiate(input, {
      imports: fsImports,
    });

    setMemory(exports.memory);

    // Run main() which writes to output.txt
    const bytesWritten = exports.main();

    assert.strictEqual(bytesWritten, 16); // "Written by Zena!" is 16 bytes
    assert.strictEqual(getFileContent('output.txt'), 'Written by Zena!');
  });

  test('should list directory contents', async () => {
    const input = `
      // Memory intrinsics
      @intrinsic("i32.load8_u")
      declare function load8(ptr: i32): i32;

      @intrinsic("i32.load")
      declare function load32(ptr: i32): i32;

      // WASI filesystem bindings
      @external("wasi:filesystem/preopens", "get-directories")
      declare function wasiGetDirectories(retPtr: i32): void;

      @external("wasi:filesystem/types", "[method]descriptor.read-directory")
      declare function wasiReadDirectory(handle: i32): i32;

      @external("wasi:filesystem/types", "[method]directory-entry-stream.read-directory-entry")
      declare function wasiReadDirEntry(handle: i32, retPtr: i32): void;

      @external("wasi:filesystem/types", "[resource-drop]directory-entry-stream")
      declare function wasiDropDirStream(handle: i32): void;

      var heapPtr: i32 = 256;

      let alloc = (size: i32): i32 => {
        let ptr = heapPtr;
        heapPtr = heapPtr + size;
        return ptr;
      };

      // Count files in the root directory
      export let countFiles = (): i32 => {
        // Get root preopen
        let preopensPtr = alloc(16);
        wasiGetDirectories(preopensPtr);
        let listPtr = load32(preopensPtr);
        let rootHandle = load32(listPtr);
        
        // Get directory stream
        let streamHandle = wasiReadDirectory(rootHandle);
        if (streamHandle < 0) {
          return -1;
        }
        
        var count = 0;
        let entryPtr = alloc(64);
        
        while (true) {
          wasiReadDirEntry(streamHandle, entryPtr);
          let hasEntry = load32(entryPtr);
          
          if (hasEntry == 0) {
            break;
          }
          
          count = count + 1;
        }
        
        wasiDropDirStream(streamHandle);
        return count;
      };

      // Get name of first file - returns [ptr, len] for TS to decode
      export let getFirstFileName = (): inline (i32, i32) => {
        let preopensPtr = alloc(16);
        wasiGetDirectories(preopensPtr);
        let listPtr = load32(preopensPtr);
        let rootHandle = load32(listPtr);
        
        let streamHandle = wasiReadDirectory(rootHandle);
        if (streamHandle < 0) {
          return (0, -1);  // Error indicator
        }
        
        let entryPtr = alloc(64);
        wasiReadDirEntry(streamHandle, entryPtr);
        
        let hasEntry = load32(entryPtr);
        if (hasEntry == 0) {
          return (0, 0);  // Empty indicator
        }
        
        let namePtr = load32(entryPtr + 12);
        let nameLen = load32(entryPtr + 16);
        
        wasiDropDirStream(streamHandle);
        return (namePtr, nameLen);
      };
    `;

    const mockFs = mockDir({
      'file1.txt': mockFile('content1'),
      'file2.txt': mockFile('content2'),
      'file3.txt': mockFile('content3'),
    });

    const {imports: fsImports, setMemory} = createWasiFsImports(mockFs);

    const exports = await compileAndInstantiate(input, {
      imports: fsImports,
    });

    setMemory(exports.memory);

    // Count files
    const count = exports.countFiles();
    assert.strictEqual(count, 3);

    // Get first file name (order may vary due to Map iteration)
    const [namePtr, nameLen] = exports.getFirstFileName();
    assert.ok(nameLen > 0, 'Expected a file name, got empty or error');

    // Read the name from linear memory
    const memory = new Uint8Array(exports.memory.buffer);
    let firstName = '';
    for (let i = 0; i < nameLen; i++) {
      firstName += String.fromCharCode(memory[namePtr + i]);
    }

    // Should be one of the files
    assert.ok(
      ['file1.txt', 'file2.txt', 'file3.txt'].includes(firstName),
      `Unexpected filename: ${firstName}`,
    );
  });

  test('should handle file not found error', async () => {
    const input = `
      @intrinsic("i32.store8")
      declare function store8(ptr: i32, value: i32): void;

      @intrinsic("i32.load")
      declare function load32(ptr: i32): i32;

      @external("wasi:filesystem/preopens", "get-directories")
      declare function wasiGetDirectories(retPtr: i32): void;

      @external("wasi:filesystem/types", "[method]descriptor.open-at")
      declare function wasiOpenAt(
        handle: i32,
        pathFlags: i32,
        pathPtr: i32,
        pathLen: i32,
        openFlags: i32,
        descFlags: i32
      ): i32;

      var heapPtr: i32 = 256;

      let alloc = (size: i32): i32 => {
        let ptr = heapPtr;
        heapPtr = heapPtr + size;
        return ptr;
      };

      let stringToMem = (s: string): [i32, i32] => {
        let len = s.length;
        let ptr = alloc(len);
        for (var i = 0; i < len; i = i + 1) {
          store8(ptr + i, s.getByteAt(i));
        }
        return [ptr, len];
      };

      // Try to open a non-existent file, return error code
      export let openNonExistent = (): i32 => {
        let preopensPtr = alloc(16);
        wasiGetDirectories(preopensPtr);
        let listPtr = load32(preopensPtr);
        let rootHandle = load32(listPtr);
        
        let [pathPtr, pathLen] = stringToMem("does-not-exist.txt");
        let result = wasiOpenAt(rootHandle, 1, pathPtr, pathLen, 0, 1);
        
        return result;
      };
    `;

    const mockFs = mockDir({});
    const {imports: fsImports, setMemory} = createWasiFsImports(mockFs);

    const exports = await compileAndInstantiate(input, {
      imports: fsImports,
    });

    setMemory(exports.memory);

    // Should return negative error code (NOENT = -28)
    const result = exports.openNonExistent();
    assert.ok(result < 0, `Expected negative error code, got ${result}`);
    assert.strictEqual(result, -28); // WASI_ERRNO_NOENT
  });
});
