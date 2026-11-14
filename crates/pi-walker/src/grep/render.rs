//! How reported lines are rendered: trailing whitespace trimmed, invalid
//! UTF-8 replaced, and lines wider than `max_columns` cut (context lines) or
//! windowed around their first match (matching lines).

use std::borrow::Cow;

use grep_matcher::Matcher;

/// `bytes` as text without trailing Unicode whitespace, invalid UTF-8
/// replaced per maximal subpart. Borrowed when `bytes` is valid UTF-8.
pub fn trimmed(bytes: &[u8]) -> Cow<'_, str> {
	if let Ok(text) = std::str::from_utf8(bytes) {
		Cow::Borrowed(text.trim_end())
	} else {
		let mut text = String::from_utf8_lossy(bytes).into_owned();
		text.truncate(text.trim_end().len());
		Cow::Owned(text)
	}
}

/// A context line: longer than `max` bytes, it is cut to `max - 3` bytes at
/// a character boundary plus `...`.
pub fn truncate_line(line: Cow<'_, str>, max: Option<usize>) -> String {
	match max {
		Some(max) if line.len() > max => {
			let cut = line.floor_char_boundary(max.saturating_sub(3));
			let mut out = String::with_capacity(cut + 3);
			out.push_str(&line[..cut]);
			out.push_str("...");
			out
		},
		_ => line.into_owned(),
	}
}

/// Fits a matched line wider than `max` bytes into `max` bytes so its first
/// match (`first_match`, a byte range in `line`) stays visible. When the
/// match fits in the head [`truncate_line`] keeps, the line is cut the same
/// way; otherwise the kept window is centred on the match and each cut side
/// is marked with `...`. Also returns the match's 1-based character column.
pub fn window_matched_line(
	line: &str,
	max: usize,
	first_match: Option<(usize, usize)>,
) -> (String, Option<u32>) {
	let head_end = line.floor_char_boundary(max.saturating_sub(3));
	let head = || format!("{}...", &line[..head_end]);
	let Some((start, end)) = first_match else {
		return (head(), None);
	};
	let start = line.floor_char_boundary(start);
	let column = Some(u32::try_from(line[..start].chars().count() + 1).unwrap_or(u32::MAX));
	let body = max.saturating_sub(6);
	if end <= head_end || body == 0 {
		return (head(), column);
	}
	// Centre the match; a match wider than the window shows from its start.
	let lead = body.saturating_sub(end - start) / 2;
	let from = start.saturating_sub(lead);
	let window = if from + body >= line.len() {
		// The window reaches the end of the line: only its start is cut.
		let from = line.ceil_char_boundary(line.len() - max.saturating_sub(3));
		format!("...{}", &line[from..])
	} else {
		let from = line.ceil_char_boundary(from);
		let to = line.floor_char_boundary(from + body);
		if from == 0 {
			format!("{}...", &line[..to])
		} else {
			format!("...{}...", &line[from..to])
		}
	};
	(window, column)
}

/// Byte range in `line` (the rendered text of the block `buf[range]`) of the
/// block's first match. Like ripgrep's printer it re-runs the matcher over
/// `buf` from the block's start, so look-behind sees the preceding text; a
/// line-mode block drops its line terminator, a multiline block keeps the
/// rest of `buf` for look-ahead.
pub fn first_match_in_line<M: Matcher>(
	matcher: &M,
	buf: &[u8],
	range: (usize, usize),
	spans_lines: bool,
	line: &str,
	lossy: bool,
) -> Option<(usize, usize)> {
	let (start, end) = range;
	let terminated = end > start && buf[end - 1] == b'\n';
	let limit = if spans_lines {
		buf.len()
	} else if terminated {
		end - 1
	} else {
		end
	};
	let found = matcher.find_at(&buf[..limit], start).ok().flatten()?;
	// A match at `end` begins on the next line, except an empty one (`$`,
	// `\z`) after an unterminated last line.
	if found.start() > end || (found.start() == end && terminated) {
		return None;
	}
	let block = &buf[start..end];
	let (from, to) = (found.start() - start, found.end().min(end) - start);
	// `line` is `block` decoded and trimmed: offsets carry over unless lossy
	// decoding replaced invalid bytes, which changes the lengths before them.
	// An offset in the trimmed trailing whitespace maps to the end of `line`.
	let to_line = |offset: usize| -> usize {
		let offset = if lossy {
			String::from_utf8_lossy(&block[..offset]).len()
		} else {
			offset
		};
		line.floor_char_boundary(offset.min(line.len()))
	};
	Some((to_line(from), to_line(to)))
}

/// A matched block rendered for a [`super::Match`]: its text, and with
/// `max` exceeded the window and first-match column.
pub fn matched_text<M: Matcher>(
	matcher: &M,
	buf: &[u8],
	range: (usize, usize),
	spans_lines: bool,
	max: Option<usize>,
) -> (String, bool, Option<u32>) {
	let raw = trimmed(&buf[range.0..range.1]);
	match max {
		Some(max) if raw.len() > max => {
			let lossy = matches!(raw, Cow::Owned(_));
			let first = first_match_in_line(matcher, buf, range, spans_lines, &raw, lossy);
			let (text, column) = window_matched_line(&raw, max, first);
			(text, true, column)
		},
		_ => (raw.into_owned(), false, None),
	}
}
