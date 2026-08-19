// Array sum Rust `#![no_std]` benchmark.
#![no_std]
#![no_main]

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

#[no_mangle]
pub extern "C" fn main() -> i32 {
    let xs = [1, 2, 3];
    let mut total = 0;
    for &x in &xs {
        total += x;
    }
    total
}
