/**
 * The message protocol between `<zena-playground>` and its compiler worker.
 *
 * The compiler is synchronous and slow enough to drop frames, so it runs in a
 * Web Worker and everything crosses as a message.
 */

import type {
  CompletionItem,
  Diagnostic,
  HoverInfo,
} from '@zena-lang/language-service';

export type {CompletionItem, Diagnostic, HoverInfo};

/** Severity levels the console pane renders. */
export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info';

/** An entry in the playground's output console. */
export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  message: string;
}

/** Loads `lsp.wasm`. Sent once, before anything else. */
export interface InitRequest {
  type: 'init';
  /** Where to fetch the Wasm from. Ignored when `wasmBytes` is given. */
  wasmUrl?: string;
  /** Pre-fetched Wasm, for hosts that would rather do the fetching. */
  wasmBytes?: ArrayBuffer;
}

/** Checks a document, and runs it too if `run` is set and it has no errors. */
export interface CheckRequest {
  type: 'check';
  id: number;
  path: string;
  source: string;
  files?: Record<string, string>;
  run: boolean;
}

export interface HoverRequest {
  type: 'hover';
  id: number;
  path: string;
  offset: number;
  files?: Record<string, string>;
}

export interface CompletionsRequest {
  type: 'completions';
  id: number;
  path: string;
  source: string;
  offset: number;
  files?: Record<string, string>;
}

export type WorkerRequest =
  | InitRequest
  | CheckRequest
  | HoverRequest
  | CompletionsRequest;

/** The compiler is loaded and initialized. */
export interface ReadyResponse {
  type: 'ready';
}

export interface DiagnosticsResponse {
  type: 'diagnostics';
  id: number;
  diagnostics: Diagnostic[];
}

/** A `console.*` call from the program being run. */
export interface ConsoleResponse {
  type: 'console';
  level: ConsoleLevel;
  message: string;
}

export interface HoverResponse {
  type: 'hover';
  id: number;
  hover: HoverInfo | null;
}

export interface CompletionsResponse {
  type: 'completions';
  id: number;
  completions: CompletionItem[];
}

/** The worker itself failed — bad Wasm, a compiler crash, a failed run. */
export interface ErrorResponse {
  type: 'error';
  id?: number;
  message: string;
}

export type WorkerResponse =
  | ReadyResponse
  | DiagnosticsResponse
  | ConsoleResponse
  | HoverResponse
  | CompletionsResponse
  | ErrorResponse;

export type PlaygroundStatus = 'loading' | 'ready' | 'checking' | 'error';

/** Represents a single project file in a playground project. */
export interface SampleFile {
  name: string;
  content: string;
  contentType?: string;
  label?: string;
  hidden?: boolean;
  selected?: boolean;
}

/** Project configuration / manifest format. */
export interface ProjectManifest {
  files?: Record<
    string,
    {
      content?: string;
      contentType?: string;
      label?: string;
      hidden?: boolean;
      selected?: boolean;
    }
  >;
}
