//! Text-shape normalization shared by every edit engine: line endings, BOM,
//! JS-compatible trimming, indentation profiling, and the fuzzy-comparison
//! normalizers.
//!
//! Ports `packages/hashline/src/normalize.ts` and
//! `packages/coding-agent/src/edit/normalize.ts`.

use xutf::IntoUnicodeNormalized;

/// Line-ending style of a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
	Lf,
	CrLf,
}

impl LineEnding {
	/// The terminator bytes for this style.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Lf => "\n",
			Self::CrLf => "\r\n",
		}
	}
}

/// Detect the first line ending style in `content`; LF when neither is present.
pub fn detect_line_ending(content: &str) -> LineEnding {
	let Some(lf) = content.find('\n') else {
		return LineEnding::Lf;
	};
	match content.find("\r\n") {
		Some(crlf) if crlf < lf => LineEnding::CrLf,
		_ => LineEnding::Lf,
	}
}

/// Normalize every `\r\n` and lone `\r` to `\n`. Borrows when nothing changes.
pub fn normalize_to_lf(text: &str) -> std::borrow::Cow<'_, str> {
	if !text.contains('\r') {
		return std::borrow::Cow::Borrowed(text);
	}
	let mut out = String::with_capacity(text.len());
	let mut chars = text.chars().peekable();
	while let Some(ch) = chars.next() {
		if ch == '\r' {
			if chars.peek() == Some(&'\n') {
				chars.next();
			}
			out.push('\n');
		} else {
			out.push(ch);
		}
	}
	std::borrow::Cow::Owned(out)
}

/// Re-encode LF text with the requested line ending.
pub fn restore_line_endings(text: &str, ending: LineEnding) -> String {
	match ending {
		LineEnding::Lf => text.to_owned(),
		LineEnding::CrLf => text.replace('\n', "\r\n"),
	}
}

/// UTF-8 byte order mark as a string.
pub const BOM: &str = "\u{FEFF}";

/// Split a leading UTF-8 BOM off `content`: `(bom, rest)`.
pub fn strip_bom(content: &str) -> (&'static str, &str) {
	content
		.strip_prefix(BOM)
		.map_or(("", content), |rest| (BOM, rest))
}

/// JavaScript's `\s` / `String.prototype.trim` whitespace set (`WhiteSpace` +
/// `LineTerminator` productions).
pub const fn is_js_whitespace(ch: char) -> bool {
	matches!(
		ch,
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

/// `String.prototype.trim` equivalent.
pub fn js_trim(text: &str) -> &str {
	text.trim_matches(is_js_whitespace)
}

/// `String.prototype.trimStart` equivalent.
pub fn js_trim_start(text: &str) -> &str {
	text.trim_start_matches(is_js_whitespace)
}

/// `String.prototype.trimEnd` equivalent.
pub fn js_trim_end(text: &str) -> &str {
	text.trim_end_matches(is_js_whitespace)
}

/// Length in UTF-16 code units — JS `string.length`.
pub fn utf16_len(text: &str) -> usize {
	text.encode_utf16().count()
}

/// Split on `\n` exactly like JS `text.split("\n")` (keeps a trailing empty
/// segment when the text ends with a newline).
pub fn split_lines(text: &str) -> Vec<&str> {
	text.split('\n').collect()
}

/// True when `line` has any non-whitespace content (JS `line.trim().length >
/// 0`).
pub fn is_non_empty_line(line: &str) -> bool {
	!js_trim(line).is_empty()
}

/// Count leading space/tab characters.
pub fn count_leading_whitespace(line: &str) -> usize {
	line
		.bytes()
		.take_while(|b| *b == b' ' || *b == b'\t')
		.count()
}

/// Leading space/tab prefix of `line`.
pub fn get_leading_whitespace(line: &str) -> &str {
	&line[..count_leading_whitespace(line)]
}

/// Minimum indentation among non-empty lines (0 when there are none).
pub fn min_indent(text: &str) -> usize {
	text
		.split('\n')
		.filter(|line| is_non_empty_line(line))
		.map(count_leading_whitespace)
		.min()
		.unwrap_or(0)
}

/// First indentation character used in `text` (space when none is found).
pub fn detect_indent_char(text: &str) -> char {
	text
		.split('\n')
		.map(get_leading_whitespace)
		.find(|ws| !ws.is_empty())
		.and_then(|ws| ws.chars().next())
		.unwrap_or(' ')
}

const fn gcd(left: usize, right: usize) -> usize {
	let (mut high, mut low) = (left, right);
	while low != 0 {
		let remainder = high % low;
		high = low;
		low = remainder;
	}
	high
}

/// Indentation statistics of a text block, used to re-indent replacements.
struct IndentProfile<'a> {
	lines:           Vec<&'a str>,
	char:            Option<char>,
	space_only:      bool,
	tab_only:        bool,
	mixed:           bool,
	unit:            usize,
	non_empty_count: usize,
}

fn build_indent_profile(text: &str) -> IndentProfile<'_> {
	let lines: Vec<&str> = text.split('\n').collect();
	let mut indent_counts = Vec::new();
	let mut char: Option<char> = None;
	let mut space_only = true;
	let mut tab_only = true;
	let mut mixed = false;
	let mut non_empty_count = 0;
	let mut unit = 0;

	for line in &lines {
		if !is_non_empty_line(line) {
			continue;
		}
		non_empty_count += 1;
		let indent = get_leading_whitespace(line);
		indent_counts.push(indent.len());
		let has_space = indent.contains(' ');
		let has_tab = indent.contains('\t');
		if has_space {
			tab_only = false;
		}
		if has_tab {
			space_only = false;
		}
		if has_space && has_tab {
			mixed = true;
		}
		if let Some(current) = indent.chars().next() {
			match char {
				None => char = Some(current),
				Some(existing) if existing != current => mixed = true,
				_ => {},
			}
		}
	}

	if space_only && non_empty_count > 0 {
		let mut current = 0;
		for count in indent_counts {
			if count == 0 {
				continue;
			}
			current = if current == 0 {
				count
			} else {
				gcd(current, count)
			};
		}
		unit = current;
	}
	if tab_only && non_empty_count > 0 {
		unit = 1;
	}

	IndentProfile { lines, char, space_only, tab_only, mixed, unit, non_empty_count }
}

/// Replace pure-tab leading indentation with `spaces_per_tab` spaces per tab.
pub fn convert_leading_tabs_to_spaces(text: &str, spaces_per_tab: usize) -> String {
	if spaces_per_tab == 0 {
		return text.to_owned();
	}
	let converted: Vec<String> = text
		.split('\n')
		.map(|line| {
			let trimmed = js_trim_start(line);
			if trimmed.is_empty() {
				return line.to_owned();
			}
			let leading = get_leading_whitespace(line);
			if !leading.contains('\t') || leading.contains(' ') {
				return line.to_owned();
			}
			let mut out = " ".repeat(leading.len() * spaces_per_tab);
			out.push_str(trimmed);
			out
		})
		.collect();
	converted.join("\n")
}

const fn replace_unicode_character(ch: char) -> Option<&'static str> {
	let cp = ch as u32;
	Some(match cp {
		0x2010..=0x2015 | 0x2212 => "-",
		0x2018..=0x201b => "'",
		0x201c..=0x201f => "\"",
		0x00a0 | 0x2002..=0x200a | 0x202f | 0x205f | 0x3000 => " ",
		0x2260 => "!=",
		0x00bd => "1/2",
		// Remaining members of the replacement class (zero-width joiners, BOM)
		// are dropped.
		0x200b..=0x200d | 0x2016 | 0x2017 | 0xfeff => "",
		_ => return None,
	})
}

/// Trim, fold typographic punctuation to ASCII, and NFC-normalize.
pub fn normalize_unicode(text: &str) -> String {
	let trimmed = js_trim(text);
	if trimmed.is_ascii() {
		return trimmed.to_owned();
	}
	let mut out = String::with_capacity(trimmed.len());
	for ch in trimmed.chars() {
		match replace_unicode_character(ch) {
			Some(replacement) => out.push_str(replacement),
			None => out.push(ch),
		}
	}
	out.into_nfc()
}

/// Normalize a line for fuzzy comparison: trim, fold quotes/dashes to ASCII,
/// collapse runs of spaces and tabs.
pub fn normalize_for_fuzzy(line: &str) -> String {
	let trimmed = js_trim(line);
	if trimmed.is_empty() {
		return String::new();
	}
	let mut out = String::with_capacity(trimmed.len());
	let mut in_space = false;
	for ch in trimmed.chars() {
		let mapped = match ch {
			'"' | '\u{201E}' | '\u{201F}' | '\u{AB}' | '\u{BB}' => '"',
			'\'' | '\u{201A}' | '\u{201B}' | '`' | '\u{B4}' => '\'',
			'\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
			' ' | '\t' => ' ',
			other => other,
		};
		if mapped == ' ' {
			if in_space {
				continue;
			}
			in_space = true;
		} else {
			in_space = false;
		}
		out.push(mapped);
	}
	out
}

fn is_indentation_only_rewrite(old_text: &str, new_text: &str) -> bool {
	let old_lines: Vec<&str> = old_text.split('\n').collect();
	let new_lines: Vec<&str> = new_text.split('\n').collect();
	old_lines.len() == new_lines.len()
		&& old_lines
			.iter()
			.zip(&new_lines)
			.all(|(a, b)| js_trim(a) == js_trim(b))
}

fn maybe_convert_tab_indentation(
	old: &IndentProfile<'_>,
	actual: &IndentProfile<'_>,
	new: &IndentProfile<'_>,
	new_text: &str,
) -> Option<String> {
	if !actual.space_only || !old.tab_only || !new.tab_only || actual.unit == 0 {
		return None;
	}
	for (old_line, actual_line) in old.lines.iter().zip(&actual.lines) {
		if !is_non_empty_line(old_line) || !is_non_empty_line(actual_line) {
			continue;
		}
		let old_indent = get_leading_whitespace(old_line);
		if old_indent.is_empty() {
			continue;
		}
		let actual_indent = get_leading_whitespace(actual_line);
		if actual_indent.len() != old_indent.len() * actual.unit {
			return None;
		}
	}
	Some(convert_leading_tabs_to_spaces(new_text, actual.unit))
}

fn compute_uniform_indent_delta(
	old: &IndentProfile<'_>,
	actual: &IndentProfile<'_>,
) -> Option<isize> {
	let mut delta: Option<isize> = None;
	for (old_line, actual_line) in old.lines.iter().zip(&actual.lines) {
		if !is_non_empty_line(old_line) || !is_non_empty_line(actual_line) {
			continue;
		}
		let current = count_leading_whitespace(actual_line) as isize
			- count_leading_whitespace(old_line) as isize;
		match delta {
			None => delta = Some(current),
			Some(existing) if existing != current => return None,
			_ => {},
		}
	}
	delta
}

fn apply_indent_delta(text: &str, delta: isize, indent_char: char) -> String {
	let adjusted: Vec<String> = text
		.split('\n')
		.map(|line| {
			if !is_non_empty_line(line) {
				return line.to_owned();
			}
			if delta > 0 {
				let mut out = String::with_capacity(line.len() + delta as usize);
				out.extend(std::iter::repeat_n(indent_char, delta as usize));
				out.push_str(line);
				return out;
			}
			let to_remove = ((-delta) as usize).min(count_leading_whitespace(line));
			line[to_remove..].to_owned()
		})
		.collect();
	adjusted.join("\n")
}

/// Re-indent `new_text` by the uniform indentation delta between the authored
/// `old_text` and the `actual_text` that was matched in the file.
///
/// A fuzzy hit at a different nesting depth lands with the right indentation.
pub fn adjust_indentation(old_text: &str, actual_text: &str, new_text: &str) -> String {
	if old_text == actual_text || is_indentation_only_rewrite(old_text, new_text) {
		return new_text.to_owned();
	}
	let old = build_indent_profile(old_text);
	let actual = build_indent_profile(actual_text);
	let new = build_indent_profile(new_text);

	if old.non_empty_count == 0 || actual.non_empty_count == 0 || new.non_empty_count == 0 {
		return new_text.to_owned();
	}
	if old.mixed || actual.mixed || new.mixed {
		return new_text.to_owned();
	}
	if let (Some(o), Some(a)) = (old.char, actual.char)
		&& o != a
	{
		return maybe_convert_tab_indentation(&old, &actual, &new, new_text)
			.unwrap_or_else(|| new_text.to_owned());
	}
	let Some(delta) = compute_uniform_indent_delta(&old, &actual) else {
		return new_text.to_owned();
	};
	if delta == 0 {
		return new_text.to_owned();
	}
	if let (Some(n), Some(a)) = (new.char, actual.char)
		&& n != a
	{
		return new_text.to_owned();
	}
	let indent_char = actual
		.char
		.or(old.char)
		.unwrap_or_else(|| detect_indent_char(actual_text));
	apply_indent_delta(new_text, delta, indent_char)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn line_ending_detection_prefers_first_terminator() {
		assert_eq!(detect_line_ending("a\r\nb\n"), LineEnding::CrLf);
		assert_eq!(detect_line_ending("a\nb\r\n"), LineEnding::Lf);
		assert_eq!(detect_line_ending("abc"), LineEnding::Lf);
	}

	#[test]
	fn lf_normalization_round_trips() {
		assert_eq!(normalize_to_lf("a\r\nb\rc\n"), "a\nb\nc\n");
		assert_eq!(restore_line_endings("a\nb", LineEnding::CrLf), "a\r\nb");
		assert_eq!(strip_bom("\u{FEFF}x"), (BOM, "x"));
	}

	#[test]
	fn adjust_indentation_shifts_uniformly() {
		assert_eq!(
			adjust_indentation("foo()\nbar()", "    foo()\n    bar()", "baz()\nqux()"),
			"    baz()\n    qux()"
		);
		assert_eq!(adjust_indentation("    foo()", "  foo()", "    bar()"), "  bar()");
		assert_eq!(adjust_indentation("foo()", "foo()", "  bar()"), "  bar()");
	}

	#[test]
	fn adjust_indentation_converts_tabs_to_spaces() {
		assert_eq!(
			adjust_indentation("\tfoo()", "    foo()", "\tbar()\n\t\tbaz()"),
			"    bar()\n        baz()"
		);
	}

	#[test]
	fn fuzzy_normalization_folds_punctuation() {
		assert_eq!(normalize_for_fuzzy("  a \t b \u{201C}x\u{2014}y\u{201F}  "), "a b \u{201C}x-y\"");
		assert_eq!(normalize_unicode(" caf\u{E9} \u{2260} 1\u{2010}"), "caf\u{E9} != 1-");
	}
}
