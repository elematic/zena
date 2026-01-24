// Debug test for generic interface lookup issue
import {Compiler, type CompilerHost} from '../lib/compiler.js';
import {CodeGenerator} from '../lib/codegen/index.js';

const host: CompilerHost = {
  load: (p) => {
    if (p === '/main.zena') {
      return `
        export interface Sequence<T> {
          length: i32 { get; }
        }

        export class MyArray<T> implements Sequence<T> {
          length: i32 { get { return 0; } }
          
          test(): Sequence<T> {
            return this;
          }
        }

        export let main = () => {
          let arr = new MyArray<i32>();
          return arr.length;
        };
      `;
    }
    return '';
  },
  resolve: (s) => s,
};

const compiler = new Compiler(host);
const modules = compiler.compile('/main.zena');
console.log('Modules compiled:', modules.length);
console.log(
  'Errors:',
  modules.flatMap((m) => m.diagnostics).map((d) => d.message),
);

try {
  const gen = new CodeGenerator(modules, '/main.zena');
  const bytes = gen.generate();
  console.log('Generated:', bytes.length, 'bytes');
} catch (e: any) {
  console.log('Error during codegen:', e.message);
  console.log('Stack:', e.stack);
}
