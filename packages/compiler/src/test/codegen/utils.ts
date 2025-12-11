import {Compiler, type CompilerHost} from '../../lib/compiler.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execSync} from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
// When running compiled tests, we are in packages/compiler/test/codegen
// Stdlib is in packages/compiler/stdlib
const stdlibPath = join(__dirname, '../../stdlib');

export interface CompileOptions {
  entryPoint?: string;
  imports?: Record<string, any>;
  path?: string;
}

export async function compileAndInstantiate(
  input: string | Record<string, string>,
  options: CompileOptions = {},
): Promise<any> {
  const path = options.path ?? '/main.zena';
  const imports = options.imports ?? {};

  let capturedExports: any = null;

  // Add default console mock if not present
  if (!imports.console) {
    const logString = (s: any, len: number) => {
      if (!capturedExports || !capturedExports.$stringGetByte) return;
      let str = '';
      for (let i = 0; i < len; i++) {
        const code = capturedExports.$stringGetByte(s, i);
        str += String.fromCharCode(code);
      }
      console.log(str);
    };

    imports.console = {
      log_i32: (v: number) => console.log(v),
      log_f32: (v: number) => console.log(v),
      log_string: logString,
      error_string: logString,
      warn_string: logString,
      info_string: logString,
      debug_string: logString,
    };
  }

  const host: CompilerHost = {
    load: (p: string) => {
      if (typeof input === 'string') {
        if (p === path) return input;
      } else if (Object.hasOwn(input, p)) {
        return input[p];
      }
      if (p.startsWith('zena:')) {
        const name = p.substring(5);
        return readFileSync(join(stdlibPath, `${name}.zena`), 'utf-8');
      }
      throw new Error(`File not found: ${p}`);
    },
    resolve: (specifier: string, referrer: string) => specifier,
  };

  const compiler = new Compiler(host);
  const program = compiler.bundle(path);

  // Re-run checker on the bundled program to ensure types have correct bundled names
  const checker = new TypeChecker(program, compiler, {
    path,
    exports: new Map(),
    isStdlib: true,
  } as any);
  checker.preludeModules = compiler.preludeModules;
  const diagnostics = checker.check();
  if (diagnostics.length > 0) {
    throw new Error(
      `Bundled program check failed: ${diagnostics.map((d) => d.message).join(', ')}`,
    );
  }

  const codegen = new CodeGenerator(program);
  const bytes = codegen.generate();

  try {
    const result = await WebAssembly.instantiate(bytes, imports);
    const instance = (result as any).instance || result;
    capturedExports = instance.exports;
    return instance.exports;
  } catch (e) {
    console.log('WASM Instantiation Error:', e);
    try {
      // Try to convert to WAT using wasm2wat
      const wat = execSync('wasm2wat - --enable-all', {
        input: bytes,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log('WASM Text (WAT):');
      console.log(wat);
    } catch (watError: any) {
      // If wasm2wat fails or is not installed, just log that we couldn't convert
      // We avoid logging the raw bytes to keep the output clean as requested.
      console.log(
        'Could not convert WASM to WAT (wasm2wat failed or not found).',
      );
      if (watError.stderr) {
        console.log('wasm2wat stderr:', watError.stderr.toString());
      }
    }
    throw e;
  }
}

export async function compileAndRun(
  input: string | Record<string, string>,
  optionsOrEntryPoint: string | CompileOptions = 'main',
  importsArg: Record<string, any> = {},
): Promise<any> {
  let entryPoint = 'main';
  let imports = importsArg;
  let path = '/main.zena';

  if (typeof optionsOrEntryPoint === 'string') {
    entryPoint = optionsOrEntryPoint;
  } else {
    entryPoint = optionsOrEntryPoint.entryPoint ?? 'main';
    imports = optionsOrEntryPoint.imports ?? importsArg;
    path = optionsOrEntryPoint.path ?? '/main.zena';
  }

  const exports = await compileAndInstantiate(input, {
    path,
    imports,
  });

  if (exports[entryPoint]) {
    return exports[entryPoint]();
  }
  return null;
}
