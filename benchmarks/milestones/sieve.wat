;; Hand-written core-wasm milestone for the sieve workload (linear
;; memory). NEVER regenerate or "optimize" this file: it is frozen.
(module
  (memory 5)
  (func (export "main") (result i32)
    (local $n i32)
    (local $count i32)
    (local $i i32)
    (local $j i32)
    (local.set $n (i32.const 300000))
    (local.set $i (i32.const 2))
    (block $outer_done
      (loop $outer
        (br_if $outer_done (i32.gt_s (local.get $i) (local.get $n)))
        (if (i32.eqz (i32.load8_u (local.get $i)))
          (then
            (local.set $count (i32.add (local.get $count) (i32.const 1)))
            (local.set $j (i32.add (local.get $i) (local.get $i)))
            (block $inner_done
              (loop $inner
                (br_if $inner_done (i32.gt_s (local.get $j) (local.get $n)))
                (i32.store8 (local.get $j) (i32.const 1))
                (local.set $j (i32.add (local.get $j) (local.get $i)))
                (br $inner)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $outer)))
    (i32.rem_s (local.get $count) (i32.const 256))))
