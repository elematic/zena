// Minimal Rust `#![no_std]` program: main returns 42 without std runtime overhead.
#![no_std]
#![no_main]

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

#[no_mangle]
pub extern "C" fn main() -> i32 {
    42
}
