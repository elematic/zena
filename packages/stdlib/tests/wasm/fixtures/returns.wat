;; Returns 7 from main, and 11 from `other`, for invoking by name.
(module
  (func (export "main") (result i32) (i32.const 7))
  (func (export "other") (result i32) (i32.const 11)))
