export interface PlaygroundDiagnostic {
  file: string;
  line: number;
  column: number;
  start: number;
  length: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface WorkerRequest {
  type: 'init' | 'check' | 'hover';
  id?: number;
  path?: string;
  source?: string;
  offset?: number;
  run?: boolean;
  wasmBytes?: ArrayBuffer;
  wasmUrl?: string;
}

export interface WorkerResponse {
  type: 'ready' | 'diagnostics' | 'console' | 'error' | 'hover';
  id?: number;
  diagnostics?: PlaygroundDiagnostic[];
  level?: 'log' | 'warn' | 'error' | 'info';
  message?: string;
  hover?: {
    label: string;
    typeStr: string;
    doc: string;
  } | null;
}

export interface ConsoleEntry {
  id: number;
  level: 'log' | 'warn' | 'error' | 'info';
  message: string;
  time?: string;
}
