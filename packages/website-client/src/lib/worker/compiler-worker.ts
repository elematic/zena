import {
  createStringReader,
  createStringWriter,
  createConsoleImports,
} from '@zena-lang/runtime';
import stdlibJson from '../stdlib-data.json' with {type: 'json'};
import type {
  PlaygroundDiagnostic,
  WorkerRequest,
  WorkerResponse,
} from '../types.js';

const STDLIB_FILES: Record<string, string> = stdlibJson as Record<
  string,
  string
>;

interface LspExports extends WebAssembly.Exports {
  init(stdlibRoot: unknown): void;
  check(path: unknown, source: unknown): unknown;
  compileToWasm(path: unknown, source: unknown): unknown;
  getByteArrayLength(bytes: unknown): number;
  getByteArrayByte(bytes: unknown, index: number): number;
  getDiagnosticCount(diagnostics: unknown): number;
  getDiagnosticLine(diagnostics: unknown, index: number): number;
  getDiagnosticColumn(diagnostics: unknown, index: number): number;
  getDiagnosticStart(diagnostics: unknown, index: number): number;
  getDiagnosticLength(diagnostics: unknown, index: number): number;
  getDiagnosticSeverity(diagnostics: unknown, index: number): number;
  getDiagnosticMessage(diagnostics: unknown, index: number): unknown;
  getDiagnosticFile(diagnostics: unknown, index: number): unknown;
  getHover(path: unknown, offset: number): unknown;
  getHoverType(hover: unknown): unknown;
  getHoverLabel(hover: unknown): unknown;
  getHoverDoc(hover: unknown): unknown;
  $stringGetByte(str: unknown, index: number): number;
  $stringGetLength(str: unknown): number;
  $stringCreate(len: number): unknown;
  $stringSetByte(str: unknown, index: number, value: number): void;
  [key: string]: any;
}

const openDocuments = new Map<string, string>();
let exports: LspExports | undefined;
let writeString: ((s: string) => unknown) | undefined;
let readString: ((ref: unknown, len: number) => string) | undefined;

function sendLog(level: 'log' | 'warn' | 'error' | 'info', message: string) {
  self.postMessage({type: 'console', level, message} as WorkerResponse);
}

function handleReadFile(pathRef: unknown, pathLen: number): unknown {
  if (!readString || !writeString) return null;
  const rawPath = readString(pathRef, pathLen);

  if (openDocuments.has(rawPath)) {
    return writeString(openDocuments.get(rawPath)!);
  }

  const normalizedPath =
    rawPath.startsWith('/') || rawPath.startsWith('zena:')
      ? rawPath
      : '/' + rawPath;

  if (openDocuments.has(normalizedPath)) {
    return writeString(openDocuments.get(normalizedPath)!);
  }

  const candidates = [
    rawPath,
    normalizedPath,
    rawPath + '.zena',
    normalizedPath + '.zena',
  ];

  if (rawPath.startsWith('zena:')) {
    const sub = rawPath.slice(5);
    candidates.push(`/stdlib/${sub}`);
    candidates.push(`/stdlib/${sub}.zena`);
    if (!sub.endsWith('.zena')) {
      candidates.push(`/stdlib/${sub}/index.zena`);
      candidates.push(`/stdlib/${sub}/host.zena`);
    }
  }

  for (const key of candidates) {
    if (STDLIB_FILES[key]) {
      return writeString(STDLIB_FILES[key]);
    }
  }

  // Search by basename fallback (e.g., string.zena)
  const filename = normalizedPath.split('/').pop();
  if (filename) {
    const stdlibKey = `/stdlib/${filename.endsWith('.zena') ? filename : filename + '.zena'}`;
    if (STDLIB_FILES[stdlibKey]) {
      return writeString(STDLIB_FILES[stdlibKey]);
    }
  }

  console.warn(
    '[Zena Compiler Worker] Host read_file file not found, returning empty for:',
    rawPath,
  );
  return writeString('');
}

console.log('[Zena Compiler Worker] Worker script loaded and initializing.');

async function initializeCompiler(
  wasmBytesOrUrl: ArrayBuffer | string,
): Promise<void> {
  console.log(
    '[Zena Compiler Worker] Initializing compiler. Source:',
    typeof wasmBytesOrUrl === 'string' ? wasmBytesOrUrl : 'ArrayBuffer',
  );
  let wasmBuffer: ArrayBuffer;
  if (typeof wasmBytesOrUrl === 'string') {
    console.log(
      '[Zena Compiler Worker] Fetching WASM binary from URL:',
      wasmBytesOrUrl,
    );
    const res = await fetch(wasmBytesOrUrl);
    console.log(
      `[Zena Compiler Worker] Fetch response status: ${res.status} ${res.statusText}`,
    );
    if (!res.ok) {
      const errorMsg = `HTTP Error ${res.status} (${res.statusText}) while fetching WASM from ${wasmBytesOrUrl}`;
      console.error('[Zena Compiler Worker]', errorMsg);
      throw new Error(errorMsg);
    }
    wasmBuffer = await res.arrayBuffer();
    console.log(
      `[Zena Compiler Worker] WASM binary fetched successfully. Length: ${wasmBuffer.byteLength} bytes.`,
    );
  } else {
    wasmBuffer = wasmBytesOrUrl;
    console.log(
      `[Zena Compiler Worker] Using provided ArrayBuffer. Length: ${wasmBuffer.byteLength} bytes.`,
    );
  }

  const consoleImports = createConsoleImports(() => exports);

  // Wrap console imports so they stream logs back to the playground console
  const customConsole = {
    ...consoleImports,
    log_string: (strRef: unknown, len: number) => {
      if (readString) sendLog('log', readString(strRef, len));
    },
    error_string: (strRef: unknown, len: number) => {
      if (readString) sendLog('error', readString(strRef, len));
    },
    warn_string: (strRef: unknown, len: number) => {
      if (readString) sendLog('warn', readString(strRef, len));
    },
    info_string: (strRef: unknown, len: number) => {
      if (readString) sendLog('info', readString(strRef, len));
    },
  };

  const compilerImports = {
    read_file: handleReadFile,
  };

  // Provide stubs for WASI preview1 if needed by WASM runtime
  const wasiStubs = {
    fd_write: () => 0,
    proc_exit: () => 0,
    environ_get: () => 0,
    environ_sizes_get: () => 0,
    clock_time_get: () => 0,
  };

  const importObject = {
    console: customConsole,
    compiler: compilerImports,
    wasi_snapshot_preview1: wasiStubs,
    env: {
      getStackTrace: () => null,
      captureStackTrace: () => null,
      formatStackTrace: () => null,
    },
  };

  console.log('[Zena Compiler Worker] Instantiating WebAssembly module...');
  const {instance} = await WebAssembly.instantiate(wasmBuffer, importObject);
  console.log(
    '[Zena Compiler Worker] WebAssembly module instantiated successfully.',
  );
  exports = instance.exports as LspExports;
  readString = createStringReader(exports);
  writeString = createStringWriter(exports);

  // Initialize compiler with stdlibRoot="/stdlib"
  console.log(
    '[Zena Compiler Worker] Executing compiler init with stdlibRoot="/stdlib"...',
  );
  try {
    exports.init(writeString('/stdlib'));
    console.log(
      '[Zena Compiler Worker] Compiler init completed successfully. Sending "ready" to main thread.',
    );
    self.postMessage({type: 'ready'} as WorkerResponse);
  } catch (err: any) {
    console.error('[Zena Compiler Worker] Compiler init exception:', err);
    self.postMessage({
      type: 'error',
      message: `Compiler init failed: ${err?.message || String(err)}`,
    } as WorkerResponse);
  }
}

async function runCheck(
  id: number,
  path: string,
  source: string,
  shouldRun: boolean = false,
) {
  if (!exports || !writeString || !readString) {
    console.error(
      '[Zena Compiler Worker] Check requested before Wasm module is initialized.',
    );
    self.postMessage({
      type: 'error',
      id,
      message: 'Compiler Wasm module is not initialized.',
    } as WorkerResponse);
    return;
  }

  openDocuments.set(path, source);
  const normPath =
    path.startsWith('/') || path.startsWith('zena:') ? path : '/' + path;
  openDocuments.set(normPath, source);

  try {
    const handle = exports.check(writeString(path), writeString(source));
    const count = exports.getDiagnosticCount(handle);
    const diagnostics: PlaygroundDiagnostic[] = [];

    for (let i = 0; i < count; i++) {
      const line = exports.getDiagnosticLine(handle, i);
      const column = exports.getDiagnosticColumn(handle, i);
      const start = exports.getDiagnosticStart(handle, i);
      const length = exports.getDiagnosticLength(handle, i);
      const sevCode = exports.getDiagnosticSeverity(handle, i);

      const msgRef = exports.getDiagnosticMessage(handle, i);
      const msgLen = exports.$stringGetLength(msgRef);
      const message = readString(msgRef, msgLen);

      const fileRef = exports.getDiagnosticFile(handle, i);
      const fileLen = exports.$stringGetLength(fileRef);
      const file = readString(fileRef, fileLen);

      const severity: 'error' | 'warning' | 'info' =
        sevCode === 0 ? 'error' : sevCode === 1 ? 'warning' : 'info';

      diagnostics.push({
        file,
        line,
        column,
        start,
        length,
        severity,
        message,
      });
    }

    const hasErrors = diagnostics.some((d) => d.severity === 'error');

    self.postMessage({
      type: 'diagnostics',
      id,
      diagnostics,
    } as WorkerResponse);

    if (!hasErrors && shouldRun) {
      await runProgram(path, source);
    }
  } catch (err: any) {
    console.error('[Zena Compiler Worker] Exception during runCheck:', err);
    self.postMessage({
      type: 'error',
      id,
      message: err?.message || String(err),
    } as WorkerResponse);
  }
}

async function runProgram(path: string, source: string) {
  if (!exports || !writeString) return;
  try {
    console.log(
      '[Zena Compiler Worker] Compiling program to WebAssembly binary...',
    );
    const bytesRef = exports.compileToWasm(
      writeString(path),
      writeString(source),
    );
    if (!bytesRef) {
      console.warn('[Zena Compiler Worker] compileToWasm returned null.');
      return;
    }

    const len = exports.getByteArrayLength(bytesRef);
    console.log(
      `[Zena Compiler Worker] WebAssembly program generated (${len} bytes). Instantiating...`,
    );

    const uint8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      uint8[i] = exports.getByteArrayByte(bytesRef, i) & 0xff;
    }

    let programInstanceExports: WebAssembly.Exports | undefined;
    const programConsoleImports = createConsoleImports(
      () => programInstanceExports,
    );

    const programConsole = {
      ...programConsoleImports,
      log_string: (strRef: unknown, len: number) => {
        if (!programInstanceExports) return;
        const reader = createStringReader(programInstanceExports);
        sendLog('log', reader(strRef, len));
      },
      error_string: (strRef: unknown, len: number) => {
        if (!programInstanceExports) return;
        const reader = createStringReader(programInstanceExports);
        sendLog('error', reader(strRef, len));
      },
      warn_string: (strRef: unknown, len: number) => {
        if (!programInstanceExports) return;
        const reader = createStringReader(programInstanceExports);
        sendLog('warn', reader(strRef, len));
      },
      info_string: (strRef: unknown, len: number) => {
        if (!programInstanceExports) return;
        const reader = createStringReader(programInstanceExports);
        sendLog('info', reader(strRef, len));
      },
    };

    const programImports = {
      console: programConsole,
      wasi_snapshot_preview1: {
        fd_write: () => 0,
        proc_exit: () => 0,
        environ_get: () => 0,
        environ_sizes_get: () => 0,
        clock_time_get: () => 0,
      },
      env: {
        getStackTrace: () => null,
        captureStackTrace: () => null,
        formatStackTrace: () => null,
      },
    };

    const {instance} = await WebAssembly.instantiate(
      uint8.buffer,
      programImports,
    );
    programInstanceExports = instance.exports;
    const exportKeys = Object.keys(instance.exports);
    console.log(
      '[Zena Compiler Worker] Instantiated program export keys:',
      exportKeys,
    );

    let mainFn: (() => unknown) | undefined = instance.exports.main as any;
    if (typeof mainFn !== 'function') {
      const mainKey = exportKeys.find(
        (k) => k === 'main' || k.endsWith('main'),
      );
      if (mainKey && typeof instance.exports[mainKey] === 'function') {
        mainFn = instance.exports[mainKey] as any;
      }
    }

    if (typeof mainFn === 'function') {
      console.log('[Zena Compiler Worker] Executing program main()...');
      const res = mainFn();
      if (res !== undefined && res !== null && typeof res !== 'object') {
        console.log('[Zena Compiler Worker] Program return value:', res);
      }
    } else {
      console.log(
        '[Zena Compiler Worker] Program compiled and instantiated (exports:',
        exportKeys.join(', '),
        ')',
      );
    }
  } catch (err: any) {
    console.error('[Zena Compiler Worker] Program execution exception:', err);
    sendLog('error', `Program execution error: ${err?.message || String(err)}`);
  }
}

function runHover(id: number, path: string, offset: number) {
  console.log(
    `[Zena Compiler Worker] runHover request path=${path}, offset=${offset}`,
  );
  if (!exports || !writeString || !readString || !exports.getHover) {
    console.warn('[Zena Compiler Worker] exports.getHover missing');
    self.postMessage({type: 'hover', id, hover: null} as WorkerResponse);
    return;
  }
  try {
    const pathRef = writeString(path);
    const hoverRef = exports.getHover(pathRef, offset);
    console.log(`[Zena Compiler Worker] getHover returned ref:`, hoverRef);
    if (!hoverRef) {
      self.postMessage({type: 'hover', id, hover: null} as WorkerResponse);
      return;
    }

    const labelRef = exports.getHoverLabel
      ? exports.getHoverLabel(hoverRef)
      : null;
    const label = labelRef
      ? readString(labelRef, exports.$stringGetLength(labelRef))
      : '';

    const typeRef = exports.getHoverType
      ? exports.getHoverType(hoverRef)
      : null;
    const typeStr = typeRef
      ? readString(typeRef, exports.$stringGetLength(typeRef))
      : '';

    const docRef = exports.getHoverDoc ? exports.getHoverDoc(hoverRef) : null;
    const doc = docRef
      ? readString(docRef, exports.$stringGetLength(docRef))
      : '';

    console.log('[Zena Compiler Worker] Hover result:', {label, typeStr, doc});

    self.postMessage({
      type: 'hover',
      id,
      hover: {label, typeStr, doc},
    } as WorkerResponse);
  } catch (err) {
    console.error('[Zena Compiler Worker] Exception during runHover:', err);
    self.postMessage({type: 'hover', id, hover: null} as WorkerResponse);
  }
}

function runCompletions(
  id: number,
  path: string,
  source: string | undefined,
  offset: number,
) {
  if (!exports || !writeString || !readString || !exports.getCompletions) {
    self.postMessage({
      type: 'completions',
      id,
      completions: [],
    } as WorkerResponse);
    return;
  }
  try {
    const pathRef = writeString(path);
    if (source && exports.check) {
      const sourceRef = writeString(source);
      exports.check(pathRef, sourceRef);
    }
    const listRef = exports.getCompletions(pathRef, offset);
    if (!listRef) {
      self.postMessage({
        type: 'completions',
        id,
        completions: [],
      } as WorkerResponse);
      return;
    }
    const count = exports.getCompletionCount
      ? exports.getCompletionCount(listRef)
      : 0;
    const completions: any[] = [];
    for (let i = 0; i < count; i++) {
      const item = exports.getCompletionItem!(listRef, i);
      const labelRef = exports.getCompletionLabel!(item);
      const label = labelRef
        ? readString(labelRef, exports.$stringGetLength(labelRef))
        : '';
      const kind = exports.getCompletionKind
        ? exports.getCompletionKind(item)
        : 6;
      const detailRef = exports.getCompletionDetail
        ? exports.getCompletionDetail(item)
        : null;
      const detail = detailRef
        ? readString(detailRef, exports.$stringGetLength(detailRef))
        : '';
      const docRef = exports.getCompletionDoc
        ? exports.getCompletionDoc(item)
        : null;
      const doc = docRef
        ? readString(docRef, exports.$stringGetLength(docRef))
        : '';
      completions.push({label, kind, detail, doc});
    }
    self.postMessage({type: 'completions', id, completions} as WorkerResponse);
  } catch (err) {
    console.error(
      '[Zena Compiler Worker] Exception during runCompletions:',
      err,
    );
    self.postMessage({
      type: 'completions',
      id,
      completions: [],
    } as WorkerResponse);
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  console.log('[Zena Compiler Worker] Received message:', msg);
  if (msg.type === 'init') {
    try {
      if (msg.wasmBytes || msg.wasmUrl) {
        await initializeCompiler(msg.wasmBytes || msg.wasmUrl!);
      } else {
        console.error(
          '[Zena Compiler Worker] Init error: No wasmBytes or wasmUrl provided.',
        );
        self.postMessage({
          type: 'error',
          message: 'No WASM bytes or WASM URL provided for init.',
        } as WorkerResponse);
      }
    } catch (err: any) {
      console.error('[Zena Compiler Worker] Initialization failed:', err);
      self.postMessage({
        type: 'error',
        message: `Compiler Wasm initialization failed: ${err?.message || String(err)}`,
      } as WorkerResponse);
    }
  } else if (msg.type === 'check') {
    if (msg.id !== undefined && msg.path && msg.source !== undefined) {
      runCheck(msg.id, msg.path, msg.source, msg.run ?? false);
    }
  } else if (msg.type === 'hover') {
    if (msg.id !== undefined && msg.path && msg.offset !== undefined) {
      runHover(msg.id, msg.path, msg.offset);
    }
  } else if (msg.type === 'completions') {
    if (msg.id !== undefined && msg.path && msg.offset !== undefined) {
      runCompletions(msg.id, msg.path, msg.source, msg.offset);
    }
  }
};
