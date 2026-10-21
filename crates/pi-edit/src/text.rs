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

/// True when `ch` is indentation whitespace the fuzzy matcher folds onto an
/// ASCII space: the ideographic space (`U+3000`) folds with the spaces and
/// tabs `normalize_for_fuzzy` collapses into a single space.
const fn is_indent_char(ch: char) -> bool {
	matches!(ch, ' ' | '\t' | '\u{3000}')
}

/// Leading indentation of `line` — the spaces, tabs and the ideographic
/// space (`U+3000`) the fuzzy matcher folds onto an ASCII space.
pub fn get_leading_indent(line: &str) -> &str {
	let end = line
		.char_indices()
		.find(|(_, ch)| !is_indent_char(*ch))
		.map_or(line.len(), |(offset, _)| offset);
	&line[..end]
}

/// True when the character is indentation whitespace the matcher folds onto an
/// ASCII space: an ASCII space or the ideographic space (`U+3000`).
const fn is_space_indent_char(ch: char) -> bool {
	matches!(ch, ' ' | '\u{3000}')
}

/// True when the indentation of `line` holds a space the matcher folds onto an
/// ASCII space: an ASCII space or the ideographic space (`U+3000`).
pub fn indent_has_space(line: &str) -> bool {
	get_leading_indent(line).chars().any(is_space_indent_char)
}

/// True when the indentation of `line` holds a tab.
pub fn indent_has_tab(line: &str) -> bool {
	get_leading_indent(line).contains('\t')
}

/// Count leading indentation characters, one per character: the ideographic
/// space (`U+3000`) is three UTF-8 bytes but indents a line as much as one
/// ASCII space does.
pub fn count_leading_indent(line: &str) -> usize {
	line.chars().take_while(|ch| is_indent_char(*ch)).count()
}

/// Drop up to `units` indentation characters from the front of `line`.
pub fn strip_leading_indent(line: &str, units: usize) -> &str {
	let mut remaining = units;
	let mut end = 0;
	for (offset, ch) in line.char_indices() {
		if remaining == 0 || !is_indent_char(ch) {
			break;
		}
		remaining -= 1;
		end = offset + ch.len_utf8();
	}
	&line[end..]
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
		let indent = get_leading_indent(line);
		indent_counts.push(count_leading_indent(line));
		let has_space = indent.chars().any(|ch| ch == ' ' || ch == '\u{3000}');
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
			// The ideographic space indents a line as much as an ASCII space,
			// so it must not read as a different indentation character.
			let current = fold_unicode_variant(current).unwrap_or(current);
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

/// Fold a typographic or width variant to the ASCII form the fuzzy matcher
/// compares it as.
///
/// Typographic quotes and dashes collapse onto their ASCII counterparts, the
/// Halfwidth and Fullwidth Forms block (`U+FF01`–`U+FF5E`) collapses onto
/// ASCII — that block holds fullwidth punctuation *and* fullwidth letters and
/// digits (`Ａ`–`Ｚ`, `０`–`９`), which are the same characters in their wide
/// form — and the fullwidth white parentheses (`U+FF5F`/`U+FF60`) and the
/// ideographic space (`U+3000`) collapse onto their ASCII counterparts.
/// Returns `None` for characters that have no such variant.
fn fold_unicode_variant(ch: char) -> Option<char> {
	match ch {
		'"' | '\u{201E}' | '\u{201F}' | '\u{AB}' | '\u{BB}' => Some('"'),
		'\'' | '\u{201A}' | '\u{201B}' | '`' | '\u{B4}' => Some('\''),
		'\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}' => Some('-'),
		'\u{FF5F}' => Some('('),
		'\u{FF60}' => Some(')'),
		'\u{3000}' => Some(' '),
		other => {
			let cp = other as u32;
			if (0xff01..=0xff5e).contains(&cp) {
				// The ASCII result may itself be a variant that folds further
				// (`｀` → `` ` `` → `'`), so fold it once more to keep the
				// equivalence transitive.
				char::from_u32(cp - 0xfee0).map(|folded| fold_unicode_variant(folded).unwrap_or(folded))
			} else {
				None
			}
		},
	}
}

/// Fold a character to the form the fuzzy matcher compares it as: the
/// typographic and width variants collapse onto their ASCII form and a tab
/// collapses onto a space.
fn fuzzy_fold_char(ch: char) -> char {
	match ch {
		'\t' => ' ',
		other => fold_unicode_variant(other).unwrap_or(other),
	}
}

/// True when two characters compare as the same in fuzzy matching, i.e. they
/// differ only by a typographic or width variant (`“` vs `"`, `（` vs `(`) or
/// by the whitespace the matcher collapses (`\t` vs ` `).
///
/// The comparison is transitive: `｀` folds to `` ` ``, which folds to `'`,
/// so `｀` and `'` compare equal too.
pub fn fuzzy_equivalent_chars(left: char, right: char) -> bool {
	fuzzy_fold_char(left) == fuzzy_fold_char(right)
}

/// True when the text is nothing but whitespace.
///
/// The matcher collapses a run of whitespace into a single space, so the
/// codepoints of a run are the caller's to reproduce even when the matcher
/// does not charge for them.
fn is_blank(text: &str) -> bool {
	!text.is_empty() && text.chars().all(|ch| ch.is_whitespace())
}

/// One character of a line as the fuzzy matcher compares it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FoldedChar {
	/// The folded character the matcher compares.
	pub folded: char,
	/// The character in the source line.
	pub source: char,
	/// The 0-based index of `source` in the source line.
	pub index:  usize,
}

/// One folded position of a line: a character, or the whitespace run the
/// matcher collapses into a single space.
struct FoldedPosition<'a> {
	/// The folded character the matcher compares.
	folded: char,
	/// The 0-based index of the position in the line.
	index:  usize,
	/// The source text of the position: the character, or the whole run.
	source: &'a str,
}

/// The folded positions of `line`: one per character, one per whitespace run.
///
/// The matcher collapses a run of whitespace into a single space, so the run
/// is one folded position — but every codepoint in it is still the caller's to
/// reproduce, and the ones the terminal renders alike (a tab the renderer
/// expands to spaces) are the ones the caller cannot see.
fn folded_positions(line: &str) -> impl Iterator<Item = FoldedPosition<'_>> + '_ {
	let mut chars = line.char_indices();
	let mut pending: Option<(usize, char)> = None;
	let mut index = 0usize;
	std::iter::from_fn(move || {
		let (offset, source) = match pending.take() {
			Some(next) => next,
			None => chars.next()?,
		};
		let folded = fuzzy_fold_char(source);
		let mut end = offset + source.len_utf8();
		let mut count = 1usize;
		if folded == ' ' {
			// The whole run collapses into the one space.
			loop {
				match chars.next() {
					Some((next_offset, next)) if fuzzy_fold_char(next) == ' ' => {
						end = next_offset + next.len_utf8();
						count += 1;
					},
					Some(next) => {
						pending = Some(next);
						break;
					},
					None => break,
				}
			}
		}
		let position = FoldedPosition { folded, index, source: &line[offset..end] };
		index += count;
		Some(position)
	})
}

/// The characters of `line` as the fuzzy matcher compares them: the
/// typographic and width variants collapse onto their ASCII form, a tab
/// collapses onto a space and a run of whitespace collapses into one space.
///
/// Every character keeps the source it came from, so two lines the matcher
/// considers equal can still be compared character by character — the folded
/// positions line up even when one of them inserted or deleted whitespace.
pub fn folded_chars(line: &str) -> impl Iterator<Item = FoldedChar> + '_ {
	folded_positions(line).map(|position| FoldedChar {
		folded: position.folded,
		source: position.source.chars().next().unwrap_or(' '),
		index:  position.index,
	})
}

/// One place where two lines differ in characters the fuzzy matcher folds
/// together.
///
/// A whitespace run is one folded position, so a difference inside a run
/// carries the codepoints of the run: every one of them is the caller's to
/// reproduce, and the ones the terminal renders alike are the ones it cannot
/// see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FoldedDifference {
	/// The 0-based index of the difference: the index of the codepoint in the
	/// line that holds it — the expected line, or the actual line for a
	/// codepoint only it has.
	pub index:    usize,
	/// The codepoint of the expected line, when it has one here.
	pub expected: Option<char>,
	/// The codepoint of the actual line, when it has one here.
	pub actual:   Option<char>,
	/// How many codepoints the difference covers.
	pub count:    usize,
}

/// The places where two lines differ in characters the fuzzy matcher folds
/// together: the typographic and width variants and the whitespace the
/// matcher collapses.
///
/// The lines are compared the way the matcher compares them — one folded
/// position per character, one per whitespace run — so the positions line up
/// even when one of the lines inserted or deleted whitespace in front of a
/// difference. Every codepoint of a run is compared: the matcher charges for
/// none of them, but an exact match charges for all of them, and a codepoint
/// the terminal renders as blank space (a tab) is one the caller cannot see.
///
/// Only the differences the matcher folds together are reported: a codepoint
/// the matcher charges for on its own is visible in the printed pair.
///
/// Two blank positions are compared codepoint by codepoint even when the
/// matcher does not fold them together: a space and a nonbreaking space are
/// different codepoints the terminal renders alike, so the printed pair alone
/// does not tell the caller which one it has to write.
pub fn folded_differences(expected: &str, actual: &str) -> Vec<FoldedDifference> {
	let mut differences = Vec::new();
	for (expected_position, actual_position) in
		folded_positions(expected).zip(folded_positions(actual))
	{
		if is_blank(expected_position.source) && is_blank(actual_position.source) {
			differences.extend(run_differences(&expected_position, &actual_position));
			continue;
		}
		let Some(expected_char) = expected_position.source.chars().next() else {
			continue;
		};
		let Some(actual_char) = actual_position.source.chars().next() else {
			continue;
		};
		if expected_char == actual_char || !fuzzy_equivalent_chars(expected_char, actual_char) {
			continue;
		}
		differences.push(FoldedDifference {
			index:    expected_position.index,
			expected: Some(expected_char),
			actual:   Some(actual_char),
			count:    1,
		});
	}
	differences
}

/// The differences inside a whitespace run.
///
/// The run is one folded position, but it is a sequence of codepoints: they
/// are compared one by one, and the ones the longer run has in excess are
/// reported with their count. The excess is reported next to the paired
/// differences: the renderer expands a tab into spaces, so a caller that
/// fixed only the named pair still misses the extra spaces.
fn run_differences(
	expected: &FoldedPosition<'_>,
	actual: &FoldedPosition<'_>,
) -> Vec<FoldedDifference> {
	let expected_chars = expected.source.chars().collect::<Vec<_>>();
	let actual_chars = actual.source.chars().collect::<Vec<_>>();
	let mut differences = Vec::new();
	let common = expected_chars.len().min(actual_chars.len());
	for offset in 0..common {
		if expected_chars[offset] == actual_chars[offset] {
			continue;
		}
		differences.push(FoldedDifference {
			index:    expected.index + offset,
			expected: Some(expected_chars[offset]),
			actual:   Some(actual_chars[offset]),
			count:    1,
		});
	}
	// The codepoints the longer run has in excess: the matcher charges for
	// none of them, but an exact match charges for all of them. They are
	// reported in the order the run holds them — the renderer expands a tab
	// into spaces, so a hint that sorted them would leave the caller unable
	// to reproduce the line.
	let (leftover, index, in_expected) = if expected_chars.len() > actual_chars.len() {
		(&expected_chars[common..], expected.index + common, true)
	} else if actual_chars.len() > expected_chars.len() {
		(&actual_chars[common..], actual.index + common, false)
	} else {
		return differences;
	};
	let mut offset = 0;
	while offset < leftover.len() {
		let ch = leftover[offset];
		let mut count = 1;
		while offset + count < leftover.len() && leftover[offset + count] == ch {
			count += 1;
		}
		differences.push(FoldedDifference {
			index: index + offset,
			expected: in_expected.then_some(ch),
			actual: (!in_expected).then_some(ch),
			count,
		});
		offset += count;
	}
	differences
}

/// Normalize a line for fuzzy comparison: trim, fold quotes/dashes/fullwidth
/// forms to ASCII, collapse runs of spaces and tabs.
pub fn normalize_for_fuzzy(line: &str) -> String {
	let trimmed = js_trim(line);
	if trimmed.is_empty() {
		return String::new();
	}
	let mut out = String::with_capacity(trimmed.len());
	for folded in folded_chars(trimmed) {
		out.push(folded.folded);
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

/// The authored line with the characters the file holds.
///
/// The matcher folds a fullwidth character onto its ASCII counterpart, so the
/// file can hold characters the authored line does not: writing the authored
/// line would silently rewrite text the hunk marked unchanged. The whitespace
/// stays the authored one - the hunk may have changed it on purpose.
pub fn merge_file_characters(authored: &str, file_line: &str) -> String {
	let authored_body = js_trim(authored);
	let file_body = js_trim(file_line);
	if authored_body == file_body {
		return authored.to_owned();
	}
	if normalize_for_fuzzy(authored_body) != normalize_for_fuzzy(file_body) {
		return authored.to_owned();
	}
	if without_whitespace(authored_body) == without_whitespace(file_body) {
		// Only the whitespace differs: that is the hunk's own change.
		return authored.to_owned();
	}
	let (leading, trailing) = boundary_whitespace(authored);
	format!("{leading}{file_body}{trailing}")
}

/// The authored line's leading and trailing whitespace, as two ranges that
/// never overlap.
///
/// A line that holds nothing but whitespace has no body: the leading and
/// trailing ranges would cover the same characters, and the merged line would
/// carry that whitespace twice. The whole line is the leading part there, so
/// the merged line keeps the whitespace the author asked for exactly once.
fn boundary_whitespace(authored: &str) -> (&str, &str) {
	if js_trim(authored).is_empty() {
		return (authored, "");
	}
	let start = authored.len() - js_trim_start(authored).len();
	let end = js_trim_end(authored).len();
	(&authored[..start], &authored[end..])
}

/// The characters of a line that are not whitespace.
fn without_whitespace(line: &str) -> String {
	line.chars().filter(|ch| !ch.is_whitespace()).collect()
}

/// The authored line's boundary whitespace with the file's body.
///
/// A rewrite that asks for a change to the line's boundary whitespace only
/// leaves the body to the file: the matcher folds a fullwidth character onto
/// its ASCII counterpart, and the authored body would transliterate text the
/// rewrite never touched. The interior whitespace is the file's as well — the
/// ideographic space folds onto an ASCII one, and the authored interior would
/// rewrite it.
pub fn merge_file_line_body(authored: &str, file_line: &str) -> String {
	let (leading, trailing) = boundary_whitespace(authored);
	format!("{leading}{}{trailing}", js_trim(file_line))
}

/// The replacement with the characters the file holds, line by line.
///
/// The rewrite changes the whitespace only, so the body of every line is the
/// file's: the matcher folds a fullwidth character onto its ASCII
/// counterpart, and the authored body would transliterate the file's text.
/// The interior whitespace is the file's too — the ideographic space folds
/// onto an ASCII one, and the authored interior would rewrite it.
fn merge_file_body(actual_text: &str, new_text: &str) -> String {
	let actual_lines = actual_text.split('\n').collect::<Vec<_>>();
	let new_lines = new_text.split('\n').collect::<Vec<_>>();
	if actual_lines.len() != new_lines.len() {
		return new_text.to_owned();
	}
	new_lines
		.iter()
		.zip(actual_lines)
		.map(|(new_line, actual_line)| merge_file_line_body(new_line, actual_line))
		.collect::<Vec<_>>()
		.join("\n")
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
		let old_indent = count_leading_indent(old_line);
		if old_indent == 0 {
			continue;
		}
		if count_leading_indent(actual_line) != old_indent * actual.unit {
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
		let current =
			count_leading_indent(actual_line) as isize - count_leading_indent(old_line) as isize;
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
			let to_remove = ((-delta) as usize).min(count_leading_indent(line));
			strip_leading_indent(line, to_remove).to_owned()
		})
		.collect();
	adjusted.join("\n")
}

/// Re-indent `new_text` by the uniform indentation delta between the authored
/// `old_text` and the `actual_text` that was matched in the file.
///
/// A fuzzy hit at a different nesting depth lands with the right indentation.
///
/// The indentation is measured in characters, not bytes, and the ideographic
/// space (`U+3000`) counts as one unit: the fuzzy matcher folds it onto an
/// ASCII space, so an anchor written with an ASCII space matches a line
/// indented with it. Measuring the same line differently would compute a
/// bogus delta and silently deindent the replacement.
pub fn adjust_indentation(old_text: &str, actual_text: &str, new_text: &str) -> String {
	if old_text == actual_text {
		return new_text.to_owned();
	}
	if is_indentation_only_rewrite(old_text, new_text) {
		// The rewrite changes the whitespace only, so the body is the file's:
		// the matcher folds a fullwidth character onto its ASCII counterpart,
		// and the authored body would transliterate the file's text.
		return merge_file_body(actual_text, new_text);
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
	fn adjust_indentation_treats_folded_ideographic_space_as_indentation() {
		// The fuzzy matcher folds the ideographic space onto an ASCII space,
		// so this anchor matches a line indented with it. The indentation
		// profiler has to see the same indentation, or it computes a bogus
		// delta and silently deindents the replacement.
		assert_eq!(adjust_indentation(" foo", "\u{3000}foo", " bar"), " bar");
		assert_eq!(adjust_indentation("\u{3000}foo", "  foo", " bar"), "  bar");
		// A line the anchor did not indent still is indented by the file.
		assert_eq!(adjust_indentation("foo", "\u{3000}foo", "bar"), " bar");
	}

	#[test]
	fn indentation_only_rewrite_keeps_the_files_body() {
		// The rewrite asks for an indentation change only, so the body is the
		// file's: the matcher folds the ideographic space onto an ASCII one, and
		// the authored interior would rewrite the file's whitespace.
		assert_eq!(adjust_indentation("foo bar", "foo\u{3000}bar", "  foo bar"), "  foo\u{3000}bar");
		// A residual difference the matcher accepted is the file's text too: the
		// rewrite never asked for the body to change.
		assert_eq!(
			adjust_indentation(
				"foo(bar)abcdefghijklmn",
				"foo（baz）abcdefghijklmn",
				"  foo(bar)abcdefghijklmn"
			),
			"  foo（baz）abcdefghijklmn"
		);
	}

	#[test]
	fn fuzzy_normalization_folds_punctuation() {
		assert_eq!(normalize_for_fuzzy("  a \t b \u{201C}x\u{2014}y\u{201F}  "), "a b \u{201C}x-y\"");
		assert_eq!(normalize_unicode(" caf\u{E9} \u{2260} 1\u{2010}"), "caf\u{E9} != 1-");
	}

	#[test]
	fn fuzzy_normalization_folds_fullwidth_forms() {
		// Halfwidth and Fullwidth Forms collapse onto ASCII, so a line written
		// with fullwidth punctuation compares equal to its halfwidth twin.
		assert_eq!(normalize_for_fuzzy("foo（bar）＝1"), "foo(bar)=1");
		assert_eq!(normalize_for_fuzzy("Ａ！～"), "A!~");
		assert_eq!(normalize_for_fuzzy("foo（bar）"), normalize_for_fuzzy("foo(bar)"));
		// The ideographic space folds to an ASCII space and joins the run.
		assert_eq!(normalize_for_fuzzy("a\u{3000}b"), "a b");
		// Halfwidth katakana sit outside the folded range and stay verbatim.
		assert_eq!(normalize_for_fuzzy("ｱ"), "ｱ");
	}

	#[test]
	fn fuzzy_normalization_folds_fullwidth_variants_transitively() {
		// U+FF40 FULLWIDTH GRAVE ACCENT folds to the ASCII grave accent, which
		// folds to the ASCII apostrophe: the fold must not stop halfway, or
		// `｀` and `'` would compare unequal.
		assert_eq!(normalize_for_fuzzy("｀"), "'");
		assert_eq!(normalize_for_fuzzy("｀"), normalize_for_fuzzy("'"));
		assert!(fuzzy_equivalent_chars('｀', '\''));
	}

	#[test]
	fn an_all_whitespace_line_keeps_its_whitespace_once() {
		// A line that holds nothing but whitespace has no body, so its leading
		// and trailing ranges would cover the same characters and the merged
		// line would carry that whitespace twice: the author asked for two
		// spaces and the formatter wrote four.
		assert_eq!(merge_file_line_body("  ", "    "), "  ");
		assert_eq!(adjust_indentation("  ", "    ", "  "), "  ");
	}

	#[test]
	fn fuzzy_normalization_folds_a_tab_onto_a_space() {
		// The matcher collapses a tab onto a space, so the two characters
		// compare equal — an interior tab would otherwise stay invisible in
		// the exact-match hint.
		assert_eq!(normalize_for_fuzzy("a\tb"), normalize_for_fuzzy("a b"));
		assert!(fuzzy_equivalent_chars('\t', ' '));
	}
}
