;; Hand-written core-wasm milestone for the sum-loop workload. NEVER
;; regenerate or "optimize" this file: its value is that it is frozen.
(module
  (func (export "main") (result i32)
    (local $sum i32)
    (local $i i32)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (i32.const 5000000)))
        (if (i32.eqz (i32.rem_s (local.get $i) (i32.const 3)))
          (then (local.set $sum (i32.add (local.get $sum)
            (i32.rem_s (local.get $i) (i32.const 7)))))
          (else (local.set $sum (i32.sub (local.get $sum)
            (i32.rem_s (local.get $i) (i32.const 5))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.rem_s (local.get $sum) (i32.const 256))))
