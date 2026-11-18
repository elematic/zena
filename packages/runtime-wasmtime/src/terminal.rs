//! `zena:host/terminal`: raw mode for stdin's terminal, and the size of
//! stdout's.
//!
//! Raw mode is what a program that asks its user questions needs: each
//! key reaches stdin as it is pressed, without echo or line editing,
//! and the program reads it through `wasi:cli/stdin` like any other
//! input. The settings are libuv's (`uv_tty_set_mode` with
//! `UV_TTY_MODE_RAW`), which Node.js uses for `setRawMode`, so a prompt
//! written for Node.js sees the same bytes here. Output processing stays
//! on, so a line feed still starts a new line.
//!
//! A terminal has one mode, so there is one [`RawMode`] at a time, and
//! the settings it replaced are kept in a process-wide slot. Dropping it
//! restores them, and so does an `atexit` handler, since the binaries
//! end with `std::process::exit` while the store that holds the
//! resource is still alive.

/// Stdin's terminal in raw mode, until this is dropped.
pub struct RawMode {
    _private: (),
}

impl RawMode {
    /// Puts stdin's terminal in raw mode.
    pub fn enter() -> Result<RawMode, String> {
        imp::enter(imp::STDIN).map(|()| RawMode { _private: () })
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        imp::leave();
    }
}

/// The columns and rows of stdout's terminal, or `None` when stdout is
/// not a terminal.
pub fn stdout_size() -> Option<(u16, u16)> {
    imp::size(imp::STDOUT)
}

#[cfg(unix)]
mod imp {
    use std::sync::{Mutex, Once};

    pub const STDIN: libc::c_int = libc::STDIN_FILENO;
    pub const STDOUT: libc::c_int = libc::STDOUT_FILENO;

    /// The terminal in raw mode and the settings raw mode replaced, while
    /// a [`super::RawMode`] is held.
    static SAVED: Mutex<Option<(libc::c_int, libc::termios)>> = Mutex::new(None);

    static AT_EXIT: Once = Once::new();

    pub fn enter(fd: libc::c_int) -> Result<(), String> {
        let mut saved = SAVED.lock().unwrap_or_else(|e| e.into_inner());
        if saved.is_some() {
            return Err("the terminal is already in raw mode".into());
        }
        // SAFETY: `isatty`, `tcgetattr` and `tcsetattr` only read and
        // write the `termios` passed to them, which lives on this stack
        // frame.
        unsafe {
            if libc::isatty(fd) != 1 {
                return Err("stdin is not a terminal".into());
            }
            let mut original: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(fd, &mut original) != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut raw = original;
            raw.c_iflag &= !(libc::BRKINT | libc::ICRNL | libc::INPCK | libc::ISTRIP | libc::IXON);
            raw.c_oflag |= libc::ONLCR;
            raw.c_cflag |= libc::CS8;
            raw.c_lflag &= !(libc::ECHO | libc::ICANON | libc::IEXTEN | libc::ISIG);
            raw.c_cc[libc::VMIN] = 1;
            raw.c_cc[libc::VTIME] = 0;
            if libc::tcsetattr(fd, libc::TCSADRAIN, &raw) != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            *saved = Some((fd, original));
        }
        AT_EXIT.call_once(|| {
            // SAFETY: `restore_at_exit` is an `extern "C"` function that
            // never unwinds.
            unsafe {
                libc::atexit(restore_at_exit);
            }
        });
        Ok(())
    }

    pub fn leave() {
        let mut saved = SAVED.lock().unwrap_or_else(|e| e.into_inner());
        restore(&mut saved);
    }

    fn restore(saved: &mut Option<(libc::c_int, libc::termios)>) {
        if let Some((fd, original)) = saved.take() {
            // SAFETY: as in `enter`.
            unsafe {
                libc::tcsetattr(fd, libc::TCSADRAIN, &original);
            }
        }
    }

    /// Restores the terminal when the process exits holding raw mode.
    /// It only tries the lock: a thread that holds it is restoring the
    /// terminal itself.
    extern "C" fn restore_at_exit() {
        if let Ok(mut saved) = SAVED.try_lock() {
            restore(&mut saved);
        }
    }

    pub fn size(fd: libc::c_int) -> Option<(u16, u16)> {
        // SAFETY: `TIOCGWINSZ` writes only the `winsize` passed to it.
        unsafe {
            if libc::isatty(fd) != 1 {
                return None;
            }
            let mut size: libc::winsize = std::mem::zeroed();
            if libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) != 0 || size.ws_col == 0 {
                return None;
            }
            Some((size.ws_col, size.ws_row))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// A pseudo-terminal's two ends, closed when dropped.
        struct Pty {
            controller: libc::c_int,
            terminal: libc::c_int,
        }

        impl Pty {
            fn open() -> Pty {
                let (mut controller, mut terminal) = (0, 0);
                // SAFETY: `openpty` writes the two descriptors and reads
                // the null name, settings and size as "none". `termp` and
                // `winp` are `*const` on Linux and `*mut` on BSD/macOS.
                let opened = unsafe {
                    libc::openpty(
                        &mut controller,
                        &mut terminal,
                        std::ptr::null_mut(),
                        std::ptr::null_mut::<libc::termios>() as _,
                        std::ptr::null_mut::<libc::winsize>() as _,
                    )
                };
                assert_eq!(opened, 0, "openpty: {}", std::io::Error::last_os_error());
                Pty {
                    controller,
                    terminal,
                }
            }

            fn settings(&self) -> libc::termios {
                // SAFETY: as in `enter`.
                unsafe {
                    let mut settings: libc::termios = std::mem::zeroed();
                    assert_eq!(libc::tcgetattr(self.terminal, &mut settings), 0);
                    settings
                }
            }
        }

        impl Drop for Pty {
            fn drop(&mut self) {
                // SAFETY: closes the descriptors `openpty` opened.
                unsafe {
                    libc::close(self.terminal);
                    libc::close(self.controller);
                }
            }
        }

        /// One test, since raw mode is one process-wide slot.
        #[test]
        fn raw_mode_is_entered_once_and_restored() {
            let pty = Pty::open();
            let before = pty.settings();
            assert_ne!(before.c_lflag & libc::ECHO, 0);
            assert_ne!(before.c_lflag & libc::ICANON, 0);

            enter(pty.terminal).unwrap();
            let raw = pty.settings();
            assert_eq!(raw.c_lflag & (libc::ECHO | libc::ICANON | libc::ISIG), 0);
            assert_eq!(raw.c_iflag & libc::ICRNL, 0);
            assert_ne!(raw.c_oflag & libc::ONLCR, 0);
            assert_eq!(raw.c_cc[libc::VMIN], 1);
            assert_eq!(
                enter(pty.terminal).unwrap_err(),
                "the terminal is already in raw mode"
            );

            leave();
            let after = pty.settings();
            // BSD/macOS sets `PENDIN` in `c_lflag` when `ICANON` changes.
            assert_eq!(
                after.c_lflag & !libc::PENDIN,
                before.c_lflag & !libc::PENDIN
            );
            assert_eq!(after.c_iflag, before.c_iflag);
            leave();

            // SAFETY: `pipe` writes the two descriptors it opens.
            let mut pipe = [0; 2];
            assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
            assert_eq!(enter(pipe[0]).unwrap_err(), "stdin is not a terminal");
            assert_eq!(size(pipe[1]), None);
            // SAFETY: closes the descriptors `pipe` opened.
            unsafe {
                libc::close(pipe[0]);
                libc::close(pipe[1]);
            }
        }
    }
}

#[cfg(not(unix))]
mod imp {
    pub const STDIN: i32 = 0;
    pub const STDOUT: i32 = 1;

    pub fn enter(_fd: i32) -> Result<(), String> {
        Err("raw mode is not supported on this platform".into())
    }

    pub fn leave() {}

    pub fn size(_fd: i32) -> Option<(u16, u16)> {
        None
    }
}
