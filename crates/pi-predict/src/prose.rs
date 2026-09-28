//! Prose gating shared by the engines: which words of a prompt are
//! completable prose, and whether a prompt looks typed rather than pasted.
//!
//! Mirrors the production gates (`maskNonProse` in
//! `packages/tui/src/prompt/markdown-prose.ts`, `isProseWord` in
//! `packages/tui/src/prompt/macos-spelling.ts`) so engines learn exactly the
//! words the editor asks them to complete. TypeScript measures lengths in
//! UTF-16 units; the length caps here do the same. Offsets are byte offsets
//! into the UTF-8 text.

use std::borrow::Cow;

/// Prompts longer than this (UTF-16 units) get no completion at all.
const MAX_BUFFER: usize = 20_000;
/// Lines longer than this (UTF-16 units) get no completion.
const MAX_LINE: usize = 1_000;
/// A word touching any of these characters is code, not prose.
const CODEISH: &[char] = &['\\', '/', '@', '_', '=', ':', '{', '}', '[', ']', '<', '>'];

/// JavaScript `\s`: the characters `String.prototype.trim` strips.
pub const fn is_js_space(c: char) -> bool {
	matches!(
		c,
		'\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
			..='\u{200A}'
				| '\u{2028}'
				| '\u{2029}'
				| '\u{202F}'
				| '\u{205F}'
				| '\u{3000}'
				| '\u{FEFF}'
	)
}

/// `[\p{L}\p{M}]`: a letter or combining mark.
pub fn is_letter(c: char) -> bool {
	if c.is_ascii() {
		return c.is_ascii_alphabetic();
	}
	c.is_alphabetic() || is_mark(c)
}

/// `[\p{L}\p{M}']`: a character of a completable word.
pub fn is_word_char(c: char) -> bool {
	c == '\'' || is_letter(c)
}

/// Combining marks (`\p{M}`) that the `Alphabetic` property misses: the
/// general-purpose combining blocks plus variation selectors.
const fn is_mark(c: char) -> bool {
	matches!(
		c,
		'\u{0300}'..='\u{036F}'
			| '\u{0483}'..='\u{0489}'
			| '\u{0591}'..='\u{05BD}'
			| '\u{0610}'..='\u{061A}'
			| '\u{064B}'..='\u{065F}'
			| '\u{0900}'..='\u{0903}'
			| '\u{093A}'..='\u{094F}'
			| '\u{1AB0}'..='\u{1AFF}'
			| '\u{1DC0}'..='\u{1DFF}'
			| '\u{20D0}'..='\u{20FF}'
			| '\u{302A}'..='\u{302F}'
			| '\u{3099}'..='\u{309A}'
			| '\u{FE00}'..='\u{FE0F}'
			| '\u{FE20}'..='\u{FE2F}'
	)
}

fn utf16_len(text: &str) -> usize {
	text.chars().map(char::len_utf16).sum()
}

fn is_blank(text: &str) -> bool {
	text.chars().all(is_js_space)
}

/// Markdown fence opener (up to 3 spaces, then 3+ backticks or tildes):
/// returns the indent and marker byte lengths.
fn fence_open(line: &[u8]) -> Option<(usize, usize)> {
	let indent = line.iter().take(4).take_while(|&&b| b == b' ').count();
	if indent > 3 {
		return None;
	}
	let marker = line[indent..]
		.iter()
		.take_while(|&&b| b == b'`' || b == b'~')
		.count();
	(marker >= 3).then_some((indent, marker))
}

/// `[A-Za-z][A-Za-z0-9-]*` at `at`; returns the end of the name.
fn tag_name_end(text: &[u8], at: usize) -> Option<usize> {
	if !text.get(at).is_some_and(u8::is_ascii_alphabetic) {
		return None;
	}
	let mut end = at + 1;
	while text
		.get(end)
		.is_some_and(|&b| b.is_ascii_alphanumeric() || b == b'-')
	{
		end += 1;
	}
	Some(end)
}

fn backtick_run_end(text: &[u8], mut i: usize) -> usize {
	while text.get(i) == Some(&b'`') {
		i += 1;
	}
	i
}

/// End of the closing backtick run of exactly `run` backticks, skipping masked
/// bytes.
fn find_backtick_close(text: &[u8], from: usize, run: usize, masked: &[bool]) -> Option<usize> {
	let mut k = from;
	while k < text.len() {
		if masked[k] {
			k += 1;
		} else if text[k] == b'`' {
			let end = backtick_run_end(text, k);
			if end - k == run {
				return Some(end);
			}
			k = end;
		} else {
			k += 1;
		}
	}
	None
}

/// Index of the `>` closing a tag whose attributes start at `from`, honoring
/// quotes.
fn find_tag_end(text: &[u8], from: usize) -> Option<usize> {
	let mut quote = 0u8;
	for (k, &b) in text.iter().enumerate().skip(from) {
		if quote != 0 {
			if b == quote {
				quote = 0;
			}
			continue;
		}
		match b {
			b'"' | b'\'' => quote = b,
			b'>' => return Some(k),
			b'<' => return None,
			_ => {},
		}
	}
	None
}

/// End (past `>`) of the `</name>` balancing an opening `<name>`, counting
/// nesting.
fn find_matching_close(text: &[u8], start: usize, name: &[u8], masked: &[bool]) -> Option<usize> {
	let mut depth = 1usize;
	let mut k = start;
	while k < text.len() {
		if masked[k] || text[k] != b'<' {
			k += 1;
			continue;
		}
		let mut m = k + 1;
		let closing = text.get(m) == Some(&b'/');
		if closing {
			m += 1;
		}
		let Some(name_end) = tag_name_end(text, m) else {
			k += 1;
			continue;
		};
		let Some(gt) = find_tag_end(text, name_end) else {
			k += 1;
			continue;
		};
		if text[m..name_end].eq_ignore_ascii_case(name) {
			if closing {
				depth -= 1;
				if depth == 0 {
					return Some(gt + 1);
				}
			} else if text[gt - 1] != b'/' {
				depth += 1;
			}
		}
		k = gt + 1;
	}
	None
}

/// Mask the HTML/XML construct at `<` (index `i`); returns the end of the
/// masked region, or `i` when the `<` starts no tag.
fn mask_tag_at(text: &[u8], i: usize, masked: &mut [bool]) -> usize {
	let n = text.len();
	if text[i..].starts_with(b"<!--") {
		let stop = text[i + 4..]
			.windows(3)
			.position(|w| w == b"-->")
			.map_or(n, |at| i + 4 + at + 3);
		masked[i..stop].fill(true);
		return stop;
	}
	let mut j = i + 1;
	let closing = text.get(j) == Some(&b'/');
	if closing {
		j += 1;
	}
	let Some(name_end) = tag_name_end(text, j) else {
		return i;
	};
	let Some(gt) = find_tag_end(text, name_end) else {
		return i;
	};
	let tag_end = gt + 1;
	masked[i..tag_end].fill(true);
	if closing || text[gt - 1] == b'/' {
		return tag_end;
	}
	let Some(close) = find_matching_close(text, tag_end, &text[j..name_end], masked) else {
		return tag_end;
	};
	masked[tag_end..close].fill(true);
	close
}

/// Copy of `text` with fenced code, inline code, and HTML/XML blanked out.
///
/// Masked characters become spaces (newlines kept), one per UTF-8 byte, so
/// byte offsets are preserved. Returns the input unchanged when nothing can
/// open such a region.
pub fn mask_non_prose(text: &str) -> Cow<'_, str> {
	if !text.contains('`') && !text.contains('<') && !text.contains("~~~") {
		return Cow::Borrowed(text);
	}
	let bytes = text.as_bytes();
	let n = bytes.len();
	let mut masked = vec![false; n];

	// Phase 1: fenced code blocks, line by line.
	let mut fence_char = 0u8;
	let mut fence_len = 0usize;
	let mut line_start = 0usize;
	loop {
		let nl = bytes[line_start..]
			.iter()
			.position(|&b| b == b'\n')
			.map_or(n, |at| line_start + at);
		let line = &bytes[line_start..nl];
		let open = fence_open(line);
		if fence_char != 0 {
			masked[line_start..nl].fill(true);
			if let Some((indent, marker)) = open
				&& line[indent] == fence_char
				&& marker >= fence_len
				&& is_blank(&text[line_start + indent + marker..nl])
			{
				fence_char = 0;
				fence_len = 0;
			}
		} else if let Some((indent, marker)) = open {
			let ch = line[indent];
			// A backtick fence's info string may not contain a backtick.
			if !(ch == b'`' && line[indent + marker..].contains(&b'`')) {
				fence_char = ch;
				fence_len = marker;
				masked[line_start..nl].fill(true);
			}
		}
		if nl == n {
			break;
		}
		line_start = nl + 1;
	}

	// Phase 2: inline code spans and HTML/XML over the rest.
	let mut i = 0usize;
	while i < n {
		if masked[i] {
			i += 1;
			continue;
		}
		match bytes[i] {
			b'`' => {
				let run_end = backtick_run_end(bytes, i);
				if let Some(close) = find_backtick_close(bytes, run_end, run_end - i, &masked) {
					masked[i..close].fill(true);
					i = close;
				} else {
					i = run_end;
				}
			},
			b'<' => {
				let end = mask_tag_at(bytes, i, &mut masked);
				i = if end > i { end } else { i + 1 };
			},
			_ => i += 1,
		}
	}

	let mut out = bytes.to_vec();
	for (byte, &hidden) in out.iter_mut().zip(&masked) {
		if hidden && *byte != b'\n' {
			*byte = b' ';
		}
	}
	// Masked regions start and end at ASCII delimiters, so every multi-byte
	// character is replaced whole and the result stays UTF-8.
	Cow::Owned(
		String::from_utf8(out)
			.unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned()),
	)
}

/// Share of non-whitespace characters (UTF-16 weighted) that survive
/// [`mask_non_prose`]; 0 for blank text.
pub fn prose_fraction(text: &str) -> f64 {
	let masked = mask_non_prose(text);
	let mut total = 0usize;
	let mut prose = 0usize;
	for ((_, c), m) in text.char_indices().zip(masked.chars()) {
		if is_js_space(c) {
			continue;
		}
		let units = c.len_utf16();
		total += units;
		if m != ' ' {
			prose += units;
		}
	}
	if total == 0 {
		0.0
	} else {
		prose as f64 / total as f64
	}
}

/// Shape rule for "a human typed this": `min..=max` UTF-16 units, at most 25
/// lines of at most 600 units each, not a slash command, ≥ 60 % prose.
fn looks_typed(prompt: &str, max: usize) -> bool {
	let len = utf16_len(prompt);
	if !(8..=max).contains(&len) {
		return false;
	}
	let mut lines = 0usize;
	for line in prompt.split('\n') {
		lines += 1;
		if lines > 25 || utf16_len(line) > 600 {
			return false;
		}
	}
	if prompt.trim_start_matches(is_js_space).starts_with('/') {
		return false;
	}
	prose_fraction(prompt) >= 0.6
}

/// The eval's typed-like rule (`build-dataset.ts`): 8–1500 UTF-16 units, ≤ 25
/// lines, no line over 600, not a slash command, ≥ 60 % prose.
pub fn is_typed_like(prompt: &str) -> bool {
	looks_typed(prompt, 1500)
}

/// The paste filter for learned vocabulary: [`is_typed_like`] with a
/// 5000-unit cap, so long hand-written prompts still count.
pub fn is_learnable(prompt: &str) -> bool {
	looks_typed(prompt, 5000)
}

/// One completable prose word of a prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProseWord {
	/// Byte offset of the word in the prompt.
	pub start: usize,
	/// Byte offset just past the word.
	pub end:   usize,
}

/// `[\p{L}\p{M}']+` matches of `line` as byte ranges.
fn word_spans(line: &str) -> impl Iterator<Item = (usize, usize)> + '_ {
	let mut chars = line.char_indices().peekable();
	std::iter::from_fn(move || {
		let start = loop {
			let (at, c) = chars.next()?;
			if is_word_char(c) {
				break at;
			}
		};
		let mut end = line.len();
		while let Some(&(at, c)) = chars.peek() {
			if !is_word_char(c) {
				end = at;
				break;
			}
			chars.next();
		}
		Some((start, end))
	})
}

/// Line-level `isProseWord`: the word survives the mask, its
/// whitespace-delimited token has no code characters, digits or camelCase,
/// and the line is not a slash command or an arrow.
fn is_prose_word(line: &str, masked_line: &str, start: usize, end: usize) -> bool {
	if is_blank(&masked_line[start..end]) {
		return false;
	}
	let token_start = line[..start]
		.char_indices()
		.rev()
		.find(|&(_, c)| is_js_space(c))
		.map_or(0, |(at, c)| at + c.len_utf8());
	let token_end = line[end..]
		.find(is_js_space)
		.map_or(line.len(), |at| end + at);
	let token = &line[token_start..token_end];
	let mut previous_lower = false;
	for c in token.chars() {
		if CODEISH.contains(&c) || c.is_ascii_digit() {
			return false;
		}
		if previous_lower && c.is_uppercase() {
			return false;
		}
		previous_lower = c.is_lowercase();
	}
	!line.trim_start_matches(is_js_space).starts_with('/')
		&& !line.starts_with("->")
		&& !line.starts_with("=>")
}

/// Every word of `prompt` the editor would offer completion for: line-level
/// prose gates, the whole-buffer prose mask, and the buffer/line caps.
pub fn prose_words(prompt: &str) -> Vec<ProseWord> {
	let mut out = Vec::new();
	if utf16_len(prompt) > MAX_BUFFER {
		return out;
	}
	let full_mask = mask_non_prose(prompt);
	let mut line_start = 0usize;
	for line in prompt.split('\n') {
		if utf16_len(line) <= MAX_LINE {
			let masked_line = mask_non_prose(line);
			for (start, end) in word_spans(line) {
				if !is_prose_word(line, &masked_line, start, end) {
					continue;
				}
				if is_blank(&full_mask[line_start + start..line_start + end]) {
					continue;
				}
				out.push(ProseWord { start: line_start + start, end: line_start + end });
			}
		}
		line_start += line.len() + 1;
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn words(prompt: &str) -> Vec<&str> {
		prose_words(prompt)
			.into_iter()
			.map(|w| &prompt[w.start..w.end])
			.collect()
	}

	#[test]
	fn code_and_markup_are_not_prose() {
		let prompt = "fix the `parse_args` call\n```rust\nlet value = 1;\n```\nthen <b>bold</b> it \
		              camelCase foo_bar v2 ok";
		assert_eq!(words(prompt), ["fix", "the", "call", "then", "it", "ok"]);
	}

	#[test]
	fn masking_preserves_byte_offsets() {
		let text = "é `ü` <i>ß</i> done";
		let masked = mask_non_prose(text);
		assert_eq!(masked.len(), text.len());
		assert_eq!(&masked[masked.len() - 4..], "done");
		assert!(masked[2..masked.len() - 5].trim().is_empty());
	}
}
