// Hello World Rust `#![no_std]` program: returns string literal pointer.
#![no_std]
#![no_main]

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

static HELLO: &[u8] = b"Hello World\0";

#[no_mangle]
pub extern "C" fn main() -> *const u8 {
    HELLO.as_ptr()
}

#[no_mangle]
pub extern "C" fn get_len() -> usize {
    11
}
