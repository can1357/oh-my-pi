use std::mem;
/// Incrementally withholds only a trailing byte sequence that can still become
/// a placeholder.
#[derive(Debug, Default)]
pub struct PlaceholderStream {
	pending: String,
}

impl PlaceholderStream {
	/// Creates an empty placeholder-aware stream buffer.
	pub const fn new() -> Self {
		Self { pending: String::new() }
	}

	/// Appends a provider delta and returns every prefix that is safe to publish
	/// now.
	pub fn push(&mut self, delta: &str) -> String {
		self.pending.push_str(delta);
		let keep = possible_placeholder_suffix_len(&self.pending);
		let emit_len = self.pending.len() - keep;
		let suffix = self.pending.split_off(emit_len);
		mem::replace(&mut self.pending, suffix)
	}

	/// Flushes any terminal literal suffix that never completed a placeholder.
	pub fn finish(&mut self) -> String {
		mem::take(&mut self.pending)
	}

	/// Returns the currently withheld possible placeholder prefix.
	pub fn pending(&self) -> &str {
		&self.pending
	}
}

fn possible_placeholder_suffix_len(text: &str) -> usize {
	let bytes = text.as_bytes();
	if let Some(before_close) = text.strip_suffix("$$")
		&& let Some(open) = before_close.rfind("$$")
		&& complete_body(&before_close[open + 2..])
	{
		return 0;
	}
	if bytes.last() == Some(&b'$') && (bytes.len() == 1 || bytes[bytes.len() - 2] != b'$') {
		if let Some(start) = text.rfind("$$")
			&& possible_body_prefix(&text[start + 2..])
		{
			return text.len() - start;
		}
		return 1;
	}
	let mut end = text.len();
	while let Some(start) = text[..end].rfind("$$") {
		if possible_body_prefix(&text[start + 2..]) {
			return text.len() - start;
		}
		end = start;
	}
	0
}

fn possible_body_prefix(body: &str) -> bool {
	if body.is_empty() {
		return true;
	}
	let bytes = body.as_bytes();
	let mut underscore = None;
	let mut colon = None;
	for (index, &byte) in bytes.iter().enumerate() {
		match byte {
			b'A'..=b'Z' | b'0'..=b'9' => {},
			b'_' if underscore.is_none() && colon.is_none() && index > 0 => underscore = Some(index),
			b':' if colon.is_none() => colon = Some(index),
			b'$' if index + 1 == bytes.len() => return complete_body(&body[..index]),
			_ => return false,
		}
	}
	if let Some(colon) = colon {
		let base_start = underscore.map_or(0, |index| index + 1);
		if colon == base_start || bytes.len() > colon + 2 {
			return false;
		}
		return colon + 1 == bytes.len() || matches!(bytes[colon + 1], b'U' | b'L' | b'C' | b'M');
	}
	true
}

fn complete_body(body: &str) -> bool {
	let (prefix_and_base, hint) = body
		.split_once(':')
		.map_or((body, None), |parts| (parts.0, Some(parts.1)));
	let base = prefix_and_base
		.rsplit_once('_')
		.map_or(prefix_and_base, |parts| parts.1);
	base.len() >= 4
		&& base
			.bytes()
			.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
		&& hint.is_none_or(|hint| matches!(hint, "U" | "L" | "C" | "M"))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn withholds_across_every_boundary_and_flushes_literals() {
		let placeholder = "$$TOKEN_ABCD1234:U$$";
		for split in 1..placeholder.len() {
			let mut stream = PlaceholderStream::new();
			assert_eq!(stream.push(&placeholder[..split]), "", "split {split}");
			let emitted = stream.push(&placeholder[split..]);
			assert_eq!(emitted, placeholder, "split {split}");
			assert_eq!(stream.finish(), "");
		}
		let mut stream = PlaceholderStream::new();
		assert_eq!(stream.push("literal $"), "literal ");
		assert_eq!(stream.finish(), "$");
	}

	#[test]
	fn publishes_invalid_candidate_without_stalling() {
		let mut stream = PlaceholderStream::new();
		assert_eq!(stream.push("before $$BAD-name"), "before $$BAD-name");
		assert_eq!(stream.finish(), "");
	}
}
