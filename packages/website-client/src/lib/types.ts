export interface PlaygroundDiagnostic {
  file: string;
  line: number;
  column: number;
  start: number;
  length: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface CompletionOption {
  label: string;
  kind: number;
  detail: string;
  doc: string;
}

export interface WorkerRequest {
  type: 'init' | 'check' | 'hover' | 'completions';
  id?: number;
  path?: string;
  source?: string;
  offset?: number;
  run?: boolean;
  wasmBytes?: ArrayBuffer;
  wasmUrl?: string;
}

export interface WorkerResponse {
  type: 'ready' | 'diagnostics' | 'console' | 'error' | 'hover' | 'completions';
  id?: number;
  diagnostics?: PlaygroundDiagnostic[];
  level?: 'log' | 'warn' | 'error' | 'info';
  message?: string;
  hover?: {
    label: string;
    typeStr: string;
    doc: string;
  } | null;
  completions?: CompletionOption[];
}

export interface ConsoleEntry {
  id: number;
  level: 'log' | 'warn' | 'error' | 'info';
  message: string;
  time?: string;
}
