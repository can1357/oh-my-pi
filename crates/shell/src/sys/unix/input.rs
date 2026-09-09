//! Terminal input utilities.

use crate::interfaces;

/// Translates a terminal key byte sequence into its abstract key.
///
/// Readline binding syntax uses the stable VT/xterm sequences below. Literal
/// printable bytes are returned as character keys; unknown terminal-specific
/// sequences remain byte bindings in the caller.
pub fn try_get_key_from_key_code(key_code: &[u8]) -> Option<interfaces::Key> {
	let key = match key_code {
		b"\r" | b"\n" => interfaces::Key::Enter,
		b"\x7f" | b"\x08" => interfaces::Key::Backspace,
		b"\x1b" => interfaces::Key::Escape,
		b"\t" => interfaces::Key::Tab,
		b"\x1b[Z" => interfaces::Key::BackTab,
		b"\x1b[A" | b"\x1bOA" => interfaces::Key::Up,
		b"\x1b[B" | b"\x1bOB" => interfaces::Key::Down,
		b"\x1b[C" | b"\x1bOC" => interfaces::Key::Right,
		b"\x1b[D" | b"\x1bOD" => interfaces::Key::Left,
		b"\x1b[H" | b"\x1bOH" | b"\x1b[1~" => interfaces::Key::Home,
		b"\x1b[F" | b"\x1bOF" | b"\x1b[4~" => interfaces::Key::End,
		b"\x1b[2~" => interfaces::Key::Insert,
		b"\x1b[3~" => interfaces::Key::Delete,
		b"\x1b[5~" => interfaces::Key::PageUp,
		b"\x1b[6~" => interfaces::Key::PageDown,
		b"\x1bOP" | b"\x1b[11~" => interfaces::Key::F(1),
		b"\x1bOQ" | b"\x1b[12~" => interfaces::Key::F(2),
		b"\x1bOR" | b"\x1b[13~" => interfaces::Key::F(3),
		b"\x1bOS" | b"\x1b[14~" => interfaces::Key::F(4),
		b"\x1b[15~" => interfaces::Key::F(5),
		b"\x1b[17~" => interfaces::Key::F(6),
		b"\x1b[18~" => interfaces::Key::F(7),
		b"\x1b[19~" => interfaces::Key::F(8),
		b"\x1b[20~" => interfaces::Key::F(9),
		b"\x1b[21~" => interfaces::Key::F(10),
		b"\x1b[23~" => interfaces::Key::F(11),
		b"\x1b[24~" => interfaces::Key::F(12),
		[byte] if !byte.is_ascii_control() => interfaces::Key::Character(*byte as char),
		_ => return None,
	};
	Some(key)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn recognizes_printable_and_navigation_sequences() {
		assert_eq!(try_get_key_from_key_code(b"a"), Some(interfaces::Key::Character('a')));
		assert_eq!(try_get_key_from_key_code(b"\x1b[A"), Some(interfaces::Key::Up));
		assert_eq!(try_get_key_from_key_code(b"\x1b[24~"), Some(interfaces::Key::F(12)));
	}
}
