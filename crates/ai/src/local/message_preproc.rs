//! Bounded low-noise preprocessing for local tiny-model prompts.

use std::sync::LazyLock;

use omp_core::Str;
use regex::{Captures, Regex};

/// Maximum characters retained in one tiny-model message.
pub const MAX_TINY_MESSAGE_CHARS: usize = 2_000;

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").expect("ANSI regex"));
static HASH: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?i)\b[0-9a-f]{12,}\b").expect("hash regex"));

/// Removes ANSI styles, paired tag envelopes, fenced code, and long hashes,
/// then middle-truncates while preserving twice as much leading context.
pub fn preprocess_tiny_message(message: &str) -> Str {
	let without_ansi = ANSI.replace_all(message, "");
	let without_tags = strip_paired_tags(&without_ansi);
	let shortened = HASH.replace_all(&without_tags, |captures: &Captures<'_>| {
		captures
			.get(0)
			.map_or_else(String::new, |matched| matched.as_str()[..7].to_owned())
	});
	let without_code = strip_fenced_code(&shortened);
	let cleaned = if without_code.trim().chars().count() >= 12 {
		without_code
	} else {
		shortened.into_owned()
	};
	Str::from(middle_truncate(cleaned.trim(), MAX_TINY_MESSAGE_CHARS))
}

/// Formats one cleaned user message in the structural title envelope.
pub fn format_title_user_message(message: &str) -> Str {
	if is_preformatted_chat_context(message) {
		return Str::from(message);
	}
	let cleaned = preprocess_tiny_message(message);
	Str::from(format!("<user>{}</user>", cleaned.as_str()))
}

/// One recent turn used to refresh a title after replanning.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TitleConversationTurn<'a> {
	/// Structural role name (`user` or `assistant`).
	pub role:    &'a str,
	/// Raw turn content.
	pub content: &'a str,
}

/// Formats recent cleaned turns as one bounded structural chat context.
pub fn format_title_conversation_context(turns: &[TitleConversationTurn<'_>]) -> Str {
	let mut output = String::from("<chat>");
	for turn in turns {
		let role = if turn.role.eq_ignore_ascii_case("assistant") {
			"assistant"
		} else {
			"user"
		};
		let cleaned = preprocess_tiny_message(turn.content);
		if cleaned.is_empty() {
			continue;
		}
		use std::fmt::Write as _;
		let _ = write!(output, "<{role}>{}</{role}>", cleaned.as_str());
	}
	output.push_str("</chat>");
	Str::from(middle_truncate(&output, MAX_TINY_MESSAGE_CHARS))
}

/// Whether a message is already a full structural chat context.
pub fn is_preformatted_chat_context(message: &str) -> bool {
	let trimmed = message.trim();
	trimmed.starts_with("<chat>") && trimmed.ends_with("</chat>")
}

/// Removes structural chat tags while retaining their text for signal checks.
pub fn strip_chat_scaffolding(message: &str) -> String {
	["chat", "user", "assistant", "think"]
		.into_iter()
		.fold(message.to_owned(), |value, tag| {
			value
				.replace(&format!("<{tag}>"), " ")
				.replace(&format!("</{tag}>"), " ")
		})
}

fn strip_fenced_code(message: &str) -> String {
	let mut output = String::with_capacity(message.len());
	let mut fence = None;
	for line in message.split_inclusive('\n') {
		let trimmed = line.trim_start();
		let marker = if trimmed.starts_with("```") {
			Some('`')
		} else if trimmed.starts_with("~~~") {
			Some('~')
		} else {
			None
		};
		if let Some(marker) = marker {
			fence = if fence == Some(marker) {
				None
			} else {
				Some(marker)
			};
			if !output.ends_with(' ') {
				output.push(' ');
			}
		} else if fence.is_none() {
			output.push_str(line);
		}
	}
	output
}

fn strip_paired_tags(message: &str) -> String {
	let mut output = String::with_capacity(message.len());
	let mut cursor = 0;
	while let Some(relative) = message[cursor..].find('<') {
		let start = cursor + relative;
		output.push_str(&message[cursor..start]);
		let Some(end_relative) = message[start..].find('>') else {
			output.push_str(&message[start..]);
			return output;
		};
		let open_end = start + end_relative + 1;
		let tag = message[start + 1..open_end - 1]
			.split_whitespace()
			.next()
			.unwrap_or_default();
		if tag.is_empty()
			|| tag.starts_with('/')
			|| !tag
				.chars()
				.all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
		{
			output.push_str(&message[start..open_end]);
			cursor = open_end;
			continue;
		}
		let close = format!("</{tag}>");
		if let Some(close_relative) = message[open_end..].find(&close) {
			output.push(' ');
			cursor = open_end + close_relative + close.len();
		} else {
			output.push_str(&message[start..open_end]);
			cursor = open_end;
		}
	}
	output.push_str(&message[cursor..]);
	output
}

fn middle_truncate(message: &str, maximum: usize) -> String {
	if message.chars().count() <= maximum {
		return message.to_owned();
	}
	const OMISSION: &str = "\n…\n";
	let budget = maximum - OMISSION.chars().count();
	let head_chars = budget * 2 / 3;
	let tail_chars = budget - head_chars;
	let head_end = message
		.char_indices()
		.nth(head_chars)
		.map_or(message.len(), |(index, _)| index);
	let tail_start = message
		.char_indices()
		.rev()
		.nth(tail_chars.saturating_sub(1))
		.map_or(message.len(), |(index, _)| index);
	let mut output = String::with_capacity(maximum + 8);
	output.push_str(&message[..head_end]);
	output.push_str(OMISSION);
	output.push_str(&message[tail_start..]);
	output
}
