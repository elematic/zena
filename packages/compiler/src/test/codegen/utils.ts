import {TypeChecker} from '../../lib/checker/index.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {Parser} from '../../lib/parser.js';

export async function compileAndRun(
  input: string,
  entryPoint: string = 'main',
): Promise<any> {
  const parser = new Parser(input);
  const ast = parser.parse();

  const checker = new TypeChecker(ast);
  const diagnostics = checker.check();
  if (diagnostics.length > 0) {
    throw new Error(
      `Type check failed: ${diagnostics.map((d) => d.message).join(', ')}`,
    );
  }

  const codegen = new CodeGenerator(ast);
  const bytes = codegen.generate();

  const result = await WebAssembly.instantiate(bytes, {});
  // @ts-ignore
  const instance = result.instance;
  const exports = instance.exports as any;
  if (exports[entryPoint]) {
    return exports[entryPoint]();
  }
  return null;
}
