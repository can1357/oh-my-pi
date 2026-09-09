use omp_core::{Str, StrMut};
use smallvec::SmallVec;

use super::{MdTheme, decode_entities, replace_tabs};
use crate::rich::{Pipeline, RichSink, RichText};

/// Captured plain-paragraph tail used by the append-only streaming fast path.
pub struct FastTail {
	source:  Str,
	row_raw: StrMut,
	width:   u16,
	theme:   MdTheme,
	#[cfg(test)]
	splices: u64,
}

impl FastTail {
	pub(super) fn capture(source: &Str, width: u16, theme: MdTheme) -> Self {
		let row = source
			.as_str()
			.rsplit_once('\n')
			.map_or(source.as_str(), |(_, row)| row);
		let row = replace_tabs(&Str::new(row));
		Self {
			source: source.clone(),
			row_raw: StrMut::new(row.as_str()),
			width,
			theme,
			#[cfg(test)]
			splices: 0,
		}
	}

	/// Replaces only the prior frame's final wrapped row when `source` grew by
	/// a same-line Markdown-inert delta.
	pub(crate) fn splice(
		&mut self,
		source: &Str,
		width: u16,
		theme: &MdTheme,
		rendered: &mut RichText,
	) -> bool {
		if width != self.width
			|| *theme != self.theme
			|| source.len() <= self.source.len()
			|| !source.as_str().starts_with(self.source.as_str())
		{
			return false;
		}
		let raw_delta = &source.as_str()[self.source.len()..];
		let expanded = raw_delta
			.contains('\t')
			.then(|| raw_delta.replace('\t', "   "));
		let delta = expanded.as_deref().unwrap_or(raw_delta);
		if hazard(self.row_raw.as_str(), delta) {
			return false;
		}
		let Some(row) = RichText::rows(rendered).checked_sub(1) else {
			return false;
		};
		let mut replacement = RichText::default();
		{
			let mut wrapped = (&mut replacement).wrap(width);
			rendered.replay_row(row, &mut wrapped);
			wrapped.run(theme.base, delta);
			wrapped.finish();
		}
		rendered.truncate_rows(row);
		replacement.replay(rendered);
		self.source = source.clone();
		self.row_raw.push_str(delta);
		#[cfg(test)]
		{
			self.splices = self.splices.saturating_add(1);
		}
		true
	}

	#[cfg(test)]
	pub(crate) const fn splice_count(&self) -> u64 {
		self.splices
	}
}

pub(super) fn hazard(raw: &str, delta: &str) -> bool {
	let marker_delta = delta.chars().any(|character| {
		matches!(
			character,
			'\n'
				| '\r' | '\\'
				| '[' | '`'
				| '<' | '!'
				| '*' | '_'
				| '~' | '$'
				| '#' | '&'
				| '@' | '\u{1b}'
		)
	});
	let seam_safe = !run_end(raw)
		&& !swatch_seam(raw)
		&& !entity_seam(raw)
		&& !decoded_tail_hazard(raw)
		&& !url_prefix_seam(raw)
		&& !raw.ends_with(']')
		&& !unclosed_pair(raw, '[', ']')
		&& !unclosed_pair(raw, '(', ')')
		&& !unclosed_pair(raw, '<', '>');
	if !seam_safe {
		return true;
	}
	if marker_delta {
		if (delta.starts_with('_') || delta.ends_with('_')) && underscore_word_at_end(raw) {
			return true;
		}
		return true;
	}
	let mut grown = String::with_capacity(raw.len().saturating_add(delta.len()));
	grown.push_str(raw);
	grown.push_str(delta);
	let trailing_delimiter = (raw
		.chars()
		.last()
		.is_some_and(|character| matches!(character, '*' | '~' | '_'))
		&& cmark_word_at_start(delta))
		|| (raw.ends_with('$') && delta.starts_with(|c: char| c.is_ascii_digit()));
	if trailing_delimiter || line_start_hazard(&grown) || table_delimiter_row(&grown) {
		return true;
	}
	let word_start = raw
		.rfind([' ', '\t'])
		.map_or(0, |offset| offset.saturating_add(1));
	url_anywhere(&grown[word_start..])
}

fn unclosed_pair(raw: &str, open: char, close: char) -> bool {
	raw.rfind(open)
		.is_some_and(|opening| raw.rfind(close).is_none_or(|closing| opening > closing))
}

fn run_end(raw: &str) -> bool {
	if raw
		.chars()
		.last()
		.is_some_and(|character| matches!(character, ' ' | '\t' | '\\' | '#'))
	{
		return true;
	}
	let Some(hash) = raw.rfind('#') else {
		return false;
	};
	let hex = &raw[hash + 1..];
	(3..=8).contains(&hex.len()) && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn swatch_seam(raw: &str) -> bool {
	let Some(hash) = raw.rfind('#') else {
		return false;
	};
	let hex = &raw[hash + 1..];
	hex.len() <= 2 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn entity_seam(raw: &str) -> bool {
	let Some(ampersand) = raw.rfind('&') else {
		return false;
	};
	let body = &raw[ampersand + 1..];
	if body.len() <= 31
		&& body
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || byte == b'#')
	{
		return true;
	}
	let Some(numeric) = body
		.strip_suffix(';')
		.and_then(|body| body.strip_prefix('#'))
	else {
		return false;
	};
	if let Some(hex) = numeric
		.strip_prefix('x')
		.or_else(|| numeric.strip_prefix('X'))
	{
		(1..=6).contains(&hex.len()) && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
	} else {
		(1..=7).contains(&numeric.len()) && numeric.bytes().all(|byte| byte.is_ascii_digit())
	}
}

fn decoded_tail_hazard(raw: &str) -> bool {
	let target = raw.len().saturating_sub(32);
	let start = raw
		.char_indices()
		.find(|(offset, _)| *offset >= target)
		.map_or(0, |(offset, _)| offset);
	let tail = &raw[start..];
	if !tail.contains('&') {
		return false;
	}
	let mut decoded = StrMut::with_capacity(tail.len());
	decode_entities(tail, &mut decoded);
	decoded.as_str() != tail && (run_end(decoded.as_str()) || swatch_seam(decoded.as_str()))
}

fn url_prefix_seam(raw: &str) -> bool {
	if [
		"http", "http:", "http:/", "http://", "https", "https:", "https:/", "https://", "ftp",
		"ftp:", "ftp:/", "ftp://",
	]
	.iter()
	.any(|prefix| ascii_ends_with(raw, prefix))
	{
		return true;
	}
	if ascii_ends_with(raw, "www.") {
		return true;
	}
	let Some(at) = raw.rfind('@') else {
		return false;
	};
	let local = raw[..at]
		.rsplit(|character: char| !is_email_prefix_character(character))
		.next()
		.unwrap_or("");
	let domain = &raw[at + 1..];
	!local.is_empty() && domain.chars().all(is_email_prefix_character)
}

fn url_anywhere(text: &str) -> bool {
	if ["http://", "https://", "ftp://"]
		.iter()
		.any(|scheme| ascii_contains(text, scheme))
	{
		return true;
	}
	let bytes = text.as_bytes();
	for index in 0..bytes.len().saturating_sub(4) {
		if bytes[index..index + 4].eq_ignore_ascii_case(b"www.")
			&& bytes.get(index + 4).is_some_and(u8::is_ascii_alphanumeric)
		{
			return true;
		}
	}
	for (index, byte) in bytes.iter().enumerate() {
		if *byte == b'@'
			&& index > 0
			&& text[..index]
				.chars()
				.rev()
				.take_while(|character| is_email_character(*character))
				.next()
				.is_some()
		{
			return true;
		}
	}
	false
}

fn ascii_ends_with(text: &str, suffix: &str) -> bool {
	text
		.as_bytes()
		.get(text.len().saturating_sub(suffix.len())..)
		.is_some_and(|tail| tail.eq_ignore_ascii_case(suffix.as_bytes()))
}

fn ascii_contains(text: &str, needle: &str) -> bool {
	text
		.as_bytes()
		.windows(needle.len())
		.any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

const fn is_email_character(character: char) -> bool {
	character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '%' | '+' | '-')
}

const fn is_email_prefix_character(character: char) -> bool {
	character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '+' | '-')
}

fn underscore_word_at_end(text: &str) -> bool {
	let Some(grapheme) = xutf::graphemes_str(text).last() else {
		return false;
	};
	let Some(character) = grapheme.chars().last() else {
		return false;
	};
	character == '_'
		|| character.is_ascii_alphanumeric()
		|| matches!(
			xutf::general_category_group(u32::from(character)),
			xutf::GeneralCategoryGroup::Letter | xutf::GeneralCategoryGroup::Number
		)
}

fn cmark_word_at_start(text: &str) -> bool {
	let Some(grapheme) = xutf::graphemes_str(text).next() else {
		return false;
	};
	let Some(character) = grapheme.chars().next() else {
		return false;
	};
	!character.is_whitespace()
		&& character != '\u{feff}'
		&& !matches!(
			xutf::general_category_group(u32::from(character)),
			xutf::GeneralCategoryGroup::Punctuation | xutf::GeneralCategoryGroup::Symbol
		)
}

fn line_start_hazard(line: &str) -> bool {
	let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
	if spaces > 3 {
		return false;
	}
	let body = &line[spaces..];
	if body.starts_with('>') || reference_definition(body) {
		return true;
	}
	let hashes = body.bytes().take_while(|byte| *byte == b'#').count();
	if (1..=6).contains(&hashes)
		&& body[hashes..]
			.chars()
			.next()
			.is_none_or(|character| matches!(character, ' ' | '\t'))
	{
		return true;
	}
	let digits = body.bytes().take_while(u8::is_ascii_digit).count();
	if (1..=9).contains(&digits)
		&& body
			.as_bytes()
			.get(digits)
			.is_some_and(|byte| matches!(byte, b'.' | b')'))
		&& body[digits + 1..]
			.chars()
			.next()
			.is_none_or(|character| matches!(character, ' ' | '\t'))
	{
		return true;
	}
	let mut markers = 0_usize;
	for character in body.chars() {
		if matches!(character, ' ' | '\t') {
			continue;
		}
		if !matches!(character, '*' | '+' | '=' | '–' | '—' | '─' | '━' | '═' | '-') {
			markers = 0;
			break;
		}
		markers += 1;
	}
	if markers >= 2 {
		return true;
	}
	let mut characters = body.chars();
	characters.next().is_some_and(|character| {
		matches!(character, '*' | '+' | '=' | '–' | '—' | '─' | '━' | '═' | '-')
			&& characters
				.next()
				.is_none_or(|next| matches!(next, ' ' | '\t'))
	})
}

fn reference_definition(line: &str) -> bool {
	let Some(label) = line.strip_prefix('[') else {
		return false;
	};
	let mut escaped = false;
	let mut content = false;
	for (offset, character) in label.char_indices() {
		if escaped {
			escaped = false;
			content = true;
			continue;
		}
		if character == '\\' {
			escaped = true;
		} else if character == ']' {
			return content && label[offset + 1..].starts_with(':');
		} else {
			content = true;
		}
	}
	false
}

fn table_delimiter_row(line: &str) -> bool {
	let mut body = line.trim();
	let leading = body.starts_with('|');
	if leading {
		body = &body[1..];
	}
	if let Some(without) = body.strip_suffix('|') {
		body = without;
	}
	let cells: SmallVec<&str, 4> = body.split('|').collect();
	let enough = if leading {
		!cells.is_empty()
	} else {
		cells.len() >= 2
	};
	enough && cells.into_iter().all(table_delimiter_cell)
}

fn table_delimiter_cell(cell: &str) -> bool {
	let mut characters = cell.chars().peekable();
	while characters
		.peek()
		.is_some_and(|character| character.is_whitespace() || *character == ':')
	{
		characters.next();
	}
	let mut dashes = 0_usize;
	while characters.peek().is_some_and(|character| *character == '-') {
		characters.next();
		dashes += 1;
	}
	dashes > 0 && characters.all(|character| character.is_whitespace() || character == ':')
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::markdown::{render_partial, render_partial_capturing};

	fn assert_same(left: &RichText, right: &RichText) {
		assert_eq!(left.rows(), right.rows());
		for row in 0..left.rows() {
			assert_eq!(left.row_text(row), right.row_text(row), "row {row}");
			assert_eq!(left.row_width(row), right.row_width(row), "row {row}");
			assert_eq!(left.row_soft_wrap(row), right.row_soft_wrap(row), "row {row}");
			let left_runs: Vec<_> = left.row_runs(row).collect();
			let right_runs: Vec<_> = right.row_runs(row).collect();
			assert_eq!(left_runs, right_runs, "row {row} styles");
		}
	}

	#[test]
	fn every_pi_hazard_class_disarms() {
		let theme = MdTheme::default();
		for marker in
			['\n', '\r', '\\', '[', '`', '<', '!', '*', '_', '~', '$', '#', '&', '@', '\u{1b}']
		{
			assert!(hazard("plain tail", &marker.to_string()), "marker {marker:?}");
			let source = Str::new("plain tail");
			let mut rendered = RichText::default();
			let mut recipe = render_partial_capturing(&source, 40, &theme, &mut rendered)
				.expect("plain paragraph captures");
			let grown = Str::new(format!("plain tail{marker}"));
			assert!(!recipe.splice(&grown, 40, &theme, &mut rendered));
		}
		for (raw, delta) in [
			("#", " heading"),
			(">", " quote"),
			("1.", " item"),
			("-", " item"),
			("--", "-"),
			("[name]:", " target"),
			("tail\t", "word"),
			("tail\\", "word"),
			("color #ab", "c"),
			("color #abc", "d"),
			("hash ##", "word"),
			("entity &am", "p;"),
			("entity &#35;", "abc"),
			("entity &nbsp;", "word"),
			("site htt", "p://x"),
			("site www.", "x"),
			("mail a@", "b.test"),
			("closed ]", "word"),
			("open (", "text"),
			("open <", "text"),
			("word*", "\u{301}"),
			("$x$", "1"),
			("|--", "-|"),
			("--|--", "-"),
		] {
			assert!(hazard(raw, delta), "{raw:?} + {delta:?}");
			let source = Str::new(raw);
			let mut rendered = RichText::default();
			if let Some(mut recipe) = render_partial_capturing(&source, 40, &theme, &mut rendered) {
				let grown = Str::new(format!("{raw}{delta}"));
				assert!(!recipe.splice(&grown, 40, &theme, &mut rendered));
			}
		}
	}

	#[test]
	fn width_theme_and_nonparagraph_tails_disarm() {
		let theme = MdTheme::default();
		let source = Str::new("plain paragraph");
		let mut rendered = RichText::default();
		let mut recipe = render_partial_capturing(&source, 20, &theme, &mut rendered)
			.expect("plain paragraph captures");
		let grown = Str::new("plain paragraph grows");
		assert!(!recipe.splice(&grown, 19, &theme, &mut rendered));
		let mut changed = theme;
		changed.base = changed.base.bold();
		assert!(!recipe.splice(&grown, 20, &changed, &mut rendered));

		for structural in ["# heading", "- item", "> quote", "```rust\ncode", "| a |\n|---|"] {
			let source = Str::new(structural);
			let mut rendered = RichText::default();
			assert!(
				render_partial_capturing(&source, 20, &theme, &mut rendered).is_none(),
				"{structural:?}",
			);
		}
	}

	#[test]
	fn unicode_flanking_classes_match_commonmark() {
		assert!(underscore_word_at_end("café"));
		assert!(underscore_word_at_end("变量"));
		assert!(!underscore_word_at_end("word-"));
		assert!(cmark_word_at_start("\u{200c}tail"));
		assert!(cmark_word_at_start("\u{301}tail"));
		assert!(!cmark_word_at_start("-tail"));
		assert!(!cmark_word_at_start("\u{feff}tail"));
	}

	#[test]
	fn single_and_unpadded_table_delimiters_disarm() {
		for row in ["|---|", "---|---", "| --- |", "--- | ---", "|:---:"] {
			assert!(table_delimiter_row(row), "{row:?}");
		}
	}

	#[test]
	fn streaming_splices_equal_cold_partial_renders() {
		let theme = MdTheme::default();
		let width = 12;
		let mut source = Str::new("A plain paragraph tail");
		let mut fast = RichText::default();
		let mut recipe = render_partial_capturing(&source, width, &theme, &mut fast)
			.expect("plain paragraph captures");
		for delta in [" grows", " across", " several", " wrapped", " rows", "."] {
			let mut next = source.to_string();
			next.push_str(delta);
			source = Str::new(next);
			assert!(recipe.splice(&source, width, &theme, &mut fast));
			let mut cold = RichText::default();
			render_partial(&source, width, &theme, &mut cold);
			assert_same(&fast, &cold);
		}
		assert_eq!(recipe.splice_count(), 6);
	}

	#[test]
	fn append_corpus_matches_full_relex_or_disarms() {
		let theme = MdTheme::default();
		for (base, delta) in [
			("ordinary prose", " continues"),
			("unicode café", " noir"),
			("wrapped words here", " and there"),
			("color #c5ffd6.", " remains painted"),
			("#", " heading"),
			("|--", "-|"),
			("open [", "label"),
		] {
			let source = Str::new(base);
			let mut fast = RichText::default();
			let Some(mut recipe) = render_partial_capturing(&source, 10, &theme, &mut fast) else {
				continue;
			};
			let grown = Str::new(format!("{base}{delta}"));
			let engaged = recipe.splice(&grown, 10, &theme, &mut fast);
			if engaged {
				let mut cold = RichText::default();
				render_partial(&grown, 10, &theme, &mut cold);
				assert_same(&fast, &cold);
			} else {
				assert!(hazard(base.rsplit_once('\n').map_or(base, |(_, row)| row), delta));
			}
		}
	}
}
