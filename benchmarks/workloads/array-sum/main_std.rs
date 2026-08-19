// Array sum Rust standard library benchmark.
#[no_mangle]
pub extern "C" fn main() -> i32 {
    let xs = [1, 2, 3];
    let mut total = 0;
    for &x in &xs {
        total += x;
    }
    total
}
