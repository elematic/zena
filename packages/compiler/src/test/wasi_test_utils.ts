import {WASIShim} from '@bytecodealliance/preview2-shim/instantiation';
import type {OutputStream} from '@bytecodealliance/preview2-shim/interfaces/wasi-io-streams';

export function createWasiImports() {
  const shim = new WASIShim();
  const shimImports = shim.getImportObject();
  const resources = new Map<number, unknown>();
  let nextHandle = 1;

  let memory: WebAssembly.Memory | undefined;
  const output: string[] = [];

  const imports = {
    'wasi:cli/stdout': {
      'get-stdout': () => {
        const stream =
          shimImports['wasi:cli/stdout' as 'wasi:cli/stdout@'].getStdout();
        // Spy on blockingWriteAndFlush
        const originalWrite = stream.blockingWriteAndFlush.bind(stream);
        stream.blockingWriteAndFlush = (buffer: Uint8Array) => {
          const text = new TextDecoder().decode(buffer);
          output.push(text);
          originalWrite(buffer);
        };
        const handle = nextHandle++;
        resources.set(handle, stream);
        return handle;
      },
    },
    'wasi:io/streams': {
      '[method]output-stream.blocking-write-and-flush': (
        handle: number,
        ptr: number,
        len: number,
      ) => {
        if (memory === undefined) {
          throw new Error('Memory not initialized');
        }
        const stream = resources.get(handle) as OutputStream | undefined;
        if (stream === undefined) {
          throw new Error('Invalid handle');
        }

        const buffer = new Uint8Array(memory.buffer, ptr, len);
        // The shim expects a Uint8Array.
        stream.blockingWriteAndFlush(buffer);
      },
    },
  };

  return {
    imports,
    setMemory: (m: WebAssembly.Memory) => {
      memory = m;
    },
    output,
  };
}
