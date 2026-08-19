// Recursive fib(27) in Rust.
fn fib(n: i32) -> i32 {
    if n < 2 {
        n
    } else {
        fib(n - 1) + fib(n - 2)
    }
}

#[no_mangle]
pub extern "C" fn main() -> i32 {
    fib(27)
}
