#!/usr/bin/env node

import {
  compile,
  compileWithStdlib,
  Parser,
  TypeChecker,
  type Diagnostic,
} from '@zena-lang/compiler';
import {instantiate} from '@zena-lang/runtime';
import {readFile, writeFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';
import {parseArgs} from 'node:util';

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

/**
 * Parse and type-check source code, returning any errors found.
 */
const checkSource = (source: string): Diagnostic[] => {
  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = new TypeChecker(ast);
  return checker.check();
};

/**
 * Output errors to stderr in a formatted way.
 */
const printErrors = (file: string, errors: Diagnostic[]): void => {
  console.error(`${file}:`);
  for (const error of errors) {
    const loc = error.location
      ? ` at line ${error.location.line}, column ${error.location.column}`
      : '';
    console.error(`  ${error.message}${loc}`);
  }
};

const buildCommand = async (
  files: string[],
  output?: string,
): Promise<number> => {
  if (files.length === 0) {
    console.error('Error: No input files specified');
    return 1;
  }

  let hasErrors = false;

  for (const file of files) {
    try {
      const source = await readSourceFile(file);
      const errors = checkSource(source);

      if (errors.length > 0) {
        hasErrors = true;
        printErrors(file, errors);
        continue;
      }

      // Compile only if no errors
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
    } catch (error) {
      hasErrors = true;
      console.error(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return hasErrors ? 1 : 0;
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
      const errors = checkSource(source);

      if (errors.length > 0) {
        hasErrors = true;
        printErrors(file, errors);
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

  let hasErrors = false;

  for (const file of files) {
    try {
      const source = await readSourceFile(file);

      // Compile with stdlib - errors are thrown as exceptions
      const bytes = compileWithStdlib(source);

      // Use the runtime to instantiate with standard library support
      const result = await instantiate(bytes);
      const instance =
        result instanceof WebAssembly.Instance
          ? result
          : (result as WebAssembly.WebAssemblyInstantiatedSource).instance;
      const exports = instance.exports;

      // Look for a main function and call it
      const mainFn = exports.main;
      if (typeof mainFn === 'function') {
        const mainResult = (mainFn as () => unknown)();
        if (mainResult !== undefined) {
          console.log(mainResult);
        }
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
