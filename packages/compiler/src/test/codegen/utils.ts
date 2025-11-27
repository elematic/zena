import {Compiler, type CompilerHost} from '../../lib/compiler.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// When running compiled tests, we are in packages/compiler/test/codegen
// Stdlib is in packages/compiler/stdlib
const stdlibPath = join(__dirname, '../../stdlib');

export async function compileAndRun(
  input: string,
  entryPoint: string = 'main',
  imports: Record<string, any> = {},
): Promise<any> {
  // Add default console mock if not present
  if (!imports.console) {
    imports.console = {
      log_i32: () => {},
      log_f32: () => {},
      log_string: () => {},
      error_string: () => {},
      warn_string: () => {},
      info_string: () => {},
      debug_string: () => {},
    };
  }

  const host: CompilerHost = {
    load: (path: string) => {
      if (path === '/main.zena') return input;
      if (path.startsWith('zena:')) {
        const name = path.substring(5);
        return readFileSync(join(stdlibPath, `${name}.zena`), 'utf-8');
      }
      throw new Error(`File not found: ${path}`);
    },
    resolve: (specifier: string, referrer: string) => specifier,
  };

  const compiler = new Compiler(host);
  const program = compiler.bundle('/main.zena');

  // Diagnostics are checked during compilation/bundling inside Compiler?
  // No, Compiler.compile calls checkModules.
  // But we should check if there are errors.
  // The Compiler doesn't throw on errors, it stores them in modules.

  const modules = compiler.compile('/main.zena'); // Re-compile to get diagnostics?
  // bundle calls compile internally.
  // But we don't have access to modules from bundle result easily unless we use compile first.

  // Actually, let's just use bundle. If there are type errors, CodeGenerator might fail or produce bad code.
  // But we want to fail fast if checker failed.

  // Let's check diagnostics from the entry module.
  const entryModule = compiler.getModule('/main.zena');
  if (entryModule && entryModule.diagnostics.length > 0) {
    throw new Error(
      `Type check failed: ${entryModule.diagnostics.map((d) => d.message).join(', ')}`,
    );
  }

  const codegen = new CodeGenerator(program);
  const bytes = codegen.generate();

  const result = await WebAssembly.instantiate(bytes, imports);
  // @ts-ignore
  const instance = result.instance;
  const exports = instance.exports as any;
  if (exports[entryPoint]) {
    return exports[entryPoint]();
  }
  return null;
}
