;; Never returns, so only a time limit ends it.
(module
  (func (export "main") (result i32)
    (loop $forever (br $forever))
    (i32.const 0)))
