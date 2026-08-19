// Hello World Rust standard library program.
static HELLO: &str = "Hello World";

#[no_mangle]
pub extern "C" fn main() -> *const u8 {
    HELLO.as_ptr()
}

#[no_mangle]
pub extern "C" fn get_len() -> usize {
    HELLO.len()
}
