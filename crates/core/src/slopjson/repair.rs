//! String-level repair of escape and control-character hazards.

use std::{borrow::Cow, fmt::Write as _};

use crate::slopjson::is_valid_escape;

/// Flush the verbatim run `[last_emit, i)` into the (lazily allocated) output
/// and mark position `i` as consumed; the caller appends the replacement.
fn flush<'o>(
	out: &'o mut Option<String>,
	json: &str,
	last_emit: &mut usize,
	i: usize,
) -> &'o mut String {
	let out = out.get_or_insert_with(|| String::with_capacity(json.len() + 8));
	out.push_str(&json[*last_emit..i]);
	*last_emit = i + 1;
	out
}

/// Lightweight string-level repair of the escape/control-char hazards that
/// make otherwise-valid JSON fail a strict parse.
///
/// Raw control characters inside strings are escaped, and invalid `\x`
/// escapes have their backslash escaped. Returns the input borrowed and
/// unchanged when no repair is needed. Pure string→string; does not parse
/// structure.
pub fn repair_json(json: &str) -> Cow<'_, str> {
	let s = json.as_bytes();
	let n = s.len();
	let mut out: Option<String> = None;
	let mut last_emit = 0usize;
	let mut in_string = false;
	let mut i = 0usize;

	while i < n {
		if !in_string {
			// Fast scan: skip to next quote.
			match s[i..].iter().position(|&b| b == b'"') {
				Some(offset) => {
					i += offset + 1;
					in_string = true;
					continue;
				},
				None => break,
			}
		}

		// Fast scan inside string: advance past chars that need no handling.
		while i < n {
			let b = s[i];
			if b < 0x20 || b == b'"' || b == b'\\' {
				break;
			}
			i += 1;
		}
		if i >= n {
			break;
		}

		let b = s[i];

		if b == b'"' {
			in_string = false;
			i += 1;
			continue;
		}

		if b == b'\\' {
			// Need at least one char after the backslash; treat end-of-input as an
			// invalid escape.
			if i + 1 >= n {
				flush(&mut out, json, &mut last_emit, i).push_str("\\\\");
				i += 1;
				continue;
			}

			let next = s[i + 1];

			if next == b'u' {
				// Need full \uXXXX, all four digits, all hex.
				if i + 5 < n && s[i + 2..i + 6].iter().all(u8::is_ascii_hexdigit) {
					i += 6;
					continue;
				}
				// Truncated or non-hex \u — escape the backslash, re-process the rest.
				flush(&mut out, json, &mut last_emit, i).push_str("\\\\");
				i += 1;
				continue;
			}

			if is_valid_escape(next) {
				i += 2;
				continue;
			}

			flush(&mut out, json, &mut last_emit, i).push_str("\\\\");
			i += 1;
			continue;
		}

		// Control character (b < 0x20).
		let buf = flush(&mut out, json, &mut last_emit, i);
		match b {
			0x08 => buf.push_str("\\b"),
			0x09 => buf.push_str("\\t"),
			0x0a => buf.push_str("\\n"),
			0x0c => buf.push_str("\\f"),
			0x0d => buf.push_str("\\r"),
			_ => {
				let _ = write!(buf, "\\u{b:04x}");
			},
		}
		i += 1;
	}

	match out {
		None => Cow::Borrowed(json),
		Some(mut out) => {
			if last_emit < n {
				out.push_str(&json[last_emit..]);
			}
			Cow::Owned(out)
		},
	}
}
