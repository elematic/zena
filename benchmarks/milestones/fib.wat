;; Hand-written core-wasm milestone for the fib workload. NEVER regenerate
;; or "optimize" this file: its value is that it is frozen, so results from
;; different machines and years can both be expressed relative to it.
(module
  (func $fib (param i32) (result i32)
    (if (result i32) (i32.lt_s (local.get 0) (i32.const 2))
      (then (local.get 0))
      (else (i32.add
        (call $fib (i32.sub (local.get 0) (i32.const 1)))
        (call $fib (i32.sub (local.get 0) (i32.const 2)))))))
  (func (export "main") (result i32)
    (call $fib (i32.const 27))))
