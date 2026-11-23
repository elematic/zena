//! The clipboard: where copied text goes and pasted text comes from.
//!
//! A window uses the platform's, so text copied in a ZenaFX window can be
//! pasted into another program and the other way round. A scene with no
//! window, which is what a test has, uses one of its own that no other
//! program sees.
//!
//! Only the host reads and writes it. A component is never handed the
//! clipboard: copying takes the selection, which the host keeps, and pasting
//! reaches a text field as a key that types the pasted text.

/// Somewhere text can be copied to and pasted from.
pub trait Clipboard: Send {
    /// The text there is to paste, if what was last copied is text.
    fn read(&mut self) -> Option<String>;
    /// Make `text` what is pasted next.
    fn write(&mut self, text: &str);
}

/// A clipboard kept in the process, for a scene with no window.
#[derive(Default)]
pub struct Memory(Option<String>);

impl Clipboard for Memory {
    fn read(&mut self) -> Option<String> {
        self.0.clone()
    }

    fn write(&mut self, text: &str) {
        self.0 = Some(text.to_owned());
    }
}

/// The platform's clipboard.
pub struct System(arboard::Clipboard);

impl System {
    /// Reach the platform's clipboard. Fails where there is none to reach,
    /// as on a machine with no display.
    pub fn new() -> Result<Self, arboard::Error> {
        arboard::Clipboard::new().map(Self)
    }
}

impl Clipboard for System {
    fn read(&mut self) -> Option<String> {
        // What was copied may not be text, and another program may hold the
        // clipboard and not answer. Neither is worth more than no paste.
        self.0.get_text().ok()
    }

    fn write(&mut self, text: &str) {
        if let Err(e) = self.0.set_text(text) {
            log::warn!("could not copy to the clipboard: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_was_copied_is_what_is_pasted() {
        let mut clipboard = Memory::default();
        assert_eq!(clipboard.read(), None);

        clipboard.write("one");
        clipboard.write("two");

        assert_eq!(clipboard.read().as_deref(), Some("two"));
        assert_eq!(
            clipboard.read().as_deref(),
            Some("two"),
            "pasting takes nothing"
        );
    }
}
