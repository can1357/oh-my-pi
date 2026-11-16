//! Paste payload decoding.
//!
//! Some terminals re-encode the control bytes inside a bracketed paste as
//! key-event escape sequences (observed with tmux extended-keys passthrough
//! under kitty). tmux emits one of two formats depending on
//! `extended-keys-format`:
//!
//! - csi-u: `ESC [ <codepoint> ; 5 u` (Ctrl+J → `ESC [ 106 ; 5 u`)
//! - xterm: `ESC [ 27 ; 5 ; <codepoint> ~` (Ctrl+J → `ESC [ 27 ; 5 ; 106 ~`)
//!
//! [`decode_reencoded_controls`] turns these back into the literal control
//! byte (Ctrl+J → `\n`) before the payload leaves the engine; otherwise the
//! components' control-character stripping drops the ESC and the printable
//! tail (`[106;5u` / `[27;5;106~`) leaks into the buffer.
//!
//! Only Ctrl+<letter> is decoded (codepoint a-z/A-Z → 0x01..0x1A). That is the
//! set tmux actually re-encodes from paste content in practice — TAB (Ctrl+I),
//! LF (Ctrl+J), CR (Ctrl+M), VT (Ctrl+K), FF (Ctrl+L), … Non-letter Ctrl
//! combos (NUL, ESC, FS-US, DEL) never appear as re-encoded paste bytes, so
//! they are left untouched rather than synthesized into raw control bytes.
//! Components still strip leftover control characters (the editor keeps
//! `\n`; the single-line input strips all of them).

use std::borrow::Cow;

/// Decode tmux's re-encoded Ctrl+<letter> sequences (both
/// `extended-keys-format` variants) in a paste payload back to their literal
/// byte, leaving everything else untouched. Borrows when there is nothing to
/// decode.
pub fn decode_reencoded_controls(text: &str) -> Cow<'_, str> {
	let bytes = text.as_bytes();
	let Some(first) = memchr_esc(bytes, 0) else {
		return Cow::Borrowed(text);
	};
	let mut out = String::new();
	let mut copied = 0;
	let mut at = first;
	loop {
		if let Some((control, len)) = reencoded_control(&bytes[at..]) {
			if out.capacity() == 0 {
				out.reserve(text.len());
			}
			out.push_str(&text[copied..at]);
			out.push(char::from(control));
			at += len;
			copied = at;
		} else {
			at += 1;
		}
		match memchr_esc(bytes, at) {
			Some(next) => at = next,
			None => break,
		}
	}
	if copied == 0 {
		return Cow::Borrowed(text);
	}
	out.push_str(&text[copied..]);
	Cow::Owned(out)
}

fn memchr_esc(bytes: &[u8], from: usize) -> Option<usize> {
	bytes
		.get(from..)?
		.iter()
		.position(|&b| b == 0x1b)
		.map(|i| from + i)
}

/// The control byte and sequence length when `seq` starts with a re-encoded
/// Ctrl+<letter>: `ESC [ <cp> ; 5 u` or `ESC [ 27 ; 5 ; <cp> ~`.
fn reencoded_control(seq: &[u8]) -> Option<(u8, usize)> {
	let body = seq.strip_prefix(b"\x1b[")?;
	if let Some(rest) = body.strip_prefix(b"27;5;")
		&& let Some((cp, len)) = digits(rest)
		&& rest.get(len) == Some(&b'~')
		&& let Some(control) = letter_control(cp)
	{
		return Some((control, 2 + 5 + len + 1));
	}
	let (cp, len) = digits(body)?;
	if body.get(len..len + 3)? != b";5u" {
		return None;
	}
	letter_control(cp).map(|control| (control, 2 + len + 3))
}

/// Leading ASCII digits as a number (saturating), and how many there were.
fn digits(bytes: &[u8]) -> Option<(u32, usize)> {
	let len = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
	if len == 0 {
		return None;
	}
	let value = bytes[..len]
		.iter()
		.fold(0u32, |acc, &b| acc.saturating_mul(10).saturating_add(u32::from(b - b'0')));
	Some((value, len))
}

/// Ctrl+<letter> for an ASCII letter codepoint: a-z / A-Z → 0x01..0x1A.
const fn letter_control(cp: u32) -> Option<u8> {
	match cp {
		0x61..=0x7a => Some((cp - 0x60) as u8),
		0x41..=0x5a => Some((cp - 0x40) as u8),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::decode_reencoded_controls;

	fn decode(text: &str) -> String {
		decode_reencoded_controls(text).into_owned()
	}

	#[test]
	fn plain_text_is_borrowed() {
		assert!(matches!(decode_reencoded_controls("line1\nline2"), std::borrow::Cow::Borrowed(_)));
		assert!(matches!(decode_reencoded_controls("a\x1b[Ab"), std::borrow::Cow::Borrowed(_)));
	}

	#[test]
	fn decodes_xterm_format() {
		assert_eq!(decode("line1\x1b[27;5;106~line2"), "line1\nline2");
		assert_eq!(decode("x\x1b[27;5;97~y"), "x\x01y");
	}

	#[test]
	fn decodes_csi_u_format() {
		assert_eq!(decode("line1\x1b[106;5uline2"), "line1\nline2");
		assert_eq!(decode("a\x1b[105;5ub"), "a\tb");
		assert_eq!(decode("\x1b[109;5u"), "\r");
	}

	#[test]
	fn decodes_uppercase_letters() {
		assert_eq!(decode("\x1b[74;5u\x1b[27;5;77~"), "\n\r");
	}

	#[test]
	fn leaves_non_letter_controls_and_other_sequences() {
		// Ctrl+[ (ESC), Ctrl+@ (NUL), digits, and other modifiers stay as sent.
		for text in [
			"\x1b[91;5u",
			"\x1b[27;5;64~",
			"\x1b[49;5u",
			"\x1b[106;3u",
			"\x1b[27;2;106~",
			"\x1b[27;5u",
			"\x1b[106;5",
			"\x1b[99999999999999999999;5u",
			"\x1b",
		] {
			assert_eq!(decode(text), text);
		}
	}

	#[test]
	fn mixes_both_formats_and_untouched_escapes() {
		assert_eq!(decode("ab\x1b[27;5;106~cd\x1b[Ae\x1b[106;5uf"), "ab\ncd\x1b[Ae\nf");
	}
}
