;; Exercises what a run passes through WASI:
;; - main writes "hello\n" to stdout and returns its argument count;
;; - `preopen` returns fd_prestat_get's errno for fd 3, the first
;;   preopened directory (0 when there is one, 8 when there is none);
;; - `env` returns how many environment variables it sees;
;; - `exits` ends the module with proc_exit(3).
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_sizes_get"
    (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_sizes_get"
    (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_get"
    (func $fd_prestat_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  ;; "hello\n" at 16; its iovec (pointer, length) at 0.
  (data (i32.const 16) "hello\n")
  (func (export "main") (result i32)
    (i32.store (i32.const 0) (i32.const 16))
    (i32.store (i32.const 4) (i32.const 6))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))
    (drop (call $args_sizes_get (i32.const 32) (i32.const 36)))
    (i32.load (i32.const 32)))
  (func (export "preopen") (result i32)
    (call $fd_prestat_get (i32.const 3) (i32.const 40)))
  (func (export "env") (result i32)
    (drop (call $environ_sizes_get (i32.const 48) (i32.const 52)))
    (i32.load (i32.const 48)))
  (func (export "exits") (result i32)
    (call $proc_exit (i32.const 3))
    (i32.const 0)))
