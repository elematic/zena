#!/usr/bin/env node

import {
  CodeGenerator,
  Compiler,
  DiagnosticSeverity,
  formatDiagnostics,
  type Diagnostic,
} from '@zena-lang/compiler';
import {instantiate} from '@zena-lang/runtime';
import {readFile, writeFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {NodeCompilerHost} from './host.js';
import {testCommand} from './test.js';

// Check Node version
const MIN_NODE_VERSION = 25;
const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
if (nodeVersion < MIN_NODE_VERSION) {
  console.warn(
    `\x1b[33mWarning: Zena requires Node.js ${MIN_NODE_VERSION}+, but you are using v${process.versions.node}.\x1b[0m`,
  );
  console.warn(
    `\x1b[33mSome features (like WASM GC exceptions) may not work correctly.\x1b[0m`,
  );
}

const Commands = {
  build: 'build',
  check: 'check',
  run: 'run',
  test: 'test',
  help: 'help',
} as const;

type Command = (typeof Commands)[keyof typeof Commands];

const isCommand = (value: string): value is Command =>
  Object.values(Commands).includes(value as Command);

const printHelp = (): void => {
  console.log(`Zena Compiler CLI

Usage: zena <command> [options] [files...]

Commands:
  build    Compile Zena source files to WASM
  check    Type-check Zena source files without emitting
  run      Compile and run Zena source files
  test     Run Zena test files
  help     Show this help message

Options:
  -o, --output <file>   Output file path (for build command)
  -t, --target <target> Compilation target: 'host' (default) or 'wasi'
  -g, --debug           Include debug info (function names in WASM name section)
  -v, --verbose         Verbose output (for test command)
  -h, --help            Show help

Targets:
  host    Output core WASM-GC with custom console imports (for @zena-lang/runtime)
  wasi    Output core WASM-GC with WASI imports (for wasmtime, jco)

Examples:
  zena build main.zena -o main.wasm
  zena build main.zena -o main.wasm --target wasi
  zena build main.zena -o main.wasm -g         # Include debug info
  zena check main.zena
  zena run main.zena
  zena test                           # Run all *_test.zena files
  zena test 'tests/**/*_test.zena'    # Run tests matching pattern
`);
};

const readSourceFile = async (filePath: string): Promise<string> => {
  const absolutePath = resolve(process.cwd(), filePath);
  return readFile(absolutePath, 'utf-8');
};

/**
 * Output errors to stderr in a formatted way with source context.
 */
const printErrors = (errors: Diagnostic[], source?: string): void => {
  console.error(formatDiagnostics(errors, source));
};

const buildCommand = async (
  files: string[],
  output?: string,
  target: Target = 'host',
  debug: boolean = false,
): Promise<number> => {
  if (files.length === 0) {
    console.error('Error: No input files specified');
    return 1;
  }

  const host = new NodeCompilerHost(target);
  const compiler = new Compiler(host, {target});

  // For now, assume first file is entry point
  const entryPoint = resolve(process.cwd(), files[0]);

  try {
    const modules = compiler.compile(entryPoint);

    // Print all diagnostics, but only fail on errors
    let hasErrors = false;
    for (const mod of modules) {
      if (mod.diagnostics.length > 0) {
        printErrors(mod.diagnostics, mod.source);
        if (
          mod.diagnostics.some((d) => d.severity === DiagnosticSeverity.Error)
        ) {
          hasErrors = true;
        }
      }
    }

    if (hasErrors) return 1;

    // Generate code (pass modules directly, no bundling needed)
    // Pass semantic context for resolved bindings
    const codegen = new CodeGenerator(
      modules,
      entryPoint,
      compiler.semanticContext,
      compiler.checkerContext,
      {target, debug},
    );
    const bytes = codegen.generate();

    const outputPath = output || basename(files[0], '.zena') + '.wasm';
    await writeFile(outputPath, bytes);
    console.log(`Built ${outputPath}`);
    return 0;
  } catch (e: any) {
    console.error('Compilation failed:', e.message);
    return 1;
  }
};

const checkCommand = async (files: string[]): Promise<number> => {
  if (files.length === 0) {
    console.error('Error: No input files specified');
    return 1;
  }

  const host = new NodeCompilerHost('host');
  const compiler = new Compiler(host);

  // For now, assume first file is entry point
  const entryPoint = resolve(process.cwd(), files[0]);

  try {
    const modules = compiler.compile(entryPoint);

    let hasErrors = false;
    for (const mod of modules) {
      if (mod.diagnostics.length > 0) {
        printErrors(mod.diagnostics, mod.source);
        if (
          mod.diagnostics.some((d) => d.severity === DiagnosticSeverity.Error)
        ) {
          hasErrors = true;
        }
      }
    }

    return hasErrors ? 1 : 0;
  } catch (e: any) {
    console.error('Check failed:', e.message);
    return 1;
  }
};

const runCommand = async (
  files: string[],
  target: Target = 'host',
): Promise<number> => {
  if (files.length === 0) {
    console.error('Error: No input files specified');
    return 1;
  }

  if (target === 'wasi') {
    console.error('Error: --target wasi is not supported for run command.');
    console.error('Use: zena build main.zena --target wasi -o main.wasm');
    console.error('Then: wasmtime run -W gc=y main.wasm');
    return 1;
  }

  const host = new NodeCompilerHost(target);
  const compiler = new Compiler(host, {target});
  const entryPoint = resolve(process.cwd(), files[0]);

  try {
    const modules = compiler.compile(entryPoint);

    let hasErrors = false;
    for (const mod of modules) {
      if (mod.diagnostics.length > 0) {
        printErrors(mod.diagnostics, mod.source);
        if (
          mod.diagnostics.some((d) => d.severity === DiagnosticSeverity.Error)
        ) {
          hasErrors = true;
        }
      }
    }

    if (hasErrors) return 1;

    // Generate code (pass modules directly, no bundling needed)
    // Pass semantic context for resolved bindings
    const codegen = new CodeGenerator(
      modules,
      entryPoint,
      compiler.semanticContext,
      compiler.checkerContext,
      {target},
    );
    const bytes = codegen.generate();

    // Use the runtime to instantiate with standard library support
    const result = await instantiate(bytes);
    const instance =
      result instanceof WebAssembly.Instance
        ? result
        : (result as WebAssembly.WebAssemblyInstantiatedSource).instance;
    const exports = instance.exports;

    // Look for a main function and call it
    // Assuming 'main' is exported from entry point.
    const mainFn = exports.main;
    if (typeof mainFn === 'function') {
      const mainResult = (mainFn as () => unknown)();
      if (mainResult !== undefined) {
        console.log(mainResult);
      }
    }
    return 0;
  } catch (e: any) {
    console.error('Run failed:', e.message);
    return 1;
  }
};

export type Target = 'host' | 'wasi';

const isTarget = (value: string): value is Target =>
  value === 'host' || value === 'wasi';

export const main = async (args: string[]): Promise<number> => {
  const {values, positionals} = parseArgs({
    args,
    options: {
      help: {type: 'boolean', short: 'h', default: false},
      output: {type: 'string', short: 'o'},
      target: {type: 'string', short: 't', default: 'host'},
      debug: {type: 'boolean', short: 'g', default: false},
      verbose: {type: 'boolean', short: 'v', default: false},
    },
    allowPositionals: true,
  });

  const [commandArg, ...files] = positionals;
  const command: Command =
    commandArg && isCommand(commandArg) ? commandArg : 'help';

  if (values.help || command === 'help') {
    printHelp();
    return 0;
  }

  // Validate target
  const target: Target = isTarget(values.target!) ? values.target : 'host';
  if (values.target && !isTarget(values.target)) {
    console.error(
      `Warning: Unknown target '${values.target}', using 'host' instead.`,
    );
  }

  switch (command) {
    case 'build':
      return buildCommand(files, values.output, target, values.debug);
    case 'check':
      return checkCommand(files);
    case 'run':
      return runCommand(files, target);
    case 'test':
      return testCommand(files, {verbose: values.verbose});
    default:
      printHelp();
      return 1;
  }
};

// Run if executed directly
const args = process.argv.slice(2);
main(args).then((code) => {
  process.exitCode = code;
});
