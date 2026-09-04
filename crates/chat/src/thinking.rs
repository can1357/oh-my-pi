//! Reasoning text prepared for display.
//!
//! Both modes drop the empty `<!-- -->` sentinel lines gpt-5.x pads reasoning
//! summaries with (outside code fences); prose-only mode additionally elides
//! fenced code down to a trailing ellipsis on the preceding prose line. The
//! fold is a pure function of the whole text — the markdown/text components
//! memoize on the resulting string, so a streaming delta costs one linear
//! pass over the trace.

use std::borrow::Cow;

use omp_core::Str;

/// Whether `text` carries anything but dots, ellipses, and whitespace:
/// placeholder-only traces stay hidden.
#[must_use]
pub fn has_content(text: &str) -> bool {
	text
		.trim()
		.chars()
		.any(|ch| !matches!(ch, '.' | '…' | ' ' | '\t' | '\n' | '\r'))
}

/// Whether a formatted thinking block has displayable content: the formatted
/// text is non-blank and the raw text is not a placeholder.
#[must_use]
pub fn is_displayable(raw: &str, formatted: &str) -> bool {
	!formatted.trim().is_empty() && has_content(raw)
}

/// Formats reasoning text for display. Returns the input untouched when no
/// rewrite applies (raw mode without comment noise).
#[must_use]
pub fn format_thinking(text: &str, prose_only: bool) -> Cow<'_, str> {
	if text.is_empty() {
		return Cow::Borrowed(text);
	}
	let has_comment = text.contains("<!--");
	if !prose_only && !has_comment {
		return Cow::Borrowed(text);
	}
	let mut fold = Fold::default();
	let lines = text.split('\n').collect::<Vec<_>>();
	let last = lines.len() - 1;
	for (index, line) in lines.iter().enumerate() {
		if let Some(fence) = fold.fence {
			if let Some((indent, marker)) = fence_marker(line)
				&& marker.starts_with(fence.0)
				&& marker.len() >= fence.1
				&& line[indent + marker.len()..].trim().is_empty()
			{
				fold.fence = None;
			}
			if !prose_only {
				fold.push(line);
			}
			continue;
		}
		if has_comment && is_comment_noise(line, index == last) {
			continue;
		}
		if let Some((indent, marker)) = fence_marker(line) {
			let ch = marker.as_bytes()[0];
			let backtick_info = ch == b'`' && line[indent + marker.len()..].contains('`');
			if !backtick_info {
				fold.fence = Some((ch as char, marker.len()));
				if prose_only {
					fold.ellipsis();
				} else {
					fold.push(line);
				}
				continue;
			}
		}
		fold.push(line);
	}
	Cow::Owned(fold.render())
}

/// Convenience over [`format_thinking`] for owned session strings.
#[must_use]
pub fn display_thinking(text: &Str, prose_only: bool) -> Str {
	match format_thinking(text.as_str(), prose_only) {
		Cow::Borrowed(_) => text.clone(),
		Cow::Owned(owned) => Str::new(owned),
	}
}

/// An empty HTML comment, or its still-open `<!--` prefix on the last
/// (streaming) line.
fn is_comment_noise(line: &str, is_last: bool) -> bool {
	let trimmed = line.trim();
	if let Some(rest) = trimmed.strip_prefix("<!--") {
		if let Some(inner) = rest.strip_suffix("-->") {
			return inner.trim().is_empty();
		}
		return is_last && rest.trim().is_empty();
	}
	false
}

/// A fence opener/closer: up to three spaces of indent then three or more
/// backticks or tildes. Returns `(indent, marker)`.
fn fence_marker(line: &str) -> Option<(usize, &str)> {
	let indent = line.len() - line.trim_start_matches(' ').len();
	if indent > 3 {
		return None;
	}
	let rest = &line[indent..];
	let ch = rest.as_bytes().first().copied()?;
	if !matches!(ch, b'`' | b'~') {
		return None;
	}
	let run = rest.bytes().take_while(|byte| *byte == ch).count();
	(run >= 3).then(|| (indent, &rest[..run]))
}

/// Output accumulator: committed lines plus a mutable last non-blank line
/// the prose ellipsis may rewrite.
#[derive(Default)]
struct Fold<'a> {
	committed: String,
	tail:      Option<Cow<'a, str>>,
	tail_pred: bool,
	blanks:    String,
	emitted:   usize,
	fence:     Option<(char, usize)>,
}

impl<'a> Fold<'a> {
	fn push(&mut self, line: &'a str) {
		self.emitted += 1;
		if line.trim().is_empty() {
			if self.tail.is_some() {
				self.blanks.push('\n');
				self.blanks.push_str(line);
			} else {
				if self.emitted > 1 {
					self.committed.push('\n');
				}
				self.committed.push_str(line);
			}
			return;
		}
		if let Some(tail) = self.tail.take() {
			if self.tail_pred {
				self.committed.push('\n');
			}
			self.committed.push_str(&tail);
			self.committed.push_str(&self.blanks);
			self.tail_pred = true;
		} else {
			self.tail_pred = self.emitted > 1;
		}
		self.tail = Some(Cow::Borrowed(line));
		self.blanks.clear();
	}

	fn ellipsis(&mut self) {
		let Some(tail) = self.tail.take() else {
			self.push("...");
			return;
		};
		let trimmed = tail.trim_end();
		let rewritten = if trimmed.ends_with("...") {
			trimmed.to_owned()
		} else if let Some(stem) = trimmed.strip_suffix('.') {
			format!("{stem}...")
		} else {
			format!("{trimmed}...")
		};
		self.tail = Some(Cow::Owned(rewritten));
	}

	fn render(mut self) -> String {
		if let Some(tail) = self.tail.take() {
			if self.tail_pred {
				self.committed.push('\n');
			}
			self.committed.push_str(&tail);
			self.committed.push_str(&self.blanks);
		}
		self.committed
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn raw_mode_without_comments_is_the_identity() {
		let text = "plain\n```rs\nlet x = 1;\n```\nafter";
		assert!(matches!(format_thinking(text, false), Cow::Borrowed(same) if same == text));
	}

	#[test]
	fn empty_comment_sentinels_are_dropped_in_both_modes() {
		let text = "**Headline**\n\n<!-- -->\nbody";
		assert_eq!(format_thinking(text, false), "**Headline**\n\nbody");
		assert_eq!(format_thinking(text, true), "**Headline**\n\nbody");
		assert_eq!(format_thinking("keep <!-- note --> this", true), "keep <!-- note --> this");
	}

	#[test]
	fn open_comment_on_the_streaming_last_line_is_hidden() {
		assert_eq!(format_thinking("prose\n<!--", true), "prose");
		assert_eq!(format_thinking("prose\n<!--\nmore", true), "prose\n<!--\nmore");
	}

	#[test]
	fn prose_only_elides_fences_into_a_trailing_ellipsis() {
		let text = "Let me check the code.\n```ts\nconst a = 1;\n```\nDone";
		assert_eq!(format_thinking(text, true), "Let me check the code...\nDone");
		assert_eq!(format_thinking("Already...\n```\nx\n```", true), "Already...");
		assert_eq!(format_thinking("```\nx\n```\ntail", true), "...\ntail");
		assert_eq!(format_thinking("Words\n\n~~~\nx\n~~~\n", true), "Words...\n\n");
	}

	#[test]
	fn fence_close_requires_same_char_and_length() {
		let text = "a\n````\ncode\n```\nstill code\n````\nb";
		assert_eq!(format_thinking(text, true), "a...\nb");
		assert_eq!(
			format_thinking("a\n``` has `tick`\nnot a fence", true),
			"a\n``` has `tick`\nnot a fence"
		);
	}

	#[test]
	fn comment_markers_inside_fences_are_code_in_raw_mode() {
		let text = "a\n```html\n<!-- -->\n```";
		assert_eq!(format_thinking(text, false), text);
	}

	#[test]
	fn placeholder_traces_are_not_displayable() {
		assert!(!is_displayable("...", "..."));
		assert!(!is_displayable("<!-- -->\n", ""));
		assert!(is_displayable("real thought", "real thought"));
	}
}
