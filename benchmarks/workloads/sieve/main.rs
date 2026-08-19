// Sieve of Eratosthenes Rust benchmark.
#[no_mangle]
pub extern "C" fn main() -> i32 {
    const N: usize = 300000;
    // Static / heap or stack array
    static mut COMPOSITE: [bool; N + 1] = [false; N + 1];
    let mut count = 0;
    let mut i = 2;
    unsafe {
        while i <= N {
            if !COMPOSITE[i] {
                count += 1;
                let mut j = i + i;
                while j <= N {
                    COMPOSITE[j] = true;
                    j += i;
                }
            }
            i += 1;
        }
    }
    count % 256
}
