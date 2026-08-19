// Sum loop Rust benchmark.
#[no_mangle]
pub extern "C" fn main() -> i32 {
    let mut sum: i32 = 0;
    let mut i: i32 = 0;
    while i < 5000000 {
        if i % 3 == 0 {
            sum = sum.wrapping_add(i % 7);
        } else {
            sum = sum.wrapping_sub(i % 5);
        }
        i += 1;
    }
    sum.rem_euclid(256)
}
