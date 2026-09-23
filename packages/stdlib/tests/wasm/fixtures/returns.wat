;; Returns 7 from main, 11 from `other` (for invoking by name), 2.5 from
;; `float`, and nothing from `nothing`.
(module
  (func (export "main") (result i32) (i32.const 7))
  (func (export "other") (result i32) (i32.const 11))
  (func (export "float") (result f64) (f64.const 2.5))
  (func (export "nothing")))
