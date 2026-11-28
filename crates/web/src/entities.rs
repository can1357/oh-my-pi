//! Decoding of HTML character references.
//!
//! A clean-room replacement for the `decode_html_entities` half of the
//! `html-escape` crate, matching its 0.3.0 behavior: only exact named and
//! numeric character references terminated with `;` are decoded, the legacy
//! semicolonless forms and the C1 control replacements of the browser
//! tokenizer are left to the caller, and invalid code points (NUL, other C0
//! controls except ASCII whitespace, surrogates, out-of-range values) are left
//! unchanged. The named table comes from `html5ever`, which ships the WHATWG
//! entity list.

use std::borrow::Cow;

/// Longest HTML named entity plus the terminating `;`, so a name and its
/// terminator always fit the lookup buffer.
const MAX_ENTITY_NAME: usize = 32;

/// A decoded character reference: one or two code points, or a single char
/// from a numeric reference.
enum Decoded {
	/// Named entities may expand to two code points (`&NotEqualTilde;`).
	Codepoints(u32, u32),
	/// A numeric reference resolves to a single character.
	Character(char),
}

/// Rejects the code points a numeric reference may not name: surrogates and
/// out-of-range values fail `char::try_from`, and NUL plus the other C0
/// controls are dropped, but the ASCII whitespace controls are allowed.
fn decode_character(number: u32) -> Option<char> {
	let character = char::try_from(number).ok()?;
	match character {
		'\t' | '\n' | '\u{000C}' | '\r' => Some(character),
		'\0'..='\u{001F}' => None,
		_ => Some(character),
	}
}

/// Looks up a `;`-terminated named entity, e.g. `gt`, and returns its code
/// points. Prefix-only entries map to zero and are treated as unknown.
fn decode_named(name: &str) -> Option<Decoded> {
	let length = name.len();
	if length == 0 || length + 1 > MAX_ENTITY_NAME {
		return None;
	}
	let mut buffer = [0u8; MAX_ENTITY_NAME];
	buffer[..length].copy_from_slice(name.as_bytes());
	buffer[length] = b';';
	let key = std::str::from_utf8(&buffer[..=length]).ok()?;
	let &(first, second) = html5ever::data::NAMED_ENTITIES.get(key)?;
	if first == 0 {
		return None;
	}
	Some(Decoded::Codepoints(first, second))
}

/// Parses a decimal numeric reference body (the digits between `#` and `;`).
fn decode_decimal(digits: &str) -> Option<Decoded> {
	if !digits.as_bytes().first()?.is_ascii_digit() {
		return None;
	}
	decode_character(digits.parse::<u32>().ok()?).map(Decoded::Character)
}

/// Parses a hexadecimal numeric reference body (the digits between `#x` and
/// `;`).
fn decode_hex(digits: &str) -> Option<Decoded> {
	if !digits.as_bytes().first()?.is_ascii_hexdigit() {
		return None;
	}
	let value = u32::from_str_radix(digits, 16).ok()?;
	decode_character(value).map(Decoded::Character)
}

/// Reads the body of a reference from `digits_start` up to the next `;`,
/// returning `None` unless a `;` terminates it before the next `&` or the end.
const fn digits_to_semicolon(bytes: &[u8], digits_start: usize) -> Option<usize> {
	let length = bytes.len();
	let mut p = digits_start;
	while p < length && bytes[p] != b';' && bytes[p] != b'&' {
		p += 1;
	}
	if p < length && bytes[p] == b';' {
		Some(p)
	} else {
		None
	}
}

/// Parses the character reference beginning at the `&` at `amp`, returning the
/// byte index just past its `;` and the decoded value.
///
/// A failed parse returns `None`; the caller then resumes the search after this
/// `&`, which reproduces the reference scanner's restart on a nested `&`.
fn parse_entity(text: &str, amp: usize) -> Option<(usize, Decoded)> {
	let bytes = text.as_bytes();
	let length = bytes.len();
	let mut p = amp + 1;
	if p >= length {
		return None;
	}

	match bytes[p] {
		// `&&` starts no reference here, and `&;` names nothing.
		b'&' | b';' => None,
		b'#' => {
			p += 1;
			if p >= length {
				return None;
			}
			match bytes[p] {
				b'&' | b';' => None,
				b'x' | b'X' => {
					p += 1;
					if p >= length {
						return None;
					}
					match bytes[p] {
						b'&' | b';' => None,
						_ => {
							let end = digits_to_semicolon(bytes, p)?;
							let value = decode_hex(&text[p..end])?;
							Some((end + 1, value))
						},
					}
				},
				_ => {
					let end = digits_to_semicolon(bytes, p)?;
					let value = decode_decimal(&text[p..end])?;
					Some((end + 1, value))
				},
			}
		},
		_ => {
			let end = digits_to_semicolon(bytes, p)?;
			let value = decode_named(&text[p..end])?;
			Some((end + 1, value))
		},
	}
}

/// Finds the next decodable character reference at or after `start`, returning
/// its byte range `[start, end)` and decoded value.
fn find_entity(text: &str, start: usize) -> Option<(usize, usize, Decoded)> {
	let bytes = text.as_bytes();
	let mut p = start;
	loop {
		while p < bytes.len() && bytes[p] != b'&' {
			p += 1;
		}
		if p >= bytes.len() {
			return None;
		}
		if let Some((end, value)) = parse_entity(text, p) {
			return Some((p, end, value));
		}
		p += 1;
	}
}

/// Decodes HTML character references in `text`.
///
/// Returns [`Cow::Borrowed`] when nothing was decoded, so callers can tell
/// whether the input changed. Only references terminated with `;` are decoded;
/// everything else is copied through unchanged.
pub fn decode_html_entities(text: &str) -> Cow<'_, str> {
	let Some((first_start, first_end, first)) = find_entity(text, 0) else {
		return Cow::Borrowed(text);
	};

	let mut out = String::with_capacity(text.len());
	out.push_str(&text[..first_start]);
	push_decoded(&mut out, first);

	let mut start = first_end;
	while let Some((entity_start, entity_end, value)) = find_entity(text, start) {
		out.push_str(&text[start..entity_start]);
		push_decoded(&mut out, value);
		start = entity_end;
	}
	out.push_str(&text[start..]);
	Cow::Owned(out)
}

/// Appends a decoded reference to `out`.
fn push_decoded(out: &mut String, value: Decoded) {
	match value {
		Decoded::Codepoints(first, second) => {
			out.extend(char::from_u32(first));
			if second != 0 {
				out.extend(char::from_u32(second));
			}
		},
		Decoded::Character(character) => out.push(character),
	}
}

#[cfg(test)]
mod tests {
	use std::borrow::Cow;

	use super::decode_html_entities;

	/// Decodes to an owned `String` for the string comparisons.
	fn d(text: &str) -> String {
		decode_html_entities(text).into_owned()
	}

	#[test]
	fn named_with_semicolon() {
		assert_eq!(d("a &amp; b &gt; c"), "a & b > c");
	}

	#[test]
	fn legacy_without_semicolon_is_untouched() {
		// Unlike the browser tokenizer, only `;`-terminated references decode.
		assert_eq!(decode_html_entities("a &gt b"), Cow::Borrowed("a &gt b"));
		assert_eq!(decode_html_entities("&amp"), Cow::Borrowed("&amp"));
	}

	#[test]
	fn multi_codepoint_named() {
		// U+2242 (≂) followed by U+0338 (combining long solidus overlay).
		assert_eq!(d("&NotEqualTilde;"), "\u{2242}\u{0338}");
	}

	#[test]
	fn decimal_and_hex() {
		assert_eq!(d("&#65;&#x42;"), "AB");
		assert_eq!(d("&#X4a;"), "J");
	}

	#[test]
	fn invalid_numbers_are_untouched() {
		assert_eq!(decode_html_entities("&#0;"), Cow::Borrowed("&#0;"));
		assert_eq!(decode_html_entities("&#xD800;"), Cow::Borrowed("&#xD800;"));
		assert_eq!(decode_html_entities("&#x;"), Cow::Borrowed("&#x;"));
	}

	#[test]
	fn unknown_name_is_untouched() {
		assert_eq!(decode_html_entities("&bogus;"), Cow::Borrowed("&bogus;"));
	}

	#[test]
	fn borrowed_without_entities() {
		assert!(matches!(decode_html_entities("plain text"), Cow::Borrowed(_)));
	}

	#[test]
	fn owned_round_trip_ranges() {
		assert_eq!(d("x&amp;y&lt;z"), "x&y<z");
	}
}
