;; A small workload for suite tests: sums 1..100000 and returns 0.
(module
  (func (export "main") (result i32)
    (local $i i32)
    (local $sum i32)
    (loop $next
      (local.set $sum (i32.add (local.get $sum) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $next (i32.lt_u (local.get $i) (i32.const 100000))))
    (i32.const 0)))
