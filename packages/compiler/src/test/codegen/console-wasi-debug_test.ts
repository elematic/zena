import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Compiler} from '../../lib/compiler.js';
import {createHost} from './utils.js';
import {TypeKind} from '../../lib/types.js';

suite('console-wasi debug', () => {
  test('trace console type resolution', () => {
    const source = `
import { console } from 'zena:console-wasi';

export let main = () => {
  console.log('Hello WASI');
  return 0;
};
`;

    const host = createHost(source, '/main.zena');
    const compiler = new Compiler(host, {
      target: 'wasi',
    });

    const modules = compiler.compile('/main.zena');

    // Find the main module
    const mainModule = modules.find((m) => m.path === '/main.zena');
    assert(mainModule, 'main module should exist');

    // Check for compilation errors
    const errors =
      mainModule.diagnostics?.filter((d) => d.severity === 1) ?? [];
    if (errors.length > 0) {
      console.log(
        'Compilation errors:',
        errors.map((e) => e.message).join(', '),
      );
    }

    // Find the console-wasi module
    const consoleWasiModule = modules.find(
      (m) => m.path === 'zena:console-wasi',
    );
    assert(consoleWasiModule, 'console-wasi module should exist');

    // Find the console module (from prelude)
    const consoleModule = modules.find((m) => m.path === 'zena:console');

    console.log('\n=== Module Order ===');
    modules.forEach((m, i) => console.log(`${i}: ${m.path}`));

    console.log('\n=== Console Module Exports ===');
    if (consoleModule) {
      console.log('zena:console exports:');
      for (const [name, info] of consoleModule.exports ?? []) {
        console.log(
          `  ${name}: kind=${info.kind}, type.kind=${info.type?.kind}`,
        );
        if (info.type?.kind === TypeKind.Interface) {
          console.log(`    Interface name: ${(info.type as any).name}`);
        }
        if (info.type?.kind === TypeKind.Class) {
          const classType = info.type as any;
          console.log(`    Class name: ${classType.name}`);
          if (classType.implements?.length) {
            console.log(`    Implements:`);
            for (const impl of classType.implements) {
              console.log(`      - ${impl.name} (kind=${impl.kind})`);
            }
          }
        }
      }
    } else {
      console.log('zena:console not found in modules');
    }

    console.log('\nzena:console-wasi exports:');
    for (const [name, info] of consoleWasiModule.exports ?? []) {
      console.log(`  ${name}: kind=${info.kind}, type.kind=${info.type?.kind}`);
      if (info.type?.kind === TypeKind.Interface) {
        console.log(`    Interface name: ${(info.type as any).name}`);
      }
      if (info.type?.kind === TypeKind.Class) {
        const classType = info.type as any;
        console.log(`    Class name: ${classType.name}`);
        if (classType.implements?.length) {
          console.log(`    Implements:`);
          for (const impl of classType.implements) {
            console.log(`      - ${impl.name} (kind=${impl.kind})`);
          }
        }
      }
    }

    // Check what type the 'console' variable has
    console.log('\n=== console variable type ===');
    const consoleExport = consoleWasiModule.exports?.get('value:console');
    if (consoleExport) {
      const consoleType = consoleExport.type;
      console.log(`console type kind: ${consoleType?.kind}`);
      if (consoleType?.kind === TypeKind.Class) {
        const classType = consoleType as any;
        console.log(`console class name: ${classType.name}`);
        console.log(
          `console class declaration module: ${classType.declaration?.module?.path}`,
        );
        if (classType.implements?.length) {
          console.log(`console implements:`);
          for (const impl of classType.implements) {
            console.log(`  - ${impl.name} (kind=${impl.kind})`);
            console.log(
              `    declaration module: ${impl.declaration?.module?.path}`,
            );
          }
        }
      }
    } else {
      console.log('value:console not found in exports');
    }

    // Check the Console interfaces from both modules are different
    console.log('\n=== Console interface identity check ===');
    const consoleInterfaceModule = modules.find(
      (m) => m.path === 'zena:console-interface',
    );
    const consoleInterfaceExport =
      consoleInterfaceModule?.exports?.get('type:Console');

    if (consoleInterfaceExport) {
      console.log(`zena:console-interface exports Console: true`);
      console.log(
        `Console type object: ${(consoleInterfaceExport.type as any)?.name}`,
      );

      // Check WasiConsole implements this interface
      const wasiConsoleClass =
        consoleWasiModule.exports?.get('type:WasiConsole');
      if (wasiConsoleClass?.type?.kind === TypeKind.Class) {
        const classType = wasiConsoleClass.type as any;
        if (classType.implements?.length) {
          const implInterface = classType.implements[0];
          console.log(
            `WasiConsole implements Console: ${implInterface === consoleInterfaceExport.type}`,
          );
        }
      }

      // Check HostConsole implements the same interface
      if (consoleModule) {
        const hostConsoleClass = consoleModule.exports?.get('type:HostConsole');
        if (hostConsoleClass?.type?.kind === TypeKind.Class) {
          const classType = hostConsoleClass.type as any;
          if (classType.implements?.length) {
            const implInterface = classType.implements[0];
            console.log(
              `HostConsole implements Console: ${implInterface === consoleInterfaceExport.type}`,
            );
          }
        }
      }
    } else {
      console.log('Console interface not found in zena:console-interface');
    }

    // Check what the call expression resolves to
    console.log('\n=== Semantic bindings ===');
    const semanticContext = compiler.semanticContext;

    // Look at all registered bindings
    let callCount = 0;
    for (const [_node, binding] of (semanticContext as any).bindings ?? []) {
      if (binding.kind === 'method' && binding.name === 'log') {
        callCount++;
        console.log(`Method binding #${callCount} for 'log':`);
        console.log(`  classType name: ${binding.classType?.name}`);
        console.log(
          `  classType module: ${binding.classType?.declaration?.module?.path}`,
        );
        console.log(`  isVirtual: ${binding.isVirtual}`);
      }
    }

    assert.strictEqual(errors.length, 0, 'Should have no compilation errors');
  });
});
