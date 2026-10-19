//! Terminal display-width math and label normalization shared by every
//! Mermaid renderer.
//!
//! Terminals render most characters in one column, but East Asian wide
//! characters and emoji-presentation glyphs occupy two. The canvas is a
//! cell-per-column grid, so all width math counts display columns over
//! grapheme clusters rather than code points: a cluster that renders two
//! columns is stored whole in one cell followed by [`WIDE_PAD`] in the
//! continuation cell it covers.

use std::borrow::Cow;

/// Placeholder occupying the second cell of a fullwidth glyph on the canvas.
///
/// U+0000 cannot appear in parsed Mermaid labels, is treated as occupied
/// label content by canvas merging, and is stripped at serialization time.
/// Invariant: a `WIDE_PAD` cell always sits immediately right of its lead
/// cell; canvas writes keep the pair atomic.
pub const WIDE_PAD: char = '\0';

/// Opaque label-space placeholder that serializes back to a regular space.
pub const LABEL_SPACE: char = '\u{1}';

/// Display width of one grapheme cluster: 2 for wide/fullwidth/emoji, else 1.
/// Zero-width clusters still occupy a cell, matching the terminal canvas.
#[inline]
pub fn grapheme_width(cluster: &str) -> usize {
	if xutf::width_str(cluster) >= 2 { 2 } else { 1 }
}

/// Display width of one code point under the same rule as [`grapheme_width`].
#[inline]
pub fn char_width(c: char) -> usize {
	if c.is_ascii() {
		1
	} else if xutf::width_char(c) >= 2 {
		2
	} else {
		1
	}
}

/// Display width of a string in terminal columns.
///
/// Summed over grapheme clusters so it always equals the number of canvas
/// cells the text occupies (see [`super::canvas::to_cells`]). ASCII-only
/// strings take a fast path.
pub fn display_width(text: &str) -> usize {
	if text.is_ascii() {
		return text.len();
	}
	xutf::graphemes_str(text).map(grapheme_width).sum()
}

/// Split a label into its lines. Parsers already normalized `<br>` tags and
/// `\n` escapes into real newlines.
#[inline]
pub fn split_lines(label: &str) -> std::str::Split<'_, char> {
	label.split('\n')
}

/// Widest line of a (possibly multi-line) label in display columns.
pub fn max_line_width(label: &str) -> usize {
	split_lines(label).map(display_width).max().unwrap_or(0)
}

/// Number of lines in a label (always at least 1).
pub fn line_count(label: &str) -> usize {
	split_lines(label).count()
}

/// Identifier boundaries preferred when a single word must be split.
const WORD_BREAK_CHARS: [char; 4] = ['_', '-', '.', '/'];

/// Wrap flowchart labels without truncation, preserving explicit line breaks.
///
/// Long words prefer `_-./` boundaries, otherwise break between graphemes.
/// A single wide grapheme remains intact even when `width` is one column.
pub fn wrap_label(label: &str, width: usize) -> String {
	let width = width.max(1);
	let mut out = String::with_capacity(label.len());
	for (i, line) in split_lines(label).enumerate() {
		if i > 0 {
			out.push('\n');
		}
		if display_width(line) <= width {
			out.push_str(line);
			continue;
		}
		let mut cur_w = 0usize;
		let mut cur_empty = true;
		for word in line.split(' ').filter(|w| !w.is_empty()) {
			let ww = display_width(word);
			let first = std::mem::take(&mut cur_empty);
			if ww <= width {
				if !first && cur_w + 1 + ww <= width {
					out.push(' ');
					cur_w += 1;
				} else if !first {
					out.push('\n');
					cur_w = 0;
				}
				out.push_str(word);
				cur_w += ww;
				continue;
			}
			if !first {
				out.push('\n');
			}
			let mut rest = word;
			loop {
				let mut end = 0;
				let mut columns = 0;
				let mut boundary = None;
				for cluster in xutf::graphemes_str(rest) {
					let cw = grapheme_width(cluster);
					if columns + cw > width && end > 0 {
						break;
					}
					end += cluster.len();
					columns += cw;
					if cluster.starts_with(WORD_BREAK_CHARS) {
						boundary = Some((end, columns));
					}
				}
				if end == rest.len() {
					out.push_str(rest);
					cur_w = columns;
					break;
				}
				let (end, _) = boundary.unwrap_or((end, columns));
				out.push_str(&rest[..end]);
				out.push('\n');
				rest = &rest[end..];
			}
		}
	}
	out
}

/// Normalize raw Mermaid label text for terminal output.
///
/// Strips surrounding double quotes, turns `<br>` tags and literal `\n`
/// escapes into newlines, and reduces inline formatting (HTML
/// bold/italic/underline/strike tags and the markdown bold, italic, and
/// strikethrough markers) to plain text. The ASCII renderer has no styled
/// spans, so preserving the markup would print raw tags and markers inside
/// node boxes. Passes run in the same order as the reference renderer.
/// Character references (`&lt;`, `&#60;`, Mermaid's `#lt;` / `#60;`) are
/// decoded last, so an escaped tag or marker stays literal text, the way the
/// browser shows it. Tabs, carriage returns, and form feeds become spaces;
/// standalone zero-width clusters are omitted, because neither occupies the
/// canvas cell that the renderer would reserve for it.
pub fn normalize_label(label: &str) -> String {
	let unquoted = label
		.strip_prefix('"')
		.and_then(|rest| rest.strip_suffix('"'))
		.unwrap_or(label);
	let text = replace_tags(unquoted, &["br"], true, "\n");
	let text = text.replace("\\n", "\n");
	let text = replace_tags(&text, &["sub", "sup", "small", "mark"], false, "");
	let text = replace_tags(&text, &["b", "strong", "i", "em", "u", "s", "del"], false, "");
	let text = strip_paired_marker(&text, "**");
	let text = strip_single_star_emphasis(&text);
	let text = strip_paired_marker(&text, "~~");
	let text = mermaid_codes_to_html(&text);
	let text = remap_c1_controls(html_escape::decode_html_entities(&text));
	let text = if text.contains(['\t', '\r', '\u{c}']) {
		text.replace(['\t', '\r', '\u{c}'], " ")
	} else {
		text.into_owned()
	};
	if text.is_ascii() {
		return text;
	}
	let mut offset = 0;
	let mut clusters = xutf::graphemes_str(&text);
	for cluster in &mut clusters {
		if cluster != "\n" && xutf::width_str(cluster) == 0 {
			let mut visible = String::with_capacity(text.len());
			visible.push_str(&text[..offset]);
			for cluster in clusters {
				if cluster == "\n" || xutf::width_str(cluster) != 0 {
					visible.push_str(cluster);
				}
			}
			return visible;
		}
		offset += cluster.len();
	}
	text
}

/// Windows-1252 characters the HTML tokenizer substitutes for numeric
/// references to C1 controls (`&#128;` is `€`), indexed by `code - 0x80`.
/// `None` entries have no substitute and stay controls.
const C1_REPLACEMENTS: [Option<char>; 32] = [
	Some('\u{20AC}'),
	None,
	Some('\u{201A}'),
	Some('\u{0192}'),
	Some('\u{201E}'),
	Some('\u{2026}'),
	Some('\u{2020}'),
	Some('\u{2021}'),
	Some('\u{02C6}'),
	Some('\u{2030}'),
	Some('\u{0160}'),
	Some('\u{2039}'),
	Some('\u{0152}'),
	None,
	Some('\u{017D}'),
	None,
	None,
	Some('\u{2018}'),
	Some('\u{2019}'),
	Some('\u{201C}'),
	Some('\u{201D}'),
	Some('\u{2022}'),
	Some('\u{2013}'),
	Some('\u{2014}'),
	Some('\u{02DC}'),
	Some('\u{2122}'),
	Some('\u{0161}'),
	Some('\u{203A}'),
	Some('\u{0153}'),
	None,
	Some('\u{017E}'),
	Some('\u{0178}'),
];

/// Apply the HTML tokenizer's C1 substitution that `html_escape` omits, so a
/// legacy reference such as `&#128;` or `#128;` shows `€` rather than a C1
/// control. Literal C1 controls in the source get the same mapping: none of
/// them is printable, and the remaining unmapped ones are zero-width and are
/// dropped with the other zero-width clusters.
fn remap_c1_controls(text: Cow<'_, str>) -> Cow<'_, str> {
	if !text.contains(|c: char| ('\u{80}'..='\u{9F}').contains(&c)) {
		return text;
	}
	text
		.chars()
		.map(|c| match c {
			'\u{80}'..='\u{9F}' => C1_REPLACEMENTS[c as usize - 0x80].unwrap_or(c),
			_ => c,
		})
		.collect::<String>()
		.into()
}

/// Rewrite Mermaid entity codes (`#\w+;`) as HTML character references:
/// `#60;` → `&#60;`, `#quot;` → `&quot;`, as Mermaid does before handing
/// labels to the browser. Codes that name no character are kept verbatim
/// (`step #1;` is not U+0001), and so is the `#` of an HTML numeric
/// reference (`&#60;`).
fn mermaid_codes_to_html(text: &str) -> Cow<'_, str> {
	if !text.contains('#') {
		return Cow::Borrowed(text);
	}
	let mut out = String::with_capacity(text.len());
	let mut reference = String::new();
	let mut rest = text;
	while let Some(hash) = rest.find('#') {
		out.push_str(&rest[..hash]);
		let after = &rest[hash + 1..];
		let name_len = after
			.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
			.unwrap_or(after.len());
		let name = &after[..name_len];
		if name_len > 0 && after[name_len..].starts_with(';') && !out.ends_with('&') {
			reference.clear();
			reference.push('&');
			if name.bytes().all(|b| b.is_ascii_digit()) {
				reference.push('#');
			}
			reference.push_str(name);
			reference.push(';');
			if matches!(html_escape::decode_html_entities(&reference), Cow::Owned(_)) {
				out.push_str(&reference);
				rest = &after[name_len + 1..];
				continue;
			}
		}
		out.push('#');
		rest = after;
	}
	out.push_str(rest);
	Cow::Owned(out)
}

/// Replace every `<name>` / `</name>` tag (case-insensitive, optional
/// whitespace and — when `self_closing` — an optional `/` before `>`) with
/// `replacement`. Mirrors `<\/?(?:names)\s*\/?>` with the `i` flag.
fn replace_tags(text: &str, names: &[&str], self_closing: bool, replacement: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	while let Some(lt) = rest.find('<') {
		out.push_str(&rest[..lt]);
		let tag = &rest[lt + 1..];
		if let Some(len) = tag_end(tag, names, self_closing) {
			out.push_str(replacement);
			rest = &tag[len..];
		} else {
			out.push('<');
			rest = tag;
		}
	}
	out.push_str(rest);
	out
}

/// Length of a tag body (`/?name\s*/?>`) at the start of `tag`, if it names
/// one of `names`.
fn tag_end(tag: &str, names: &[&str], self_closing: bool) -> Option<usize> {
	let body = tag.strip_prefix('/').unwrap_or(tag);
	let closing = tag.len() - body.len();
	if closing == 1 && self_closing {
		return None;
	}
	names.iter().find_map(|name| {
		let after_name = body
			.get(name.len()..)
			.filter(|_| body[..name.len()].eq_ignore_ascii_case(name))?;
		let mut tail = after_name.trim_start();
		if self_closing {
			tail = tail.strip_prefix('/').unwrap_or(tail);
		}
		tail.strip_prefix('>').map(|rest| tag.len() - rest.len())
	})
}

/// JavaScript line terminators, which `.` never matches.
const fn is_line_terminator(c: char) -> bool {
	matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `<m>text<m>` → `text` for a two-char marker, mirroring `m(.+?)m`: the
/// inner text is the shortest non-empty run without line terminators that
/// ends at the next marker; unmatched openers are kept verbatim.
fn strip_paired_marker(text: &str, marker: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	while let Some(open) = rest.find(marker) {
		let after = &rest[open + marker.len()..];
		// The inner text is non-empty, so the closer is searched from the
		// second char on; a line terminator before it fails this opener.
		let close = after
			.char_indices()
			.skip(1)
			.map(|(i, _)| i)
			.find(|&i| after[i..].starts_with(marker));
		match close {
			Some(close) if !after[..close].contains(is_line_terminator) => {
				out.push_str(&rest[..open]);
				out.push_str(&after[..close]);
				rest = &after[close + marker.len()..];
			},
			_ => {
				out.push_str(&rest[..open + marker.len()]);
				rest = after;
			},
		}
	}
	out.push_str(rest);
	out
}

/// `*text*` → `text`, mirroring the JavaScript pattern
/// `(?<!\*)\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)`: the opening star must not
/// follow another star, the inner text contains no star and neither starts
/// nor ends with whitespace, and the closing star must not precede another
/// star. Matches are non-overlapping, scanned left to right.
fn strip_single_star_emphasis(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = String::with_capacity(text.len());
	let mut copied = 0;
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] != b'*' || (i > 0 && bytes[i - 1] == b'*') {
			i += 1;
			continue;
		}
		let inner_start = i + 1;
		let Some(close) = text[inner_start..].find('*').map(|off| inner_start + off) else {
			break;
		};
		let inner = &text[inner_start..close];
		let closes_cleanly = bytes.get(close + 1) != Some(&b'*');
		let trimmed_edges = inner.chars().next().is_some_and(|c| !c.is_whitespace())
			&& inner
				.chars()
				.next_back()
				.is_some_and(|c| !c.is_whitespace());
		if closes_cleanly && trimmed_edges {
			out.push_str(&text[copied..i]);
			out.push_str(inner);
			copied = close + 1;
			i = close + 1;
		} else {
			i += 1;
		}
	}
	out.push_str(&text[copied..]);
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn width_counts_columns_per_grapheme() {
		assert_eq!(display_width("abc"), 3);
		assert_eq!(display_width("日本"), 4);
		assert_eq!(display_width("a🚀b"), 4);
		assert_eq!(display_width("─│┌"), 3);
		assert_eq!(display_width("🇨🇳"), 2);
	}

	#[test]
	fn wrap_label_breaks_on_words_boundaries_and_keeps_newlines() {
		assert_eq!(
			wrap_label("Check if the user has permission", 12),
			"Check if the\nuser has\npermission"
		);
		assert_eq!(wrap_label("  a  b\n\nc ", 12), "  a  b\n\nc ");
		assert_eq!(wrap_label("a_\u{301}bcdef", 3), "a_\u{301}\nbcd\nef");
		assert_eq!(wrap_label("a\nb c", 1), "a\nb\nc");
		// Over-wide identifiers split after the last `_-./` that fits, and a
		// token with no boundary hard-breaks per grapheme; nothing is lost.
		assert_eq!(wrap_label("mark_filter_restore_context", 12), "mark_filter_\nrestore_\ncontext");
		assert_eq!(wrap_label("x aaaaaaaaaaaaaa", 6), "x\naaaaaa\naaaaaa\naa");
		assert_eq!(wrap_label("日本語日本語 ab", 6), "日本語\n日本語\nab");
	}

	#[test]
	fn normalize_reduces_markup_to_plain_text() {
		assert_eq!(normalize_label("\"a<br/>b\""), "a\nb");
		assert_eq!(normalize_label("x\\ny"), "x\ny");
		assert_eq!(normalize_label("<b>bold</b> **strong** *em* ~~gone~~"), "bold strong em gone");
		assert_eq!(normalize_label("a * b * c"), "a * b * c");
		assert_eq!(normalize_label("**multi\nline**"), "**multi\nline**");
		assert_eq!(normalize_label("*a**"), "*a**");
		assert_eq!(normalize_label("*a*b*"), "ab*");
		assert_eq!(normalize_label("a<BR />b<br/>c</br>d"), "a\nb\nc</br>d");
		assert_eq!(normalize_label("<S>x</s ><sub>y</SUB><small>z"), "xyz");
		assert_eq!(normalize_label("<bx>k</b>"), "<bx>k");
		assert_eq!(normalize_label("****"), "****");
		assert_eq!(normalize_label("***a**"), "*a");
		assert_eq!(normalize_label("**a\n**b**"), "**a\nb");
	}

	#[test]
	fn normalize_decodes_character_references() {
		assert_eq!(normalize_label("x &lt; y &amp;&amp; y &gt; z"), "x < y && y > z");
		assert_eq!(normalize_label("\"&quot;q&quot; &#60;&#x3E; &rarr;\""), "\"q\" <> →");
		assert_eq!(normalize_label("#quot;q#quot; #60;b#62; #9829;"), "\"q\" <b> ♥");
		// Escaped markup is literal text, not a tag or emphasis marker.
		assert_eq!(normalize_label("&lt;b&gt;x&lt;/b&gt; &#42;y&#42;"), "<b>x</b> *y*");
		assert_eq!(normalize_label("&amp;lt; #amp;gt;"), "&lt; &gt;");
		// Decoded tabs, CRs, and form feeds would misalign the canvas.
		assert_eq!(normalize_label("a&#9;b#9;c&Tab;d&#13;e&#12;f"), "a b c d e f");
		// Retain emoji ZWJ.
		assert_eq!(normalize_label("a&ZeroWidthSpace;b#8203;c"), "abc");
		assert_eq!(normalize_label("👩‍💻\na"), "👩‍💻\na");
		// Legacy C1 references take the browser's Windows-1252 substitutes;
		// unmapped C1 controls are dropped instead of reaching the terminal.
		assert_eq!(normalize_label("&#128;5 #150; &#x9F;&#x81;!"), "€5 – Ÿ!");
		// Unknown names, controls, and unterminated codes stay verbatim.
		assert_eq!(
			normalize_label("step #1; #nope; #x2192; C# &bogus; &lt"),
			"step #1; #nope; #x2192; C# &bogus; &lt"
		);
	}
}
