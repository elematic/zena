export const version = '0.0.1';
export * from './lexer.js';
export * from './ast.js';
export * from './parser.js';
export * from './types.js';
export * from './checker/index.js';
export * from './wasm.js';
export * from './emitter.js';
export * from './diagnostics.js';
export * from './codegen/index.js';
export * from './compiler.js';

import {Parser} from './parser.js';
import {CodeGenerator} from './codegen/index.js';
import {TypeChecker} from './checker/index.js';
import {prelude} from './prelude.js';
import {NodeType, type Program} from './ast.js';

/**
 * Standard library sources.
 * These can be prepended to user code until module system is implemented.
 */
export const stdlib = {
  console: `
// Console Standard Library
// Provides a JavaScript-like console API for logging

// External host functions for each console method and type
@external("console", "log_i32")
declare function __console_log_i32(val: i32): void;

@external("console", "log_f32")
declare function __console_log_f32(val: f32): void;

// For string logging, we pass the string reference and length.
// The host (JS) uses the exported $stringGetByte function to iterate.
// This is the V8-recommended pattern for reading GC arrays from JS.
@external("console", "log_string")
declare function __console_log_string(s: string, len: i32): void;

@external("console", "error_string")
declare function __console_error_string(s: string, len: i32): void;

@external("console", "warn_string")
declare function __console_warn_string(s: string, len: i32): void;

@external("console", "info_string")
declare function __console_info_string(s: string, len: i32): void;

@external("console", "debug_string")
declare function __console_debug_string(s: string, len: i32): void;

// Console interface - matches JavaScript's Console API (subset)
export interface Console {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

// HostConsole - implementation that calls external host functions
export class HostConsole implements Console {
  log(message: string): void {
    __console_log_string(message, message.length);
  }

  error(message: string): void {
    __console_error_string(message, message.length);
  }

  warn(message: string): void {
    __console_warn_string(message, message.length);
  }

  info(message: string): void {
    __console_info_string(message, message.length);
  }

  debug(message: string): void {
    __console_debug_string(message, message.length);
  }
}

// Global console instance - connected to the host environment
export let console = new HostConsole();

// Convenience functions for primitive types (overloaded-like API)
export let log = (val: i32) => {
  __console_log_i32(val);
};

export let logF32 = (val: f32) => {
  __console_log_f32(val);
};

export let logString = (val: string) => {
  __console_log_string(val, val.length);
};
`,
};

export function compile(source: string): Uint8Array {
  // Parse prelude
  const preludeParser = new Parser(prelude);
  const preludeAst = preludeParser.parse();

  // Parse user code
  const parser = new Parser(source);
  const ast = parser.parse();

  // Merge ASTs
  const program: Program = {
    type: NodeType.Program,
    body: [...preludeAst.body, ...ast.body],
  };

  const checker = new TypeChecker(program);
  const errors = checker.check();
  if (errors.length > 0) {
    const errorMessage = errors
      .map(
        (e) =>
          `${e.message} at line ${e.location?.line}, column ${e.location?.column}`,
      )
      .join('\n');
    throw new Error(errorMessage);
  }

  const codegen = new CodeGenerator(program);
  return codegen.generate();
}

/**
 * Compile Zena source code with the standard library included.
 * This prepends the console stdlib to the user source before compilation.
 *
 * @param source - The Zena source code to compile
 * @returns The compiled WASM binary
 */
export function compileWithStdlib(source: string): Uint8Array {
  const fullSource = stdlib.console + source;
  return compile(fullSource);
}
