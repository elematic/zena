import {parentPort} from 'node:worker_threads';
import {createCompiler, type ZenaCompiler} from '@zena-lang/compiler';

if (!parentPort) {
  throw new Error('compiler-worker must run inside node:worker_threads');
}
const port = parentPort;

export type WorkerRequest =
  | {
      kind: 'init';
      id: number;
      wasm: Uint8Array;
      stdlibRoot: string;
      target: string;
      workspaceRoot: string | undefined;
      packageCache: string | undefined;
    }
  | {
      kind: 'call';
      id: number;
      method:
        | 'check'
        | 'lint'
        | 'definition'
        | 'hover'
        | 'completions'
        | 'documentSymbols'
        | 'format'
        | 'openDocument'
        | 'closeDocument';
      args: unknown[];
    }
  | {
      kind: 'fsResult';
      id: number;
      value: string | string[] | undefined;
    };

export type WorkerMessage =
  | {kind: 'result'; id: number; value: unknown}
  | {kind: 'error'; id: number; message: string}
  | {kind: 'fs'; id: number; op: 'readFile' | 'listDir'; path: string}
  | {kind: 'log'; level: 'log' | 'warn' | 'error'; msg: string};

let compiler: ZenaCompiler | undefined;
let nextFsId = 1;
const pendingFs = new Map<number, (val: unknown) => void>();
let callQueue: Promise<void> = Promise.resolve();

function requestFs<T>(op: 'readFile' | 'listDir', path: string): Promise<T> {
  const id = nextFsId++;
  return new Promise<T>((resolve) => {
    pendingFs.set(id, resolve as (val: unknown) => void);
    port.postMessage({kind: 'fs', id, op, path} satisfies WorkerMessage);
  });
}

port.on('message', (msg: WorkerRequest) => {
  if (msg.kind === 'fsResult') {
    const resolve = pendingFs.get(msg.id);
    if (resolve !== undefined) {
      pendingFs.delete(msg.id);
      resolve(msg.value);
    }
    return;
  }

  // Serialize compiler operations in FIFO order while keeping `fsResult`
  // handling unblocked so an in-flight `check` awaiting `readFile` settles
  // completely before queued `hover`/`definition`/`lint` queries run.
  callQueue = callQueue.then(() => handleOperation(msg));
});

async function handleOperation(
  msg: Exclude<WorkerRequest, {kind: 'fsResult'}>,
): Promise<void> {
  if (msg.kind === 'init') {
    try {
      compiler = await createCompiler({
        wasm: msg.wasm,
        stdlibRoot: msg.stdlibRoot,
        stdlibUrl: null,
        target: msg.target,
        workspaceRoot: msg.workspaceRoot,
        packageCache: msg.packageCache,
        console: {
          log: (m) =>
            port.postMessage({
              kind: 'log',
              level: 'log',
              msg: m,
            } satisfies WorkerMessage),
          warn: (m) =>
            port.postMessage({
              kind: 'log',
              level: 'warn',
              msg: m,
            } satisfies WorkerMessage),
          error: (m) =>
            port.postMessage({
              kind: 'log',
              level: 'error',
              msg: m,
            } satisfies WorkerMessage),
        },
        readFile: (rawPath) =>
          requestFs<string | undefined>('readFile', rawPath),
        listDir: (rawPath) =>
          requestFs<string[] | undefined>('listDir', rawPath),
      });
      port.postMessage({
        kind: 'result',
        id: msg.id,
        value: true,
      } satisfies WorkerMessage);
    } catch (e) {
      const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
      port.postMessage({
        kind: 'error',
        id: msg.id,
        message,
      } satisfies WorkerMessage);
    }
    return;
  }

  if (msg.kind === 'call') {
    if (!compiler) {
      port.postMessage({
        kind: 'error',
        id: msg.id,
        message: 'Zena compiler worker is not initialized',
      } satisfies WorkerMessage);
      return;
    }
    try {
      let value: unknown;
      switch (msg.method) {
        case 'check':
          value = await compiler.check(
            msg.args[0] as string,
            msg.args[1] as string | undefined,
          );
          break;
        case 'lint':
          value = await compiler.lint(msg.args[0] as string);
          break;
        case 'definition':
          value = await compiler.definition(
            msg.args[0] as string,
            msg.args[1] as number,
            msg.args[2] as string | undefined,
          );
          break;
        case 'hover':
          value = await compiler.hover(
            msg.args[0] as string,
            msg.args[1] as number,
            msg.args[2] as string | undefined,
          );
          break;
        case 'completions':
          value = await compiler.completions(
            msg.args[0] as string,
            msg.args[1] as number,
            msg.args[2] as string | undefined,
          );
          break;
        case 'documentSymbols':
          value = await compiler.documentSymbols(
            msg.args[0] as string,
            msg.args[1] as string,
          );
          break;
        case 'format':
          value = compiler.format(msg.args[0] as string);
          break;
        case 'openDocument':
          compiler.openDocument(msg.args[0] as string, msg.args[1] as string);
          value = undefined;
          break;
        case 'closeDocument':
          compiler.closeDocument(msg.args[0] as string);
          value = undefined;
          break;
      }
      port.postMessage({
        kind: 'result',
        id: msg.id,
        value,
      } satisfies WorkerMessage);
    } catch (e) {
      const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
      port.postMessage({
        kind: 'error',
        id: msg.id,
        message,
      } satisfies WorkerMessage);
    }
  }
}
