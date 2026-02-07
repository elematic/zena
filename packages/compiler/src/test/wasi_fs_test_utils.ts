// WASI Filesystem Test Utilities
// Provides mock filesystem imports for testing Zena's wasi:filesystem bindings
// in Node.js without needing a real WASI runtime.

/**
 * Mock file or directory entry in the virtual filesystem.
 */
export interface MockFsEntry {
  type: 'file' | 'directory';
  content?: Uint8Array; // Only for files
  children?: Map<string, MockFsEntry>; // Only for directories
}

/**
 * Create a mock file entry.
 */
export function mockFile(content: string | Uint8Array): MockFsEntry {
  const data =
    typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {type: 'file', content: data};
}

/**
 * Create a mock directory entry.
 */
export function mockDir(
  children: Record<string, MockFsEntry> = {},
): MockFsEntry {
  return {
    type: 'directory',
    children: new Map(Object.entries(children)),
  };
}

/**
 * Mock descriptor representing an open file or directory.
 */
interface MockDescriptor {
  entry: MockFsEntry;
  path: string;
  flags: number; // Descriptor flags (read, write, etc.)
}

/**
 * Mock directory entry stream for iterating directories.
 */
interface MockDirStream {
  entries: Array<[string, MockFsEntry]>;
  index: number;
}

// WASI error codes
const WASI_ERRNO = {
  SUCCESS: 0,
  ACCESS: -1,
  BADF: -6,
  EXIST: -12,
  NOENT: -28,
  ISDIR: -21,
  NOTDIR: -29,
  NOTEMPTY: -30,
  ROFS: -44,
  IO: -64,
};

/**
 * Creates WASI filesystem imports backed by a mock in-memory filesystem.
 *
 * @param rootFs - The root filesystem structure
 * @returns Import object and utilities for testing
 */
export function createWasiFsImports(rootFs: MockFsEntry) {
  // Ensure root is a directory
  if (rootFs.type !== 'directory') {
    throw new Error('Root filesystem must be a directory');
  }

  // Handle tables
  const descriptors = new Map<number, MockDescriptor>();
  const dirStreams = new Map<number, MockDirStream>();
  let nextDescriptorHandle = 3; // 0=stdin, 1=stdout, 2=stderr
  let nextStreamHandle = 1000;

  // Linear memory reference
  let memory: WebAssembly.Memory | undefined;

  // Preopen the root directory
  descriptors.set(3, {
    entry: rootFs,
    path: '/',
    flags: 0x0f, // read + write + mutate-directory
  });

  // Helper: resolve a path relative to a descriptor
  const resolvePath = (
    base: MockDescriptor,
    pathStr: string,
  ): MockFsEntry | null => {
    // Normalize path
    const parts = pathStr.split('/').filter((p) => p && p !== '.');

    let current: MockFsEntry = base.entry;

    for (const part of parts) {
      if (part === '..') {
        // Parent navigation - simplified, doesn't actually go up
        continue;
      }

      if (current.type !== 'directory' || !current.children) {
        return null;
      }

      const child = current.children.get(part);
      if (!child) {
        return null;
      }
      current = child;
    }

    return current;
  };

  // Helper: get parent directory and filename from path
  const getParentAndName = (
    base: MockDescriptor,
    pathStr: string,
  ): {parent: MockFsEntry; name: string} | null => {
    const parts = pathStr.split('/').filter((p) => p && p !== '.');
    if (parts.length === 0) return null;

    const name = parts.pop()!;
    let parent: MockFsEntry = base.entry;

    for (const part of parts) {
      if (parent.type !== 'directory' || !parent.children) {
        return null;
      }
      const child = parent.children.get(part);
      if (!child) return null;
      parent = child;
    }

    if (parent.type !== 'directory') return null;
    return {parent, name};
  };

  // Helper: read string from linear memory
  const readString = (ptr: number, len: number): string => {
    if (!memory) throw new Error('Memory not initialized');
    const bytes = new Uint8Array(memory.buffer, ptr, len);
    return new TextDecoder().decode(bytes);
  };

  // Helper: write to linear memory
  const writeMemory = (ptr: number, data: Uint8Array): void => {
    if (!memory) throw new Error('Memory not initialized');
    new Uint8Array(memory.buffer, ptr, data.length).set(data);
  };

  // Helper: write i32 to linear memory
  const writeI32 = (ptr: number, value: number): void => {
    if (!memory) throw new Error('Memory not initialized');
    new DataView(memory.buffer).setInt32(ptr, value, true);
  };

  // Helper: write i64 to linear memory
  const writeI64 = (ptr: number, value: bigint): void => {
    if (!memory) throw new Error('Memory not initialized');
    new DataView(memory.buffer).setBigInt64(ptr, value, true);
  };

  // Helper: convert file type to WASI type code
  const getFileTypeCode = (entry: MockFsEntry): number => {
    return entry.type === 'directory' ? 3 : 4; // 3=directory, 4=regular_file
  };

  const imports = {
    'wasi:filesystem/preopens': {
      'get-directories': (retPtr: number) => {
        // Write list of preopened directories
        // For simplicity, we allocate the list data right after retPtr
        const listPtr = retPtr + 16;
        const listLen = 1; // Just one preopen (root)

        // Write list header
        writeI32(retPtr, listPtr);
        writeI32(retPtr + 4, listLen);

        // Write preopen entry: (handle: i32, pathPtr: i32, pathLen: i32)
        writeI32(listPtr, 3); // handle for root
        const pathBytes = new TextEncoder().encode('/');
        const pathPtr = listPtr + 12;
        writeI32(listPtr + 4, pathPtr);
        writeI32(listPtr + 8, pathBytes.length);
        writeMemory(pathPtr, pathBytes);
      },
    },

    'wasi:filesystem/types': {
      '[method]descriptor.open-at': (
        handle: number,
        pathFlags: number,
        pathPtr: number,
        pathLen: number,
        openFlags: number,
        descFlags: number,
      ): number => {
        const base = descriptors.get(handle);
        if (!base) return WASI_ERRNO.BADF;

        const pathStr = readString(pathPtr, pathLen);
        const resolved = resolvePath(base, pathStr);

        // Handle create flag
        if (openFlags & 1) {
          // CREATE flag
          if (!resolved) {
            const pn = getParentAndName(base, pathStr);
            if (!pn) return WASI_ERRNO.NOENT;

            // Create new empty file
            const newFile: MockFsEntry = {
              type: 'file',
              content: new Uint8Array(),
            };
            pn.parent.children!.set(pn.name, newFile);

            const newHandle = nextDescriptorHandle++;
            descriptors.set(newHandle, {
              entry: newFile,
              path: pathStr,
              flags: descFlags,
            });
            return newHandle;
          }
        }

        if (!resolved) return WASI_ERRNO.NOENT;

        // Check directory flag
        if (openFlags & 2 && resolved.type !== 'directory') {
          // DIRECTORY flag
          return WASI_ERRNO.NOTDIR;
        }

        const newHandle = nextDescriptorHandle++;
        descriptors.set(newHandle, {
          entry: resolved,
          path: pathStr,
          flags: descFlags,
        });

        return newHandle;
      },

      '[method]descriptor.read': (
        handle: number,
        length: bigint,
        offset: bigint,
        retPtr: number,
      ): void => {
        const desc = descriptors.get(handle);
        if (!desc) {
          writeI32(retPtr, 0); // dataLen
          writeI32(retPtr + 4, 0); // eof
          writeI32(retPtr + 8, WASI_ERRNO.BADF);
          return;
        }

        if (desc.entry.type !== 'file' || !desc.entry.content) {
          writeI32(retPtr, 0);
          writeI32(retPtr + 4, 0);
          writeI32(retPtr + 8, WASI_ERRNO.ISDIR);
          return;
        }

        const content = desc.entry.content;
        const start = Number(offset);
        const end = Math.min(start + Number(length), content.length);
        const chunk = content.slice(start, end);
        const eof = end >= content.length ? 1 : 0;

        // Allocate buffer for chunk (after retPtr)
        const bufPtr = retPtr + 16;
        writeMemory(bufPtr, chunk);

        writeI32(retPtr, chunk.length); // dataLen
        writeI32(retPtr + 4, eof);
        writeI32(retPtr + 8, 0); // success
      },

      '[method]descriptor.write': (
        handle: number,
        bufferPtr: number,
        bufferLen: number,
        offset: bigint,
      ): bigint => {
        const desc = descriptors.get(handle);
        if (!desc) return BigInt(WASI_ERRNO.BADF);

        if (desc.entry.type !== 'file') {
          return BigInt(WASI_ERRNO.ISDIR);
        }

        if (!memory) throw new Error('Memory not initialized');
        const data = new Uint8Array(memory.buffer, bufferPtr, bufferLen);

        // Grow file if needed
        const writeEnd = Number(offset) + data.length;
        const currentContent = desc.entry.content || new Uint8Array();

        if (writeEnd > currentContent.length) {
          const newContent = new Uint8Array(writeEnd);
          newContent.set(currentContent);
          desc.entry.content = newContent;
        }

        // Write data
        desc.entry.content!.set(data, Number(offset));

        return BigInt(data.length);
      },

      '[method]descriptor.stat': (handle: number, retPtr: number): void => {
        const desc = descriptors.get(handle);
        if (!desc) {
          writeI32(retPtr, WASI_ERRNO.BADF);
          return;
        }

        writeI32(retPtr, 0); // success
        writeI32(retPtr + 4, getFileTypeCode(desc.entry));
        writeI64(
          retPtr + 8,
          BigInt(
            desc.entry.type === 'file' ? (desc.entry.content?.length ?? 0) : 0,
          ),
        );
      },

      '[method]descriptor.stat-at': (
        handle: number,
        pathFlags: number,
        pathPtr: number,
        pathLen: number,
        retPtr: number,
      ): void => {
        const base = descriptors.get(handle);
        if (!base) {
          writeI32(retPtr, WASI_ERRNO.BADF);
          return;
        }

        const pathStr = readString(pathPtr, pathLen);
        const resolved = resolvePath(base, pathStr);

        if (!resolved) {
          writeI32(retPtr, WASI_ERRNO.NOENT);
          return;
        }

        writeI32(retPtr, 0); // success
        writeI32(retPtr + 4, getFileTypeCode(resolved));
        writeI64(
          retPtr + 8,
          BigInt(
            resolved.type === 'file' ? (resolved.content?.length ?? 0) : 0,
          ),
        );
      },

      '[method]descriptor.read-directory': (handle: number): number => {
        const desc = descriptors.get(handle);
        if (!desc) return WASI_ERRNO.BADF;

        if (desc.entry.type !== 'directory' || !desc.entry.children) {
          return WASI_ERRNO.NOTDIR;
        }

        const streamHandle = nextStreamHandle++;
        dirStreams.set(streamHandle, {
          entries: Array.from(desc.entry.children.entries()),
          index: 0,
        });

        return streamHandle;
      },

      '[method]descriptor.create-directory-at': (
        handle: number,
        pathPtr: number,
        pathLen: number,
      ): number => {
        const base = descriptors.get(handle);
        if (!base) return WASI_ERRNO.BADF;

        const pathStr = readString(pathPtr, pathLen);
        const pn = getParentAndName(base, pathStr);
        if (!pn) return WASI_ERRNO.NOENT;

        if (pn.parent.children!.has(pn.name)) {
          return WASI_ERRNO.EXIST;
        }

        pn.parent.children!.set(pn.name, mockDir());
        return 0;
      },

      '[method]descriptor.unlink-file-at': (
        handle: number,
        pathPtr: number,
        pathLen: number,
      ): number => {
        const base = descriptors.get(handle);
        if (!base) return WASI_ERRNO.BADF;

        const pathStr = readString(pathPtr, pathLen);
        const pn = getParentAndName(base, pathStr);
        if (!pn) return WASI_ERRNO.NOENT;

        const entry = pn.parent.children!.get(pn.name);
        if (!entry) return WASI_ERRNO.NOENT;
        if (entry.type === 'directory') return WASI_ERRNO.ISDIR;

        pn.parent.children!.delete(pn.name);
        return 0;
      },

      '[method]descriptor.remove-directory-at': (
        handle: number,
        pathPtr: number,
        pathLen: number,
      ): number => {
        const base = descriptors.get(handle);
        if (!base) return WASI_ERRNO.BADF;

        const pathStr = readString(pathPtr, pathLen);
        const pn = getParentAndName(base, pathStr);
        if (!pn) return WASI_ERRNO.NOENT;

        const entry = pn.parent.children!.get(pn.name);
        if (!entry) return WASI_ERRNO.NOENT;
        if (entry.type !== 'directory') return WASI_ERRNO.NOTDIR;
        if (entry.children && entry.children.size > 0) {
          return WASI_ERRNO.NOTEMPTY;
        }

        pn.parent.children!.delete(pn.name);
        return 0;
      },

      '[method]directory-entry-stream.read-directory-entry': (
        handle: number,
        retPtr: number,
      ): void => {
        const stream = dirStreams.get(handle);
        if (!stream) {
          writeI32(retPtr, 0); // hasEntry = false
          writeI32(retPtr + 4, WASI_ERRNO.BADF);
          return;
        }

        if (stream.index >= stream.entries.length) {
          writeI32(retPtr, 0); // hasEntry = false
          writeI32(retPtr + 4, 0); // success
          return;
        }

        const [name, entry] = stream.entries[stream.index++];
        const nameBytes = new TextEncoder().encode(name);
        const namePtr = retPtr + 24;

        writeI32(retPtr, 1); // hasEntry = true
        writeI32(retPtr + 4, 0); // success
        writeI32(retPtr + 8, getFileTypeCode(entry));
        writeI32(retPtr + 12, namePtr);
        writeI32(retPtr + 16, nameBytes.length);
        writeMemory(namePtr, nameBytes);
      },

      '[resource-drop]descriptor': (handle: number): void => {
        descriptors.delete(handle);
      },

      '[resource-drop]directory-entry-stream': (handle: number): void => {
        dirStreams.delete(handle);
      },
    },
  };

  return {
    imports,
    setMemory: (m: WebAssembly.Memory) => {
      memory = m;
    },
    // Utilities for test assertions
    getFileContent: (path: string): string | null => {
      const parts = path.split('/').filter((p) => p);
      let current: MockFsEntry = rootFs;

      for (const part of parts) {
        if (current.type !== 'directory' || !current.children) return null;
        const child = current.children.get(part);
        if (!child) return null;
        current = child;
      }

      if (current.type !== 'file' || !current.content) return null;
      return new TextDecoder().decode(current.content);
    },
    fileExists: (path: string): boolean => {
      const parts = path.split('/').filter((p) => p);
      let current: MockFsEntry = rootFs;

      for (const part of parts) {
        if (current.type !== 'directory' || !current.children) return false;
        const child = current.children.get(part);
        if (!child) return false;
        current = child;
      }

      return true;
    },
  };
}
