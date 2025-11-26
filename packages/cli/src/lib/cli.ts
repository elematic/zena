#!/usr/bin/env node

import {readFile, writeFile} from 'node:fs/promises';
import {resolve, basename} from 'node:path';
import {parseArgs} from 'node:util';
import {compile, Parser, TypeChecker} from '@zena-lang/compiler';

const Commands = {
  build: 'build',
  check: 'check',
  run: 'run',
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
  help     Show this help message

Options:
  -o, --output <file>  Output file path (for build command)
  -h, --help           Show help

Examples:
  zena build main.zena -o main.wasm
  zena check main.zena
  zena run main.zena
`);
};

const readSourceFile = async (filePath: string): Promise<string> => {
  const absolutePath = resolve(process.cwd(), filePath);
  return readFile(absolutePath, 'utf-8');
};

const buildCommand = async (
  files: string[],
  output?: string,
): Promise<number> => {
  if (files.length === 0) {
    console.error('Error: No input files specified');
    return 1;
  }

  try {
    for (const file of files) {
      const source = await readSourceFile(file);
      const bytes = compile(source);

      // Replace .zena extension or append .wasm if different extension
      const baseName = basename(file);
      const outputPath =
        output ??
        (baseName.endsWith('.zena')
          ? baseName.slice(0, -5) + '.wasm'
          : baseName + '.wasm');
      await writeFile(outputPath, bytes);
      console.log(`Compiled ${file} -> ${outputPath}`);
    }
    return 0;
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
};

const checkCommand = async (files: string[]): Promise<number> => {
  if (files.length === 0) {
    console.error('Error: No input files specified');
    return 1;
  }

  let hasErrors = false;

  for (const file of files) {
    try {
      const source = await readSourceFile(file);
      const parser = new Parser(source);
      const ast = parser.parse();
      const checker = new TypeChecker(ast);
      const errors = checker.check();

      if (errors.length > 0) {
        hasErrors = true;
        console.error(`${file}:`);
        for (const error of errors) {
          const loc = error.location
            ? ` at line ${error.location.line}, column ${error.location.column}`
            : '';
          console.error(`  ${error.message}${loc}`);
        }
      } else {
        console.log(`${file}: OK`);
      }
    } catch (error) {
      hasErrors = true;
      console.error(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return hasErrors ? 1 : 0;
};

const runCommand = async (files: string[]): Promise<number> => {
  if (files.length === 0) {
    console.error('Error: No input files specified');
    return 1;
  }

  try {
    for (const file of files) {
      const source = await readSourceFile(file);
      const bytes = compile(source);

      // WebAssembly.instantiate returns WebAssemblyInstantiatedSource for buffer input
      const result = await WebAssembly.instantiate(bytes, {});
      const {instance} = result as unknown as WebAssembly.WebAssemblyInstantiatedSource;
      const exports = instance.exports;

      // Look for a main function and call it
      const mainFn = exports.main;
      if (typeof mainFn === 'function') {
        const mainResult = (mainFn as () => unknown)();
        if (mainResult !== undefined) {
          console.log(mainResult);
        }
      }
    }
    return 0;
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
};

export const main = async (args: string[]): Promise<number> => {
  const {values, positionals} = parseArgs({
    args,
    options: {
      help: {type: 'boolean', short: 'h', default: false},
      output: {type: 'string', short: 'o'},
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

  switch (command) {
    case 'build':
      return buildCommand(files, values.output);
    case 'check':
      return checkCommand(files);
    case 'run':
      return runCommand(files);
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
