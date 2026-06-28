//! Terminal input utilities

use crate::{error, interfaces};

/// Translates a key code (byte sequence) into a `Key` enum value. Returns
/// `None` if the key code is not recognized.
///
/// This is a stub implementation that recognizes single-byte non-control
/// characters but does not support terminal-specific key sequences.
pub fn try_get_key_from_key_code(key_code: &[u8]) -> Option<interfaces::Key> {
	if key_code.len() == 1 && !key_code[0].is_ascii_control() {
		Some(interfaces::Key::Character(key_code[0] as char))
	} else {
		None
	}
}
